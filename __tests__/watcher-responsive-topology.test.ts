import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileWatcher, __setFsWatchForTests } from '../src/sync/watcher';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const recursive = process.platform === 'win32' || process.platform === 'darwin';

describe.runIf(recursive)('recursive watcher topology stays responsive', () => {
  let root: string;
  let watcher: FileWatcher;
  let release: () => void;
  let entered: boolean;
  let rootEvent: (event: string, file: string) => void;
  const temporary: string[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const handles: Array<{ file: string; callback: typeof rootEvent; handle: fs.FSWatcher }> = [];

  function directory(prefix: string) {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporary.push(value);
    return value;
  }

  function link(target: string) {
    fs.symlinkSync(target, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  }

  function delayRead(directory: string) {
    const original = fs.promises.readdir.bind(fs.promises);
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let delayed = false;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
      if (!delayed && String(args[0]) === directory) {
        delayed = true;
        entered = true;
        await barrier;
      }
      return (original as any)(...args);
    }) as typeof fs.promises.readdir);
  }

  beforeEach(() => {
    opened.length = closed.length = 0;
    handles.length = 0;
    entered = false;
    release = () => {};
    root = directory('cg-responsive-watch-');
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export const before = true;\n');
    __setFsWatchForTests(((file: fs.PathLike, _options: unknown, callback: typeof rootEvent) => {
      opened.push(String(file));
      if (String(file) === fs.realpathSync.native(root)) rootEvent = callback;
      const handle = new EventEmitter() as fs.FSWatcher;
      handle.close = () => { closed.push(String(file)); };
      handles.push({ file: String(file), callback, handle });
      return handle;
    }) as typeof fs.watch);
    watcher = new FileWatcher(root, async () => ({ filesChanged: 0, durationMs: 0 }), { debounceMs: 100 });
  });

  afterEach(async () => {
    watcher.stop();
    release();
    await tick();
    await tick();
    __setFsWatchForTests(null);
    vi.restoreAllMocks();
    for (const folder of temporary.splice(0)) {
      expect(path.dirname(path.resolve(folder))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(folder)).toMatch(/^cg-(responsive-watch|watch-target)-/);
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  async function waitForRead() {
    const deadline = Date.now() + 2000;
    while (!entered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(entered).toBe(true);
  }

  it('keeps the root active and startup edits pending during a slow discovery', async () => {
    delayRead(root);
    expect(watcher.start()).toBe(true);
    let ready = false;
    const settled = watcher.waitUntilReady().then(() => { ready = true; });
    await tick();
    expect(ready).toBe(false);
    await waitForRead();
    expect(watcher.isActive()).toBe(true);
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export const after = true;\n');
    watcher.ingestEventForTests('entry.ts');
    expect(watcher.getPendingFiles().map(file => file.path)).toEqual(['entry.ts']);
    release();
    await settled;
    expect(watcher.getPendingFiles().map(file => file.path)).toEqual(['entry.ts']);
  });

  it('cancels old readiness and never registers late handles after stop and restart', async () => {
    link(directory('cg-watch-target-'));
    delayRead(root);
    expect(watcher.start()).toBe(true);
    const old = watcher.waitUntilReady().then(() => 'unexpected readiness', error => String(error));
    await waitForRead();
    watcher.stop();
    expect(watcher.start()).toBe(true);
    await watcher.waitUntilReady();
    const registered = opened.length;
    const retired = closed.length;
    release();
    await tick();
    await tick();
    expect(await old).toMatch(/stopped/i);
    expect(watcher.isActive()).toBe(true);
    expect(opened).toHaveLength(registered);
    expect(closed).toHaveLength(retired);
  });

  it('replays a retarget request that arrives during discovery', async () => {
    const first = directory('cg-watch-target-');
    const second = directory('cg-watch-target-');
    link(first);
    delayRead(path.join(root, 'linked'));
    expect(watcher.start()).toBe(true);
    await waitForRead();
    fs.unlinkSync(path.join(root, 'linked'));
    link(second);
    rootEvent('rename', 'linked');
    await new Promise(resolve => setTimeout(resolve, 80));
    release();
    await watcher.waitUntilReady();
    expect(opened).toContain(fs.realpathSync.native(second));
    expect(opened.filter(file => file === fs.realpathSync.native(first))).toHaveLength(0);
  });

  it('does not install an ignored target from an obsolete scope observation', async () => {
    const target = directory('cg-watch-target-');
    link(target);
    delayRead(root);
    expect(watcher.start()).toBe(true);
    await waitForRead();
    fs.writeFileSync(path.join(root, '.gitignore'), 'linked/\n');
    rootEvent('change', '.gitignore');
    await new Promise(resolve => setTimeout(resolve, 80));
    release();
    await watcher.waitUntilReady();
    expect(opened).not.toContain(fs.realpathSync.native(target));
  });

  it('reports supplemental exhaustion without completing readiness', async () => {
    link(directory('cg-watch-target-'));
    const watch = vi.fn((file: fs.PathLike) => {
      if (String(file) !== fs.realpathSync.native(root)) {
        throw Object.assign(new Error('too many watches'), { code: 'EMFILE' });
      }
      const handle = new EventEmitter() as fs.FSWatcher;
      handle.close = vi.fn();
      return handle;
    });
    __setFsWatchForTests(watch as typeof fs.watch);
    expect(watcher.start()).toBe(true);
    await expect(watcher.waitUntilReady()).rejects.toThrow(/stopped/i);
    expect(watcher.isDegraded()).toBe(true);
    expect(watcher.isActive()).toBe(false);
  });

  it.each(['change', 'error'])('ignores a retired stream %s after the same logical link is retargeted', async event => {
    const first = directory('cg-watch-target-');
    const second = directory('cg-watch-target-');
    link(first);
    expect(watcher.start()).toBe(true);
    await watcher.waitUntilReady();
    const retired = handles.find(item => item.file === fs.realpathSync.native(first))!;
    expect(retired).toBeDefined();
    fs.unlinkSync(path.join(root, 'linked'));
    link(second);
    rootEvent('rename', 'linked');
    const deadline = Date.now() + 2000;
    while (!handles.some(item => item.file === fs.realpathSync.native(second)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(handles.some(item => item.file === fs.realpathSync.native(second))).toBe(true);
    if (event === 'change') {
      retired.callback('change', 'stale.ts');
      expect(watcher.getPendingFiles().some(file => file.path.endsWith('stale.ts'))).toBe(false);
    } else {
      retired.handle.emit('error', Object.assign(new Error('retired watcher error'), { code: 'EMFILE' }));
      expect(watcher.isDegraded()).toBe(false);
      expect(watcher.isActive()).toBe(true);
      expect(closed).not.toContain(fs.realpathSync.native(second));
    }
  });
});
