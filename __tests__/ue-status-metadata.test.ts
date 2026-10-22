import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { CodeGraph } from '../src';

const BIN = path.resolve('dist/bin/codegraph.js');

describe('metadata-only CLI status', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-metadata-status-'));
  });

  afterEach(() => {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^codegraph-metadata-status-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function run(...arguments_: string[]) {
    return execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, ...arguments_], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    });
  }

  function status(metadataOnly = false) {
    const output = run('status', root, '--json', ...(metadataOnly ? ['--metadata-only'] : []));
    return JSON.parse(output.trim().split(/\r?\n/).pop()!);
  }

  it('advertises the opt-in capability without requiring a project index', () => {
    expect(run('status', '--help')).toMatch(/^\s+--metadata-only\s+/m);
  });

  it('does not turn an unchecked uninitialized worktree into a freshness claim', () => {
    const observation = status(true);
    expect(observation.initialized).toBe(false);
    expect(observation.pendingChanges).toBeNull();
    expect(observation.workingTreeChecked).toBe(false);
    expect(observation.freshness).toBe('unknown');
    expect(fs.existsSync(path.join(root, '.codegraph/codegraph.db'))).toBe(false);
  });

  async function indexedFixture(mtimeSeconds?: number) {
    fs.writeFileSync(path.join(root, 'example.ts'), 'export function before() { return 1; }\n');
    if (mtimeSeconds !== undefined) fs.utimesSync(path.join(root, 'example.ts'), mtimeSeconds, mtimeSeconds);
    const graph = CodeGraph.initSync(root);
    try { await graph.indexAll(); } finally { graph.destroy(); }
  }

  it('reads initialized metadata without claiming a worktree check or changing the database', async () => {
    await indexedFixture();
    const db = path.join(root, '.codegraph/codegraph.db');
    const hash = () => createHash('sha256').update(fs.readFileSync(db)).digest('hex');
    const before = hash();
    fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = true;\n');
    const observation = status(true);
    expect(observation).toMatchObject({ initialized: true, workingTreeChecked: false, freshness: 'unknown', pendingChanges: null });
    expect(observation.index.filesNeedingReindex).toBeNull();
    expect(observation.index.filesWithParseErrors).toBeNull();
    expect(observation.cppIncludeEnvironment).toBeNull();
    expect(hash()).toBe(before);
    expect(status().pendingChanges.added).toBe(1);
    expect(status().cppIncludeEnvironment).toMatchObject({ observed: true, complete: true, changed: false, affectedFileCount: 0 });
    const human = run('status', root, '--metadata-only');
    expect(human).toContain('Working tree was not checked');
    expect(human).not.toContain('Index is up to date');
  }, 30_000);

  it('retains invalid-config, extraction-version and pending-reference gates in metadata', async () => {
    await indexedFixture();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'));
    try {
      db.prepare("UPDATE project_metadata SET value = '0' WHERE key = 'indexed_with_extraction_version'").run();
      db.prepare("INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col) SELECT id, 'PendingTarget', 'call', 1, 0 FROM nodes LIMIT 1").run();
    } finally { db.close(); }
    const observation = status(true);
    expect(observation.index.reindexRecommended).toBe(true);
    expect(observation.index.pendingRefs).toBe(1);
    expect(observation.freshness).toBe('unknown');
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), '{');
    const invalid = status(true);
    expect(invalid.initialized).toBe(true);
    expect(invalid.indexingConfig.error).toContain('invalid JSON');
    expect(invalid.workingTreeChecked).toBe(false);
  }, 30_000);

  it('never certifies a same-size edit with identical mtime when SDK stat caching leaves it unsynced', async () => {
    await indexedFixture(1_700_000_000);
    const file = path.join(root, 'example.ts');
    const before = fs.statSync(file);
    fs.writeFileSync(file, 'export function after_() { return 2; }\n');
    fs.utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    const changed = fs.statSync(file);
    expect(changed.size).toBe(before.size);
    expect(Math.floor(changed.mtimeMs)).toBe(Math.floor(before.mtimeMs));
    expect(status(true).freshness).toBe('unknown');
    expect(status().pendingChanges.modified).toBe(1);
    run('sync', root, '--quiet');
    expect(status().pendingChanges.modified).toBe(1);
    const graph = await CodeGraph.open(root, { readOnly: true, sync: false });
    try {
      expect(graph.searchNodes('after_')).toHaveLength(0);
      expect(graph.searchNodes('before').some(result => result.node.name === 'before')).toBe(true);
    } finally { graph.destroy(); }
  }, 30_000);
});
