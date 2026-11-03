import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import { buildUeScopeForProject, buildUeScopeForProjectAsync, scanDirectoryAsync } from '../src/extraction';
import type { QueryBuilder } from '../src/db/queries';
import { loadIndexingConfig } from '../src/indexing-config';
import type { UePluginScope } from '../src/extraction/ue-engine-scope';

describe('UE cooperative source observation', () => {
  let root: string;
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-yield-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('observes the same scope while allowing event-loop heartbeats through Git and source traversal', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    for (let i = 0; i < 100; i++) write(`Engine/Source/Runtime/Core/Private/File${i}.cpp`, `void Entry${i}() {}\n`);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const config = loadIndexingConfig(root).ueEngine!;
    const sync = buildUeScopeForProject(root, config);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now += 100);
    let finished = false;
    const timer = new Promise<void>(resolve => setImmediate(resolve));
    const observed = buildUeScopeForProjectAsync(root, config).then(result => { finished = true; return result; });
    await timer;
    expect(finished).toBe(false);
    const asyncScope = await observed;
    expect(asyncScope.fingerprint).toBe(sync.fingerprint);
    expect(asyncScope.plugins).toEqual(sync.plugins);
    expect([...asyncScope.sourceHashes]).toEqual([...sync.sourceHashes]);
  }, 60000);

  it('does not report fresh if an update starts while the status probe is suspended', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Private/File.cpp', 'void Entry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const instance = graph as unknown as { queries: QueryBuilder; probeUeScope: (...args: never[]) => Promise<string> };
      const original = instance.probeUeScope.bind(instance);
      let signalStarted!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { signalStarted = resolve; });
      const proceed = new Promise<void>(resolve => { release = resolve; });
      const mock = vi.spyOn(instance, 'probeUeScope').mockImplementation(async (...args) => {
        signalStarted();
        await proceed;
        return original(...args);
      });
      try {
        const status = graph.getUeScopeStatus();
        await started;
        instance.queries.setMetadata('index_state', 'partial');
        release();
        expect((await status)?.state).toBe('stale');
      } finally { mock.mockRestore(); }
    } finally { await graph.destroy(); }
  }, 30000);

  it('yields while merging a large force-included source set', async () => {
    const includedRoot = 'Engine/Source/Runtime/Core/Private/Forced/';
    write('.codegraph/indexing.json', JSON.stringify({ include: [includedRoot], ueEngine: { plugins: [] } }));
    write('.gitignore', `${includedRoot}\n`);
    for (let i = 0; i < 100; i++) write(`${includedRoot}File${i}.cpp`, `void Entry${i}() {}\n`);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now += 100);
    let finished = false;
    const timer = new Promise<void>(resolve => setImmediate(resolve));
    const scan = scanDirectoryAsync(root, undefined, undefined, { allows: () => true } as UePluginScope).then(result => { finished = true; return result; });
    await timer;
    expect(finished).toBe(false);
    expect(await scan).toHaveLength(100);
  }, 60000);

  it('yields during Git admission even when every file is rejected', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    for (let i = 0; i < 100; i++) write(`Engine/Source/Runtime/Core/Private/File${i}.cpp`, `void Entry${i}() {}\n`);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now += 100);
    let finished = false;
    const timer = new Promise<void>(resolve => setImmediate(resolve));
    const scan = scanDirectoryAsync(root, undefined, undefined, { allows: () => false } as UePluginScope).then(result => { finished = true; return result; });
    await timer;
    expect(finished).toBe(false);
    expect(await scan).toEqual([]);
  }, 60000);
});
