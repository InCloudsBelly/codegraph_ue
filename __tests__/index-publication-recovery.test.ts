import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { acquireIndexPublicationLease, isInitialized } from '../src/directory';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const { DatabaseSync } = require('node:sqlite');
const { assertConsumerRecords } = require('../scripts/publish-validated-index.cjs');
const CHILD = path.resolve(__dirname, 'fixtures/index-publication-child.cjs');
const PHASES = ['journal-linked', 'prepared', 'formal-marker-linked', 'candidate-marker-linked', 'marker-written', 'old-move-intent', 'old-preserved',
  'candidate-move-intent', 'candidate-promoted', 'committed'];

describe('validated index publication survives real process exits', () => {
  let root: string;
  let original: Buffer;
  let candidate: Buffer;
  const db = (directory: string) => path.join(root, directory, 'codegraph.db');

  function makeDatabase(directory: string, label: string): Buffer {
    fs.mkdirSync(path.dirname(db(directory)), { recursive: true });
    const connection = new DatabaseSync(db(directory));
    connection.exec('CREATE TABLE labels(value TEXT NOT NULL)');
    connection.prepare('INSERT INTO labels VALUES (?)').run(label);
    connection.close();
    return fs.readFileSync(db(directory));
  }
  function label(directory: string): string {
    const connection = new DatabaseSync(db(directory), { readOnly: true });
    try { return connection.prepare('SELECT value FROM labels').get().value; } finally { connection.close(); }
  }
  function validationIdentity(directory: string) {
    const stat = fs.statSync(db(directory), { bigint: true });
    return { size: String(stat.size), mtimeTicks: String(stat.mtimeNs / 100n + 621355968000000000n) };
  }
  function run(action: 'publish' | 'recover', exitAfter?: string, transactionId?: string) {
    const options = { projectRoot: root, indexDirectory: '.codegraph', candidateDirectory: '.codegraph-candidate',
      validationPath: path.join(root, 'validation.json'), ...(transactionId ? { transactionId } : {}) };
    const document = path.join(root, 'child-operation.json');
    fs.writeFileSync(document, JSON.stringify({ action, exitAfter, options }));
    return spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, CHILD, document], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, timeout: 30_000,
    });
  }
  function journal() {
    const files = fs.readdirSync(root).filter(name => /^\.codegraph\.publication\.[0-9a-f-]+\.journal\.json$/i.test(name));
    expect(files).toHaveLength(1);
    return JSON.parse(fs.readFileSync(path.join(root, files[0]!), 'utf8'));
  }
  function layout() {
    return Object.fromEntries(fs.readdirSync(root).filter(name => fs.existsSync(db(name)))
      .map(name => [name, fs.readFileSync(db(name)).toString('base64')]));
  }
  function assertRestored() {
    expect(fs.readFileSync(db('.codegraph'))).toEqual(original);
    expect(fs.readFileSync(db('.codegraph-candidate'))).toEqual(candidate);
    expect(label('.codegraph')).toBe('original');
    expect(label('.codegraph-candidate')).toBe('candidate');
    expect(fs.existsSync(path.join(root, '.codegraph.publication.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph.publication.lock'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph-candidate.publication.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph-candidate.publication.lock'))).toBe(false);
  }
  function assertProtected(directory: string) {
    const before = process.env.CODEGRAPH_DIR;
    process.env.CODEGRAPH_DIR = directory;
    try {
      expect(() => CodeGraph.initSync(root)).toThrow(/publication.*lease|publication.*pending/i);
      expect(() => isInitialized(root)).toThrow(/publication/i);
    } finally {
      if (before === undefined) delete process.env.CODEGRAPH_DIR;
      else process.env.CODEGRAPH_DIR = before;
    }
  }
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-publish-recovery-')));
    original = makeDatabase('.codegraph', 'original');
    candidate = makeDatabase('.codegraph-candidate', 'candidate');
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ verified: true, projectRoot: root,
      candidateDirectory: '.codegraph-candidate', formal: validationIdentity('.codegraph'), candidate: validationIdentity('.codegraph-candidate') }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it.each(PHASES)('recovers an actual exit 91 at %s without rebuilding either database', phase => {
    const stopped = run('publish', phase);
    expect(stopped.status, stopped.stderr).toBe(91);
    const recorded = journal();
    expect(recorded.phase).toBe(phase.endsWith('-linked') ? 'prepared' : phase);
    assertProtected('.codegraph');
    assertProtected('.codegraph-candidate');
    const beforeRecover = layout();
    expect(Object.values(beforeRecover).sort()).toEqual([original.toString('base64'), candidate.toString('base64')].sort());
    const recovered = run('recover', undefined, recorded.transactionId);
    expect(recovered.status, recovered.stderr).toBe(0);
    if (phase === 'committed') {
      expect(JSON.parse(recovered.stdout).state).toBe('committed');
      expect(fs.readFileSync(db('.codegraph'))).toEqual(candidate);
      expect(fs.readFileSync(db(recorded.backupDirectory))).toEqual(original);
      expect(label('.codegraph')).toBe('candidate');
      expect(label(recorded.backupDirectory)).toBe('original');
      expect(fs.existsSync(db('.codegraph-candidate'))).toBe(false);
    } else {
      expect(JSON.parse(recovered.stdout).state).toBe('rolled-back');
      assertRestored();
    }
    const expected = layout();
    const again = run('recover', undefined, recorded.transactionId);
    expect(again.status, again.stderr).toBe(0);
    expect(layout()).toEqual(expected);
    expect(fs.existsSync(path.join(root, '.codegraph.publication.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph.publication.lock'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph-candidate.publication.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph-candidate.publication.lock'))).toBe(false);
    expect(fs.readdirSync(root).filter(name => name.includes('.publication.') && name.includes('.tmp-'))).toEqual([]);
  }, 60_000);

  it.each(['rollback-candidate-intent', 'rollback-old-intent'])(
    'resumes recovery after another actual exit 91 at %s', phase => {
      expect(run('publish', 'candidate-promoted').status).toBe(91);
      const transactionId = journal().transactionId;
      const stopped = run('recover', phase, transactionId);
      expect(stopped.status, stopped.stderr).toBe(91);
      expect(journal().phase).toBe(phase);
      expect(() => isInitialized(root)).toThrow(/publication/i);
      const recovered = run('recover', undefined, transactionId);
      expect(recovered.status, recovered.stderr).toBe(0);
      assertRestored();
    }, 60_000,
  );

  it('publishes normally and retains the original database as a backup', () => {
    const result = run('publish');
    expect(result.status, result.stderr).toBe(0);
    const recorded = journal();
    expect(fs.readFileSync(db('.codegraph'))).toEqual(candidate);
    expect(fs.readFileSync(db(recorded.backupDirectory))).toEqual(original);
    expect(label('.codegraph')).toBe('candidate');
    expect(label(recorded.backupDirectory)).toBe('original');
    expect(fs.existsSync(path.join(root, '.codegraph.publication.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph.publication.lock'))).toBe(false);
  });

  it('refuses publication while an initializer owns the candidate lease', () => {
    const previous = process.env.CODEGRAPH_DIR;
    process.env.CODEGRAPH_DIR = '.codegraph-candidate';
    const release = acquireIndexPublicationLease(root, 'initialize');
    if (previous === undefined) delete process.env.CODEGRAPH_DIR;
    else process.env.CODEGRAPH_DIR = previous;
    const before = layout();
    try {
      const result = run('publish');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/publication.*lease/i);
      expect(layout()).toEqual(before);
      expect(fs.readdirSync(root).filter(name => name.endsWith('.journal.json'))).toEqual([]);
    } finally { release(); }
  });

  it('refuses an unrelated hard-link alias to the publication journal', () => {
    expect(run('publish', 'prepared').status).toBe(91);
    const recorded = journal();
    const file = path.join(root, `.codegraph.publication.${recorded.transactionId}.journal.json`);
    const foreignAlias = path.join(root, 'unrelated-journal-alias');
    fs.linkSync(file, foreignAlias);
    const before = layout();
    const result = run('recover', undefined, recorded.transactionId);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown publication record aliases/i);
    expect(fs.existsSync(foreignAlias)).toBe(true);
    expect(layout()).toEqual(before);
  });

  it('refuses a changed marker and preserves every directory', () => {
    expect(run('publish', 'old-preserved').status).toBe(91);
    const transactionId = journal().transactionId;
    const marker = path.join(root, '.codegraph.publication.json');
    fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, indexDirectory: '.codegraph', transactionId: 'another-owner', state: 'pending' }));
    const before = layout();
    const result = run('recover', undefined, transactionId);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown publication marker/i);
    expect(layout()).toEqual(before);
  });

  it('refuses a changed database identity during recovery and retains both databases', () => {
    expect(run('publish', 'old-preserved').status).toBe(91);
    const transactionId = journal().transactionId;
    fs.appendFileSync(db('.codegraph-candidate'), Buffer.from('changed identity'));
    const before = layout();
    const result = run('recover', undefined, transactionId);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/recorded identities|identity changed/i);
    expect(layout()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.codegraph.publication.json'))).toBe(true);
  });

  it('rejects stale validation before moving either directory', () => {
    const validation = path.join(root, 'validation.json');
    const document = JSON.parse(fs.readFileSync(validation, 'utf8'));
    document.formal.mtimeTicks = String(BigInt(document.formal.mtimeTicks) + 1n);
    fs.writeFileSync(validation, JSON.stringify(document));
    const before = layout();
    const result = run('publish');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/changed since validation/i);
    expect(layout()).toEqual(before);
  });
});

describe('publication consumer inspection fails closed', () => {
  it.each([null, undefined, '', '   '])('rejects an unreadable or blank command line %j', CommandLine => {
    expect(() => assertConsumerRecords([{ Name: 'node.exe', ProcessId: 99, CommandLine }], 42)).toThrow(/cannot determine/i);
  });
  it('rejects a known CodeGraph consumer and permits a known unrelated command', () => {
    expect(() => assertConsumerRecords([{ Name: 'node.exe', ProcessId: 99, CommandLine: 'node codegraph serve --mcp' }], 42)).toThrow(/still running/i);
    expect(() => assertConsumerRecords([{ Name: 'node.exe', ProcessId: 99, CommandLine: 'node unrelated.js' }], 42)).not.toThrow();
  });
});
