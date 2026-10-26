import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { __emitWatchEventForTests } from '../src/sync/watcher';

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof fs>();
  return { ...real, statSync: vi.fn(real.statSync), openSync: vi.fn(real.openSync) };
});

describe('sync refreshes observations of unchanged source', () => {
  let root: string;
  let graph: CodeGraph;
  let realFs: typeof fs;

  beforeEach(async () => {
    realFs = await vi.importActual<typeof fs>('fs');
    vi.mocked(fs.statSync).mockImplementation(realFs.statSync);
    vi.mocked(fs.openSync).mockImplementation(realFs.openSync);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unchanged-observation-'));
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export function entry() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'other.ts'), 'export function other() { return 2; }\n');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    graph.destroy();
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^cg-unchanged-observation-/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(file: string) {
    const full = path.join(root, file);
    const before = fs.statSync(full);
    fs.utimesSync(full, before.atime, new Date(before.mtimeMs + 60_000));
    return fs.statSync(full);
  }

  it.each([false, true])('persists a hash-verified timestamp without replacing nodes (scoped=%s)', async scoped => {
    const before = graph.getFile('entry.ts')!;
    const nodeIds = graph.getNodesInFile('entry.ts').map(node => node.id);
    const observed = touch('entry.ts');
    const result = await graph.sync(scoped ? { paths: ['entry.ts'] } : {});
    expect(result).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0 });
    expect(graph.getFile('entry.ts')).toEqual({ ...before, modifiedAt: observed.mtimeMs, size: observed.size });
    expect(graph.getNodesInFile('entry.ts').map(node => node.id)).toEqual(nodeIds);
    graph.destroy();
    graph = await CodeGraph.open(root, { readOnly: true });
    expect(graph.getFile('entry.ts')!.modifiedAt).toBe(observed.mtimeMs);
    expect(graph.getNodesInFile('entry.ts').map(node => node.id)).toEqual(nodeIds);
  });

  it.runIf(process.platform === 'win32')('does not requeue Windows read-access events after the verified sync', async () => {
    touch('entry.ts');
    await graph.sync({ paths: ['entry.ts'] });
    expect(graph.watch({ inertForTests: true })).toBe(true);
    __emitWatchEventForTests(root, 'entry.ts');
    expect(graph.getPendingFiles()).toEqual([]);
  });

  it('does not refresh observations when another source read failed', async () => {
    const before = graph.getFile('entry.ts')!;
    touch('entry.ts');
    touch('other.ts');
    vi.mocked(fs.openSync).mockImplementation(((file: fs.PathLike, ...args: any[]) => {
      if (String(file) === path.join(root, 'other.ts')) {
        throw Object.assign(new Error('injected source read failure'), { code: 'EACCES' });
      }
      return (realFs.openSync as any)(file, ...args);
    }) as typeof fs.openSync);
    const result = await graph.sync();
    expect(result.failedFilePaths).toContain('other.ts');
    expect(graph.getFile('entry.ts')).toEqual(before);
  });

  it('leaves a later edit stale instead of certifying the earlier timestamp', async () => {
    const before = graph.getFile('entry.ts')!;
    touch('entry.ts');
    fs.writeFileSync(path.join(root, 'other.ts'), 'export function other() { return 3; }\n');
    await graph.sync({ onProgress: progress => {
      if (progress.phase === 'parsing') {
        fs.writeFileSync(path.join(root, 'entry.ts'), 'export function changedDuringSync() { return 4; }\n');
      }
    } });
    expect(graph.getFile('entry.ts')).toEqual(before);
    expect(graph.getChangedFiles().modified).toContain('entry.ts');
  });

  it('preserves every observation when a later final stat fails', async () => {
    const before = graph.getFile('entry.ts')!;
    touch('entry.ts');
    touch('other.ts');
    let hashedOther = false;
    vi.mocked(fs.openSync).mockImplementation(((file: fs.PathLike, ...args: any[]) => {
      const result = (realFs.openSync as any)(file, ...args);
      if (String(file) === path.join(root, 'other.ts')) hashedOther = true;
      return result;
    }) as typeof fs.openSync);
    vi.mocked(fs.statSync).mockImplementation(((file: fs.PathLike, ...args: any[]) => {
      if (hashedOther && String(file) === path.join(root, 'other.ts')) {
        throw Object.assign(new Error('injected final stat failure'), { code: 'EIO' });
      }
      return (realFs.statSync as any)(file, ...args);
    }) as typeof fs.statSync);
    await expect(graph.sync()).rejects.toThrow(/scan|incomplete/i);
    expect(graph.getFile('entry.ts')).toEqual(before);
  });

  it('rolls back earlier observations if a later SQLite write fails', async () => {
    const before = graph.getFile('entry.ts')!;
    touch('entry.ts');
    touch('other.ts');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'));
    try {
      db.exec("CREATE TRIGGER fail_observation BEFORE UPDATE ON files WHEN NEW.path='other.ts' BEGIN SELECT RAISE(ABORT, 'injected observation write failure'); END");
    } finally { db.close(); }
    await expect(graph.sync()).rejects.toThrow(/injected observation write failure/);
    expect(graph.getFile('entry.ts')).toEqual(before);
  });

  it('does not treat an unread oversize size-stamp as a verified content hash', async () => {
    const full = path.join(root, 'large.ts');
    fs.writeFileSync(full, Buffer.alloc(1024 * 1024 + 1, 0x41));
    await graph.sync();
    const before = graph.getFile('large.ts')!;
    touch('large.ts');
    vi.mocked(fs.openSync).mockClear();
    await graph.sync();
    expect(graph.getFile('large.ts')).toEqual(before);
    expect(vi.mocked(fs.openSync).mock.calls.some(([file]) => String(file) === full)).toBe(false);
  });
});
