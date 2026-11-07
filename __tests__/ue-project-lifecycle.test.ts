import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type CodeGraph from '../src';
import { acquireProject } from '../src/mcp/project-lifecycle';
import { ToolHandler } from '../src/mcp/tools';
import { MCPEngine } from '../src/mcp/engine';

describe('project lifecycle after a close failure', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('retains its owner and reports a close failure (deferred=%s)', async deferred => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-close-retry-'));
    roots.push(root);
    const close = vi.fn().mockImplementationOnce(() => { throw new Error('injected close failure'); });
    const isIndexing = vi.fn().mockReturnValueOnce(deferred).mockReturnValue(false);
    const graph = { close, isIndexing } as unknown as CodeGraph;
    const first = acquireProject(root, () => graph, {});
    await expect(Promise.resolve().then(() => first.release())).rejects.toThrow('injected close failure');
    const second = acquireProject(root, () => { throw new Error('existing owner was lost'); }, {});
    expect(second.cg).toBe(graph);
    await second.release();
    await first.release();
    expect(close).toHaveBeenCalledTimes(2);
  }, 30000);
});

describe('cached project close failure', () => {
  it('keeps a directly opened graph available for a close retry', async () => {
    const close = vi.fn().mockImplementationOnce(() => { throw new Error('injected close failure'); });
    const graph = { close } as unknown as CodeGraph;
    const handler = new ToolHandler(null);
    const cache = (handler as unknown as { projectCache: Map<string, CodeGraph> }).projectCache;
    cache.set('fixture', graph);
    await expect(Promise.resolve().then(() => handler.closeAll())).rejects.toThrow('injected close failure');
    expect(cache.get('fixture')).toBe(graph);
    await handler.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('keeps an asynchronously released graph available for a close retry', async () => {
    const graph = {} as CodeGraph;
    const handler = new ToolHandler(null);
    const release = vi.fn().mockRejectedValueOnce(new Error('injected async close failure')).mockResolvedValue(undefined);
    handler.setProjectLifecycle({ open: () => graph, activate: async () => {}, release });
    const cache = (handler as unknown as { projectCache: Map<string, CodeGraph> }).projectCache;
    cache.set('fixture', graph);
    await expect(handler.closeAll()).rejects.toThrow('injected async close failure');
    expect(cache.get('fixture')).toBe(graph);
    await handler.closeAll();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('waits for an in-flight project release before a new tool call', async () => {
    const graph = {} as CodeGraph;
    const handler = new ToolHandler(null);
    let rejectRelease!: (error: Error) => void;
    const firstRelease = new Promise<void>((_resolve, reject) => { rejectRelease = reject; });
    const release = vi.fn().mockReturnValueOnce(firstRelease).mockResolvedValue(undefined);
    handler.setProjectLifecycle({ open: () => graph, activate: async () => {}, release });
    const internals = handler as unknown as {
      projectCache: Map<string, CodeGraph>;
      projectUsedAt: Map<string, number>;
      trimProjects(): void;
      getCodeGraph(): CodeGraph;
      handleStatus(): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
    };
    internals.projectCache.set('fixture', graph);
    internals.projectUsedAt.set('fixture', Date.now() - 10_000);
    const previous = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '1';
    const getGraph = vi.spyOn(internals, 'getCodeGraph').mockReturnValue(graph);
    vi.spyOn(internals, 'handleStatus').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    try {
      internals.trimProjects();
      await Promise.resolve();
      process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '0';
      const query = handler.execute('codegraph_status', {});
      await new Promise<void>(resolve => setImmediate(resolve));
      const openedBeforeReleaseFinished = getGraph.mock.calls.length;
      rejectRelease(new Error('injected async close failure'));
      await query;
      expect(openedBeforeReleaseFinished).toBe(0);
      expect(getGraph).toHaveBeenCalled();
      expect(internals.projectCache.get('fixture')).toBe(graph);
      await handler.closeAll();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = previous;
      vi.restoreAllMocks();
    }
  }, 30000);

  it('opens a new graph only after the previous release succeeds', async () => {
    const oldGraph = {} as CodeGraph, newGraph = {} as CodeGraph;
    const handler = new ToolHandler(null);
    let finishRelease!: () => void;
    const release = vi.fn().mockReturnValueOnce(new Promise<void>(resolve => { finishRelease = resolve; })).mockResolvedValue(undefined);
    const open = vi.fn(() => newGraph);
    handler.setProjectLifecycle({ open, activate: async () => {}, release });
    const internals = handler as unknown as {
      projectCache: Map<string, CodeGraph>; projectUsedAt: Map<string, number>;
      trimProjects(): void; getCodeGraph(): CodeGraph;
      handleStatus(): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
    };
    internals.projectCache.set('fixture', oldGraph);
    internals.projectUsedAt.set('fixture', Date.now() - 10_000);
    vi.spyOn(internals, 'getCodeGraph').mockImplementation(() => {
      let graph = internals.projectCache.get('fixture');
      if (!graph) { graph = open(); internals.projectCache.set('fixture', graph); }
      return graph;
    });
    vi.spyOn(internals, 'handleStatus').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const previous = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '1';
    try {
      internals.trimProjects();
      await Promise.resolve();
      process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '0';
      const query = handler.execute('codegraph_status', {});
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(open).not.toHaveBeenCalled();
      finishRelease();
      await query;
      expect(open).toHaveBeenCalledTimes(1);
      expect(internals.projectCache.get('fixture')).toBe(newGraph);
      await handler.closeAll();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = previous;
      vi.restoreAllMocks();
    }
  }, 30000);

  it('does not reopen a project if the session closes while a release is pending', async () => {
    const graph = {} as CodeGraph;
    const handler = new ToolHandler(null);
    let finishRelease!: () => void;
    const release = vi.fn().mockReturnValueOnce(new Promise<void>(resolve => { finishRelease = resolve; })).mockResolvedValue(undefined);
    handler.setProjectLifecycle({ open: () => graph, activate: async () => {}, release });
    const internals = handler as unknown as {
      projectCache: Map<string, CodeGraph>; projectUsedAt: Map<string, number>;
      trimProjects(): void; getCodeGraph(): CodeGraph;
    };
    internals.projectCache.set('fixture', graph);
    internals.projectUsedAt.set('fixture', Date.now() - 10_000);
    const getGraph = vi.spyOn(internals, 'getCodeGraph').mockReturnValue(graph);
    const previous = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '1';
    try {
      internals.trimProjects();
      await Promise.resolve();
      const query = handler.execute('codegraph_status', {});
      const closing = handler.closeAll();
      finishRelease();
      expect((await query).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('closing') });
      await closing;
      expect(getGraph).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = previous;
      vi.restoreAllMocks();
    }
  }, 30000);
});

describe('MCP engine close recovery', () => {
  it('can retry stopping a default graph after close fails', async () => {
    const close = vi.fn().mockImplementationOnce(() => { throw new Error('injected default close failure'); });
    const graph = { close, unwatch: vi.fn(), isIndexing: () => false } as unknown as CodeGraph;
    const engine = new MCPEngine({ watch: false, queryPool: false });
    (engine as unknown as { cg: CodeGraph | null }).cg = graph;
    await expect(engine.stop()).rejects.toThrow('injected default close failure');
    await engine.stop();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('retains an explicit project and can retry stopping after close fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-close-'));
    const close = vi.fn().mockImplementationOnce(() => { throw new Error('injected project close failure'); });
    const graph = { close, isIndexing: () => false, getProjectRoot: () => root } as unknown as CodeGraph;
    const lease = acquireProject(root, () => graph, {});
    const engine = new MCPEngine({ watch: true, queryPool: false });
    const internals = engine as unknown as {
      explicitProjects: Map<CodeGraph, typeof lease>;
      toolHandler: ToolHandler;
    };
    internals.explicitProjects.set(graph, lease);
    (internals.toolHandler as unknown as { projectCache: Map<string, CodeGraph> }).projectCache.set(root, graph);
    try {
      await expect(engine.stop()).rejects.toThrow('injected project close failure');
      expect(internals.explicitProjects.get(graph)).toBe(lease);
      await engine.stop();
      expect(close).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('does not replace an explicit project lease while its close is in flight', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-race-'));
    let indexing = true;
    const close = vi.fn().mockImplementationOnce(() => { throw new Error('injected project close failure'); });
    const graph = { close, isIndexing: () => indexing, getProjectRoot: () => root } as unknown as CodeGraph;
    const lease = acquireProject(root, () => graph, {});
    const engine = new MCPEngine({ watch: true, queryPool: false });
    const state = engine as unknown as { explicitProjects: Map<CodeGraph, typeof lease>; toolHandler: ToolHandler };
    state.explicitProjects.set(graph, lease);
    const handler = state.toolHandler;
    const internals = handler as unknown as {
      projectCache: Map<string, CodeGraph>;
      projectUsedAt: Map<string, number>;
      projectLifecycle: { open(root: string, open: () => CodeGraph): CodeGraph };
      trimProjects(): void;
      getCodeGraph(): CodeGraph;
      handleStatus(): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
    };
    internals.projectCache.set(root, graph);
    internals.projectUsedAt.set(root, Date.now() - 10_000);
    vi.spyOn(internals, 'getCodeGraph').mockImplementation(() => {
      let result = internals.projectCache.get(root);
      if (!result) {
        result = internals.projectLifecycle.open(root, () => graph);
        internals.projectCache.set(root, result);
      }
      return result;
    });
    vi.spyOn(internals, 'handleStatus').mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const previous = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '1';
    try {
      internals.trimProjects();
      await new Promise<void>(resolve => setImmediate(resolve));
      process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '0';
      const query = handler.execute('codegraph_status', {});
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(state.explicitProjects.get(graph)).toBe(lease);
      indexing = false;
      await query;
      expect(state.explicitProjects.get(graph)).toBe(lease);
      await engine.stop();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      indexing = false;
      if (previous === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = previous;
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
