'use strict';

// Explicit, recoverable publication of an already validated candidate. This
// module never opens SQLite, initializes an index, or runs an indexer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES = new Set(['prepared', 'marker-written', 'old-move-intent', 'old-preserved',
  'candidate-move-intent', 'candidate-promoted', 'committed',
  'rollback-candidate-intent', 'rollback-old-intent', 'rolled-back']);

function assertConsumerRecords(records, selfPid = process.pid) {
  for (const item of records) {
    if (!/^(node|codegraph)(\.exe)?$/i.test(item.Name || '') || Number(item.ProcessId) === selfPid) continue;
    if (typeof item.CommandLine !== 'string' || !item.CommandLine.trim()) {
      throw new Error(`Cannot determine whether process ${item.ProcessId} is a CodeGraph consumer; publication refused.`);
    }
    if (/codegraph/i.test(item.CommandLine)) throw new Error(`CodeGraph consumer ${item.ProcessId} is still running; publication refused.`);
  }
}

function assertNoGraphConsumers() {
  if (process.platform !== 'win32') throw new Error('The consumer guard currently supports Windows only.');
  const script = "$ErrorActionPreference='Stop'; @([object[]](Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(node|codegraph)(\\.exe)?$' } | Select-Object Name,ProcessId,CommandLine)) | ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(output.trim());
  assertConsumerRecords(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
}

function basename(value) {
  if (typeof value !== 'string' || !/^\.codegraph(?:[-_a-zA-Z0-9.]*)$/.test(value) || value.includes('..') || value.endsWith('.')) {
    throw new Error('Publication directories must be distinct, plain .codegraph names.');
  }
  return value;
}
function lstat(file) {
  try { return fs.lstatSync(file, { bigint: true }); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function ordinaryRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) throw new Error('An exact absolute project root is required.');
  for (let current = root;; current = path.dirname(current)) {
    const stat = lstat(current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Non-ordinary project path: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
function fileBytes(file) {
  const stat = lstat(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error(`Expected an ordinary, unaliased file: ${file}`);
  return fs.readFileSync(file);
}
function parse(bytes) { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
function hash(bytes) { return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); }
function snapshot(directory) {
  const dir = lstat(directory);
  if (!dir) return null;
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error(`Non-ordinary index directory: ${directory}`);
  const db = lstat(path.join(directory, 'codegraph.db'));
  if (!db || !db.isFile() || db.isSymbolicLink() || db.nlink !== 1n || db.size === 0n) throw new Error(`Missing or non-ordinary database: ${directory}`);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = lstat(path.join(directory, 'codegraph.db' + suffix));
    if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1n || (suffix !== '-shm' && sidecar.size !== 0n))) {
      throw new Error(`Uncheckpointed or non-ordinary database sidecar: ${directory}${suffix}`);
    }
  }
  return { directoryDevice: String(dir.dev), directoryInode: String(dir.ino),
    device: String(db.dev), inode: String(db.ino), size: String(db.size), mtimeNs: String(db.mtimeNs) };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function assertSnapshot(directory, expected) {
  if (!same(snapshot(directory), expected)) throw new Error(`Database identity changed; preserving all directories: ${directory}`);
}
function checkedWrite(file, value, previous, onLinked) {
  if (previous !== undefined && !fileBytes(file).equals(previous)) throw new Error(`Publication record changed: ${file}`);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const temporary = file + '.tmp-' + crypto.randomUUID();
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (previous === undefined) {
    // A hard link publishes the complete record atomically without replacing an
    // existing record. Its temporary second link is removed before returning.
    fs.linkSync(temporary, file);
    onLinked?.();
    fs.unlinkSync(temporary);
  } else {
    if (!fileBytes(file).equals(previous)) throw new Error(`Publication record changed: ${file}`);
    fs.renameSync(temporary, file);
  }
  return bytes;
}
function recoveryRecord(file) {
  const stat = lstat(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || ![1n, 2n].includes(stat.nlink)) throw new Error(`Unknown publication record: ${file}`);
  let alias;
  if (stat.nlink === 2n) {
    const prefix = path.basename(file) + '.tmp-';
    const aliases = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(prefix) && UUID.test(name.slice(prefix.length)))
      .map(name => path.join(path.dirname(file), name)).filter(name => {
        const candidate = lstat(name);
        return candidate?.isFile() && !candidate.isSymbolicLink() && candidate.dev === stat.dev && candidate.ino === stat.ino;
      });
    if (aliases.length !== 1) throw new Error(`Unknown publication record aliases: ${file}`);
    alias = aliases[0];
  }
  return { file, stat, alias, bytes: fs.readFileSync(file) };
}
function retireRecordAlias(record) {
  const current = recoveryRecord(record.file);
  if (current.stat.dev !== record.stat.dev || current.stat.ino !== record.stat.ino ||
      current.alias !== record.alias || !current.bytes.equals(record.bytes)) throw new Error('Publication record changed while claiming recovery.');
  if (record.alias) fs.unlinkSync(record.alias);
  if (!fileBytes(record.file).equals(record.bytes)) throw new Error('Publication record changed after retiring its temporary alias.');
}
function removeOwnRecord(file, bytes) {
  if (!fileBytes(file).equals(bytes)) throw new Error(`Publication marker changed; preserving it: ${file}`);
  fs.unlinkSync(file);
}

function createPublicationService(directoryApi, consumerGuard = assertNoGraphConsumers) {
  function context(options, transactionId) {
    ordinaryRoot(options.projectRoot);
    const d = basename(options.indexDirectory || '.codegraph');
    if (!UUID.test(transactionId)) throw new Error('A valid transaction UUID is required.');
    const root = options.projectRoot;
    return { root, d, transactionId,
      formal: path.join(root, d), marker: path.join(root, d + '.publication.json'),
      lock: path.join(root, d + '.publication.lock'),
      journal: path.join(root, `${d}.publication.${transactionId}.journal.json`) };
  }
  function withDirectory(c, operation) {
    const before = process.env.CODEGRAPH_DIR;
    process.env.CODEGRAPH_DIR = c.d;
    try { return operation(); } finally {
      if (before === undefined) delete process.env.CODEGRAPH_DIR;
      else process.env.CODEGRAPH_DIR = before;
    }
  }
  function marker(c) { return { schemaVersion: 1, indexDirectory: c.d, transactionId: c.transactionId, state: 'pending' }; }
  function candidateContext(c, j) {
    return { ...c, d: j.candidateDirectory,
      marker: path.join(c.root, j.candidateDirectory + '.publication.json'),
      lock: path.join(c.root, j.candidateDirectory + '.publication.lock') };
  }
  function acquire(c, recovery = false) {
    return withDirectory(c, () => recovery ? claimRecoveryLease(c) :
      directoryApi.acquireIndexPublicationLease(c.root, 'publication', c.transactionId));
  }
  function paths(c, j) {
    if (j.schemaVersion !== 1 || j.kind !== 'codegraph-index-publication' || j.projectRoot !== c.root ||
        j.transactionId !== c.transactionId || j.indexDirectory !== c.d || !PHASES.has(j.phase)) throw new Error('Unknown publication journal; no directories were changed.');
    const candidateName = basename(j.candidateDirectory);
    const backupName = `${c.d}-before-publication-${c.transactionId}`;
    if (j.backupDirectory !== backupName || candidateName === c.d || candidateName === backupName) throw new Error('Invalid publication directory binding.');
    const validSnapshot = s => s && Object.keys(s).length === 6 && ['directoryDevice', 'directoryInode', 'device', 'inode', 'size', 'mtimeNs'].every(k => typeof s[k] === 'string' && /^\d+$/.test(s[k]));
    if (!validSnapshot(j.old) || !validSnapshot(j.next) || !/^sha256:[0-9a-f]{64}$/.test(j.validationFileHash || '')) throw new Error('Invalid database identity in publication journal.');
    return { candidate: path.join(c.root, candidateName), backup: path.join(c.root, backupName) };
  }
  function observe(c, j, p) {
    const formal = snapshot(c.formal), candidate = snapshot(p.candidate), backup = snapshot(p.backup);
    if (same(formal, j.old) && same(candidate, j.next) && backup === null) return 'original';
    if (formal === null && same(candidate, j.next) && same(backup, j.old)) return 'gap';
    if (same(formal, j.next) && candidate === null && same(backup, j.old)) return 'promoted';
    throw new Error('Publication directories do not match the recorded identities; preserving all data for explicit investigation.');
  }
  function claimRecoveryLease(c) {
    const existing = lstat(c.lock);
    if (existing) {
      const bytes = fileBytes(c.lock), lease = parse(bytes);
      if (lease.schemaVersion !== 1 || lease.indexDirectory !== c.d || lease.purpose !== 'publication' ||
          lease.transactionId !== c.transactionId || !Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw new Error('Unknown publication lease; it was retained.');
      try { process.kill(lease.pid, 0); throw new Error('Publication owner is still running; its lease was retained.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const now = lstat(c.lock);
      if (!now || now.ino !== existing.ino || now.dev !== existing.dev || !fileBytes(c.lock).equals(bytes)) throw new Error('Publication lease changed during recovery.');
      // Recovery is explicit. Retain the abandoned ownership record as evidence.
      const archived = c.lock + '.abandoned-' + crypto.randomUUID();
      fs.renameSync(c.lock, archived);
      const moved = lstat(archived);
      if (!moved || moved.ino !== existing.ino || moved.dev !== existing.dev || !fileBytes(archived).equals(bytes)) throw new Error('Abandoned publication lease identity changed; recovery stopped.');
    }
    return directoryApi.acquireIndexPublicationLease(c.root, 'publication', c.transactionId);
  }
  function recover(options) {
    const c = context(options, options.transactionId);
    return withDirectory(c, () => {
      const journalRecord = recoveryRecord(c.journal);
      let bytes = journalRecord.bytes, j = parse(bytes);
      const p = paths(c, j);
      if (journalRecord.alias && j.phase !== 'prepared') throw new Error('A non-initial journal has unknown aliases; recovery refused.');
      const candidate = candidateContext(c, j);
      const markers = new Map();
      const records = [journalRecord];
      for (const item of [c, candidate]) {
        if (lstat(item.marker)) {
          const record = recoveryRecord(item.marker), markerBytes = record.bytes;
          if (!markerBytes.equals(Buffer.from(JSON.stringify(marker(item), null, 2) + '\n'))) throw new Error('Unknown publication marker; it was retained.');
          records.push(record);
          markers.set(item.marker, markerBytes);
        } else if (!['prepared', 'committed', 'rolled-back'].includes(j.phase)) {
          throw new Error('Missing publication marker for an unfinished move; recovery refused.');
        }
      }
      consumerGuard();
      const releases = [];
      try {
        for (const item of [c, candidate].sort((a, b) => a.d.localeCompare(b.d))) releases.push(acquire(item, true));
        for (const record of records) retireRecordAlias(record);
        const retiredAliases = records.filter(record => record.alias).map(record => ({
          record: path.basename(record.file), temporaryAlias: path.basename(record.alias),
          device: String(record.stat.dev), inode: String(record.stat.ino), contentHash: hash(record.bytes) }));
        if (retiredAliases.length) {
          j.recoveredTemporaryRecords = [...(j.recoveredTemporaryRecords || []), ...retiredAliases];
          bytes = checkedWrite(c.journal, j, bytes);
        }
        // Re-read after claiming ownership; do not overwrite a changed journal.
        if (!fileBytes(c.journal).equals(bytes)) throw new Error('Publication journal changed during recovery.');
        let state = observe(c, j, p);
        const phase = name => { j.phase = name; bytes = checkedWrite(c.journal, j, bytes); options.onPhase?.(name, c); };
        if (j.phase === 'committed') {
          if (state !== 'promoted') throw new Error('Committed publication does not match the active database.');
        } else if (j.phase === 'rolled-back') {
          if (state !== 'original') throw new Error('Restored publication does not match the original database.');
        } else {
          if (markers.size !== 2 && state !== 'original') throw new Error('A move occurred without valid publication markers.');
          if (state === 'promoted') {
            phase('rollback-candidate-intent');
            assertSnapshot(c.formal, j.next); assertSnapshot(p.candidate, null);
            fs.renameSync(c.formal, p.candidate); state = 'gap';
          }
          if (state === 'gap') {
            phase('rollback-old-intent');
            assertSnapshot(p.backup, j.old); assertSnapshot(c.formal, null);
            fs.renameSync(p.backup, c.formal);
          }
          if (observe(c, j, p) !== 'original') throw new Error('Restoration verification failed.');
          phase('rolled-back');
        }
        for (const [file, content] of markers) removeOwnRecord(file, content);
        return { state: j.phase, transactionId: c.transactionId, journal: c.journal, backup: p.backup };
      } finally { for (const release of releases.reverse()) release(); }
    });
  }
  function publish(options) {
    const c = context(options, crypto.randomUUID());
    return withDirectory(c, () => {
      const candidateDirectory = basename(options.candidateDirectory);
      if (candidateDirectory === c.d) throw new Error('The candidate must be an independent directory.');
      const candidate = candidateContext(c, { candidateDirectory });
      directoryApi.assertNoPendingIndexPublication(c.root);
      withDirectory(candidate, () => directoryApi.assertNoPendingIndexPublication(c.root));
      const releases = [], markers = new Map();
      let bytes, j;
      try {
        for (const item of [c, candidate].sort((a, b) => a.d.localeCompare(b.d))) releases.push(acquire(item));
        consumerGuard();
        if (lstat(c.marker) || lstat(candidate.marker)) throw new Error('Publication marker appeared while claiming the leases.');
        const validationBytes = fileBytes(options.validationPath), validation = parse(validationBytes);
        if (validation.verified !== true || validation.projectRoot !== c.root || validation.candidateDirectory !== candidateDirectory) throw new Error('Candidate validation is missing or belongs to another project.');
        const old = snapshot(c.formal), next = snapshot(path.join(c.root, candidateDirectory));
        for (const [current, expected] of [[old, validation.formal], [next, validation.candidate]]) {
          if (!current || !expected || current.size !== String(expected.size) ||
              String(BigInt(current.mtimeNs) / 100n + 621355968000000000n) !== expected.mtimeTicks) throw new Error('Database changed since validation; publication refused.');
        }
        if (old.device === next.device && old.inode === next.inode) throw new Error('Candidate aliases the current database.');
        j = { schemaVersion: 1, kind: 'codegraph-index-publication', projectRoot: c.root,
          transactionId: c.transactionId, indexDirectory: c.d, candidateDirectory,
          backupDirectory: `${c.d}-before-publication-${c.transactionId}`, old, next,
          validationFileHash: hash(validationBytes), phase: 'prepared' };
        const p = paths(c, j);
        if (lstat(p.backup)) throw new Error('The backup path already exists.');
        bytes = checkedWrite(c.journal, j, undefined, () => options.onPhase?.('journal-linked', c));
        options.onPhase?.('prepared', c);
        for (const item of [c, candidate]) markers.set(item.marker, checkedWrite(item.marker, marker(item), undefined,
          () => options.onPhase?.(item === c ? 'formal-marker-linked' : 'candidate-marker-linked', c)));
        const phase = name => { j.phase = name; bytes = checkedWrite(c.journal, j, bytes); options.onPhase?.(name, c); };
        phase('marker-written');
        consumerGuard();
        if (!fileBytes(options.validationPath).equals(validationBytes)) throw new Error('Validation record changed during publication.');
        assertSnapshot(c.formal, old); assertSnapshot(p.candidate, next); assertSnapshot(p.backup, null);
        phase('old-move-intent');
        fs.renameSync(c.formal, p.backup);
        phase('old-preserved');
        assertSnapshot(p.backup, old); assertSnapshot(c.formal, null); assertSnapshot(p.candidate, next);
        phase('candidate-move-intent');
        fs.renameSync(p.candidate, c.formal);
        phase('candidate-promoted');
        if (observe(c, j, p) !== 'promoted') throw new Error('Publication verification failed.');
        phase('committed');
        for (const [file, content] of markers) removeOwnRecord(file, content);
        return { state: j.phase, transactionId: c.transactionId, journal: c.journal, backup: p.backup };
      } catch (error) {
        // Leave the marker/identities intact on every error. Explicit recovery
        // handles both ordinary failures and uncatchable process exits alike.
        if (j) error.message += ` Recover explicitly with transaction ${c.transactionId}; records and databases were retained.`;
        throw error;
      } finally { for (const release of releases.reverse()) release(); }
    });
  }
  return { publish, recover };
}

module.exports = { createPublicationService, assertConsumerRecords, assertNoGraphConsumers };
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    const keys = new Map([['--project-root', 'projectRoot'], ['--index-directory', 'indexDirectory'],
      ['--candidate-directory', 'candidateDirectory'], ['--validation', 'validationPath'], ['--recover', 'transactionId']]);
    for (let i = 0; i < args.length; i += 2) {
      if (!keys.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || keys.get(args[i]) in options) throw new Error('Invalid publication arguments.');
      options[keys.get(args[i])] = args[i + 1];
    }
    const api = createPublicationService(require('../dist/directory.js'));
    console.log(JSON.stringify(options.transactionId ? api.recover(options) : api.publish(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
