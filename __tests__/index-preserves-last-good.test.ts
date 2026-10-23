import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

describe('raw rebuild preserves existing index artifacts', () => {
  let root: string;
  const dbPath = () => path.join(root, '.codegraph', 'codegraph.db');
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-preserve-rebuild-'));
    fs.writeFileSync(path.join(root, 'source.ts'), 'export function original() { return 1; }\n');
    const cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    cg.close();
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('refuses SDK recreate before changing the database', async () => {
    const before = fs.readFileSync(dbPath());
    let replacement: CodeGraph | undefined;
    let rejected: unknown;
    try { replacement = await CodeGraph.recreate(root); } catch (error) { rejected = error; }
    replacement?.close();
    expect(fs.readFileSync(dbPath()).equals(before)).toBe(true);
    expect(String(rejected)).toMatch(/preserving existing index|independent.*candidate/i);
    const reopened = CodeGraph.openSync(root);
    try { expect(reopened.searchNodes('original').length).toBeGreaterThan(0); } finally { reopened.close(); }
  });

  it.each(['populated', 'foreign', 'empty', 'symlink'] as const)('refuses CLI index for a %s artifact before daemon or schema work', artifact => {
    if (artifact === 'foreign') fs.writeFileSync(dbPath(), 'preserve foreign database bytes');
    if (artifact === 'empty') fs.truncateSync(dbPath());
    if (artifact === 'symlink') {
      const target = path.join(root, 'original.db');
      fs.renameSync(dbPath(), target);
      fs.symlinkSync(target, dbPath(), 'file');
    }
    const before = fs.readFileSync(dbPath());
    // A malformed daemon pidfile must not even be inspected/removed by refusal.
    const marker = path.join(root, '.codegraph', 'daemon.pid');
    fs.writeFileSync(marker, 'preserve daemon marker');
    const child = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.resolve(__dirname, '../dist/bin/codegraph.js'), 'index', root, '--quiet'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, timeout: 30_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/preserving existing index|independent.*candidate/i);
    expect(fs.readFileSync(dbPath()).equals(before)).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('preserve daemon marker');
  }, 60_000);

  it('can initialize an independent empty CODEGRAPH_DIR candidate without touching the old database', () => {
    const before = fs.readFileSync(dbPath());
    const child = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.resolve(__dirname, '../dist/bin/codegraph.js'), 'init', root, '--yes'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_DIR: '.codegraph-candidate', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_PROMPT_HOOK: '1' }, timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(fs.readFileSync(dbPath()).equals(before)).toBe(true);
    expect(fs.statSync(path.join(root, '.codegraph-candidate', 'codegraph.db')).size).toBeGreaterThan(0);
  }, 90_000);

  it.each(['-wal', '-shm', '-journal'])('preserves an orphaned %s artifact even without the main database', async suffix => {
    fs.rmSync(dbPath());
    const artifact = dbPath() + suffix;
    fs.writeFileSync(artifact, 'last-good recovery artifact');
    await expect(CodeGraph.recreate(root)).rejects.toThrow(/preserving existing index/);
    const child = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.resolve(__dirname, '../dist/bin/codegraph.js'), 'index', root, '--quiet'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, timeout: 30_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('preserving existing index');
    expect(fs.readFileSync(artifact, 'utf8')).toBe('last-good recovery artifact');
  }, 60_000);

  it.each(['EACCES', 'EPERM', 'EIO'])('refuses SDK rebuild when artifact existence cannot be confirmed (%s)', async code => {
    const before = fs.readFileSync(dbPath());
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const failure = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === dbPath()) throw Object.assign(new Error(`Injected ${code}`), { code });
      return (actual.lstatSync as any)(file, ...args);
    }) as typeof fs.lstatSync);
    await expect(CodeGraph.recreate(root)).rejects.toThrow(/state cannot be confirmed/);
    failure.mockRestore();
    expect(fs.readFileSync(dbPath()).equals(before)).toBe(true);
  });
});
