#!/usr/bin/env node
/**
 * Remove only persisted C++ value references the existing lexical guard proves local.
 * Work on an existing SQLite backup, never the default or another live index:
 * CODEGRAPH_DIR=.codegraph-repair-<id> node scripts/repair-cpp-local-references.cjs <project-root> [--batch-size 250]
 * No extraction, pending sweep, synthesis, schema upgrade, or graph promotion.
 * One outer transaction makes a failed source check roll back the whole repair.
 */
const fs = require('node:fs');
const path = require('node:path');

function failure(code, message) {
  return Object.assign(new Error(message), { code, verified: false });
}

function counts() {
  return { filesVerified: 0, scannedEdges: 0, unchangedEdges: 0, changedTuples: 0, removedEdges: 0, failedReferences: 0 };
}

function candidatePath(projectRoot) {
  const name = process.env.CODEGRAPH_DIR?.trim();
  if (!name || !/^\.codegraph-repair-[A-Za-z0-9_-]+$/.test(name)) {
    throw failure('CANDIDATE_REQUIRED', 'Explicit CODEGRAPH_DIR=.codegraph-repair-<id> is required; default/live indexes are refused');
  }
  const dir = path.join(projectRoot, name);
  const dbPath = path.join(dir, 'codegraph.db');
  if (!fs.existsSync(dir) || !fs.existsSync(dbPath)) throw failure('NOT_INITIALIZED', 'An existing initialized candidate index is required');
  if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(dbPath).isSymbolicLink()) {
    throw failure('CANDIDATE_ALIAS', 'Candidate directory/database aliases are refused');
  }
  const stat = fs.statSync(dbPath);
  if (!stat.isFile() || stat.size === 0 || stat.nlink !== 1) throw failure('CANDIDATE_ALIAS', 'Candidate must be a standalone database file');
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar) && (fs.lstatSync(sidecar).isSymbolicLink() || fs.statSync(sidecar).nlink !== 1)) {
      throw failure('CANDIDATE_ALIAS', 'Candidate database sidecar aliases are refused');
    }
  }
  const original = path.join(projectRoot, '.codegraph', 'codegraph.db');
  if (fs.existsSync(original)) {
    const other = fs.statSync(original);
    if (fs.realpathSync.native(original) === fs.realpathSync.native(dbPath) ||
        (stat.ino !== 0 && stat.ino === other.ino && stat.dev === other.dev)) {
      throw failure('CANDIDATE_ALIAS', 'Candidate must not alias the default index');
    }
  }
  return { dir, dbPath };
}

const tuple = (ref) => JSON.stringify([ref.fromNodeId, ref.referenceName, ref.referenceKind, ref.line, ref.column]);
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
const MAX_TUPLE_ROWS = 10_000;

function repairCppLocalReferences(options = {}) {
  const report = counts();
  let connection;
  let lock;
  try {
    if (typeof options.projectRoot !== 'string' || !options.projectRoot) throw failure('PROJECT_REQUIRED', 'Explicit project root is required');
    const projectRoot = fs.realpathSync.native(path.resolve(options.projectRoot));
    const batchSize = options.batchSize ?? 250;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw failure('INVALID_BATCH_SIZE', 'Batch size must be an integer from 1 to 2000');
    const candidate = candidatePath(projectRoot);
    const { DatabaseConnection } = require('../dist/db');
    const { QueryBuilder } = require('../dist/db/queries');
    const { ReferenceResolver } = require('../dist/resolution');
    const { resurrectRefFromDroppedEdge } = require('../dist/resolution/resurrect-ref');
    const { clearNameMatcherMemos, isCppLocalValueRef } = require('../dist/resolution/name-matcher');
    if (typeof isCppLocalValueRef !== 'function') throw failure('LOCAL_GUARD_UNAVAILABLE', 'Built runtime must provide the internal C++ lexical guard');
    const { hashContent } = require('../dist/extraction');
    const { isInitialized } = require('../dist/directory');
    const { FileLock } = require('../dist/utils');
    const { getCurrentVersion, CURRENT_SCHEMA_VERSION } = require('../dist/db/migrations');
    if (!isInitialized(projectRoot)) throw failure('NOT_INITIALIZED', 'An existing initialized candidate index is required');
    lock = new FileLock(path.join(candidate.dir, 'codegraph.lock'));
    lock.acquire();
    const readOnly = DatabaseConnection.open(candidate.dbPath, { readOnly: true });
    try {
      const db = readOnly.getDb();
      if (getCurrentVersion(db) !== CURRENT_SCHEMA_VERSION) throw failure('SCHEMA_MISMATCH', 'Candidate schema must already match the built runtime; no migrations are performed');
      if (!db.prepare('SELECT 1 FROM files LIMIT 1').get() || !db.prepare('SELECT 1 FROM nodes LIMIT 1').get()) {
        throw failure('NOT_INDEXED', 'An existing populated candidate index is required');
      }
    } finally { readOnly.close(); }

    connection = DatabaseConnection.open(candidate.dbPath);
    const db = connection.getDb();
    const queries = new QueryBuilder(db);
    // The guard only needs caller nodes and local source text. Do not initialize
    // frameworks, resolve globals/imports, or warm the graph's full name sets.
    const context = new ReferenceResolver(projectRoot, queries).getResolutionContext();
    const metadata = "(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END)";
    const name = `json_extract(${metadata}, '$.refName')`;
    const eligible = `src.language = 'cpp' AND src.kind IN ('method', 'function')
      AND e.kind = 'references' AND COALESCE(e.provenance, '') != 'heuristic'
      AND json_extract(${metadata}, '$.resolvedBy') IN ('exact-match', 'qualified-name', 'fuzzy', 'instance-method')
      AND COALESCE(json_extract(${metadata}, '$.refKind'), 'references') = 'references'
      AND json_type(${metadata}, '$.framework') IS NULL
      AND json_type(${metadata}, '$.fnRef') IS NULL
      AND json_type(${metadata}, '$.synthesizedBy') IS NULL
      AND json_type(${metadata}, '$.refName') = 'text'
      AND substr(${name}, 1, 1) GLOB '[A-Za-z_]' AND ${name} NOT GLOB '*[^A-Za-z0-9_]*'`;
    const join = 'FROM edges e JOIN nodes src ON src.id = e.source';
    const edgeLimit = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM edges').get().id;
    const files = db.prepare(`SELECT DISTINCT src.file_path AS file_path ${join} WHERE ${eligible} AND e.id <= ? ORDER BY src.file_path`).all(edgeLimit);
    const page = db.prepare(`SELECT e.*, src.file_path AS source_file_path, src.language AS source_language
      FROM nodes src CROSS JOIN edges e ON e.source = src.id
      WHERE ${eligible} AND src.file_path = ? AND e.id > ? AND e.id <= ? ORDER BY e.id LIMIT ?`);
    const sameTuple = db.prepare(`SELECT e.id, e.target ${join} WHERE ${eligible}
      AND e.source = ? AND ${name} = ? AND e.line = ? AND e.col = ? AND e.id <= ? ORDER BY e.id LIMIT ?`);
    const existingRefs = db.prepare(`SELECT id FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ?
      AND reference_kind = 'references' AND line = ? AND col = ? ORDER BY id LIMIT ?`);
    const refState = db.prepare('SELECT status FROM unresolved_refs WHERE id = ?');
    const verifiedFiles = new Map();

    function verifySource(filePath, expected) {
      const tracked = queries.getFileByPath(filePath);
      if (!tracked || tracked.language !== 'cpp') throw failure('SOURCE_RECORD_MISSING', 'Tracked C++ source record is missing');
      const full = path.resolve(projectRoot, filePath);
      const relative = path.relative(projectRoot, full);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure('SOURCE_PATH_INVALID', 'Source path must stay within the project');
      let before, after, source;
      try {
        before = fs.statSync(full);
        source = fs.readFileSync(full, 'utf8');
        after = fs.statSync(full);
      } catch { throw failure('SOURCE_UNAVAILABLE', 'Indexed source is missing or unreadable'); }
      if (!before.isFile() || stamp(before) !== stamp(after) || (expected !== undefined && expected !== stamp(after))) {
        throw failure('SOURCE_CHANGED', 'Source changed during repair');
      }
      if (after.size !== tracked.size || hashContent(source) !== tracked.contentHash) throw failure('SOURCE_HASH_MISMATCH', 'Source hash does not match the indexed file');
      return { source, stamp: stamp(after) };
    }

    function validatePosition(ref, lines) {
      const line = lines[ref.line - 1];
      const matches = (at) => line !== undefined && line.slice(at).startsWith(ref.referenceName) && !/\w/.test(line[at + ref.referenceName.length] ?? '');
      if (ref.line < 1 || ref.column < 0) throw failure('REFERENCE_POSITION_INVALID', 'Reference source position is invalid');
      if (matches(ref.column)) return;
      const prefix = line === undefined ? '' : Buffer.from(line, 'utf8').subarray(0, ref.column).toString('utf8');
      if (Buffer.byteLength(prefix) === ref.column && matches(prefix.length)) return;
      throw failure('REFERENCE_POSITION_INVALID', 'Reference source position does not match the indexed name');
    }

    function persistChanges(changes) {
      const edgeIds = [...new Set(changes.flatMap((c) => c.edgeIds))];
      const refs = [];
      const rowIds = [];
      const wanted = new Map();
      for (const change of changes) {
        wanted.set(tuple(change.ref), change);
        const existing = existingRefs.all(change.ref.fromNodeId, change.ref.referenceName, change.ref.line, change.ref.column, MAX_TUPLE_ROWS + 1);
        if (existing.length > MAX_TUPLE_ROWS) throw failure('TUPLE_TOO_LARGE', 'Reference tuple exceeds the bounded repair limit');
        if (existing.length) rowIds.push(...existing.map((r) => r.id));
        else refs.push(change.ref);
        if (rowIds.length + refs.length > MAX_TUPLE_ROWS) throw failure('BATCH_TOO_LARGE', 'Reference batch exceeds the bounded repair limit; reduce batch size');
      }
      const beforeId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM unresolved_refs').get().id;
      const removed = queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
      if (removed !== edgeIds.length) throw failure('CANDIDATE_CHANGED', 'Candidate edges changed during repair');
      const inserted = db.prepare('SELECT id FROM unresolved_refs WHERE id > ? ORDER BY id').all(beforeId);
      if (inserted.length !== refs.length) throw failure('CANDIDATE_CHANGED', 'Candidate reference queue changed during repair');
      rowIds.push(...inserted.map((r) => r.id));
      const selected = queries.getUnresolvedReferencesByIds(rowIds).map((ref) => {
        const change = wanted.get(tuple(ref));
        if (!change) throw failure('REFERENCE_TUPLE_MISMATCH', 'Inserted reference tuple does not match the selected repair');
        return ref;
      });
      if (selected.length !== rowIds.length) throw failure('REFERENCE_TUPLE_MISMATCH', 'Selected reference row is missing');
      // These exact tuples already have a local-binding proof. Park by row id
      // without asking the global resolver to make any other graph decisions.
      const marked = queries.markReferencesFailedByRowIds(selected.map((ref) => ({
        rowId: ref.rowId, referenceName: ref.referenceName, referenceKind: ref.referenceKind,
      })));
      if (marked !== selected.length) throw failure('REFERENCE_TUPLE_MISMATCH', 'Selected reference row did not settle completely');
      for (const ref of selected) {
        if (refState.get(ref.rowId)?.status !== 'failed') throw failure('REFERENCE_NOT_PARKED', 'Selected local reference did not settle as failed');
      }
      report.removedEdges += removed;
      report.failedReferences += selected.length;
    }

    queries.runInTransaction(() => {
      for (const file of files) {
        const captured = verifySource(file.file_path);
        const lines = captured.source.split(/\r?\n/);
        const seen = new Set();
        let lastId = 0;
        for (;;) {
          const rows = page.all(file.file_path, lastId, edgeLimit, batchSize);
          if (!rows.length) break;
          lastId = rows[rows.length - 1].id;
          const changes = [];
          for (const row of rows) {
            const edge = { source: row.source, target: row.target, kind: row.kind, line: row.line, column: row.col,
              metadata: JSON.parse(row.metadata), sourceFilePath: row.source_file_path, sourceLanguage: row.source_language };
            const ref = resurrectRefFromDroppedEdge(edge);
            if (!ref) throw failure('REFERENCE_STAMP_MISSING', 'Original reference metadata is missing');
            const key = tuple(ref);
            if (seen.has(key)) continue;
            validatePosition(ref, lines);
            if (!isCppLocalValueRef(ref, context)) {
              report.scannedEdges++;
              report.unchangedEdges++;
              continue;
            }
            seen.add(key);
            const siblings = sameTuple.all(ref.fromNodeId, ref.referenceName, ref.line, ref.column, edgeLimit, MAX_TUPLE_ROWS + 1);
            if (siblings.length > MAX_TUPLE_ROWS) throw failure('TUPLE_TOO_LARGE', 'Edge tuple exceeds the bounded repair limit');
            report.scannedEdges += siblings.length;
            report.changedTuples++;
            changes.push({ ref, edgeIds: siblings.map((e) => e.id) });
            if (changes.reduce((total, change) => total + change.edgeIds.length, 0) > MAX_TUPLE_ROWS) {
              throw failure('BATCH_TOO_LARGE', 'Edge batch exceeds the bounded repair limit; reduce batch size');
            }
          }
          options.onProgress?.({ filesVerified: report.filesVerified, scannedEdges: report.scannedEdges, changedTuples: report.changedTuples,
            stagedRemovedEdges: report.removedEdges, stagedFailedReferences: report.failedReferences });
          verifySource(file.file_path, captured.stamp);
          if (changes.length) persistChanges(changes);
        }
        verifySource(file.file_path, captured.stamp);
        verifiedFiles.set(file.file_path, captured.stamp);
        report.filesVerified++;
        clearNameMatcherMemos(context);
      }
      // Recheck earlier files before the single commit, so a late edit rolls everything back.
      for (const [filePath, expected] of verifiedFiles) verifySource(filePath, expected);
    });
    return { verified: true, ...report };
  } catch (error) {
    error.verified = false;
    error.counts = { ...report, removedEdges: 0, failedReferences: 0 };
    throw error;
  } finally {
    try { connection?.close(); }
    finally { lock?.release(); }
  }
}

module.exports = { repairCppLocalReferences };

if (require.main === module) {
  try {
    const [projectRoot, flag, value, ...extra] = process.argv.slice(2);
    if (extra.length || (flag !== undefined && (flag !== '--batch-size' || value === undefined))) throw failure('INVALID_ARGUMENTS', 'Expected <project-root> [--batch-size N]');
    const result = repairCppLocalReferences({ projectRoot, batchSize: value === undefined ? undefined : Number(value),
      onProgress: (progress) => console.log(`[repair-cpp-local-references] progress ${JSON.stringify(progress)}`) });
    const { verified, ...summary } = result;
    console.log(`[repair-cpp-local-references] verified ${JSON.stringify(summary)}`);
  } catch (error) {
    console.error(`[repair-cpp-local-references] unverified ${JSON.stringify(error.counts ?? counts())} reason=${error.code ?? 'REPAIR_FAILED'}`);
    process.exitCode = 1;
  }
}
