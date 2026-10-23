import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph, DatabaseConnection, QueryBuilder } from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const { repairCppLocalReferences } = require('../scripts/repair-cpp-local-references.cjs');
const candidateDir = '.codegraph-repair-test';
const roots: string[] = [];
const originalDir = process.env.CODEGRAPH_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalDir === undefined) delete process.env.CODEGRAPH_DIR;
  else process.env.CODEGRAPH_DIR = originalDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(keepFailed = false, additionalFiles: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repair-cpp-'));
  roots.push(root);
  process.env.CODEGRAPH_DIR = candidateDir;
  const source = [
    'struct Expr { int OutputIndex; void* Expression; };',
    'Expr Stable;',
    'enum class EPCGMetadataMathOperation { Product };',
    'class ICreatedMaterial { public: int B() const { return 0; } };',
    'Expr Box(int value) { return {}; }',
    'class Arithmetic {',
    ' public:',
    '  Expr Sub(float A, Expr B) {',
    '    Expr Product;',
    '    Product.OutputIndex = A;',
    '    return Box(B.OutputIndex);',
    '  }',
    '  int Genuine() { return Stable.OutputIndex; }',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'material.cpp'), source);
  for (const [file, content] of Object.entries(additionalFiles)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();
  const dbPath = path.join(root, candidateDir, 'codegraph.db');
  const db = DatabaseConnection.open(dbPath);
  const q = new QueryBuilder(db.getDb());
  const sub = q.getNodesByQualifiedNameExact('Arithmetic::Sub')[0]!;
  const product = q.getNodesByQualifiedNameExact('EPCGMetadataMathOperation::Product')[0]!;
  const b = q.getNodesByQualifiedNameExact('ICreatedMaterial::B')[0]!;
  const bogus = [
    { source: sub.id, target: product.id, kind: 'references' as const, line: 10, column: 4, metadata: { refName: 'Product', resolvedBy: 'exact-match', confidence: 0.7 } },
    { source: sub.id, target: b.id, kind: 'references' as const, line: 11, column: 15, metadata: { refName: 'B', resolvedBy: 'exact-match', confidence: 0.7 } },
  ];
  q.insertEdges([
    ...bogus,
    { ...bogus[1]!, column: 30, metadata: { refName: 'B', refKind: 'function_ref', resolvedBy: 'function-ref', fnRef: true } },
    { ...bogus[1]!, column: 31, provenance: 'heuristic', metadata: { refName: 'B', resolvedBy: 'exact-match', synthesizedBy: 'fixture' } },
    { ...bogus[1]!, column: 32, metadata: { refName: 'B', resolvedBy: 'exact-match', framework: 'fixture' } },
    { ...bogus[1]!, column: 33, metadata: { refName: 'B', resolvedBy: 'import' } },
  ]);
  // The old resolver consumed these rows when it incorrectly created the edges.
  if (!keepFailed) db.getDb().prepare("DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_kind = 'references' AND reference_name IN ('Product', 'B') AND line IN (10, 11)").run(sub.id);
  q.insertUnresolvedRef({ fromNodeId: sub.id, referenceName: 'B', referenceKind: 'references', line: 100, column: 4, filePath: 'material.cpp', language: 'cpp' });
  const before = db.getDb().prepare('SELECT * FROM edges ORDER BY id').all();
  const bogusIds = before.filter((e: any) => e.source === sub.id && ((e.line === 10 && e.col === 4) || (e.line === 11 && e.col === 15))).map((e: any) => e.id);
  const pendingBefore = db.getDb().prepare('SELECT * FROM unresolved_refs ORDER BY id').all();
  const nodesBefore = db.getDb().prepare('SELECT * FROM nodes ORDER BY id').all();
  const filesBefore = db.getDb().prepare('SELECT * FROM files ORDER BY path').all();
  db.close();
  fs.mkdirSync(path.join(root, '.codegraph'));
  fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), 'untouched default index');
  return { root, source, dbPath, before, bogusIds, pendingBefore, nodesBefore, filesBefore };
}

function rows(dbPath: string, sql: string): any[] {
  const db = DatabaseConnection.open(dbPath, { readOnly: true });
  try { return db.getDb().prepare(sql).all(); }
  finally { db.close(); }
}

describe('candidate-only repair of persisted C++ local references', () => {
  it('uses the lexical guard without initializing, warming or resolving the whole graph', async () => {
    const f = await fixture();
    const { ReferenceResolver } = require('../dist/resolution');
    const forbidden = ['initialize', 'warmCaches', 'resolveNow', 'resolveAndPersist']
      .map((method) => vi.spyOn(ReferenceResolver.prototype, method));
    expect(repairCppLocalReferences({ projectRoot: f.root, batchSize: 1 }).removedEdges).toBe(2);
    for (const method of forbidden) expect(method).not.toHaveBeenCalled();
  });

  it('preserves cross-module included anonymous/static values in a fresh UE CLI process', async () => {
    const rules = (module: string, body = '') => `using UnrealBuildTool; public class ${module} : ModuleRules { public ${module}(ReadOnlyTargetRules Target) : base(Target) { ${body} } }`;
    const use = 'Plugins/Main/Source/Main/Private/use.cpp';
    const included = 'Source/Shared/Public/Chosen.cpp';
    const f = await fixture(false, {
      'Plugins/Main/Main.uplugin': JSON.stringify({ Modules: [{ Name: 'Main' }] }),
      'Plugins/Main/Source/Main/Main.Build.cs': rules('Main', 'PublicDependencyModuleNames.Add("Shared");'),
      'Source/Shared/Shared.Build.cs': rules('Shared'),
      'Source/Unrelated/Unrelated.Build.cs': rules('Unrelated'),
      [use]: '#include <Chosen.cpp>\nint UseIncludedState() { return SharedState.Value + StaticState.Value; }\n',
      [included]: 'struct IncludedPayload { int Value; };\nnamespace { IncludedPayload SharedState; }\nstatic IncludedPayload StaticState;\n',
      'Source/Unrelated/Public/Chosen.cpp': 'struct OtherPayload { int Value; };\nnamespace { OtherPayload OtherState; }\n',
    });
    const positive = rows(f.dbPath, `SELECT e.*, target.file_path AS target_file_path FROM edges e JOIN nodes source ON source.id=e.source
      JOIN nodes target ON target.id=e.target WHERE source.name='UseIncludedState' AND e.kind='references' ORDER BY e.id`);
    expect(positive).toHaveLength(2);
    expect(positive.map((e: any) => e.target_file_path)).toEqual([included, included]);
    const run = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.join(__dirname, '..', 'scripts', 'repair-cpp-local-references.cjs'), f.root, '--batch-size', '1'], {
      encoding: 'utf8', env: { ...process.env, CODEGRAPH_DIR: candidateDir }, timeout: 30_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before.filter((e: any) => !f.bogusIds.includes(e.id)));
  });

  it('repairs through the real CLI in a fresh process, without inheriting loaded grammars', async () => {
    const f = await fixture();
    const run = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.join(__dirname, '..', 'scripts', 'repair-cpp-local-references.cjs'), f.root, '--batch-size', '1'], {
      encoding: 'utf8', env: { ...process.env, CODEGRAPH_DIR: candidateDir }, timeout: 30_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const final = run.stdout.trim().split(/\r?\n/).find((line) => line.includes('] verified '));
    expect(final).toBeDefined();
    expect(JSON.parse(final!.slice(final!.indexOf('{'))).removedEdges).toBe(2);
    expect(run.stdout).not.toContain(f.root);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before.filter((e: any) => !f.bogusIds.includes(e.id)));
  });

  it('repairs only changed reference tuples, preserves unrelated rows, and reruns without writes', async () => {
    const f = await fixture();
    const result = repairCppLocalReferences({ projectRoot: f.root, batchSize: 1 });
    expect(result.verified).toBe(true);
    expect(result.removedEdges).toBe(2);
    expect(result.failedReferences).toBe(2);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before.filter((e: any) => !f.bogusIds.includes(e.id)));
    expect(rows(f.dbPath, "SELECT * FROM unresolved_refs WHERE status='pending' ORDER BY id")).toEqual(f.pendingBefore.filter((r: any) => r.status === 'pending'));
    const refsAfterRepair = rows(f.dbPath, 'SELECT * FROM unresolved_refs ORDER BY id');
    expect(refsAfterRepair.filter((r: any) => f.pendingBefore.some((old: any) => old.id === r.id))).toEqual(f.pendingBefore);
    expect(refsAfterRepair.filter((r: any) => !f.pendingBefore.some((old: any) => old.id === r.id)).map((r: any) => r.status)).toEqual(['failed', 'failed']);
    expect(rows(f.dbPath, 'SELECT * FROM nodes ORDER BY id')).toEqual(f.nodesBefore);
    expect(rows(f.dbPath, 'SELECT * FROM files ORDER BY path')).toEqual(f.filesBefore);
    expect(fs.readFileSync(path.join(f.root, '.codegraph', 'codegraph.db'), 'utf8')).toBe('untouched default index');
    const refsAfter = rows(f.dbPath, 'SELECT * FROM unresolved_refs ORDER BY id');
    expect(repairCppLocalReferences({ projectRoot: f.root, batchSize: 1 }).removedEdges).toBe(0);
    expect(rows(f.dbPath, 'SELECT * FROM unresolved_refs ORDER BY id')).toEqual(refsAfter);
  });

  it('reuses existing exact failed tuples without adding duplicate queue rows', async () => {
    const f = await fixture(true);
    expect(repairCppLocalReferences({ projectRoot: f.root, batchSize: 1 }).removedEdges).toBe(2);
    expect(rows(f.dbPath, 'SELECT * FROM unresolved_refs ORDER BY id')).toEqual(f.pendingBefore);
  });

  it('rejects unset/default directories and uninitialized candidates', async () => {
    const f = await fixture();
    delete process.env.CODEGRAPH_DIR;
    expect(() => repairCppLocalReferences({ projectRoot: f.root })).toThrow(/CODEGRAPH_DIR/);
    process.env.CODEGRAPH_DIR = '.codegraph';
    expect(() => repairCppLocalReferences({ projectRoot: f.root })).toThrow(/CODEGRAPH_DIR/);
    process.env.CODEGRAPH_DIR = '.codegraph-repair-missing';
    expect(() => repairCppLocalReferences({ projectRoot: f.root })).toThrow(/initialized/i);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before);
  });

  it.each(['hash drift', 'missing source'])('rejects %s without changing the candidate graph', async (mode) => {
    const f = await fixture();
    if (mode === 'hash drift') fs.appendFileSync(path.join(f.root, 'material.cpp'), '// edited after indexing\n');
    else fs.unlinkSync(path.join(f.root, 'material.cpp'));
    expect(() => repairCppLocalReferences({ projectRoot: f.root })).toThrow(/hash|source/i);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before);
    expect(rows(f.dbPath, 'SELECT * FROM unresolved_refs ORDER BY id')).toEqual(f.pendingBefore);
  });

  it('detects edits during decision progress before committing the affected file', async () => {
    const f = await fixture();
    let edited = false;
    expect(() => repairCppLocalReferences({
      projectRoot: f.root,
      batchSize: 1,
      onProgress: (progress: { stagedRemovedEdges: number }) => {
        if (edited || progress.stagedRemovedEdges === 0) return;
        edited = true;
        fs.appendFileSync(path.join(f.root, 'material.cpp'), '// concurrent edit\n');
      },
    })).toThrow(/hash|source/i);
    expect(edited).toBe(true);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before);
    expect(rows(f.dbPath, 'SELECT * FROM unresolved_refs ORDER BY id')).toEqual(f.pendingBefore);
  });

  it('rejects a hard-linked database instead of modifying another index through it', async () => {
    const f = await fixture();
    fs.linkSync(f.dbPath, path.join(f.root, 'db-hardlink'));
    expect(() => repairCppLocalReferences({ projectRoot: f.root })).toThrow(/standalone|alias/i);
    expect(rows(f.dbPath, 'SELECT * FROM edges ORDER BY id')).toEqual(f.before);
  });
});
