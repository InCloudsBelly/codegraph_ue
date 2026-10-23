import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase } from '../src/db/sqlite-adapter';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

// The production detector deliberately declines inode tracking on Windows.
// Exercise its POSIX path on every host using real, distinct filesystem IDs;
// database connections, SQL, recovery, and persisted files are never mocked.
vi.mock('../src/directory', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/directory')>();
  const io = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, statInode(file: string) {
    try { const stat = io.statSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; }
    catch { return null; }
  } };
});

describe('discovery failure before following a replaced database', () => {
  let root: string;
  let cg: CodeGraph;
  const persisted = () => {
    const { db } = createDatabase(getDatabasePath(root), { readOnly: true });
    try {
      return {
        schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        ...Object.fromEntries(['files', 'nodes', 'edges', 'project_metadata'].map(table =>
          [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])),
      };
    } finally { db.close(); }
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-replaced-scan-'));
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'target.ts'), 'export function original() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();

    // Keep a real connection to the old physical file while its logical path
    // points to a replacement. The bounded path seam avoids unlinking an open
    // SQLite file, which Windows does not support, and reproduces a stale fd.
    cg.close();
    const livePath = getDatabasePath(root);
    const stalePath = path.join(path.dirname(livePath), 'held-original.db');
    fs.renameSync(livePath, stalePath);
    const stale = DatabaseConnection.open(stalePath);
    (stale as any).dbPath = livePath;
    (cg as any).db = stale;
    (cg as any).queries = new QueryBuilder(stale.getDb());
    (cg as any).wireLayers();

    const replacement = CodeGraph.initSync(root);
    await replacement.indexAll();
    const replacementDb = (replacement as any).db as DatabaseConnection;
    replacementDb.beginBulkNodeLoad();
    replacementDb.getDb().exec('DROP INDEX idx_nodes_kind');
    replacement.close();
    expect((cg as any).db.isReplacedOnDisk()).toBe(true);
  });
  afterEach(() => { vi.restoreAllMocks(); cg?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('does not migrate or repair the replacement until the full scan succeeds', async () => {
    const before = persisted();
    fs.writeFileSync(path.join(root, 'added.ts'), 'export function afterRecovery() { return 2; }\n');
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const failure = vi.spyOn(fs, 'readdirSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === path.join(root, 'nested')) throw Object.assign(new Error('Injected replacement scan EIO'), { code: 'EIO' });
      return (actual.readdirSync as any)(file, ...args);
    }) as typeof fs.readdirSync);
    await expect(cg.sync({ paths: ['added.ts'] })).rejects.toThrow(/EIO/);
    failure.mockRestore();
    expect(persisted()).toEqual(before);
    await cg.sync({ paths: ['added.ts'] });
    expect(cg.searchNodes('afterRecovery').length).toBeGreaterThan(0);
    expect(persisted().schema.some((row: any) => row.name === 'nodes_ai')).toBe(true);
    expect(persisted().schema.some((row: any) => row.name === 'idx_nodes_kind')).toBe(true);
  }, 60_000);
});
