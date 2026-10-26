import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { createDirectory } from '../src/directory';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

describe('initialization preserves unknown and recovery artifacts', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-preserve-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    fs.writeFileSync(path.join(root, 'tiny.py'), 'def tiny():\n    return 1\n');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['empty', 'foreign', '-wal', '-shm', '-journal'] as const)(
    'rejects async init, sync init and directory creation for %s without rewriting bytes', async kind => {
      const artifact = path.join(root, '.codegraph', 'codegraph.db' + (kind.startsWith('-') ? kind : ''));
      const before = Buffer.from(kind === 'empty' ? '' : 'preserve existing index recovery bytes');
      fs.writeFileSync(artifact, before);
      let opened: CodeGraph | undefined;
      let failure: unknown;
      try { opened = await CodeGraph.init(root); } catch (error) { failure = error; }
      opened?.close();
      expect(String(failure)).toMatch(/preserving existing index/i);
      expect(fs.readFileSync(artifact)).toEqual(before);
      expect(() => CodeGraph.initSync(root)).toThrow(/preserving existing index/i);
      expect(() => createDirectory(root)).toThrow(/preserving existing index/i);
      expect(fs.readFileSync(artifact)).toEqual(before);
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])('rejects uncertain artifact existence before writing (%s)', async code => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const dbPath = path.join(root, '.codegraph', 'codegraph.db');
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === dbPath) throw Object.assign(new Error('injected I/O failure'), { code });
      return (actual.lstatSync as any)(file, ...args);
    }) as typeof fs.lstatSync);
    let opened: CodeGraph | undefined;
    let failure: unknown;
    try { opened = await CodeGraph.init(root); } catch (error) { failure = error; }
    opened?.close();
    expect(String(failure)).toMatch(/state cannot be confirmed/i);
    expect(() => CodeGraph.initSync(root)).toThrow(/state cannot be confirmed/i);
    expect(fs.readdirSync(path.join(root, '.codegraph'))).toEqual([]);
  });

  it.each(['empty', '-wal', '-shm', '-journal'] as const)('CLI init preserves a %s artifact', kind => {
    const artifact = path.join(root, '.codegraph', 'codegraph.db' + (kind.startsWith('-') ? kind : ''));
    const before = kind === 'empty' ? '' : 'preserve orphaned recovery artifact';
    fs.writeFileSync(artifact, before);
    const result = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.resolve(__dirname, '../dist/bin/codegraph.js'), 'init', root, '--yes'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/preserving existing index/i);
    expect(fs.readFileSync(artifact, 'utf8')).toBe(before);
  }, 40_000);
});
