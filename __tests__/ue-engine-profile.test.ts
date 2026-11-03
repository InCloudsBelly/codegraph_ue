import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import * as fileLimits from '../src/file-limits';
import { ToolHandler } from '../src/mcp/tools';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import type { QueryBuilder } from '../src/db/queries';

describe('UE engine source profile', () => {
  let root: string;

  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-engine-profile-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

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
      write('.codegraph/indexing.json', '{ invalid json');
      const refused = await handler.execute('codegraph_search', { query: 'CurrentName' });
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
    const BuiltCodeGraph = require('../dist').default as typeof CodeGraph;
    const graph = BuiltCodeGraph.initSync(root);
    expect((await graph.indexAll()).success).toBe(true);
    await graph.destroy();
    const cli = (...args: string[]) => execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, path.resolve('dist/bin/codegraph.js'), ...args], {
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
