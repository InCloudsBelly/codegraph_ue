/**
 * Regression coverage for issue #874: `codegraph index` produced 0 nodes / 0
 * edges while `codegraph init` worked, and appeared to wipe the graph.
 *
 * Raw rebuilds now refuse existing artifacts. Updates use sync; independent
 * candidates must be validated before replacing a last-good database.
 *
 * Exercised end-to-end against the built binary so the CLI wiring (not just the
 * library) is covered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { encodeLockInfo, getDaemonPidPath } from '../src/mcp/daemon-paths';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

/** Normalize a PRAGMA read across return shapes (array | object | scalar). */
function pragmaValue(raw: unknown, key: string): unknown {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (row !== null && typeof row === 'object') return (row as Record<string, unknown>)[key];
  return row;
}

function runCodegraph(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function graphCounts(dir: string): { nodes: number; edges: number } {
  const cg = CodeGraph.openSync(dir);
  try {
    const stats = cg.getStats();
    return { nodes: stats.nodeCount, edges: stats.edgeCount };
  } finally {
    cg.close();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDetachedProcess(): number {
  const source = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    'child.unref();',
    'console.log(child.pid);',
  ].join(' ');
  const pid = Number(execFileSync(process.execPath, ['-e', source], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('could not start daemon fixture');
  return pid;
}

describe('codegraph index — refuses destruction and keeps the graph populated (#874)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-cmd-'));
    // A couple of files with a call edge so there is a non-trivial graph to
    // (fail to) reproduce.
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function greet(name: string) { return hello(name); }\n` +
        `export function hello(n: string) { return 'hi ' + n; }\n`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'b.ts'),
      `import { greet } from './a';\nexport function main() { return greet('world'); }\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses replacement and preserves init\'s nodes and edges', () => {
    runCodegraph(['init'], tempDir);
    const afterInit = graphCounts(tempDir);
    expect(afterInit.nodes).toBeGreaterThan(0);
    expect(afterInit.edges).toBeGreaterThan(0);

    const before = fs.readFileSync(path.join(tempDir, '.codegraph', 'codegraph.db'));
    expect(() => runCodegraph(['index'], tempDir)).toThrow(/preserving existing index/);
    expect(fs.readFileSync(path.join(tempDir, '.codegraph', 'codegraph.db')).equals(before)).toBe(true);
    const afterIndex = graphCounts(tempDir);

    // The graph stays fully populated after refusal.
    expect(afterIndex.nodes).toBe(afterInit.nodes);
    expect(afterIndex.edges).toBe(afterInit.edges);

  });

  it('repeated refusals do not grow or modify the graph', () => {
    runCodegraph(['init'], tempDir);
    expect(() => runCodegraph(['index'], tempDir)).toThrow(/preserving existing index/);
    const first = graphCounts(tempDir);
    expect(() => runCodegraph(['index'], tempDir)).toThrow(/preserving existing index/);
    const second = graphCounts(tempDir);

    // A clean rebuild each time — no duplicate (re-resolved) edges accumulating
    // across runs (the C# "+18 edges" symptom in the report).
    expect(second.nodes).toBe(first.nodes);
    expect(second.edges).toBe(first.edges);
  });

  it('--quiet also refuses replacement and preserves a populated graph', () => {
    runCodegraph(['init'], tempDir);
    const afterInit = graphCounts(tempDir);

    expect(() => runCodegraph(['index', '--quiet'], tempDir)).toThrow(/preserving existing index/);
    const afterIndex = graphCounts(tempDir);

    expect(afterIndex.nodes).toBe(afterInit.nodes);
    expect(afterIndex.edges).toBe(afterInit.edges);
  });

  it('refuses to recreate while a live daemon cannot be verified (#1325)', () => {
    runCodegraph(['init'], tempDir);
    const daemonPid = startDetachedProcess();
    const lockPath = getDaemonPidPath(fs.realpathSync(tempDir));
    fs.writeFileSync(
      lockPath,
      encodeLockInfo({
        pid: daemonPid,
        version: 'test',
        socketPath: path.join(tempDir, '.codegraph', 'missing.sock'),
        startedAt: Date.now(),
      }),
    );

    try {
      expect(() => runCodegraph(['index', '--quiet'], tempDir)).toThrow(/preserving existing index/);
      expect(isAlive(daemonPid)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      if (isAlive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
    }
  });
});

/**
 * Regression coverage for issue #1067: a full re-index must RECOVER an existing
 * oversized/stale index from earlier versions, not wedge on it.
 *
 * A stale graph still must not be discarded before a candidate succeeds.
 * Raw index now refuses it; sync can apply confirmed filesystem deletions.
 */
describe('codegraph index — preserves a stale/oversized prior index (#1067)', () => {
  let tempDir: string;
  const dbPath = (dir: string) => path.join(dir, '.codegraph', 'codegraph.db');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-recover-'));
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function greet(name: string) { return hello(name); }\n` +
        `export function hello(n: string) { return 'hi ' + n; }\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves the old graph on refusal, then sync applies confirmed deletions', () => {
    // Stand in for the "old graph indexed an ignored corpus" shape: index a tree
    // that also has a junk/ directory, then delete junk/ from disk so the DB now
    // carries stale nodes for paths that should no longer be indexed.
    const junkDir = path.join(tempDir, 'junk');
    fs.mkdirSync(junkDir);
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(junkDir, `j${i}.ts`), `export function j${i}() { return ${i}; }\n`);
    }
    runCodegraph(['init'], tempDir);
    const withJunk = graphCounts(tempDir);

    // Remove the corpus from disk. The DB still holds its nodes — the stale,
    // oversized prior state #1067 is about.
    fs.rmSync(junkDir, { recursive: true, force: true });

    expect(() => runCodegraph(['index'], tempDir)).toThrow(/preserving existing index/);
    expect(graphCounts(tempDir)).toEqual(withJunk);
    runCodegraph(['sync'], tempDir);
    const recovered = graphCounts(tempDir);

    // The rebuild reflects only what's on disk now — the junk nodes are gone…
    expect(recovered.nodes).toBeLessThan(withJunk.nodes);

    // …and the result is identical to a fresh init of the same (now-smaller) tree.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-fresh-'));
    try {
      fs.copyFileSync(path.join(tempDir, 'a.ts'), path.join(fresh, 'a.ts'));
      runCodegraph(['init'], fresh);
      const freshCounts = graphCounts(fresh);
      expect(recovered.nodes).toBe(freshCounts.nodes);
      expect(recovered.edges).toBe(freshCounts.edges);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  // A header sentinel proves refusal retains the original physical database.
  it('retains the old database and its header on refusal', () => {
    runCodegraph(['init'], tempDir);

    const stamp = DatabaseConnection.open(dbPath(tempDir));
    stamp.getDb().pragma('user_version = 4242');
    stamp.close();

    expect(() => runCodegraph(['index'], tempDir)).toThrow(/preserving existing index/);

    const check = DatabaseConnection.open(dbPath(tempDir));
    const userVersion = pragmaValue(check.getDb().pragma('user_version'), 'user_version');
    check.close();

    expect(Number(userVersion)).toBe(4242);

    // …and the graph is intact afterwards.
    const counts = graphCounts(tempDir);
    expect(counts.nodes).toBeGreaterThan(0);
    expect(counts.edges).toBeGreaterThan(0);
  });
});
