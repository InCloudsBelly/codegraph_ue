import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { CodeGraph } from '../src';

describe('CLI private indexing scope diagnostics', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ue-status-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
  });

  afterEach(() => {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^codegraph-ue-status-/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function status() {
    const output = execFileSync(process.execPath, [
      ...WASM_RUNTIME_FLAGS, path.resolve('dist/bin/codegraph.js'), 'status', root, '--json',
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' } });
    return JSON.parse(output.trim().split(/\r?\n/).pop()!);
  }

  it('reports an absent private config without creating a database', () => {
    const result = status();
    expect(result.indexingConfig).toMatchObject({ loaded: false, include: [], exclude: [], error: null });
    expect(fs.existsSync(path.join(root, '.codegraph/codegraph.db'))).toBe(false);
  });

  it('reports the configured private include and exclude patterns', () => {
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), JSON.stringify({
      include: ['Client/Plugins/**'], exclude: ['Client/Plugins/Generated/**'],
    }));
    expect(status().indexingConfig).toMatchObject({
      loaded: true, include: ['Client/Plugins/**'], exclude: ['Client/Plugins/Generated/**'], error: null,
    });
  });

  it('reports invalid private configuration instead of claiming it was loaded', () => {
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), '{');
    expect(status().indexingConfig).toMatchObject({ loaded: false, error: expect.stringContaining('invalid JSON') });
  });

  it('keeps diagnostics available for an already initialized project with invalid config', () => {
    const graph = CodeGraph.initSync(root);
    graph.destroy();
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), '{');
    const result = status();
    expect(result.initialized).toBe(true);
    expect(result.indexingConfig).toMatchObject({ loaded: false, error: expect.stringContaining('invalid JSON') });
    expect(result.pendingChanges).toBeNull();
    const output = execFileSync(process.execPath, [
      ...WASM_RUNTIME_FLAGS, path.resolve('dist/bin/codegraph.js'), 'status', root,
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' } });
    expect(output).toContain('invalid JSON');
    expect(output).not.toContain('Index is up to date');
  });

  it('the built CLI finds a private plugin type using its omitted Unreal prefix', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'Client/\n');
    const plugin = path.join(root, 'Client/Plugins/Probe/Private');
    fs.mkdirSync(plugin, { recursive: true });
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(path.join(plugin, 'RuntimeTarget.cpp'), 'class UPrivateWidgetBuild { public: int Rebuild() { return 42; } };\n');
    fs.writeFileSync(path.join(root, 'other/Namesake.cpp'), 'int PrivateWidgetBuild() { return 1; }\n');
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), JSON.stringify({ include: ['Client/Plugins/**'] }));
    const graph = CodeGraph.initSync(root);
    try { await graph.indexAll(); } finally { graph.destroy(); }
    const output = execFileSync(process.execPath, [
      ...WASM_RUNTIME_FLAGS, path.resolve('dist/bin/codegraph.js'), 'explore', 'PrivateWidgetBuild',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' } });
    expect(output).toContain('UPrivateWidgetBuild');
    expect(output.replace(/\\/g, '/')).toContain('Client/Plugins/Probe/Private/RuntimeTarget.cpp');
  }, 30_000);
});
