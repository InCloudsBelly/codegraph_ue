import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import type { QueryBuilder } from '../src/db/queries';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { ueRuntimeBuildIdentity } from '../src/extraction/ue-build-identity';

describe('UE initial candidate recovery', () => {
  let root: string;
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-initial-recovery-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('explicitly resumes an interrupted first index without treating it as fresh', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Private/A.cpp', 'void Target() {}\nvoid Caller() { Target(); }\n');
    write('Engine/Source/Runtime/Core/Private/B.cpp', 'void Other() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      let interrupted = false;
      await expect(graph.indexAll({ onProgress: progress => {
        if (!interrupted && progress.phase === 'parsing' && progress.current >= 1) {
          interrupted = true;
          throw new Error('injected initial interruption');
        }
      } })).rejects.toThrow(/injected initial interruption/);
      expect(interrupted).toBe(true);
      expect(graph.getIndexState()).not.toBe('complete');
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      expect(queries.getMetadata('ue_engine_scope_pending_v1')).toBeTruthy();
      expect(queries.getMetadata('ue_engine_scope_applied_v1')).toBeNull();
    } finally { await graph.destroy(); }
    const resumed = CodeGraph.openSync(root);
    try {
      await expect(resumed.syncAutomatically()).rejects.toThrow();
      await resumed.sync();
      expect(resumed.getIndexState()).toBe('complete');
      expect(resumed.getNodesByName('Target')).toHaveLength(1);
      expect(resumed.getNodesByName('Caller')).toHaveLength(1);
      expect(resumed.getNodesByName('Other')).toHaveLength(1);
      expect(resumed.getPendingReferenceCount()).toBe(0);
      expect(resumed.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
      expect((await resumed.getUeScopeStatus())?.state).toBe('fresh');
      await expect(resumed.syncAutomatically()).resolves.toBeTruthy();
    } finally { await resumed.destroy(); }
  }, 60000);

  it('reruns deferred linking after interruption with no pending references', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Private/A.cpp', 'void Target() {}\nvoid Caller() { Target(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      const original = graph.resolveReferencesBatched.bind(graph);
      const mock = vi.spyOn(graph, 'resolveReferencesBatched').mockImplementation(async (...args) => {
        await original(...args);
        throw new Error('injected after reference resolution');
      });
      try { await expect(graph.indexAll()).rejects.toThrow(/injected after reference resolution/); }
      finally { mock.mockRestore(); }
      expect(graph.getPendingReferenceCount()).toBe(0);
      const instance = graph as unknown as { resolver: { refreshSynthesis: (...args: never[]) => Promise<unknown>; resolveDeferredThisMemberRefs: (...args: never[]) => Promise<unknown> } };
      const synthesis = vi.spyOn(instance.resolver, 'refreshSynthesis');
      const deferred = vi.spyOn(instance.resolver, 'resolveDeferredThisMemberRefs');
      await graph.sync();
      expect(synthesis).toHaveBeenCalled();
      expect(deferred).toHaveBeenCalled();
      expect(graph.getIndexState()).toBe('complete');
      expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
    } finally { await graph.destroy(); }
  }, 60000);

  it.each(['missing', 'different'])('refuses initial recovery when the recorded build identity is %s', async mode => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Private/A.cpp', 'void Before() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      await expect(graph.indexAll({ onProgress: progress => {
        if (progress.phase === 'parsing' && progress.current >= 1) throw new Error('injected interruption');
      } })).rejects.toThrow(/injected interruption/);
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const pending = JSON.parse(queries.getMetadata('ue_engine_scope_pending_v1')!);
      if (mode === 'missing') delete pending.buildIdentity;
      else pending.buildIdentity = '0'.repeat(64);
      queries.setMetadata('ue_engine_scope_pending_v1', JSON.stringify(pending));
      await expect(graph.sync()).rejects.toThrow(/recorded runtime build identity/i);
      expect(graph.getIndexState()).not.toBe('complete');
    } finally { await graph.destroy(); }
  }, 60000);

  it('refuses to reuse a complete UE index from a different runtime build', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Private/A.cpp', 'void Before() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const applied = JSON.parse(queries.getMetadata('ue_engine_scope_applied_v1')!);
      applied.buildIdentity = '0'.repeat(64);
      queries.setMetadata('ue_engine_scope_applied_v1', JSON.stringify(applied));
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await expect(graph.syncAutomatically()).rejects.toThrow(/different or unverified runtime/i);
      expect(graph.getNodesByName('Before')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 60000);

  it('changes the runtime identity when code or grammar bytes change', async () => {
    write('runtime/extraction/parser.js', 'module.exports = 1;');
    write('runtime/extraction/parser.wasm', 'first');
    write('package-lock.json', '{}');
    write('package.json', '{}');
    const runtime = path.join(root, 'runtime');
    const dependencies = process.cwd();
    const original = await ueRuntimeBuildIdentity(runtime, dependencies);
    write('runtime/.test-build-engine.json', '{"temporary":true}');
    expect(await ueRuntimeBuildIdentity(runtime, dependencies)).toBe(original);
    const priorWorkers = process.env.CODEGRAPH_PARSE_WORKERS;
    process.env.CODEGRAPH_PARSE_WORKERS = priorWorkers === '1' ? '2' : '1';
    try { expect(await ueRuntimeBuildIdentity(runtime, dependencies)).toBe(original); }
    finally { if (priorWorkers === undefined) delete process.env.CODEGRAPH_PARSE_WORKERS; else process.env.CODEGRAPH_PARSE_WORKERS = priorWorkers; }
    write('runtime/extraction/parser.js', 'module.exports = 2;');
    const changedCode = await ueRuntimeBuildIdentity(runtime, dependencies);
    expect(changedCode).not.toBe(original);
    write('runtime/extraction/parser.wasm', 'second');
    const changedGrammar = await ueRuntimeBuildIdentity(runtime, dependencies);
    expect(changedGrammar).not.toBe(changedCode);
    write('kernel/codegraph-kernel.node', 'native-one');
    const changedNative = await ueRuntimeBuildIdentity(runtime, dependencies);
    expect(changedNative).not.toBe(changedGrammar);
    const previous = process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL = '0';
    try { expect(await ueRuntimeBuildIdentity(runtime, dependencies)).not.toBe(changedNative); }
    finally { if (previous === undefined) delete process.env.CODEGRAPH_KERNEL; else process.env.CODEGRAPH_KERNEL = previous; }
  });

  it('refuses to reuse an interrupted candidate if its source inputs changed', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/A.cpp';
    write(file, 'void Before() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      await expect(graph.indexAll({ onProgress: progress => {
        if (progress.phase === 'parsing' && progress.current >= 1) throw new Error('injected interruption');
      } })).rejects.toThrow(/injected interruption/);
      write(file, 'void After() {}\n');
      await expect(graph.sync()).rejects.toThrow(/source scope changed/i);
      expect(graph.getIndexState()).not.toBe('complete');
    } finally { await graph.destroy(); }
  }, 60000);
});
