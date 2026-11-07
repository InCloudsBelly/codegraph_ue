import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';

const fs = require('node:fs') as typeof import('node:fs');
const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
const CodeGraph = require(dist).default as typeof import('../src').default;

it('uses the verified UE delta after reopening and reconciles edits omitted by hints', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cg-ue-delta-'));
  const directory = 'Engine/Source/Runtime/Core';
  const full = (file: string) => path.join(root, directory, file);
  fs.mkdirSync(full(''), { recursive: true });
  fs.mkdirSync(path.join(root, '.codegraph'));
  fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), '{"ueEngine":{"plugins":[]}}');
  expect(spawnSync('git', ['init', '-q', root], { windowsHide: true }).status).toBe(0);
  fs.writeFileSync(full('First.cpp'), '#include "AuditFirstMissing.h"\nvoid AuditFirstA() {}\n');
  fs.writeFileSync(full('Second.cpp'), 'void AuditOtherA() {}\n');
  fs.writeFileSync(full('Unchanged.cpp'), 'void AuditStable() {}\n');
  fs.writeFileSync(full('WithInclude.cpp'), '#include "AuditShared.h"\nvoid AuditIncludeUser() {}\n');
  const initial = CodeGraph.initSync(root);
  try { expect((await initial.indexAll()).filesIndexed).toBe(4); }
  finally { initial.destroy(); }

  const graph = CodeGraph.openSync(root);
  const opens = vi.spyOn(fs, 'openSync');
  try {
    fs.writeFileSync(full('First.cpp'), '#include "AuditFirstMissing.h"\nvoid AuditFirstB() {}\n');
    const original = fs.statSync(full('Second.cpp'));
    fs.writeFileSync(full('Second.cpp'), 'void AuditOtherB() {}\n');
    fs.utimesSync(full('Second.cpp'), original.atime, original.mtime);
    opens.mockClear();
    let refreshed = 0;
    const synced = await graph.syncAutomatically({
      paths: [directory + '/First.cpp'],
      onProgress: event => { if (event.phase === 'refreshing') refreshed = Math.max(refreshed, event.current); },
    });
    expect(synced.filesModified).toBe(2);
    expect(synced.filesChecked).toBe(2);
    expect(refreshed).toBe(1);
    expect(opens.mock.calls.some(([file]) => String(file) === full('Unchanged.cpp'))).toBe(false);
    expect(graph.getNodesByName('AuditOtherB')).toHaveLength(1);
    expect((await graph.getUeScopeStatus())?.state).toBe('fresh');

    fs.writeFileSync(full('AuditShared.h'), 'struct FAuditShared {};\n');
    expect((await graph.syncAutomatically()).filesAdded).toBe(1);
    expect(graph.getUnresolvedReferencesInFile(directory + '/WithInclude.cpp', 10))
      .toEqual(expect.arrayContaining([expect.objectContaining({ candidates: [directory + '/AuditShared.h'] })]));

    fs.unlinkSync(full('Unchanged.cpp'));
    expect((await graph.syncAutomatically()).filesRemoved).toBe(1);
    expect(graph.getNodesByName('AuditStable')).toHaveLength(0);
  } finally {
    opens.mockRestore();
    graph.destroy();
  }
}, 60_000);
