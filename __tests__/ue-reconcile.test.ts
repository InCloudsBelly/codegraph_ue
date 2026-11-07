import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';

const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
const { default: CodeGraph, FileLock } = require(dist) as typeof import('../src');
const { ToolHandler } = require(path.join(dist, 'mcp/tools.js')) as typeof import('../src/mcp/tools');

it('reconciles, rejects drift during reading, and reports only a verified UE result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cg-ue-reconcile-'));
  const files = path.join(root, 'Engine/Source/Runtime/Core');
  mkdirSync(files, { recursive: true });
  mkdirSync(path.join(root, '.codegraph'));
  writeFileSync(path.join(root, '.codegraph/indexing.json'), '{"ueEngine":{"plugins":[]}}');
  writeFileSync(path.join(files, 'AuditTarget.h'), 'inline void AuditTarget() {}\n');
  const caller = path.join(files, 'AuditPeer.cpp');
  writeFileSync(caller, 'void AuditPeer() {}\n');
  expect(spawnSync('git', ['init', '-q', root], { windowsHide: true }).status).toBe(0);
  const graph = CodeGraph.initSync(root);
  const handler = new ToolHandler(graph);
  const cli = (...args: string[]) => spawnSync(process.execPath, [
    '--liftoff-only', path.join(dist, 'bin/codegraph.js'), ...args,
  ], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CODEGRAPH_DIR: '.codegraph', CODEGRAPH_TELEMETRY: '0', NO_COLOR: '1' },
  });
  try {
    expect((await graph.indexAll()).filesIndexed).toBe(2);
    const getCallers = graph.getCallers.bind(graph);
    const injection = vi.spyOn(graph, 'getCallers').mockImplementationOnce(id => {
      writeFileSync(caller, '#include "AuditTarget.h"\nvoid AuditPeer() { AuditTarget(); }\n');
      return getCallers(id);
    });
    const drift = await handler.execute('codegraph_callers', { symbol: 'AuditTarget' });
    expect(injection).toHaveBeenCalled();
    injection.mockRestore();
    expect(drift.isError).toBe(true);
    expect(drift.content[0]?.text).toContain('source-or-plugin-input-changed');

    const command = cli('reconcile-ue', root, '--query=AuditPeer');
    expect(command.status, command.stdout + command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({ protocol: 1, status: 'fresh', text: expect.stringContaining('AuditPeer') });

    const cancellation = new AbortController();
    const verify = graph.getUeScopeStatus.bind(graph);
    const cancelDuringVerify = vi.spyOn(graph, 'getUeScopeStatus').mockImplementationOnce(async options => {
      const scope = await verify(options);
      cancellation.abort();
      return scope;
    });
    const outcome = { signal: cancellation.signal };
    const cancelled = await handler.execute('codegraph_callers', { symbol: 'AuditTarget' }, undefined, outcome);
    cancelDuringVerify.mockRestore();
    expect(cancelled.isError).toBe(true);
    expect(outcome).toMatchObject({ reason: 'cancelled' });

    const status = cli('status', root, '--json', '--metadata-only');
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ workingTreeChecked: false, dataConsistent: true });
    expect(JSON.parse(status.stdout)).not.toHaveProperty('nodesByKind');

    const lockPath = path.join(root, '.codegraph/codegraph.lock');
    const held = new FileLock(lockPath);
    held.acquire();
    try {
      const busy = cli('reconcile-ue', root, '--query=AuditPeer');
      expect(busy.status, busy.stderr).toBe(0);
      expect(JSON.parse(busy.stdout)).toMatchObject({ status: 'unverified', reason: 'project-busy' });
    } finally { held.release(); }

    const lease = `${lockPath}.lease`;
    writeFileSync(lease, 'corrupt SQLite lease'.repeat(100));
    const unavailable = cli('reconcile-ue', root, '--query=AuditPeer');
    expect(unavailable.status, unavailable.stderr).toBe(0);
    expect.soft(JSON.parse(unavailable.stdout)).toMatchObject({ status: 'unverified', reason: 'index-lock-error' });
    unlinkSync(lease);

    writeFileSync(lockPath, '99999999999999999999');
    try {
      const invalid = cli('reconcile-ue', root, '--query=AuditPeer');
      expect(invalid.status, invalid.stderr).toBe(0);
      expect(JSON.parse(invalid.stdout)).toMatchObject({ status: 'unverified', reason: 'index-lock-error' });
    } finally { unlinkSync(lockPath); }

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'));
    try {
      db.prepare("UPDATE project_metadata SET value='partial' WHERE key='index_state'").run();
      db.exec('DROP TRIGGER nodes_ai');
    } finally { db.close(); }
    const partial = cli('reconcile-ue', root, '--query=AuditPeer');
    expect(partial.status, partial.stderr).toBe(0);
    expect(JSON.parse(partial.stdout)).toMatchObject({ protocol: 1, status: 'unverified', reason: 'index-incomplete' });
    expect(graph.getIndexState()).toBe('partial');
    const publicRead = cli('explore', 'AuditPeer');
    expect(publicRead.status, publicRead.stdout + publicRead.stderr).toBe(1);
    const diagnostic = cli('status', root, '--json');
    expect(diagnostic.status, diagnostic.stderr).toBe(0);
    expect(JSON.parse(diagnostic.stdout)).toMatchObject({ index: { state: 'partial' } });

    const server = spawn(process.execPath, ['--liftoff-only', path.join(dist, 'bin/codegraph.js'), 'serve', '--mcp'], {
      cwd: root, windowsHide: true, timeout: 30_000, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CODEGRAPH_DIR: '.codegraph',
        CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_QUERY_POOL_SIZE: '1', CODEGRAPH_TELEMETRY: '0' },
    });
    const exited = once(server, 'close');
    const lines = createInterface({ input: server.stdout });
    const replies = lines[Symbol.asyncIterator]();
    const send = (method: string, params: object, id?: number) =>
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
    const response = async (id: number) => {
      for (;;) {
        const line = await replies.next();
        if (line.done) throw new Error('MCP closed before responding');
        const message = JSON.parse(line.value);
        if (message.id === id) return message.result;
      }
    };
    try {
      send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ue-gate-test', version: '1' } }, 1);
      expect(await response(1)).toBeDefined();
      send('notifications/initialized', {});
      send('tools/call', { name: 'codegraph_explore', arguments: { query: 'AuditPeer' } }, 2);
      expect((await response(2)).isError).toBe(true);
    } finally {
      lines.close();
      server.stdin.end();
      server.kill();
      await exited;
    }
    const preserved = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'));
    try {
      expect.soft(preserved.prepare("SELECT name FROM sqlite_schema WHERE name='nodes_ai'").get()).toBeUndefined();
      preserved.exec("DELETE FROM nodes; UPDATE project_metadata SET value='complete' WHERE key='index_state'");
    } finally { preserved.close(); }
    const inconsistent = cli('status', root, '--json', '--metadata-only');
    expect(inconsistent.status, inconsistent.stderr).toBe(0);
    expect(JSON.parse(inconsistent.stdout)).toMatchObject({
      dataConsistent: false, index: { state: 'partial', storedState: 'complete' },
    });
  } finally {
    await handler.closeAll();
    graph.destroy();
  }
}, 75_000);

it('keeps an unverified profile available for diagnostics only', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cg-unverified-profile-'));
  CodeGraph.initSync(root).close();
  writeFileSync(path.join(root, '.codegraph/indexing.json'), '{"ueEngine":');
  const graph = CodeGraph.openSync(root, { automaticOpen: 'query' });
  const handler = new ToolHandler(graph);
  try {
    const query = await handler.execute('codegraph_explore', { query: 'AuditPeer' });
    expect(query.isError).toBe(true);
    expect(query.content[0]?.text).toContain('Cannot verify the active index profile');
    const diagnostic = await handler.execute('codegraph_status', {});
    expect(diagnostic.isError).not.toBe(true);
    expect(diagnostic.content[0]?.text).toContain('**Index profile:** unverified');

    const read = spawnSync(process.execPath, [
      '--liftoff-only', path.join(dist, 'bin/codegraph.js'), 'context', '--path', root, 'AuditPeer',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, CODEGRAPH_DIR: '.codegraph', CODEGRAPH_TELEMETRY: '0' } });
    expect(read.status, read.stdout + read.stderr).toBe(1);
    expect(read.stderr).toContain('Cannot verify the active index profile');
  } finally {
    await handler.closeAll();
    graph.destroy();
  }
}, 30_000);
