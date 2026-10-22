import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildScopeIgnore, scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { getCodeGraphDir, removeDirectory } from '../src/directory';
import { FileWatcher } from '../src/sync/watcher';
import { getIndexingConfigStatus, loadIndexingConfig } from '../src/indexing-config';
import { validatePathWithinRoot } from '../src/utils';
import CodeGraph from '../src';

describe('private UE indexing scope', () => {
  let dir: string;
  let external: string;
  const write = (root: string, relative: string, content = 'void UEPrivateSource() {}\n') => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const privateConfig = (config: unknown) =>
    write(dir, path.relative(dir, path.join(getCodeGraphDir(dir), 'indexing.json')), JSON.stringify(config));
  const gitInit = () => execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-private-'));
    external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-p4-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });

  it('includes gitignored P4 plugin source through a project-local directory link', () => {
    write(dir, '.gitignore', 'Client/\n');
    write(dir, 'Engine/Renderer.cpp');
    write(external, 'Plugins/Mirror/Source/Mirror.cpp');
    fs.symlinkSync(external, path.join(dir, 'Client'), process.platform === 'win32' ? 'junction' : 'dir');
    gitInit();
    expect(scanDirectory(dir)).not.toContain('Client/Plugins/Mirror/Source/Mirror.cpp');

    privateConfig({ include: ['Client/Plugins/**'] });
    expect(scanDirectory(dir)).toEqual(expect.arrayContaining([
      'Engine/Renderer.cpp', 'Client/Plugins/Mirror/Source/Mirror.cpp',
    ]));
    const scope = buildScopeIgnore(dir);
    expect(scope.ignores('Client/')).toBe(false);
    expect(scope.ignores('Client/Plugins/Mirror/Source/Mirror.cpp')).toBe(false);
  });

  it('applies private excludes to public includes without editing the team config', () => {
    write(dir, '.gitignore', 'Client/\n');
    write(dir, 'Client/Plugins/Keep.cpp');
    write(dir, 'Client/Plugins/Skip.cpp');
    const teamConfig = JSON.stringify({ include: ['Client/Plugins/'] });
    write(dir, 'codegraph.json', teamConfig);
    privateConfig({ exclude: ['Client/Plugins/Skip.cpp'] });
    gitInit();

    const files = scanDirectory(dir);
    expect(files).toContain('Client/Plugins/Keep.cpp');
    expect(files).not.toContain('Client/Plugins/Skip.cpp');
    expect(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf8')).toBe(teamConfig);
  });

  it('refreshes watcher scope and requests a full reconcile after a private config edit', async () => {
    write(dir, '.gitignore', 'Client/\n');
    write(dir, 'Client/Plugins/Item.cpp');
    privateConfig({});
    let calls = 0;
    let reported: string[] | undefined;
    const watcher = new FileWatcher(dir, async paths => {
      calls++;
      reported = paths;
      return { filesChanged: 0, durationMs: 1 };
    }, { inertForTests: true, debounceMs: 20 });
    try {
      expect(watcher.start()).toBe(true);
      privateConfig({ include: ['Client/Plugins/**'] });
      watcher.ingestEventForTests(path.relative(dir, path.join(getCodeGraphDir(dir), 'indexing.json')));
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(calls).toBe(1);
      expect(reported).toBeUndefined();
      watcher.ingestEventForTests('Client/Plugins/Item.cpp');
      expect(watcher.getPendingFiles().map(file => file.path)).toContain('Client/Plugins/Item.cpp');
      privateConfig({ include: ['../outside/'] });
      watcher.ingestEventForTests(path.relative(dir, path.join(getCodeGraphDir(dir), 'indexing.json')));
      expect(watcher.isDegraded()).toBe(true);
      expect(watcher.isActive()).toBe(false);
    } finally {
      watcher.stop();
    }
  });

  it('allows private first-party source under soft defaults but preserves hard and explicit exclusions', async () => {
    write(dir, 'vendor/Own.cpp');
    write(dir, 'vendor/Skip.cpp');
    write(dir, 'vendor/.git/Internals.cpp');
    write(dir, 'vendor/.codegraph-other/Graph.cpp');
    write(dir, 'codegraph.json', JSON.stringify({ include: ['vendor/'], exclude: ['vendor/Skip.cpp'] }));
    expect(scanDirectory(dir)).not.toContain('vendor/Own.cpp');
    privateConfig({ include: ['vendor/**', '.git/**', '.codegraph/**'] });
    const files = await scanDirectoryAsync(dir);
    expect(files).toContain('vendor/Own.cpp');
    expect(files).not.toContain('vendor/Skip.cpp');
    expect(files.some(file => file.endsWith('/Internals.cpp') || file.endsWith('/Graph.cpp'))).toBe(false);
    const scope = buildScopeIgnore(dir);
    expect(scope.ignores('vendor/Own.cpp')).toBe(false);
    expect(scope.ignores('vendor/Skip.cpp')).toBe(true);
    expect(scope.ignores('vendor/.git/Internals.cpp')).toBe(true);
    expect(scope.ignores('vendor/.codegraph-other/Graph.cpp')).toBe(true);
  });

  it.each([
    '{ bad JSON',
    JSON.stringify({ include: '../outside/' }),
    JSON.stringify({ include: ['../outside/'] }),
    JSON.stringify({ include: ['C:/outside/'] }),
    JSON.stringify({ include: ['Client\\Plugins\\'] }),
    JSON.stringify({ include: ['**/Plugins/'] }),
    JSON.stringify({ include: ['!Client/'] }),
    JSON.stringify({ include: ['Client/?/'] }),
    JSON.stringify({ unknown: [] }),
  ])('fails closed for invalid private config %s', raw => {
    write(dir, path.relative(dir, path.join(getCodeGraphDir(dir), 'indexing.json')), raw);
    expect(() => loadIndexingConfig(dir)).toThrow();
    expect(() => scanDirectory(dir)).toThrow();
    expect(getIndexingConfigStatus(dir).error).toBeTruthy();
    const watcher = new FileWatcher(dir, async () => ({ filesChanged: 0, durationMs: 1 }), { inertForTests: true });
    try {
      expect(watcher.start()).toBe(false);
      expect(watcher.isDegraded()).toBe(true);
    } finally { watcher.stop(); }
  });

  it('preserves private config bytes when generated index data is removed', () => {
    const raw = '{ "include": ["Client/Plugins/**"] }\n';
    write(dir, path.relative(dir, path.join(getCodeGraphDir(dir), 'indexing.json')), raw);
    write(dir, path.relative(dir, path.join(getCodeGraphDir(dir), 'codegraph.db')), 'temporary fixture');
    removeDirectory(dir);
    expect(fs.readFileSync(path.join(getCodeGraphDir(dir), 'indexing.json'), 'utf8')).toBe(raw);
    expect(fs.existsSync(path.join(getCodeGraphDir(dir), 'codegraph.db'))).toBe(false);
    expect(fs.existsSync(path.join(getCodeGraphDir(dir), '.gitignore'))).toBe(true);
  });

  it('indexes and syncs linked plugin source while keeping content reads confined to the root', async () => {
    write(dir, '.gitignore', 'Client/\n');
    write(external, 'Plugins/Mirror.cpp', 'void UEPluginBefore() {}\n');
    fs.symlinkSync(external, path.join(dir, 'Client'), process.platform === 'win32' ? 'junction' : 'dir');
    privateConfig({ include: ['Client/Plugins/**'] });
    gitInit();
    const graph = CodeGraph.initSync(dir, { config: { include: ['**/*.cpp'], exclude: [] } });
    try {
      const indexed = await graph.indexAll();
      expect(indexed.success).toBe(true);
      expect(graph.getNodesByName('UEPluginBefore')[0]?.filePath).toBe('Client/Plugins/Mirror.cpp');
      expect(validatePathWithinRoot(dir, 'Client/Plugins/Mirror.cpp')).toBeNull();

      write(external, 'Plugins/Mirror.cpp', 'void UEPluginAfter() {}\n');
      write(external, 'Plugins/Added.cpp', 'void UEPluginAdded() {}\n');
      expect(graph.getChangedFiles()).toMatchObject({
        modified: ['Client/Plugins/Mirror.cpp'], added: ['Client/Plugins/Added.cpp'],
      });
      await graph.sync({ paths: ['Client/Plugins/Mirror.cpp'] });
      expect(graph.getNodesByName('UEPluginBefore')).toHaveLength(0);
      expect(graph.getNodesByName('UEPluginAfter')).toHaveLength(1);
      await graph.sync();
      expect(graph.getNodesByName('UEPluginAdded')).toHaveLength(1);

      privateConfig({ include: ['Client/Plugins/**'], exclude: ['Client/Plugins/Added.cpp'] });
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(path.join(getCodeGraphDir(dir), 'indexing.json'), future, future);
      await graph.sync({ paths: ['Client/Plugins/Added.cpp'] });
      expect(graph.getNodesByName('UEPluginAdded')).toHaveLength(0);
      fs.unlinkSync(path.join(external, 'Plugins/Mirror.cpp'));
      await graph.sync();
      expect(graph.getNodesByName('UEPluginAfter')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it.runIf(process.platform === 'win32')('auto-syncs P4 junction edits and live private scope changes through native Windows watches', async () => {
    write(dir, '.gitignore', 'Client/\n');
    write(external, 'Plugins/Mirror.cpp', 'void UENativeBefore() {}\n');
    fs.symlinkSync(external, path.join(dir, 'Client'), 'junction');
    privateConfig({ include: ['Client/Plugins/**'] });
    gitInit();
    const graph = CodeGraph.initSync(dir, { config: { include: ['**/*.cpp'], exclude: [] } });
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Native watcher did not reconcile linked plugin source');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.watch({ debounceMs: 100 })).toBe(true);
      write(external, 'Plugins/Mirror.cpp', 'void UENativeAfter() {}\n');
      await waitFor(() => graph.getNodesByName('UENativeAfter').length === 1);
      expect(graph.getNodesByName('UENativeBefore')).toHaveLength(0);
      write(external, 'Plugins/Added.cpp', 'void UENativeAdded() {}\n');
      await waitFor(() => graph.getNodesByName('UENativeAdded').length === 1);
      privateConfig({ include: ['Client/Plugins/**'], exclude: ['Client/Plugins/Added.cpp'] });
      await waitFor(() => graph.getNodesByName('UENativeAdded').length === 0);
      fs.unlinkSync(path.join(external, 'Plugins/Mirror.cpp'));
      await waitFor(() => graph.getNodesByName('UENativeAfter').length === 0);
    } finally { await graph.destroy(); }
  }, 45000);
});
