import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';

const fs = require('node:fs') as typeof import('node:fs');
const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
const { default: CodeGraph, FileLock } = require(dist) as typeof import('../src');

it('blocks an overlapping UE build and independently rereads final candidate bytes', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cg-ue-build-lease-'));
  const source = path.join(root, 'Engine/Source/Runtime/Core/AuditCandidate.cpp');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.join(root, '.codegraph'));
  fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), '{"ueEngine":{"plugins":[]}}');
  fs.writeFileSync(source, 'void AuditCandidateA() {}\n');
  expect(spawnSync('git', ['init', '-q', root], { windowsHide: true }).status).toBe(0);
  const graph = CodeGraph.initSync(root);
  const occupied = new FileLock(path.join(root, '.codegraph-ue-build.lock'));
  const originalLstat = fs.lstatSync;
  let restoreStat: (() => void) | undefined;
  try {
    const state = graph.getIndexState();
    occupied.acquire();
    try {
      const blocked = await graph.indexAll();
      expect(blocked.success).toBe(false);
      expect(blocked.errors[0]?.message).toMatch(/UE build in this worktree/);
      expect(graph.getIndexState()).toBe(state);
    } finally { occupied.release(); }

    let changed = false;
    const build = graph.indexAll({
      onProgress: progress => {
        if (progress.phase !== 'verifying' || changed) return;
        changed = true;
        const stamp = originalLstat(source, { bigint: true });
        fs.writeFileSync(source, 'void AuditCandidateB() {}\n');
        // Independent byte verification is required even if stamps match.
        const stat = vi.spyOn(fs, 'lstatSync').mockImplementation(((file, options) =>
          path.resolve(String(file)) === source && options?.bigint
            ? stamp : originalLstat(file, options)) as typeof fs.lstatSync);
        restoreStat = () => stat.mockRestore();
      },
    });
    await expect(build).rejects.toThrow('UE scope inputs changed during indexing');
    expect(changed).toBe(true);
    expect(graph.getIndexState()).not.toBe('complete');
  } finally {
    restoreStat?.();
    graph.destroy();
  }
}, 60_000);

it('separates display artifact identity from graph engine identity', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cg-ue-identities-'));
  const runtime = path.join(root, 'dist');
  const bin = path.join(runtime, 'bin/codegraph.js');
  const engine = path.join(runtime, 'index.js');
  const presentation = ['mcp/server-instructions.js', 'mcp/tools.js', 'ui/shimmer-progress.js']
    .map(file => path.join(runtime, file));
  const { ueRuntimeBuildIdentities } = require(path.join(dist, 'extraction/ue-build-identity.js')) as
    typeof import('../src/extraction/ue-build-identity');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.writeFileSync(bin, 'console.log("status A");');
  fs.writeFileSync(engine, 'module.exports = 1;');
  for (const file of presentation) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'module.exports = "before";');
  }
  const before = await ueRuntimeBuildIdentities(runtime, path.dirname(dist));
  fs.writeFileSync(bin, 'console.log("status B");');
  const display = await ueRuntimeBuildIdentities(runtime, path.dirname(dist));
  expect(display.exact).not.toBe(before.exact);
  expect(display.semantics).toBe(before.semantics);
  let last = display;
  for (const file of presentation) {
    fs.writeFileSync(file, 'module.exports = "after";');
    const updated = await ueRuntimeBuildIdentities(runtime, path.dirname(dist));
    expect(updated.exact).not.toBe(last.exact);
    expect(updated.semantics).toBe(before.semantics);
    last = updated;
  }
  fs.writeFileSync(engine, 'module.exports = 2;');
  const changed = await ueRuntimeBuildIdentities(runtime, path.dirname(dist));
  expect(changed.semantics).not.toBe(display.semantics);
}, 30_000);
