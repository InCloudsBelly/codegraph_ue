import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import CodeGraph from '../src';
import { MCPEngine } from '../src/mcp/engine';
import { acquireProject } from '../src/mcp/project-lifecycle';
import { __emitWatchEventForTests } from '../src/sync/watcher';

describe('automatic catch-up never repairs an incomplete graph by reindexing the repository', () => {
  let root: string;
  let cg: CodeGraph;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-auto-sync-protect-'));
    const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
    fs.writeFileSync(path.join(root, 'tiny.py'), 'def tiny():\n    return 1\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { cg.close(); } catch { /* an explicitly released MCP lease already closed it */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function breakIndex(state: string) {
    if (state === 'empty-nodes') (cg as any).db.getDb().exec('DELETE FROM nodes');
    else if (state === 'empty-files') (cg as any).db.getDb().exec('DELETE FROM files');
    else if (state === 'older-extraction') (cg as any).queries.setMetadata('indexed_with_extraction_version', '0');
    else if (state === 'newer-extraction') (cg as any).queries.setMetadata('indexed_with_extraction_version', '999999');
    else if (state === 'missing-extraction') (cg as any).db.getDb().prepare("DELETE FROM project_metadata WHERE key='indexed_with_extraction_version'").run();
    else (cg as any).queries.setMetadata('index_state', state);
  }

  it.each(['partial', 'failed', 'indexing', 'unknown', 'empty-nodes', 'empty-files', 'older-extraction', 'newer-extraction', 'missing-extraction'])(
    'MCP project activation never starts watching or syncing a %s index', async state => {
      breakIndex(state);
      const watch = vi.spyOn(cg, 'watch').mockReturnValue(false);
      const sync = vi.spyOn(cg, 'sync').mockResolvedValue({} as any);
      const automatic = vi.spyOn(cg, 'syncAutomatically').mockResolvedValue({} as any);
      const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan');
      const lease = acquireProject(root, () => cg, { inertForTests: true });
      try { await lease.ready(); } finally { await lease.release(); }
      expect(watch).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(automatic).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
    },
  );

  it.each(['partial', 'failed', 'indexing', 'unknown', 'empty-nodes', 'empty-files', 'older-extraction', 'newer-extraction', 'missing-extraction'])(
    'direct MCP catch-up never syncs a %s index', async state => {
      breakIndex(state);
      const sync = vi.spyOn(cg, 'sync').mockResolvedValue({ filesAdded: 0, filesModified: 0, filesRemoved: 0 } as any);
      const automatic = vi.spyOn(cg, 'syncAutomatically').mockResolvedValue({ filesAdded: 0, filesModified: 0, filesRemoved: 0 } as any);
      const engine = new MCPEngine({ watch: false, queryPool: false });
      (engine as any).cg = cg;
      try {
        (engine as any).catchUpSync();
        await (engine as any).toolHandler.catchUpGate;
        expect(sync).not.toHaveBeenCalled();
        expect(automatic).not.toHaveBeenCalled();
      } finally { (engine as any).cg = null; await engine.stop(); }
    },
  );

  it('does not start a watcher for an incomplete index', () => {
    breakIndex('partial');
    expect(() => cg.watch({ inertForTests: true })).toThrow(/automatic.*sync.*refused|incomplete/i);
    expect(cg.isWatching()).toBe(false);
  });

  it('still permits watching a legitimate empty complete index', () => {
    (cg as any).db.getDb().exec('DELETE FROM nodes; DELETE FROM files');
    expect(cg.watch({ inertForTests: true })).toBe(true);
    expect(cg.isWatching()).toBe(true);
  });

  it('preserves the explicit SDK sync contract for an incomplete index', async () => {
    breakIndex('partial');
    const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan');
    await cg.sync();
    expect(scan).toHaveBeenCalledOnce();
    expect(cg.getStats().fileCount).toBe(1);
  });

  it.each(['empty-nodes', 'empty-files', 'older-extraction', 'newer-extraction', 'missing-extraction'])('an already active watcher refuses a graph that later becomes %s', async state => {
    let report!: (value: string) => void;
    const reported = new Promise<string>(resolve => { report = resolve; });
    expect(cg.watch({ inertForTests: true, debounceMs: 20,
      onSyncComplete: () => report('synced'), onSyncError: () => report('refused') })).toBe(true);
    await cg.waitUntilWatcherReady();
    breakIndex(state);
    const sync = vi.spyOn(cg, 'sync');
    const automatic = vi.spyOn(cg, 'syncAutomatically');
    const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan');
    fs.appendFileSync(path.join(root, 'tiny.py'), '\ndef later():\n    return 2\n');
    expect(__emitWatchEventForTests(root, 'tiny.py')).toBe(true);
    const outcome = await Promise.race([reported, new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 3000))]);
    expect(outcome).toBe('refused');
    expect(sync).not.toHaveBeenCalled();
    expect(automatic).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('rechecks publication state after a queued sync acquires the index mutex', async () => {
    const release = await (cg as any).indexMutex.acquire();
    const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan').mockRejectedValue(new Error('source scan must not start'));
    const queued = cg.sync();
    fs.writeFileSync(path.join(root, '.codegraph.publication.json'), 'pending');
    release();
    await expect(queued).rejects.toThrow(/publication/i);
    expect(scan).not.toHaveBeenCalled();
  });

  it('rechecks completeness under the mutex after automatic sync has queued', async () => {
    const release = await (cg as any).indexMutex.acquire();
    const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan');
    const queued = (cg as any).syncAutomatically();
    breakIndex('partial');
    breakIndex('empty-nodes');
    release();
    await expect(queued).rejects.toThrow(/automatic sync is refused/i);
    expect(scan).not.toHaveBeenCalled();
  });

  it('does not trust the complete old handle after an automatic writer sees replacement', async () => {
    vi.spyOn((cg as any).db, 'isReplacedOnDisk').mockReturnValue(true);
    const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan');
    await expect((cg as any).syncAutomatically()).rejects.toThrow(/replacement|replaced/i);
    expect(scan).not.toHaveBeenCalled();
  });
});
