import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { DatabaseConnection, getDatabasePath } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { ContextBuilder } from '../src/context';
import { QueryBuilder } from '../src/db/queries';
import { GraphTraverser } from '../src/graph';

describe('large-index explore query limits', () => {
  let root: string;
  let cg: CodeGraph;
  let connection: DatabaseConnection;
  let builder: ContextBuilder;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-large-query-'));
    fs.writeFileSync(path.join(root, 'exact.ts'), 'export function stableCaptureProbe() { return 41; }\n');
    fs.writeFileSync(path.join(root, 'broad.ts'),
      '/** Holographic capture metadata. */\nexport function unrelatedLoader() { return 0; }\n');
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    connection = DatabaseConnection.open(getDatabasePath(root));
    const queries = new QueryBuilder(connection.getDb());
    builder = new ContextBuilder(root, queries, new GraphTraverser(queries));
  }, 120_000);

  afterAll(() => {
    connection?.close();
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function padFilesTo(count: number): void {
    // Real SQLite file records exercise the production stats threshold without
    // parsing a hundred thousand identical source files.
    const db = connection.getDb();
    db.exec("DELETE FROM files WHERE path LIKE 'fixture-padding/%'");
    db.prepare(`
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count)
      SELECT 'fixture-padding/' || n || '.ts', 'fixture', 'typescript', 0, 0, 0, 0 FROM numbers
    `).run(count - 2);
    expect(cg.getStats().fileCount).toBe(count);
  }

  it('can skip broad searches while preserving exact-symbol lookup', async () => {
    const options = {
      maxTextSearchTerms: 0,
      enableDefinitionPrefixSearch: false,
      enableSubstringSearch: false,
      enableDominantFileBoost: false,
      traversalDepth: 0,
    };
    expect((await builder.findRelevantContext('holographic')).nodes.size).toBeGreaterThan(0);
    expect((await builder.findRelevantContext('holographic', options)).nodes.size).toBe(0);
    const exact = await builder.findRelevantContext('stableCaptureProbe holographic', options);
    expect([...exact.nodes.values()].map((n) => n.name)).toContain('stableCaptureProbe');
    expect([...exact.nodes.values()].map((n) => n.name)).not.toContain('unrelatedLoader');
  });

  it('keeps ordinary broad text matches below the huge-index threshold', async () => {
    padFilesTo(99_999);
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'stableCaptureProbe holographic', maxFiles: 20,
    });
    expect(result.content[0]!.text).toContain('**`broad.ts`**');
  });

  it('skips broad text matches at one hundred thousand files and retains exact code', async () => {
    padFilesTo(100_000);
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'stableCaptureProbe holographic', maxFiles: 20,
    });
    expect(result.content[0]!.text).toContain('**`exact.ts`**');
    expect(result.content[0]!.text).not.toContain('**`broad.ts`**');
  });

  it('explains the limited searches when a huge-index query has no exact match', async () => {
    padFilesTo(100_000);
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'holographic' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('No relevant code found');
    expect(result.content[0]!.text).toContain('searches are skipped for this large index');
    expect(result.content[0]!.text).not.toContain('docstrings (FTS prefixes)');
  });
});
