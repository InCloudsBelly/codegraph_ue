import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, LockUnavailableError } from '../src';
import {
  acquireIndexPublicationLease, assertNoPendingIndexPublication,
  getIndexPublicationPaths, isInitialized, resolveServerRoot,
  isCodeGraphDataDir,
} from '../src/directory';

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

describe('index publication protects initialization and routing', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-publication-guard-')); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it.each(['', '{}', '{"schemaVersion":999}', 'not JSON'])(
    'blocks every marker, including incomplete or unknown content %j', async content => {
      const marker = getIndexPublicationPaths(root).markerPath;
      fs.writeFileSync(marker, content);
      expect(() => isInitialized(root)).toThrow(/publication.*pending/i);
      expect(() => resolveServerRoot(root)).toThrow(/publication.*pending/i);
      expect(() => CodeGraph.initSync(root)).toThrow(/publication.*pending/i);
      await expect(CodeGraph.init(root)).rejects.toThrow(/publication.*pending/i);
      expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
      expect(fs.readFileSync(marker, 'utf8')).toBe(content);
    },
  );

  it('keeps a selected candidate independent of the default publication marker', () => {
    fs.writeFileSync(getIndexPublicationPaths(root).markerPath, 'pending default publication');
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph-candidate');
    const cg = CodeGraph.initSync(root);
    cg.close();
    expect(fs.existsSync(path.join(root, '.codegraph-candidate', 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(false);
    fs.writeFileSync(getIndexPublicationPaths(root).markerPath, 'pending candidate publication');
    expect(() => isInitialized(root)).toThrow(/publication.*pending/i);
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])('rejects uncertain marker state (%s)', async code => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const marker = getIndexPublicationPaths(root).markerPath;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === marker) throw Object.assign(new Error('injected marker I/O failure'), { code });
      return (actual.lstatSync as any)(file, ...args);
    }) as typeof fs.lstatSync);
    expect(() => assertNoPendingIndexPublication(root)).toThrow(/cannot be confirmed/i);
    expect(() => CodeGraph.initSync(root)).toThrow(/cannot be confirmed/i);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });

  it.each(['initialize', 'publication'] as const)('a %s lease prevents competing initialization and publication', purpose => {
    const release = acquireIndexPublicationLease(root, purpose);
    try {
      expect(() => CodeGraph.initSync(root)).toThrow(/lease is busy/i);
      expect(() => acquireIndexPublicationLease(root, 'publication')).toThrow(/lease is busy/i);
      expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    } finally { release(); }
    const cg = CodeGraph.initSync(root);
    cg.close();
    expect(fs.existsSync(getIndexPublicationPaths(root).lockPath)).toBe(false);
  });

  it('a publication lease blocks readers before the marker has been written', async () => {
    const cg = CodeGraph.initSync(root);
    const release = acquireIndexPublicationLease(root, 'publication');
    try {
      expect(() => isInitialized(root)).toThrow(/publication lease is pending/i);
      expect(() => CodeGraph.openSync(root)).toThrow(/publication lease is pending/i);
      await expect(CodeGraph.open(root)).rejects.toThrow(/publication lease is pending/i);
      await expect(cg.sync()).rejects.toThrow(/publication lease is pending/i);
    } finally { release(); cg.close(); }
  });

  it('a JSON lease claiming this PID cannot impersonate an in-process initialization lease', () => {
    const { lockPath, indexDirectory } = getIndexPublicationPaths(root);
    fs.writeFileSync(lockPath, JSON.stringify({
      schemaVersion: 1, indexDirectory, purpose: 'initialize',
      transactionId: '00000000-0000-4000-8000-000000000000', pid: process.pid,
    }));
    expect(() => isInitialized(root)).toThrow(/publication lease is pending/i);
  });

  it('release never deletes a lease with changed ownership', () => {
    const release = acquireIndexPublicationLease(root, 'publication');
    const lock = getIndexPublicationPaths(root).lockPath;
    fs.writeFileSync(lock, 'another owner');
    expect(release).toThrow(/ownership changed/i);
    expect(fs.readFileSync(lock, 'utf8')).toBe('another owner');
  });

  it('preserves explicit initialization of a nonexistent project directory', async () => {
    const syncRoot = path.join(root, 'new-sync-project');
    const sync = CodeGraph.initSync(syncRoot);
    sync.close();
    const asyncRoot = path.join(root, 'new-async-project');
    const asyncInstance = await CodeGraph.init(asyncRoot);
    asyncInstance.close();
    expect(isInitialized(syncRoot)).toBe(true);
    expect(isInitialized(asyncRoot)).toBe(true);
  });

  it('never creates a project directory when existence is uncertain', async () => {
    const candidate = path.join(root, 'unreadable-project');
    const actual = await vi.importActual<typeof import('fs')>('fs');
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === candidate) throw Object.assign(new Error('injected project I/O failure'), { code: 'EACCES' });
      return (actual.lstatSync as any)(file, ...args);
    }) as typeof fs.lstatSync);
    expect(() => CodeGraph.initSync(candidate)).toThrow(/injected project I\/O failure/i);
    await expect(CodeGraph.init(candidate)).rejects.toThrow(/injected project I\/O failure/i);
    expect(fs.existsSync(candidate)).toBe(false);
  });

  it('excludes default publication records from source discovery and watching', () => {
    expect(isCodeGraphDataDir('.codegraph.publication.json')).toBe(true);
    expect(isCodeGraphDataDir('.codegraph.publication.lock')).toBe(true);
    expect(isCodeGraphDataDir('.codegraph.publication.00000000-0000-4000-8000-000000000000.journal.json')).toBe(true);
    expect(isCodeGraphDataDir('ordinary-publication.json')).toBe(false);
  });

  it('excludes the active custom directory publication records', () => {
    vi.stubEnv('CODEGRAPH_DIR', 'graph-cache');
    expect(isCodeGraphDataDir('graph-cache.publication.json')).toBe(true);
    expect(isCodeGraphDataDir('graph-cache.publication.lock')).toBe(true);
    expect(isCodeGraphDataDir('graph-cache.publication.00000000-0000-4000-8000-000000000000.journal.json')).toBe(true);
    expect(isCodeGraphDataDir('graph-cache-extra.json')).toBe(false);
  });

  it('never turns an old incomplete or empty replacement into an automatic full reparse', async () => {
    fs.writeFileSync(path.join(root, 'tiny.py'), 'def tiny():\n    return 1\n');
    const cg = CodeGraph.initSync(root);
    // Simulate the post-reopen state without platform-specific inode replacement.
    (cg as any).pendingFullReconcile = true;
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(root, '.codegraph', 'codegraph.db'), old, old);
    const scan = vi.spyOn((cg as any).orchestrator, 'prepareScan');
    try {
      await expect(cg.sync()).rejects.toBeInstanceOf(LockUnavailableError);
      expect(scan).not.toHaveBeenCalled();
      expect(cg.getStats().fileCount).toBe(0);
      (cg as any).queries.setMetadata('index_state', 'complete');
      await expect(cg.sync()).rejects.toThrow(/incomplete or empty/i);
      expect(scan).not.toHaveBeenCalled();
    } finally { cg.close(); }
  });
});
