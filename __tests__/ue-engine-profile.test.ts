import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import * as fileLimits from '../src/file-limits';
import * as callbackSynthesis from '../src/resolution/callback-synthesizer';
import { ToolHandler } from '../src/mcp/tools';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { detectLanguage } from '../src/extraction/grammars';
import type { QueryBuilder } from '../src/db/queries';
import type { ReferenceResolver } from '../src/resolution';

describe('UE engine source profile', () => {
  let root: string;

  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-engine-profile-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it.each(['initial', 'existing'] as const)('preserves and retries failed UE synthesis during %s indexing', async mode => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', `
DECLARE_MULTICAST_DELEGATE(FReady);
class UOwner {
  FReady Ready;
public:
  void Handle() {}
  void Setup() { Ready.AddUObject(this, &UOwner::Handle); }
  void Dispatch() { Ready.Broadcast(); }
};
`);
    let graph = CodeGraph.initSync(root);
    try {
      if (mode === 'existing') expect((await graph.indexAll()).success).toBe(true);
      const failure = vi.spyOn(callbackSynthesis, 'synthesizeCallbackEdges')
        .mockRejectedValueOnce(new Error('injected UE synthesis failure'));
      await expect(graph.indexAll()).rejects.toThrow('injected UE synthesis failure');
      failure.mockRestore();
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
      expect((graph as unknown as { queries: QueryBuilder }).queries.getMetadata('synthesis_pending')).toBe('1');
      graph.destroy();
      graph = CodeGraph.openSync(root);
      await graph.sync();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      const dispatch = graph.getNodesByQualifiedName('UOwner::Dispatch').find(node => node.kind === 'method');
      const handle = graph.getNodesByQualifiedName('UOwner::Handle').find(node => node.kind === 'method');
      expect(dispatch).toBeDefined();
      expect(handle).toBeDefined();
      expect(graph.getOutgoingEdges(dispatch!.id)).toContainEqual(expect.objectContaining({
        target: handle!.id, metadata: expect.objectContaining({ synthesizedBy: 'unreal-delegate' }),
      }));
    } finally {
      vi.restoreAllMocks();
      graph.destroy();
    }
  }, 30_000);

  it('does not silently skip a failed UE delegate pass on a large graph', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const context = (resolver as unknown as { context: Parameters<typeof callbackSynthesis.synthesizeCallbackEdges>[1] }).context;
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      vi.spyOn(queries, 'getNodeAndEdgeCount').mockReturnValue({ nodes: 1_500_001, edges: 0 });
      const pool = { size: 2, runSynthPass: async (name: string) => {
        if (name === 'unrealDelegates') throw new Error('injected worker failure');
        return { edges: [], ms: 0 };
      } };
      await expect(callbackSynthesis.synthesizeCallbackEdges(queries, context, undefined, pool, undefined, undefined,
        { requireAllPasses: true })).rejects.toThrow(/unrealDelegates.*injected worker failure/);
    } finally {
      vi.restoreAllMocks();
      graph.destroy();
    }
  }, 30_000);

  it('drains a concurrent main-thread fallback before reporting a synthesis failure', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    const graph = CodeGraph.initSync(root);
    let release!: () => void;
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const context = (resolver as unknown as { context: Parameters<typeof callbackSynthesis.synthesizeCallbackEdges>[1] }).context;
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      let started!: () => void, failed!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const failedPromise = new Promise<void>(resolve => { failed = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const field = callbackSynthesis.SYNTH_PASSES.find(pass => pass.name === 'fieldEdges')!;
      const delegate = callbackSynthesis.SYNTH_PASSES.find(pass => pass.name === 'unrealDelegates')!;
      vi.spyOn(field, 'run').mockImplementation(async () => { started(); await hold; return []; });
      vi.spyOn(delegate, 'run').mockImplementation(async () => { failed(); throw new Error('injected fallback failure'); });
      const pool = { size: 2, runSynthPass: async (name: string) => {
        if (name === 'fieldEdges' || name === 'unrealDelegates') throw new Error('injected worker failure');
        return { edges: [], ms: 0 };
      } };
      const operation = callbackSynthesis.synthesizeCallbackEdges(queries, context, undefined, pool, undefined, undefined,
        { requireAllPasses: true });
      let settled = false;
      const settledPromise = operation.then(() => { settled = true; }, () => { settled = true; });
      try {
        await Promise.all([startedPromise, failedPromise]);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
      } finally {
        release();
        await settledPromise;
      }
      await expect(operation).rejects.toThrow('injected fallback failure');
    } finally {
      release?.();
      vi.restoreAllMocks();
      graph.destroy();
    }
  }, 30_000);

  it('drains worker lanes when concurrent main-thread synthesis work fails', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    const graph = CodeGraph.initSync(root);
    let release!: () => void;
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const context = (resolver as unknown as { context: Parameters<typeof callbackSynthesis.synthesizeCallbackEdges>[1] }).context;
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const pool = { size: 2, runSynthPass: async (name: string) => {
        if (name === 'cFnPtrEdges') { started(); await hold; }
        return { edges: [], ms: 0 };
      } };
      const operation = callbackSynthesis.synthesizeCallbackEdges(queries, context, undefined, pool, undefined,
        () => { throw new Error('injected concurrent main-work failure'); }, { requireAllPasses: true });
      let settled = false;
      const settledPromise = operation.then(() => { settled = true; }, () => { settled = true; });
      try {
        await startedPromise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
      } finally {
        release();
        await settledPromise;
      }
      await expect(operation).rejects.toThrow('injected concurrent main-work failure');
    } finally {
      release?.();
      graph.destroy();
    }
  }, 30_000);

  it('aborts an unresponsive worker after a required synthesis pass fails', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    const graph = CodeGraph.initSync(root);
    let release!: () => void;
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const context = (resolver as unknown as { context: Parameters<typeof callbackSynthesis.synthesizeCallbackEdges>[1] }).context;
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      vi.spyOn(queries, 'getNodeAndEdgeCount').mockReturnValue({ nodes: 1_500_001, edges: 0 });
      const hold = new Promise<void>(resolve => { release = resolve; });
      let aborts = 0;
      const pool = { size: 2, runSynthPass: async (name: string) => {
        if (name === 'cFnPtrEdges') await hold;
        if (name === 'unrealDelegates') throw new Error('injected required-pass failure');
        return { edges: [], ms: 0 };
      }, abort: async () => { aborts++; release(); } };
      const operation = callbackSynthesis.synthesizeCallbackEdges(queries, context, undefined, pool, undefined, undefined,
        { requireAllPasses: true });
      const settled = operation.then(() => true, () => true);
      try {
        const completed = await Promise.race([settled, new Promise<false>(resolve => setTimeout(() => resolve(false), 3000))]);
        expect(completed).toBe(true);
        expect(aborts).toBe(1);
        await expect(operation).rejects.toThrow(/unrealDelegates.*injected required-pass failure/);
      } finally {
        release();
        await settled;
      }
    } finally {
      release?.();
      vi.restoreAllMocks();
      graph.destroy();
    }
  }, 30_000);

  it('keeps ordinary projects on their existing best-effort synthesis policy', async () => {
    write('main.cpp', 'void EngineEntry() {}\n');
    const graph = CodeGraph.initSync(root);
    try {
      vi.spyOn(callbackSynthesis, 'synthesizeCallbackEdges').mockRejectedValueOnce(new Error('optional synthesis failure'));
      expect((await graph.indexAll()).success).toBe(true);
    } finally {
      vi.restoreAllMocks();
      graph.destroy();
    }
  }, 30_000);

  it('indexes only selected UE C/C++ and one uniquely referenced plugin, excluding tests and unrelated files', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: {
      plugins: ['Engine/Plugins/Project/Seed'], excludePlugins: [], maxDepth: 3,
    } }));
    write('Engine/Source/Runtime/Core/Public/Core.h', '#include "Auto/AutoHeader.h"\nclass FEngineCore {};\n');
    write('Engine/Source/Runtime/Core/Private/Core.cpp', '#include "Core.h"\nvoid EngineEntry() {}\n');
    write('Engine/Source/Runtime/Core/Private/Tests/CoreTests.cpp', '#if WITH_DEV_AUTOMATION_TESTS\nvoid MustNotIndexTest() {}\n#endif\n');
    write('Engine/Source/Runtime/AIModule/Classes/EnvironmentQuery/Tests/EnvQueryTest_Distance.h', 'class UEnvQueryTest_Distance {};\n');
    write('Engine/Source/Runtime/Core/Core.Build.cs', 'class MustNotIndexBuildRules {}\n');
    write('Engine/Plugins/Project/Seed/Seed.uplugin', '{"Modules":[{"Name":"Seed"}]}');
    write('Engine/Plugins/Project/Seed/Source/Seed/Private/Seed.cpp', 'void ManualPluginEntry() {}\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{"Modules":[{"Name":"Auto"}]}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/AutoHeader.h', 'class FAutoPluginHeader {};\n');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Private/Auto.cpp', 'void AutoPluginEntry() {}\n');
    write('Engine/Plugins/Runtime/Unrelated/Unrelated.uplugin', '{"Modules":[{"Name":"Unrelated"}]}');
    write('Engine/Plugins/Runtime/Unrelated/Source/Unrelated/Private/Unrelated.cpp', 'void UnrelatedPluginEntry() {}\n');
    write('Client/Source/Client.cpp', 'void ClientEntry() {}\n');
    write('Samples/Example.cpp', 'void SampleEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });

    const graph = CodeGraph.initSync(root);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);
      expect(graph.getFile('Engine/Source/Runtime/Core/Private/Core.cpp')).toBeTruthy();
      expect(graph.getFile('Engine/Source/Runtime/Core/Public/Core.h')).toBeTruthy();
      for (const name of ['FEngineCore', 'EngineEntry', 'ManualPluginEntry', 'FAutoPluginHeader', 'AutoPluginEntry', 'UEnvQueryTest_Distance']) {
        expect(graph.getNodesByName(name), name).toHaveLength(1);
      }
      for (const name of ['MustNotIndexTest', 'MustNotIndexBuildRules', 'UnrelatedPluginEntry', 'ClientEntry', 'SampleEntry']) {
        expect(graph.getNodesByName(name), name).toHaveLength(0);
      }
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not advance on a no-op automatic sync and advances one layer for an explicit request', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', '#include "First/First.h"\nvoid EngineEntry() {}\n');
    for (const name of ['First', 'Second', 'Third', 'Fourth']) {
      const base = `Engine/Plugins/Runtime/${name}`;
      write(`${base}/${name}.uplugin`, `{ "Modules": [{ "Name": "${name}" }] }`);
      write(`${base}/Source/${name}/Public/${name}/${name}.h`, `class F${name} {};\n`);
    }
    write('Engine/Plugins/Runtime/First/Source/First/Private/First.cpp', '#include "Second/Second.h"\n');
    write('Engine/Plugins/Runtime/Second/Source/Second/Private/Second.cpp', '#include "Third/Third.h"\n');
    write('Engine/Plugins/Runtime/Third/Source/Third/Private/Third.cpp', '#include "Fourth/Fourth.h"\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });

    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FFirst')).toHaveLength(1);
      expect(graph.getNodesByName('FSecond')).toHaveLength(0);
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FSecond')).toHaveLength(0);
      await graph.sync({ expandUePlugins: true });
      expect(graph.getNodesByName('FSecond')).toHaveLength(1);
      expect(graph.getNodesByName('FThird')).toHaveLength(0);
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FThird')).toHaveLength(0);
      await graph.sync({ expandUePlugins: true });
      expect(graph.getNodesByName('FThird')).toHaveLength(1);
      await graph.sync({ expandUePlugins: true });
      expect(graph.getNodesByName('FFourth')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 60000);

  it('adds a new direct plugin on source change and removes an explicitly excluded plugin', async () => {
    const policy = (excludePlugins: string[] = []) => write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], excludePlugins, maxDepth: 3 } }));
    policy();
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{"Modules":[{"Name":"Auto"}]}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h', 'class FAutoPlugin {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(0);
      write('Engine/Source/Runtime/Core/Core.cpp', '#include "Auto/Auto.h"\nvoid EngineEntry() {}\n');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(1);
      policy(['Auto']);
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(0);
      expect(fs.existsSync(path.join(root, 'Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h'))).toBe(true);
    } finally { await graph.destroy(); }
  }, 60000);

  it('keeps an interrupted scope update non-fresh until an explicit recovery finishes', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineBefore() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      let changed = false;
      await expect(graph.sync({ expandUePlugins: true, onProgress: progress => {
        if (!changed && progress.phase === 'scanning') {
          changed = true;
          write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineAfter() {}\n');
        }
      } })).rejects.toThrow(/scope inputs changed/i);
      expect(graph.getIndexState()).toBe('partial');
      await expect(graph.syncAutomatically()).rejects.toThrow(/incomplete index/i);
      await graph.sync();
      expect(graph.getIndexState()).toBe('complete');
      expect(graph.getNodesByName('EngineAfter')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 60000);

  it('removes proven test-only branches from a mixed production file without moving production lines', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    write('Engine/Source/Runtime/Core/Mixed.cpp', [
      'void ProductionBefore() {}',
      '#if WITH_DEV_AUTOMATION_TESTS',
      'void AutomationOnly() {}',
      '#else',
      'void ProductionElse() {}',
      '#endif',
      'void ProductionAfter() {}',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('AutomationOnly')).toHaveLength(0);
      expect(graph.getNodesByName('ProductionBefore')[0]?.startLine).toBe(1);
      expect(graph.getNodesByName('ProductionElse')[0]?.startLine).toBe(5);
      expect(graph.getNodesByName('ProductionAfter')[0]?.startLine).toBe(7);
    } finally { await graph.destroy(); }
  }, 30000);

  it.each(['Engine/Plugins/Runtime/Auto', 'Auto'])('honors explicit plugin exclusion %s with an oversize unrelated source', async excluded => {
    const policy = (excludePlugins: string[] = []) => write('.codegraph/indexing.json', JSON.stringify({ ueEngine: {
      plugins: ['Engine/Plugins/Runtime/Auto'], excludePlugins, maxDepth: 3,
    } }));
    policy();
    write('Engine/Source/Runtime/Core/TooLarge.h', `// ${'x'.repeat(1024 * 1024 + 1)}\n`);
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{"Modules":[{"Name":"Auto"}]}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto.h', 'class FAutoPlugin {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(1);
      policy([excluded]);
      await graph.sync();
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect((await graph.getUeScopeStatus())?.incompleteFiles).toContain('Engine/Source/Runtime/Core/TooLarge.h');
    } finally { graph.destroy(); }
  }, 30000);

  it('honors a whole-plugin path exclusion with an oversize unrelated source', async () => {
    const policy = (exclude: string[] = []) => write('.codegraph/indexing.json', JSON.stringify({
      ueEngine: { plugins: ['Engine/Plugins/Runtime/Auto'], maxDepth: 3 }, exclude,
    }));
    policy();
    write('Engine/Source/Runtime/Core/TooLarge.h', `// ${'x'.repeat(1024 * 1024 + 1)}\n`);
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{"Modules":[{"Name":"Auto"}]}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto.h', 'class FAutoPlugin {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(1);
      policy(['Engine/Plugins/Runtime/Auto/']);
      await graph.sync();
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { graph.destroy(); }
  }, 30000);

  it('retains an unproven unreachable plugin when an unrelated source is oversize', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    const source = 'Engine/Source/Runtime/Core/Core.cpp';
    write(source, '#include "Auto/Auto.h"\nvoid Core() {}\n');
    write('Engine/Source/Runtime/Core/TooLarge.h', `// ${'x'.repeat(1024 * 1024 + 1)}\n`);
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{"Modules":[{"Name":"Auto"}]}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h', 'class FAutoPlugin {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(1);
      write(source, 'void Core() {}\n');
      await expect(graph.sync()).rejects.toThrow(/observation is incomplete/i);
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(1);
    } finally { graph.destroy(); }
  }, 30000);

  it('does not synthesize a delegate binding from a test-only branch inside a production method', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Owner.cpp', [
      'DECLARE_MULTICAST_DELEGATE(FReady);',
      'class UOwner {',
      '  FReady Ready;',
      'public:',
      '  void ProductionHandle() {}',
      '  void TestHandle() {}',
      '  void Setup() {',
      '    Ready.AddUObject(this, &UOwner::ProductionHandle);',
      '#if WITH_DEV_AUTOMATION_TESTS',
      '    Ready.AddUObject(this, &UOwner::TestHandle);',
      '#endif',
      '  }',
      '  void Dispatch() { Ready.Broadcast(); }',
      '};',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const dispatch = graph.getNodesByQualifiedName('UOwner::Dispatch').find(node => node.kind === 'method');
      expect(dispatch).toBeTruthy();
      const targets = graph.getOutgoingEdges(dispatch!.id).filter(edge => edge.metadata?.synthesizedBy === 'unreal-delegate')
        .map(edge => graph.getNode(edge.target)?.qualifiedName);
      expect(targets).toContain('UOwner::ProductionHandle');
      expect(targets).not.toContain('UOwner::TestHandle');
    } finally { await graph.destroy(); }
  }, 30000);

  it('reports a changed scope as stale before the index is reconciled', async () => {
    const policy = (extraRoots: string[] = []) => write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots, maxDepth: 3 } }));
    policy();
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Engine/Extras/Tool/Tool.cpp', 'void OptionalTool() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      policy(['Engine/Extras/Tool']);
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      expect(graph.getNodesByName('OptionalTool')).toHaveLength(0);
      await graph.syncAutomatically();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect(graph.getNodesByName('OptionalTool')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);
  it('does not discover plugins from excluded source, and removes newly excluded files on sync', async () => {
    const policy = (exclude: string[] = []) => write('.codegraph/indexing.json', JSON.stringify({
      include: ['Client/**'], exclude, ueEngine: { plugins: [], maxDepth: 3 },
    }));
    policy(['Engine/Source/Runtime/Core/Excluded.cpp']);
    write('Engine/Source/Runtime/Core/Excluded.cpp', '#include "Auto/Auto.h"\nvoid ExcludedEntry() {}\n');
    write('Engine/Source/Runtime/Core/Kept.cpp', 'void InitiallyKept() {}\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h', 'class FAutoPlugin {};\n');
    write('Client/Source/Client.cpp', 'void ClientEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('ExcludedEntry')).toHaveLength(0);
      expect(graph.getNodesByName('FAutoPlugin')).toHaveLength(0);
      expect(graph.getNodesByName('ClientEntry')).toHaveLength(0);
      policy(['Engine/Source/Runtime/Core/Excluded.cpp', 'Engine/Source/Runtime/Core/Kept.cpp']);
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('InitiallyKept')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('can discover a production plugin header in a Tests directory', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', '#include "Auto/Tests/Feature.h"\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Tests/Feature.h', 'class FProductionFeature {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FProductionFeature')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);

  it('enforces the UE boundary even for explicit indexFiles calls', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Client/Source/Client.cpp', 'void ClientEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      await expect(graph.indexFiles(['Client/Source/Client.cpp'])).rejects.toThrow(/require sync/i);
      expect(graph.getNodesByName('ClientEntry')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not mark fresh when a file changes during parsing and then changes back', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Core.cpp';
    const before = 'void OriginalEntry() {}\n';
    write(file, before);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      let staged = false;
      let restored = false;
      await expect(graph.sync({ expandUePlugins: true, onProgress: progress => {
        if (!staged && progress.phase === 'scanning') {
          staged = true;
          write(file, 'void TransientEntry() {}\n');
        } else if (staged && !restored && progress.phase === 'resolving') {
          restored = true;
          write(file, before);
        }
      } })).rejects.toThrow(/indexed source.*changed/i);
      expect(staged && restored).toBe(true);
      expect(graph.getIndexState()).toBe('partial');
      await graph.sync();
      expect(graph.getNodesByName('OriginalEntry')).toHaveLength(1);
      expect(graph.getNodesByName('TransientEntry')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('excludes Objective-C headers and clearly generated C++ while retaining normal C++ headers', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/Bridge.h', '@interface Bridge : NSObject\n@end\n');
    write('Engine/Source/Runtime/Core/Public/Message.pb.h', 'class FGeneratedMessage {};\n');
    write('Engine/Source/Runtime/Core/Public/Native.h', 'class FNative {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getFile('Engine/Source/Runtime/Core/Public/Bridge.h')).toBeFalsy();
      expect(graph.getFile('Engine/Source/Runtime/Core/Public/Message.pb.h')).toBeFalsy();
      expect(graph.getNodesByName('FNative')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);

  it('excludes whole-file UE generator output without excluding a handwritten file with a generated section', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const generated = 'Engine/Source/Runtime/Core/Generated.h';
    const handwritten = 'Engine/Source/Runtime/Core/MixedGenerated.cpp';
    write(generated, '// Copyright Epic Games, Inc. All Rights Reserved.\n// generated\n#ifndef GENERATED_H\n#define GENERATED_H\n//~ generated from code at syms/metaprogram/syms_metaprogram_serial.c:1068\nvoid GeneratedOnly();\n#endif\n');
    write(handwritten, '// Copyright Epic Games, Inc. All Rights Reserved.\n//~ NOTE: Generated Code\n#include "generated/Stuff.h"\nvoid HandwrittenCode() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getFile(generated)).toBeFalsy();
      expect(graph.getNodesByName('HandwrittenCode')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);

  it('recognizes forward-declaration C++ headers without reclassifying C comments or strings', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const cpp = 'Engine/Source/Runtime/Core/Public/Forward.h';
    const c = 'Engine/Source/Runtime/Core/Public/PlainC.h';
    const referenceOnly = 'Engine/Source/Runtime/Core/Public/ReferenceOnly.h';
    write(cpp, 'class FSceneInterface;\nvoid RenderWaterInfoTexture(FSceneInterface& Scene);\n');
    write(c, '// class NotAClass;\nconst char* message = "class AlsoNotAClass;";\ntypedef struct CThing { int value; } CThing;\nenum { A=1, B=2 };\nvoid F(int values[sizeof(A & B)]);\nstatic inline int combine(int a, int b) { return foo(a & b); }\n');
    write(referenceOnly, 'void RequiresReference(int& value);\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getFile(cpp)?.language).toBe('cpp');
      expect(graph.getFile(cpp)?.errors?.some(error => error.code === 'parse_error') ?? false).toBe(false);
      expect(graph.getFile(c)?.language).toBe('c');
      expect(graph.getFile(referenceOnly)?.language).toBe('cpp');
    } finally { await graph.destroy(); }
  }, 30000);

  it('classifies long multiline declarations without backtracking on C expressions', () => {
    const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
    const script = path.join(root, 'header-language-fixture.cjs');
    fs.writeFileSync(script, [
      'const { detectLanguage } = require(process.argv[2]);',
      "const args = Array.from({ length: 50 }, (_, i) => `int p${i},\\n`).join('');",
      "const prefix = 'void A(\\n' + args;",
      "console.log(JSON.stringify([detectLanguage('probe.h', prefix + 'int &ref);\\n'), detectLanguage('probe.h', prefix + 'int values[sizeof(A & B)]);\\n')]));",
    ].join('\n'));
    const output = execFileSync(process.execPath, [script, path.join(dist, 'extraction/grammars.js')], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    expect(JSON.parse(output)).toEqual(['cpp', 'c']);
  }, 10000);

  it('does not infer C++ from reference-like text in C expressions or macro definitions', () => {
    expect(detectLanguage('plain.h', 'void Use(void) { a & call(b & c); }\n')).toBe('c');
    expect(detectLanguage('plain.h', 'void f(int); static inline void g(int A, int B) { do f(A & B); while (0); }\n')).toBe('c');
    expect(detectLanguage('plain.h', 'void f(int); static inline void g(int A, int B) { if (A) f(0); else f(A & B); }\n')).toBe('c');
    expect(detectLanguage('plain.h', 'void f(int); static inline void g(int A, int B) { label: f(A & B); }\n')).toBe('c');
    expect(detectLanguage('plain.h', 'enum { A=3, B=1 };\nvoid F(struct Bits { unsigned a:1, b:A & B, c:1; } value);\n')).toBe('c');
    for (const operator of ['__real__', '__real', '__imag__', '__imag', '__alignof__', '__alignof']) {
      expect(detectLanguage('plain.h', `_Complex double Sample(int); static inline void Use(int A,int B){ ${operator} Sample(A & B); }\n`)).toBe('c');
    }
    expect(detectLanguage('plain.h', '#define DECL(x) void x(int &value)\nvoid Plain(int n);\n')).toBe('c');
    expect(detectLanguage('reference.h', 'void F(\n  int first,\n  int& value);\n')).toBe('cpp');
    expect(detectLanguage('reference.h', 'void* Find(int& value);\n')).toBe('cpp');
    expect(detectLanguage('reference.h', 'int * Find(int& value);\n')).toBe('cpp');
    expect(detectLanguage('reference.h', `/* ${'documentation '.repeat(600)} */\nvoid F(int& value);\n`)).toBe('cpp');
    expect(detectLanguage('plain.h', 'void F(int values[sizeof(A & B)]);\n')).toBe('c');
  });

  it('indexes a C++ function declaration without treating its matching definition as an unrelated candidate', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const header = 'Engine/Source/Runtime/Core/Public/Water.h';
    const implementation = 'Engine/Source/Runtime/Core/Private/Water.cpp';
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(header, 'class FSceneInterface;\nvoid HeaderDeclaration(int& Scene);\n');
    write(implementation, 'void RenderWaterInfoTexture(int& Scene);\nvoid RenderWaterInfoTexture(int& Scene) {}\n');
    write(callerFile, 'void Caller(int& Scene) { RenderWaterInfoTexture(Scene); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesInFile(header).some(node => node.name === 'HeaderDeclaration')).toBe(true);
      expect(graph.getNodesInFile(implementation).filter(node => node.name === 'RenderWaterInfoTexture')).toHaveLength(2);
      const caller = graph.getNodesByName('Caller')[0]!;
      const targets = graph.getOutgoingEdges(caller.id).filter(edge => edge.kind === 'calls').map(edge => graph.getNode(edge.target));
      expect(targets.some(node => node?.filePath === implementation && node.name === 'RenderWaterInfoTexture')).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'RenderWaterInfoTexture')?.candidates?.length ?? 0).toBe(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('links a C call to its same-file void-parameter definition', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Work.c';
    write(file, 'void Work(void);\nvoid Work(void) {}\nvoid Caller(void) { Work(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesByName('Caller')[0]!;
      const targets = graph.getOutgoingEdges(caller.id).filter(edge => edge.kind === 'calls').map(edge => graph.getNode(edge.target));
      expect(targets.some(node => node?.name === 'Work' && node.startLine === 2)).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(file).find(ref => ref.fromNodeId === caller.id && ref.referenceName === 'Work')?.candidates?.length ?? 0).toBe(0);
    } finally { graph.destroy(); }
  }, 30000);

  it('keeps C empty-parameter declarations as candidates instead of merging them with void prototypes', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Work.c';
    write(file, 'void Work();\nvoid Work(void) {}\nvoid Caller(void) { Work(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesByName('Caller')[0]!;
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'Work')).toBe(false);
      expect(graph.getUnresolvedReferencesInFile(file).find(ref => ref.fromNodeId === caller.id && ref.referenceName === 'Work')?.candidates).toHaveLength(2);
    } finally { graph.destroy(); }
  }, 30000);

  it('indexes ordinary C and C++ declarator forms without inventing functions for pointers', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const cppHeader = 'Engine/Source/Runtime/Core/Public/Forms.h';
    const cHeader = 'Engine/Source/Runtime/Core/Public/Plain.h';
    write(cppHeader, 'class FForceCpp;\nvoid First(), Second();\nint* Make();\nint& Get();\nvoid (*Callback)();\nint Existing = 7, Mixed();\n');
    write(cHeader, 'void CFirst(), CSecond();\nint* CMake();\nvoid (*CCallback)();\nint CExisting = 7, CMixed();\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const cppNames = graph.getNodesInFile(cppHeader).filter(node => node.kind === 'function').map(node => node.name);
      const cNames = graph.getNodesInFile(cHeader).filter(node => node.kind === 'function').map(node => node.name);
      expect(cppNames).toEqual(expect.arrayContaining(['First', 'Second', 'Make', 'Get', 'Mixed']));
      expect(cNames).toEqual(expect.arrayContaining(['CFirst', 'CSecond', 'CMake', 'CMixed']));
      expect(cppNames).not.toContain('Callback');
      expect(cNames).not.toContain('CCallback');
      expect(graph.getNodesInFile(cppHeader).some(node => node.name === 'Existing' && node.kind === 'variable')).toBe(true);
      expect(graph.getNodesInFile(cHeader).some(node => node.name === 'CExisting' && node.kind === 'variable')).toBe(true);
    } finally { await graph.destroy(); }
  }, 30000);

  it('records parameter type references for UE function declarations', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Public/Signatures.h';
    write(file, 'class FArg {};\nvoid Plain(FArg* value);\nint* Make(FArg* value);\nint& Get(FArg* value);\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      for (const name of ['Plain', 'Make', 'Get']) {
        const fn = graph.getNodesByName(name).find(node => node.filePath === file && node.kind === 'function');
        expect(fn, name).toBeDefined();
        const targets = graph.getOutgoingEdges(fn!.id).filter(edge => edge.kind === 'references')
          .map(edge => graph.getNode(edge.target)?.name);
        const unresolved = graph.getUnresolvedReferencesInFile(file)
          .find(ref => ref.fromNodeId === fn!.id && ref.referenceKind === 'references' && ref.referenceName === 'FArg');
        expect(targets, name).not.toContain('FArg');
        expect(unresolved?.candidates, name).toEqual([`${file}:1 FArg`]);
      }
    } finally { graph.destroy(); }
  }, 30000);

  it('updates declaration type candidates as same-named types appear and disappear', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const base = 'Engine/Source/Runtime/Core/Public';
    const header = `${base}/Api.h`, first = `${base}/First.h`, second = `${base}/Second.h`, third = `${base}/Third.h`;
    write(header, 'int* Make(FParam* value);\n');
    write(first, 'class FParam {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const ref = () => graph.getUnresolvedReferencesInFile(header)
        .find(value => value.referenceKind === 'references' && value.referenceName === 'FParam');
      expect(ref()?.candidates).toEqual([`${first}:1 FParam`]);
      write(second, 'class FParam {};\n');
      await graph.syncAutomatically();
      expect(ref()?.candidates).toEqual([`${first}:1 FParam`, `${second}:1 FParam`]);
      fs.unlinkSync(path.join(root, first));
      await graph.syncAutomatically();
      expect(ref()?.candidates).toEqual([`${second}:1 FParam`]);
      fs.unlinkSync(path.join(root, second));
      await graph.syncAutomatically();
      expect(ref()?.candidates).toEqual([]);
      write(third, 'class FParam {};\n');
      await graph.syncAutomatically();
      expect(ref()?.candidates).toEqual([`${third}:1 FParam`]);
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const actualRefresh = resolver.refreshUeIncludeCandidates.bind(resolver);
      const interrupted = vi.spyOn(resolver, 'refreshUeIncludeCandidates').mockImplementationOnce(async names => {
        await actualRefresh(names);
        throw new Error('injected type candidate refresh interruption');
      });
      write(third, '\nclass FParam {};\n');
      try { await expect(graph.syncAutomatically()).rejects.toThrow('injected type candidate refresh interruption'); }
      finally { interrupted.mockRestore(); }
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
      await graph.sync();
      expect(ref()?.candidates).toEqual([`${third}:2 FParam`]);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect((await graph.getUeScopeStatus())?.unresolvedCount).toBeGreaterThan(0);
      const handler = new ToolHandler(graph);
      try {
        const answer = await handler.execute('codegraph_search', { query: 'Make' });
        expect(answer.content[0]?.text).toMatch(/references FParam.*candidates/i);
      } finally { await handler.closeAll(); }
    } finally { graph.destroy(); }
  }, 60000);

  it('keeps template parameters and default expressions out of declaration type candidates', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Public/Templates.h';
    write(file, [
      'class T {}; class U {}; class FArg {}; class FCallbackType {}; class FOther {}; class FResult {};',
      'template<typename T, class U = FArg, int N = 2> FResult* Make(T* value, U (&array)[N], void (*callback)(FCallbackType*), FArg* arg = Factory<FOther>());',
      'FResult *First(FArg*), &Second(FArg*);',
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const namesFor = (name: string) => {
        const fn = graph.getNodesByName(name).find(node => node.filePath === file && node.kind === 'function');
        expect(fn, name).toBeDefined();
        return graph.getUnresolvedReferencesInFile(file)
          .filter(ref => ref.fromNodeId === fn!.id && ref.referenceKind === 'references').map(ref => ref.referenceName);
      };
      expect(namesFor('Make')).toEqual(expect.arrayContaining(['FArg', 'FCallbackType', 'FResult']));
      for (const excluded of ['T', 'U', 'N', 'callback', 'value', 'FOther']) expect(namesFor('Make')).not.toContain(excluded);
      for (const name of ['First', 'Second']) expect(namesFor(name)).toEqual(expect.arrayContaining(['FArg', 'FResult']));
    } finally { graph.destroy(); }
  }, 30000);

  it('does not collapse distinct pointer and reference overload declarations', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/Overloads.h', 'class FForceCpp;\nvoid Decide(int* value);\nvoid Decide(int& value);\n');
    write('Engine/Source/Runtime/Core/Private/Overloads.cpp', 'void Decide(int* value) {}\n');
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(callerFile, 'void Caller(int& value) { Decide(value); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Decide')?.candidates).toHaveLength(3);
      const caller = graph.getNodesByName('Caller')[0]!;
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'Decide')).toBe(false);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not merge a function template with a non-template of the same parameters', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/Overloads.h', 'template <typename T> void Decide(int value);\n');
    write('Engine/Source/Runtime/Core/Private/Overloads.cpp', 'void Decide(int value) {}\n');
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(callerFile, 'void Caller(int value) { Decide(value); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Decide')?.candidates).toHaveLength(2);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not merge declarations and definitions whose short type names can refer to different aliases', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/A.h', 'namespace A { struct T {}; }\nusing A::T;\nvoid Pick(T*);\n');
    write('Engine/Source/Runtime/Core/Private/B.cpp', 'namespace B { struct T {}; }\nusing B::T;\nvoid Pick(T*) {}\n');
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(callerFile, '#include "A.h"\nvoid Caller(A::T* value) { Pick(value); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Pick')?.candidates).toHaveLength(2);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not confuse an unnamed long long parameter with a named long parameter', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/A.h', 'class FTag;\nvoid Pick(long long);\n');
    write('Engine/Source/Runtime/Core/Private/B.cpp', 'void Pick(long value) {}\n');
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(callerFile, 'void Caller(long long value) { Pick(value); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Pick')?.candidates).toHaveLength(2);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not merge a header declaration with a different file’s static definition', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/A.h', 'class FTag;\nvoid Pick(int value);\n');
    write('Engine/Source/Runtime/Core/Private/B.cpp', 'static void Pick(int value) {}\n');
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(callerFile, 'void Caller(int value) { Pick(value); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Pick')?.candidates).toHaveLength(2);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not infer that same-named declarations in different files share a translation unit', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/A.h', 'class FTag;\nvoid Pick(int value);\n');
    write('Engine/Source/Runtime/Core/Private/B.cpp', 'int Pick(int value) { return value; }\n');
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(callerFile, 'void Caller(int value) { Pick(value); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Pick')?.candidates).toHaveLength(2);
    } finally { await graph.destroy(); }
  }, 30000);

  it('warns queries and status when an indexed UE source failed to parse', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Public/Broken.h';
    write(file, 'class FBroken {\nvoid Broken( {\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getFile(file)?.errors?.some(error => error.code === 'parse_error')).toBe(true);
      const answer = await handler.execute('codegraph_explore', { query: file, maxFiles: 1 });
      expect(answer.content.map(part => part.type === 'text' ? part.text : '').join('\n')).toMatch(/parse error/i);
      const missing = await handler.execute('codegraph_explore', { query: 'CompletelyAbsentSymbol987', maxFiles: 1 });
      expect(missing.content.map(part => part.type === 'text' ? part.text : '').join('\n')).toMatch(/1 parse errors/i);
      const status = await handler.execute('codegraph_status', {});
      expect(status.content.map(part => part.type === 'text' ? part.text : '').join('\n')).toMatch(/parse errors.*1/i);
    } finally { await handler.closeAll(); await graph.destroy(); }
  }, 30000);

  it('warns about partially parsed UE files even when some symbols survive', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Public/PartlyBroken.h';
    write(file, 'class FUsable {};\nvoid Broken( {\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FUsable')).toHaveLength(1);
      expect(graph.getFile(file)?.errors?.some(error => error.code === 'partial_parse')).toBe(true);
      expect(graph.getIndexHealth().parseErrors).toContain(file);
      const answer = await handler.execute('codegraph_explore', { query: 'FUsable', maxFiles: 1 });
      expect(answer.content.map(part => part.type === 'text' ? part.text : '').join('\n')).toMatch(/parse error/i);
    } finally { await handler.closeAll(); await graph.destroy(); }
  }, 30000);

  it('checks an unchanged tracked project without reopening every source file', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['add', 'Engine'], { cwd: root, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const opened = vi.spyOn(fileLimits, 'readBoundedSourceSync');
      try {
        await graph.syncAutomatically();
        expect(opened.mock.calls.filter(([file]) => String(file).endsWith('Core.cpp'))).toHaveLength(0);
      } finally { opened.mockRestore(); }
    } finally { await graph.destroy(); }
  }, 30000);

  it('invalidates the probe for restored-mtime source edits and new plugin headers', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Core.cpp';
    write(file, 'void Before() {}\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{}');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const stats = fs.statSync(path.join(root, file));
      write(file, 'void After_() {}\n');
      fs.utimesSync(path.join(root, file), stats.atime, stats.mtime);
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('After_')).toHaveLength(1);
      write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h', 'class FNewHeader {};\n');
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
    } finally { await graph.destroy(); }
  }, 30000);

  it('updates before an MCP query and refuses stale answers when automatic update fails', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Core.cpp';
    write(file, 'void PreviousName() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write(file, 'void CurrentName() {}\n');
      const answer = await handler.execute('codegraph_search', { query: 'CurrentName' });
      expect(answer.content[0]?.text).toContain('CurrentName');
      expect(graph.getNodesByName('CurrentName')).toHaveLength(1);
      const read = handler.executeReadTool.bind(handler);
      const drift = vi.spyOn(handler, 'executeReadTool').mockImplementationOnce(async (name, args) => {
        const result = await read(name, args);
        write(file, 'void ChangedDuringQuery() {}\n');
        return result;
      });
      const changedDuringQuery = await handler.execute('codegraph_search', { query: 'CurrentName' });
      expect(changedDuringQuery.isError).toBe(true);
      expect(changedDuringQuery.content[0]?.text).toContain('cannot answer from this index');
      expect(changedDuringQuery.content[0]?.text).not.toContain('**CurrentName**');
      drift.mockRestore();
      write(file, 'void CurrentName() {}\n');
      vi.spyOn(graph, 'getUeScopeStatus').mockResolvedValueOnce(null);
      const unverifiable = await handler.execute('codegraph_search', { query: 'CurrentName' });
      expect(unverifiable.isError).toBe(true);
      expect(unverifiable.content[0]?.text).toContain('cannot verify a fresh UE scope');
      write('.codegraph/indexing.json', '{ invalid json');
      const refused = await handler.execute('codegraph_search', { query: 'CurrentName' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toMatch(/cannot.*fresh|cannot.*update|source/i);
      expect(refused.content[0]?.text).not.toContain('**CurrentName**');
    } finally { await handler.closeAll(); await graph.destroy(); }
  }, 30000);

  it('keeps ambiguous includes as candidates and does not bind angle includes to a sibling', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write(file, '#include "Other/Shared.h"\n#include <vector>\n#include "Local.h"\nvoid Use() {}\n');
    write('Engine/Source/Runtime/Core/Private/Local.h', 'class FLocal {};\n');
    write('Engine/Source/Runtime/One/Public/Other/Shared.h', 'class FSharedOne {};\n');
    write('Engine/Source/Runtime/Two/Public/Other/Shared.h', 'class FSharedTwo {};\n');
    // Make a same-name local path look plausible to the old generic fallback.
    write('Engine/Source/Runtime/Core/Private/vector.h', 'class FNotStdVector {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const refs = graph.getUnresolvedReferencesInFile(file);
      const ambiguous = refs.find(ref => ref.referenceName === 'Other/Shared.h');
      expect(ambiguous?.candidates?.sort()).toEqual([
        'Engine/Source/Runtime/One/Public/Other/Shared.h',
        'Engine/Source/Runtime/Two/Public/Other/Shared.h',
      ]);
      const sourceNodes = graph.getNodesInFile(file).map(node => node.id);
      const targets = graph.getOutgoingEdgesFrom(sourceNodes, ['imports']).map(edge => graph.getNode(edge.target)?.filePath);
      expect(refs.find(ref => ref.referenceName === 'Local.h')?.candidates)
        .toEqual(['Engine/Source/Runtime/Core/Private/Local.h']);
      expect(targets).not.toContain('Engine/Source/Runtime/Core/Private/Local.h');
      expect(targets).not.toContain('Engine/Source/Runtime/One/Public/Other/Shared.h');
      expect(targets).not.toContain('Engine/Source/Runtime/Two/Public/Other/Shared.h');
      expect(targets).not.toContain('Engine/Source/Runtime/Core/Private/vector.h');
      const handler = new ToolHandler(graph);
      try {
        const answer = await handler.execute('codegraph_search', { query: 'Use' });
        expect(answer.content[0]?.text).toContain('Other/Shared.h');
        expect(answer.content[0]?.text).toContain('candidates');
      } finally { await handler.closeAll(); }
    } finally { await graph.destroy(); }
    const reopened = CodeGraph.openSync(root);
    try {
      expect(reopened.getUnresolvedReferencesInFile(file).find(ref => ref.referenceName === 'Other/Shared.h')?.candidates).toHaveLength(2);
      fs.unlinkSync(path.join(root, 'Engine/Source/Runtime/Two/Public/Other/Shared.h'));
      await reopened.syncAutomatically();
      expect(reopened.getUnresolvedReferencesInFile(file).find(ref => ref.referenceName === 'Other/Shared.h')?.candidates)
        .toEqual(['Engine/Source/Runtime/One/Public/Other/Shared.h']);
    } finally { await reopened.destroy(); }
  }, 30000);

  it('explores an explicitly named include-only UE header and its candidate target', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Public/OnlyIncludes.h';
    const target = 'Engine/Source/Runtime/Core/Public/Other/Shared.h';
    write(file, '#pragma once\n#include "Other/Shared.h"\n');
    write(target, 'class FShared {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const answer = await handler.execute('codegraph_explore', { query: file, maxFiles: 1 });
      const text = answer.content.map(part => part.type === 'text' ? part.text : '').join('\n');
      expect(text).not.toContain('No relevant code found');
      expect(text).toContain('#include "Other/Shared.h"');
      expect(text).toContain(target);
      expect(text).toContain('(candidates)');
    } finally { await handler.closeAll(); graph.destroy(); }
  }, 30000);

  it('windows a large include-only UE header and honors an explicit line anchor', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Public/LargeIncludes.h';
    const target = 'Engine/Source/Runtime/Core/Public/Other/Shared.h';
    write(file, ['#pragma once', '#include "Other/Shared.h"', ...Array.from({ length: 300 }, (_, i) => `// marker ${i + 3}`)].join('\n'));
    write(target, 'class FShared {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const text = async (query: string): Promise<string> =>
        (await handler.execute('codegraph_explore', { query, maxFiles: 1 })).content
          .map(part => part.type === 'text' ? part.text : '').join('\n');
      const head = await text(file);
      expect(head).toContain('#include "Other/Shared.h"');
      expect(head).toContain(target);
      expect(head).toContain('(candidates)');
      expect(await text(`${file}:260`)).toContain('// marker 260');
    } finally { await handler.closeAll(); graph.destroy(); }
  }, 45000);

  it('does not expose an excluded include-only header by explicitly naming its path', async () => {
    const file = 'Engine/Source/Runtime/Core/Public/ExcludedIncludes.h';
    write('.codegraph/indexing.json', JSON.stringify({ exclude: [file], ueEngine: { plugins: [] } }));
    write(file, '#pragma once\n// EXCLUDED_PRIVATE_MARKER\n');
    write('Engine/Source/Runtime/Core/Core.cpp', 'void RetainedEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getFile(file)).toBeNull();
      const answer = await handler.execute('codegraph_explore', { query: file, maxFiles: 1 });
      const text = answer.content.map(part => part.type === 'text' ? part.text : '').join('\n');
      expect(text).not.toContain('EXCLUDED_PRIVATE_MARKER');
    } finally { await handler.closeAll(); graph.destroy(); }
  }, 30000);

  it.runIf(process.platform === 'win32')('refuses a pinned UE path replaced by a Client junction', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const directory = 'Engine/Source/Runtime/Core/Public/Pinned';
    const file = `${directory}/OnlyIncludes.h`;
    write(file, '#pragma once\n#include "Other.h"\n');
    write('Client/OnlyIncludes.h', '// CLIENT_PRIVATE_MARKER\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      fs.renameSync(path.join(root, directory), path.join(root, `${directory}Saved`));
      fs.symlinkSync(path.join(root, 'Client'), path.join(root, directory), 'junction');
      const answer = await handler.execute('codegraph_explore', { query: file, maxFiles: 1 });
      const text = answer.content.map(part => part.type === 'text' ? part.text : '').join('\n');
      expect(text).toContain('cannot update the UE scope');
      expect(text).not.toContain('CLIENT_PRIVATE_MARKER');
    } finally { await handler.closeAll(); graph.destroy(); }
  }, 30000);

  it('preserves an include written as a preprocessor expression without guessing a target', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write(file, '#include PLATFORM_HEADER\nvoid Use() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesInFile(file).some(node => node.kind === 'import' && node.signature?.includes('PLATFORM_HEADER'))).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(file).some(ref => ref.referenceName === 'PLATFORM_HEADER')).toBe(true);
    } finally { await graph.destroy(); }
  }, 30000);

  it('fully reconciles changed UE inputs even when sync receives a partial path list', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const first = 'Engine/Source/Runtime/Core/First.cpp';
    const second = 'Engine/Source/Runtime/Core/Second.cpp';
    write(first, 'void FirstBefore() {}\n');
    write(second, 'void SecondBefore() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write(first, 'void FirstAfter() {}\n');
      write(second, 'void SecondAfter() {}\n');
      await graph.sync({ paths: [first] });
      expect(graph.getNodesByName('FirstAfter')).toHaveLength(1);
      expect(graph.getNodesByName('SecondAfter')).toHaveLength(1);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { await graph.destroy(); }
  }, 30000);

  it('exposes stale UE scope to existing CLI status consumers and offers explicit expansion', async () => {
    const policy = (extraRoots: string[] = []) => write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots } }));
    policy();
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Engine/Extras/Tool/Tool.cpp', 'void OptionalTool() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    // The CLI and its initial SDK writer must use the same compiled runtime identity.
    const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
    const BuiltCodeGraph = require(dist).default as typeof CodeGraph;
    const graph = BuiltCodeGraph.initSync(root);
    expect((await graph.indexAll()).success).toBe(true);
    await graph.destroy();
    const cli = (...args: string[]) => execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.join(dist, 'bin/codegraph.js'), ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_TELEMETRY: '0' },
    });
    policy(['Engine/Extras/Tool']);
    const stale = JSON.parse(cli('status', root, '--json'));
    expect(stale.ueScope.state).toBe('stale');
    expect(stale.index.state).toBe('partial');
    cli('sync', root, '--quiet');
    const fresh = JSON.parse(cli('status', root, '--json'));
    expect(fresh.ueScope.state).toBe('fresh');
    const depth = fresh.ueScope.depth;
    cli('sync', root, '--quiet', '--expand-ue-plugins');
    expect(JSON.parse(cli('status', root, '--json')).ueScope.depth).toBe(depth + 1);
  }, 60000);

  it('refreshes the UE graph before a raw CLI query', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Core.cpp';
    write(file, 'void BeforeEdit() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
    const BuiltCodeGraph = require(dist).default as typeof CodeGraph;
    const graph = BuiltCodeGraph.initSync(root);
    try { expect((await graph.indexAll()).success).toBe(true); }
    finally { await graph.destroy(); }
    write(file, 'void AfterEdit() {}\n');
    const output = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.join(dist, 'bin/codegraph.js'),
      'query', 'AfterEdit', '--path', root, '--json'], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_TELEMETRY: '0' },
    });
    expect(JSON.parse(output).some((result: { node: { name: string } }) => result.node.name === 'AfterEdit')).toBe(true);
  }, 60000);

  it('retries a failed lock release on the next automatic UE sync', () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void BeforeEdit() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
    const script = path.join(root, 'lock-retry-fixture.cjs');
    fs.writeFileSync(script, [
      "const fs = require('fs'), path = require('path');",
      'const Graph = require(process.argv[2]).default, root = process.argv[3];',
      '(async () => {',
      '  const graph = await Graph.init(root, { index: false });',
      '  try {',
      "    if (!(await graph.indexAll()).success) throw new Error('index failed');",
      "    fs.writeFileSync(path.join(root, 'Engine/Source/Runtime/Core/Core.cpp'), 'void AfterEdit() {}\\n');",
      "    const lock = path.join(root, '.codegraph', 'codegraph.lock'), original = fs.unlinkSync;",
      "    fs.unlinkSync = file => { if (String(file) === lock) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return original(file); };",
      '    let denied = false;',
      "    try { await graph.syncAutomatically(); } catch (error) { denied = error.code === 'EPERM'; } finally { fs.unlinkSync = original; }",
      "    if (!denied) throw new Error('release failure was not reported');",
      '    await graph.syncAutomatically();',
      "    if (!graph.getNodesByName('AfterEdit').length) throw new Error('retry did not retain the update');",
      "    process.stdout.write('ok');",
      '  } finally { graph.close(); }',
      "})().catch(error => { console.error(error); process.exitCode = 1; });",
    ].join('\n'));
    const output = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, script, dist, root], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
    });
    expect(output).toContain('ok');
  }, 60000);

  it('observes Git exclude changes before retaining an untracked engine file', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Untracked.cpp';
    write(file, 'void ExcludedLater() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('ExcludedLater')).toHaveLength(1);
      write('.git/info/exclude', `${file}\n`);
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('ExcludedLater')).toHaveLength(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not expand a plugin from source hidden by Git ignore rules', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('.gitignore', 'Engine/Source/Runtime/Core/Private/Hidden.cpp\n');
    write('Engine/Source/Runtime/Core/Private/Hidden.cpp', '#include "Auto/Auto.h"\nvoid Hidden() {}\n');
    write('Engine/Source/Runtime/Core/Private/Kept.cpp', 'void Kept() {}\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h', 'class FAuto {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('Hidden')).toHaveLength(0);
      expect(graph.getNodesByName('FAuto')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('respects nested ignore rules for plugin discovery in a non-Git project', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/.gitignore', 'Private/Hidden.cpp\n');
    write('Engine/Source/Runtime/Core/Private/Hidden.cpp', '#include "Auto/Auto.h"\nvoid Hidden() {}\n');
    write('Engine/Source/Runtime/Core/Private/Kept.cpp', 'void Kept() {}\n');
    write('Engine/Plugins/Runtime/Auto/Auto.uplugin', '{}');
    write('Engine/Plugins/Runtime/Auto/Source/Auto/Public/Auto/Auto.h', 'class FAuto {};\n');
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('Hidden')).toHaveLength(0);
      expect(graph.getNodesByName('FAuto')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('settles fresh after an unrelated implementation is added to an unselected plugin', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Engine/Plugins/Runtime/Other/Other.uplugin', '{}');
    write('Engine/Plugins/Runtime/Other/Source/Other/Public/Other/Other.h', 'class FOther {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('Engine/Plugins/Runtime/Other/Source/Other/Private/Unused.cpp', 'void OutsideScope() {}\n');
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect(graph.getNodesByName('OutsideScope')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('settles fresh after a semantically unchanged Git ignore edit', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('.gitignore', '# existing\n');
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('.gitignore', '# existing\n# comment only\n');
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { await graph.destroy(); }
  }, 30000);

  it('notices when a tracked file becomes ignored without changing its source bytes', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/.gitignore', 'Hidden.cpp\n');
    const file = 'Engine/Source/Runtime/Core/Hidden.cpp';
    write(file, 'void TrackedThenIgnored() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['add', '-f', file], { cwd: root, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('TrackedThenIgnored')).toHaveLength(1);
      execFileSync('git', ['rm', '--cached', '-q', '--', file], { cwd: root, windowsHide: true });
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('TrackedThenIgnored')).toHaveLength(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { await graph.destroy(); }
  }, 30000);

  it('observes Git exclude changes inside a selected embedded plugin', async () => {
    const plugin = 'Engine/Plugins/Runtime/Seed';
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [plugin] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write(`${plugin}/Seed.uplugin`, '{}');
    const source = `${plugin}/Source/Seed/Private/Seed.cpp`;
    write(source, 'void PluginBeforeExclude() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, plugin), windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('PluginBeforeExclude')).toHaveLength(1);
      write(`${plugin}/.git/info/exclude`, 'Source/Seed/Private/Seed.cpp\n');
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('PluginBeforeExclude')).toHaveLength(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { await graph.destroy(); }
  }, 30000);

  it('observes Git exclude changes at an ancestor Engine repository boundary', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Core.cpp';
    write(file, 'void NestedEngineEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Engine'), windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('NestedEngineEntry')).toHaveLength(1);
      write('Engine/.git/info/exclude', 'Source/Runtime/Core/Core.cpp\n');
      expect((await graph.getUeScopeStatus())?.state).toBe('stale');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('NestedEngineEntry')).toHaveLength(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally { await graph.destroy(); }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('keeps tracked files after a case-only rename on Windows', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const upper = 'Engine/Source/Runtime/Core/Public/Foo.h';
    const lower = 'Engine/Source/Runtime/Core/Public/foo.h';
    write(upper, 'class FCaseRename {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['config', 'core.ignorecase', 'true'], { cwd: root, windowsHide: true });
    execFileSync('git', ['add', 'Engine'], { cwd: root, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      fs.renameSync(path.join(root, upper), path.join(root, 'Engine/Source/Runtime/Core/Public/rename-tmp.h'));
      fs.renameSync(path.join(root, 'Engine/Source/Runtime/Core/Public/rename-tmp.h'), path.join(root, lower));
      await graph.syncAutomatically();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect(graph.getNodesByName('FCaseRename')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('finds an include candidate written with different Windows path casing', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write(file, '#include "local.h"\nvoid Use() {}\n');
    write('Engine/Source/Runtime/Core/Private/Local.h', 'class FLocal {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(file).find(ref => ref.referenceName === 'local.h')?.candidates)
        .toEqual(['Engine/Source/Runtime/Core/Private/Local.h']);
    } finally { await graph.destroy(); }
  }, 30000);

  it('shows the written platform condition for a queried symbol', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Platform.cpp', '#if PLATFORM_WINDOWS\nvoid PlatformEntry() {}\n#else\nvoid OtherEntry() {}\n#endif\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    const handler = new ToolHandler(graph);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const answer = await handler.execute('codegraph_search', { query: 'PlatformEntry' });
      expect(answer.content[0]?.text).toContain('condition: PLATFORM_WINDOWS');
      expect(graph.getNodesByName('OtherEntry')).toHaveLength(1);
    } finally { await handler.closeAll(); await graph.destroy(); }
  }, 30000);

  it('does not allow extra roots to bypass plugin selection', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots: ['Engine/Plugins'] } }));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      await expect(graph.indexAll()).rejects.toThrow(/must not bypass plugin selection/i);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not enter a separate Client Git repository during an engine index or sync', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Client/Source/Client.cpp', 'void ClientEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Client'), windowsHide: true });
    // If the engine scanner enters this separate repository, Git must fail.
    write('Client/.git/config', '[invalid\n');
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      await graph.syncAutomatically();
      expect(graph.getNodesByName('ClientEntry')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('retains multiple plausible C++ call and base-type targets as candidates', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/One/Public/One.h', 'class FSharedBase {};\nvoid SharedCall() {}\n');
    write('Engine/Source/Runtime/Two/Public/Two.h', 'class FSharedBase {};\nvoid SharedCall() {}\n');
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write(file, 'class FChild : public FSharedBase {};\nvoid Caller() { SharedCall(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const refs = graph.getUnresolvedReferencesInFile(file);
      expect(refs.find(ref => ref.referenceName === 'FSharedBase')?.candidates).toHaveLength(2);
      expect(refs.find(ref => ref.referenceName === 'SharedCall')?.candidates).toHaveLength(2);
      const ids = graph.getNodesInFile(file).map(node => node.id);
      const edges = graph.getOutgoingEdgesFrom(ids, ['calls', 'extends']);
      expect(edges.some(edge => ['FSharedBase', 'SharedCall'].includes(graph.getNode(edge.target)?.name ?? ''))).toBe(false);
    } finally { await graph.destroy(); }
  }, 30000);

  it('reconsiders more than 500 existing call edges when another target appears', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Many.cpp';
    write(file, ['void SharedCall() {}', ...Array.from({ length: 501 }, (_, i) => `void Caller${i}() { SharedCall(); }`)].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const callerIds = graph.getNodesInFile(file).filter(node => node.name.startsWith('Caller')).map(node => node.id);
      expect(graph.getOutgoingEdgesFrom(callerIds, ['calls']).length).toBe(501);
      write('Engine/Source/Runtime/Other/Other.cpp', 'void SharedCall() {}\n');
      await graph.syncAutomatically();
      expect(graph.getOutgoingEdgesFrom(callerIds, ['calls']).length).toBe(0);
      const refs = graph.getUnresolvedReferencesInFile(file);
      expect(refs.filter(ref => ref.referenceName === 'SharedCall' && ref.candidates?.length === 2)).toHaveLength(501);
    } finally { await graph.destroy(); }
  }, 60000);

  it('reconsiders an existing call when its target file gains another same-named definition', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const definitions = 'Engine/Source/Runtime/Core/Definitions.cpp';
    const callerFile = 'Engine/Source/Runtime/Core/Caller.cpp';
    write(definitions, 'void SharedCall() {}\n');
    write(callerFile, 'void Caller() { SharedCall(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesByName('Caller').find(node => node.filePath === callerFile)!;
      expect(graph.getOutgoingEdges(caller.id).some(edge =>
        edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'SharedCall')).toBe(true);
      write(definitions, 'void SharedCall() {}\nnamespace Other { void SharedCall() {} }\n');
      await graph.syncAutomatically();
      const refs = graph.getUnresolvedReferencesInFile(callerFile);
      expect(refs.find(ref => ref.referenceName === 'SharedCall')?.candidates).toHaveLength(2);
      expect(graph.getOutgoingEdges(caller.id).some(edge =>
        edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'SharedCall')).toBe(false);
      write(definitions, 'void SharedCall() {}\n');
      await graph.syncAutomatically();
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'SharedCall')?.candidates?.length ?? 0).toBe(0);
      expect(graph.getOutgoingEdges(caller.id).some(edge =>
        edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'SharedCall')).toBe(true);
    } finally { await graph.destroy(); }
  }, 30000);

  it('reconsiders existing calls when a C++ definition changes parameter types', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Public/Decl.h', 'class FTag;\n');
    const definition = 'Engine/Source/Runtime/Core/Private/Definition.cpp';
    const callerFile = 'Engine/Source/Runtime/Core/Private/Caller.cpp';
    write(definition, 'void Pick(int value);\nvoid Pick(int value) {}\n');
    write(callerFile, 'void Caller() { Pick(1); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesByName('Caller')[0]!;
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls' && graph.getNode(edge.target)?.filePath === definition)).toBe(true);
      write(definition, 'void Pick(int value);\nvoid Pick(long value) {}\n');
      await graph.syncAutomatically();
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Pick')?.candidates).toHaveLength(2);
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'Pick')).toBe(false);
    } finally { await graph.destroy(); }
  }, 30000);

  it('retries every high-fan-in UE call after its definition is added', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const callerFile = 'Engine/Source/Runtime/Core/ManyCallers.cpp';
    write(callerFile, Array.from({ length: 505 }, (_, i) => `void UECaller${i}() { LaterDefined(); }`).join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUnresolvedReferencesInFile(callerFile, 1000).filter(ref => ref.referenceName === 'LaterDefined')).toHaveLength(505);
      write('Engine/Source/Runtime/Core/NewDefinition.cpp', 'void LaterDefined() {}\n');
      await graph.syncAutomatically();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect(graph.getUnresolvedReferencesInFile(callerFile, 1000).filter(ref => ref.referenceName === 'LaterDefined')).toHaveLength(0);
      const target = graph.getNodesByName('LaterDefined').find(node => node.kind === 'function');
      expect(target).toBeDefined();
      for (let i = 0; i < 505; i++) {
        const caller = graph.getNodesByName(`UECaller${i}`).find(node => node.kind === 'function');
        expect(caller).toBeDefined();
        expect(graph.getOutgoingEdges(caller!.id).some(edge => edge.kind === 'calls' && edge.target === target!.id)).toBe(true);
      }
    } finally { graph.destroy(); }
  }, 60_000);

  it('retries a UE member call when its target is added after the caller', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const callerFile = 'Engine/Source/Runtime/Core/Caller.cpp';
    const definition = 'Engine/Source/Runtime/Core/Target.h';
    write(callerFile, '#include "Target.h"\nvoid UECaller(FDeferred* value) { value->LaterMember(); }\n');
    write(definition, 'class FDeferred {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const before = graph.getUnresolvedReferencesInFile(callerFile, 1000);
      expect(before.find(ref => ref.referenceName.includes('LaterMember'))?.referenceName).toBe('value.LaterMember');
      write(definition, 'class FDeferred { public: void LaterMember() {} };\n');
      await graph.syncAutomatically();
      const caller = graph.getNodesByName('UECaller')[0]!;
      const target = graph.getNodesByName('LaterMember').find(node => node.kind === 'method');
      expect(target).toBeDefined();
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls' && edge.target === target!.id)).toBe(true);
    } finally { graph.destroy(); }
  }, 30_000);

  it('persists bounded reference batches before an interrupted incremental sync', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Definition.cpp', 'void SharedCall() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('Engine/Source/Runtime/Core/Many.cpp',
        Array.from({ length: 1200 }, (_, i) => `void Caller${i}() { SharedCall(); }`).join('\n'));
      let total = 0;
      await expect(graph.sync({ onProgress: progress => {
        if (progress.phase === 'resolving' && progress.current >= 500) {
          total = progress.total;
          throw new Error('interrupt after progress');
        }
      } })).rejects.toThrow('interrupt after progress');
      expect(total).toBeGreaterThan(500);
      expect(graph.getPendingReferenceCount()).toBeGreaterThan(0);
      expect(graph.getPendingReferenceCount()).toBeLessThan(total);
      await graph.sync();
      expect(graph.getPendingReferenceCount()).toBe(0);
      expect(graph.getIndexState()).toBe('complete');
      const last = graph.getNodesByName('Caller1199')[0]!;
      expect(graph.getOutgoingEdges(last.id).some(edge =>
        edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'SharedCall')).toBe(true);
    } finally { await graph.destroy(); }
  }, 60000);

  it('recovers failed calls when interrupted after storing their new definition', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const callerFile = 'Engine/Source/Runtime/Core/Caller.cpp';
    write(callerFile, 'void Caller() { FutureCall(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('Engine/Source/Runtime/Core/Future.cpp', 'void FutureCall() {}\n');
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const retry = vi.spyOn(queries, 'getRetryableFailedReferences').mockImplementationOnce(() => {
        throw new Error('injected retry interruption');
      });
      try { await expect(graph.syncAutomatically()).rejects.toThrow(/injected retry interruption/); }
      finally { retry.mockRestore(); }
      expect(graph.getIndexState()).toBe('partial');
      await graph.sync();
      const caller = graph.getNodesByName('Caller')[0]!;
      expect(graph.getOutgoingEdges(caller.id).some(edge =>
        edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'FutureCall')).toBe(true);
    } finally { await graph.destroy(); }
  }, 60000);

  it('retries failed references through bounded name and row batches', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const callerFile = 'Engine/Source/Runtime/Core/Caller.cpp';
    write(callerFile, Array.from({ length: 40 }, (_, i) => `void Caller${i}() { Future${i}(); }`).join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('Engine/Source/Runtime/Core/Future.cpp', Array.from({ length: 40 }, (_, i) => `void Future${i}() {}`).join('\n'));
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const retry = vi.spyOn(queries, 'getRetryableFailedReferences');
      try {
        await graph.syncAutomatically();
        expect(retry.mock.calls.length).toBeGreaterThan(1);
        expect(Math.max(...retry.mock.calls.map(args => args[0].length))).toBeLessThanOrEqual(1);
      } finally { retry.mockRestore(); }
      const callers = graph.getNodesInFile(callerFile).filter(node => node.kind === 'function').map(node => node.id);
      expect(graph.getOutgoingEdgesFrom(callers, ['calls'])).toHaveLength(40);
    } finally { await graph.destroy(); }
  }, 60000);

  it('resolves retry prerequisites before calls across page boundaries', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const calls = Array.from({ length: 600 }, (_, i) => `void Caller${i}() { ${i < 300 ? 'FutureA' : 'FutureB'}(); }`);
    write('Engine/Source/Runtime/Core/Caller.cpp', [...calls, 'class FChild : public FNewBase {};'].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('Engine/Source/Runtime/Core/Definitions.cpp', 'void FutureA() {}\nvoid FutureB() {}\nclass FNewBase {};\n');
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const batches = vi.spyOn(resolver, 'resolveAndPersistListYielding');
      try {
        await graph.syncAutomatically();
        const order = batches.mock.calls.flatMap(args => args[0].map(ref => ref.referenceKind));
        const lastPrerequisite = Math.max(order.lastIndexOf('imports'), order.lastIndexOf('extends'), order.lastIndexOf('implements'));
        expect(lastPrerequisite).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('calls')).toBeGreaterThan(lastPrerequisite);
      } finally { batches.mockRestore(); }
    } finally { await graph.destroy(); }
  }, 60000);

  it('invalidates cached resolution when a deletion is interrupted and retried in the same instance', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const definition = 'Engine/Source/Runtime/Core/Future.cpp';
    write(definition, 'void FutureCall() {}\n');
    write('Engine/Source/Runtime/Core/Caller.cpp', 'void Caller() { FutureCall(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      fs.unlinkSync(path.join(root, definition));
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const remove = queries.deleteFile.bind(queries);
      const deletion = vi.spyOn(queries, 'deleteFile').mockImplementationOnce(file => {
        remove(file);
        throw new Error('injected delete interruption');
      });
      try { await expect(graph.syncAutomatically()).rejects.toThrow(/injected delete interruption/); }
      finally { deletion.mockRestore(); }
      await graph.sync();
      const caller = graph.getNodesByName('Caller')[0]!;
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls')).toBe(false);
      expect(graph.getUnresolvedReferencesInFile('Engine/Source/Runtime/Core/Caller.cpp')
        .some(ref => ref.referenceName === 'FutureCall')).toBe(true);
    } finally { await graph.destroy(); }
  }, 60000);

  it('reconsiders previously indexed callers when another definition appears during recovery', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const callerFile = 'Engine/Source/Runtime/Core/A.cpp';
    write('Engine/Source/Runtime/Core/Definition.cpp', 'void Foo() {}\n');
    write(callerFile, 'void Caller() { Foo(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write(callerFile, 'void Caller() { int value = 1; Foo(); }\n');
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const retry = vi.spyOn(queries, 'getRetryableFailedReferences').mockImplementationOnce(() => {
        throw new Error('injected retry interruption');
      });
      try { await expect(graph.syncAutomatically()).rejects.toThrow(/injected retry interruption/); }
      finally { retry.mockRestore(); }
      write('Engine/Source/Runtime/Core/B.cpp', 'void Foo() {}\n');
      await graph.sync();
      const caller = graph.getNodesByName('Caller')[0]!;
      expect(graph.getOutgoingEdges(caller.id).some(edge => edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'Foo')).toBe(false);
      expect(graph.getUnresolvedReferencesInFile(callerFile).find(ref => ref.referenceName === 'Foo')?.candidates).toHaveLength(2);
    } finally { await graph.destroy(); }
  }, 60000);

  it('resumes the remaining ambiguous edges after interruption between replay batches', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Many.cpp';
    write(file, ['void SharedCall() {}', ...Array.from({ length: 501 }, (_, i) => `void Caller${i}() { SharedCall(); }`)].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      write('Engine/Source/Runtime/Other/Other.cpp', 'void SharedCall() {}\n');
      const queries = (graph as unknown as { queries: QueryBuilder }).queries;
      const original = queries.replaceResolutionEdgesWithUnresolvedRefs.bind(queries);
      let interrupted = false;
      const replay = vi.spyOn(queries, 'replaceResolutionEdgesWithUnresolvedRefs').mockImplementation((ids, refs) => {
        const count = original(ids, refs);
        if (!interrupted && ids.length === 500) { interrupted = true; throw new Error('injected replay interruption'); }
        return count;
      });
      try { await expect(graph.syncAutomatically()).rejects.toThrow(/injected replay interruption/); }
      finally { replay.mockRestore(); }
      expect(interrupted).toBe(true);
      expect(graph.getIndexState()).toBe('partial');
    } finally { await graph.destroy(); }
    const recovered = CodeGraph.openSync(root);
    try {
      await recovered.sync();
      const callers = recovered.getNodesInFile(file).filter(node => node.name.startsWith('Caller')).map(node => node.id);
      expect(recovered.getOutgoingEdgesFrom(callers, ['calls'])).toHaveLength(0);
      expect(recovered.getUnresolvedReferencesInFile(file).filter(ref => ref.referenceName === 'SharedCall' && ref.candidates?.length === 2)).toHaveLength(501);
      expect(recovered.getIndexState()).toBe('complete');
    } finally { await recovered.destroy(); }
  }, 60000);

  it('keeps a uniquely determined lexical C++ call despite same-named functions elsewhere', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Scopes.cpp';
    write(file, 'namespace A { void Foo() {} void Use() { Foo(); } }\nnamespace B { void Foo() {} }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesByQualifiedName('A::Use').find(node => node.kind === 'function');
      expect(caller).toBeTruthy();
      const targets = graph.getOutgoingEdges(caller!.id).filter(edge => edge.kind === 'calls')
        .map(edge => graph.getNode(edge.target)?.qualifiedName);
      expect(targets).toContain('A::Foo');
      expect(targets).not.toContain('B::Foo');
    } finally { await graph.destroy(); }
  }, 30000);

  it('keeps ambiguous unselected plugin headers as candidates without indexing either plugin', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write(file, '#include "SharedModule/Feature.h"\nvoid Use() {}\n');
    for (const parent of ['One', 'Two']) {
      const plugin = `Engine/Plugins/${parent}/Plugin${parent}`;
      write(`${plugin}/Plugin${parent}.uplugin`, '{}');
      write(`${plugin}/Source/SharedModule/Public/SharedModule/Feature.h`, `class FPlugin${parent} {};\n`);
    }
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FPluginOne')).toHaveLength(0);
      expect(graph.getNodesByName('FPluginTwo')).toHaveLength(0);
      expect(graph.getUnresolvedReferencesInFile(file).find(ref => ref.referenceName === 'SharedModule/Feature.h')?.candidates?.sort()).toEqual([
        'Engine/Plugins/One/PluginOne/Source/SharedModule/Public/SharedModule/Feature.h',
        'Engine/Plugins/Two/PluginTwo/Source/SharedModule/Public/SharedModule/Feature.h',
      ]);
      fs.unlinkSync(path.join(root, 'Engine/Plugins/Two/PluginTwo/Source/SharedModule/Public/SharedModule/Feature.h'));
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FPluginOne')).toHaveLength(1);
      expect(graph.getUnresolvedReferencesInFile(file).find(ref => ref.referenceName === 'SharedModule/Feature.h')?.candidates)
        .toEqual(['Engine/Plugins/One/PluginOne/Source/SharedModule/Public/SharedModule/Feature.h']);
    } finally { await graph.destroy(); }
  }, 30000);

  it('infers module associations from indexed C++ references without Build.cs', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write(file, '#include "Other/Other.h"\nvoid Use() {}\n');
    write('Engine/Source/Runtime/Other/Public/Other/Other.h', 'class FOther {};\n');
    write('Engine/Source/Runtime/Core/Core.Build.cs', 'class NoBuildRuleParsing {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getUeModuleRelations([file]).relations).toContainEqual(expect.objectContaining({
        from: 'Engine/Source/Runtime/Core', to: 'Engine/Source/Runtime/Other', inferred: true,
      }));
      expect(graph.getNodesByName('NoBuildRuleParsing')).toHaveLength(0);
      const handler = new ToolHandler(graph);
      try {
        const answer = await handler.execute('codegraph_search', { query: 'Use' });
        expect(answer.content[0]?.text).toContain('UE module associations');
        expect(answer.content[0]?.text).toContain('inferred from C/C++ source');
      } finally { await handler.closeAll(); }
    } finally { await graph.destroy(); }
  }, 30000);

  it('removes unreachable auto-added plugin cycles after their last root reference disappears', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], maxDepth: 3 } }));
    const entry = 'Engine/Source/Runtime/Core/Private/Core.cpp';
    write(entry, '#include "First/First.h"\n');
    for (const plugin of ['First', 'Second']) {
      const rootPath = `Engine/Plugins/Runtime/${plugin}`;
      write(`${rootPath}/${plugin}.uplugin`, '{}');
      write(`${rootPath}/Source/${plugin}/Public/${plugin}/${plugin}.h`, `class F${plugin} {};\n`);
    }
    write('Engine/Plugins/Runtime/First/Source/First/Private/First.cpp', '#include "Second/Second.h"\n');
    write('Engine/Plugins/Runtime/Second/Source/Second/Private/Second.cpp', '#include "First/First.h"\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      await graph.sync({ expandUePlugins: true });
      expect(graph.getNodesByName('FFirst')).toHaveLength(1);
      expect(graph.getNodesByName('FSecond')).toHaveLength(1);
      write(entry, 'void Unrelated() {}\n');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FFirst')).toHaveLength(0);
      expect(graph.getNodesByName('FSecond')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);
});
