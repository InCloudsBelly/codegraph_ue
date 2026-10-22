import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { SYNTH_PASSES } from '../src/resolution/callback-synthesizer';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

type Files = Record<string, string>;
const rules = (name: string, body = '', base = 'ModuleRules') =>
  `using UnrealBuildTool;\npublic class ${name} : ${base} {\n public ${name}(ReadOnlyTargetRules Target) : base(Target) {\n${body}\n }\n}\n`;
const core: Files = {
  'Source/Main/Main.Build.cs': rules('Main',
    'PublicDependencyModuleNames.Add("Shared");\nPrivateDependencyModuleNames.Add("Shared");\nDynamicallyLoadedModuleNames.Add("Dynamic");\nif (Target.bBuildEditor) PrivateDependencyModuleNames.Add("Editor");'),
  'Source/Shared/Shared.Build.cs': rules('Shared'),
  'Source/Dynamic/Dynamic.Build.cs': rules('Dynamic'),
  'Source/Editor/Editor.Build.cs': rules('Editor'),
};
const roots: string[] = [];
const graphs: CodeGraph[] = [];
const write = (root: string, files: Files) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
};
async function indexed(files: Files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-modules-'));
  roots.push(root); write(root, files);
  for (const file of Object.keys(files)) fs.utimesSync(path.join(root, file), 1_700_000_000, 1_700_000_000);
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return { root, graph };
}
const moduleEdges = (graph: CodeGraph, file = 'Source/Main/Main.Build.cs') => {
  const node = graph.getNodesInFile(file).find(n => n.kind === 'file');
  return node ? graph.getOutgoingEdges(node.id).filter(e => e.metadata?.synthesizedBy === 'ue-module') : [];
};
const naturalEdges = (graph: CodeGraph) => graph.getFiles().flatMap(f => moduleEdges(graph, f.path))
  .map(e => [graph.getNode(e.source)?.filePath, graph.getNode(e.target)?.qualifiedName,
    e.kind, e.provenance, e.metadata]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}, 30_000);

describe('UE Build.cs module graph', () => {
  it('indexes file dependencies with distinct static, dynamic and conditional evidence', async () => {
    const { graph } = await indexed(core);
    expect(graph.getFileDependencies('Source/Main/Main.Build.cs')).toEqual(expect.arrayContaining([
      'Source/Shared/Shared.Build.cs', 'Source/Dynamic/Dynamic.Build.cs', 'Source/Editor/Editor.Build.cs',
    ]));
    const edges = moduleEdges(graph);
    const shared = edges.find(e => graph.getNode(e.target)?.filePath === 'Source/Shared/Shared.Build.cs')!;
    expect(shared.metadata?.ueDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'public', conditional: false }),
      expect.objectContaining({ kind: 'private', conditional: false }),
    ]));
    expect(edges.find(e => graph.getNode(e.target)?.filePath === 'Source/Dynamic/Dynamic.Build.cs'))
      .toMatchObject({ provenance: 'heuristic', metadata: { ueDependencies: [expect.objectContaining({ kind: 'dynamic' })] } });
    expect(edges.find(e => graph.getNode(e.target)?.filePath === 'Source/Editor/Editor.Build.cs')?.metadata?.ueDependencies)
      .toEqual([expect.objectContaining({ kind: 'private', conditional: true })]);
    const declaration = edges.find(e => e.metadata?.ueModuleDeclaration === true)!;
    expect(declaration.metadata).toMatchObject({ ueModuleName: 'Main', complete: false });
    const answer = await new ToolHandler(graph).execute('codegraph_node', { file: 'Source/Shared/Shared.Build.cs' });
    expect(JSON.stringify(answer)).toContain('Source/Main/Main.Build.cs');
  }, 120_000);

  it('does not reinterpret ordinary C# classes or choose an ambiguous module by basename', async () => {
    const files = { ...core,
      'Source/Ordinary/Ordinary.Build.cs': rules('Ordinary', 'PublicDependencyModuleNames.Add("Shared");', 'OrdinaryBase'),
      'Other/Shared/Shared.Build.cs': rules('Shared'),
    };
    const { graph } = await indexed(files);
    expect(moduleEdges(graph, 'Source/Ordinary/Ordinary.Build.cs')).toEqual([]);
    expect(moduleEdges(graph).filter(e => e.metadata?.ueDependencies && graph.getNode(e.target)?.name === 'Shared.Build.cs')).toEqual([]);
    expect(moduleEdges(graph).find(e => e.metadata?.ueModuleDeclaration)?.metadata?.unresolvedDependencies)
      .toContainEqual(expect.objectContaining({ name: 'Shared', reason: 'ambiguous-module' }));
  }, 120_000);

  it('refreshes Build.cs content with restored size and mtime and agrees with fresh indexing', async () => {
    const files = { ...core, 'Source/Main/Main.Build.cs': rules('Main', 'PublicDependencyModuleNames.Add("Shared");') };
    const { root, graph } = await indexed(files);
    const file = path.join(root, 'Source/Main/Main.Build.cs');
    const before = fs.statSync(file);
    const edited = rules('Main', 'PublicDependencyModuleNames.Add("Editor");');
    expect(Buffer.byteLength(edited)).toBe(before.size);
    fs.writeFileSync(file, edited); fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(file).size).toBe(before.size);
    expect(await graph.sync()).toMatchObject({ filesAdded: 0, filesRemoved: 0 });
    expect(graph.getFileDependencies('Source/Main/Main.Build.cs')).toContain('Source/Editor/Editor.Build.cs');
    expect(moduleEdges(graph).filter(e => e.metadata?.ueDependencies).map(e => graph.getNode(e.target)?.filePath))
      .toEqual(['Source/Editor/Editor.Build.cs']);
    const fresh = await indexed({ ...files, 'Source/Main/Main.Build.cs': edited });
    expect(naturalEdges(graph)).toEqual(naturalEdges(fresh.graph));
  }, 120_000);

  it('tracks unindexed plugin ownership and refreshes descriptor-only changes and deletion', async () => {
    const descriptor = (name: string, dependency?: string) => JSON.stringify({
      Modules: [{ Name: name, Type: 'Runtime', LoadingPhase: 'Default', PlatformAllowList: ['Win64'] }],
      Plugins: dependency ? [{ Name: dependency, Enabled: true, Optional: true, PlatformAllowList: ['Win64'] }] : [],
    });
    const files: Files = {
      'Plugins/Alpha/Alpha.uplugin': descriptor('AlphaModule', 'Bravo'),
      'Plugins/Alpha/Source/AlphaModule/AlphaModule.Build.cs': rules('AlphaModule'),
      'Plugins/RenamedBravo/Bravo.uplugin': descriptor('BravoModule'),
      'Plugins/RenamedBravo/Source/BravoModule/BravoModule.Build.cs': rules('BravoModule'),
      'Plugins/Delta/Delta.uplugin': descriptor('DeltaModule'),
      'Plugins/Delta/Source/DeltaModule/DeltaModule.Build.cs': rules('DeltaModule'),
    };
    const { root, graph } = await indexed(files);
    const source = 'Plugins/Alpha/Source/AlphaModule/AlphaModule.Build.cs';
    const bravo = 'Plugins/RenamedBravo/Source/BravoModule/BravoModule.Build.cs';
    const delta = 'Plugins/Delta/Source/DeltaModule/DeltaModule.Build.cs';
    expect(graph.getFiles().some(f => f.path.endsWith('.uplugin'))).toBe(false);
    expect(graph.getFileDependencies(source)).toContain(bravo);
    expect(moduleEdges(graph, source).find(e => e.metadata?.ueModuleDeclaration)?.metadata?.plugin)
      .toMatchObject({ name: 'Alpha', descriptorPath: 'Plugins/Alpha/Alpha.uplugin', declared: true,
        module: { name: 'AlphaModule', type: 'Runtime', conditions: { PlatformAllowList: ['Win64'] } } });
    expect(moduleEdges(graph, source).find(e => graph.getNode(e.target)?.filePath === bravo))
      .toMatchObject({ provenance: 'heuristic', metadata: { ueDependencies: [expect.objectContaining({
        kind: 'plugin', conditional: true, enabled: true, optional: true,
        conditions: { PlatformAllowList: ['Win64'] },
      })] } });
    const file = path.join(root, 'Plugins/Alpha/Alpha.uplugin');
    const before = fs.statSync(file);
    const edited = descriptor('AlphaModule', 'Delta');
    expect(Buffer.byteLength(edited)).toBe(before.size);
    fs.writeFileSync(file, edited); fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(file).size).toBe(before.size);
    const passes = SYNTH_PASSES.map(pass => vi.spyOn(pass, 'run'));
    expect(await graph.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    for (const pass of passes) expect(pass).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(graph.getFileDependencies(source)).toContain(delta);
    expect(graph.getFileDependencies(source)).not.toContain(bravo);
    const fresh = await indexed({ ...files, 'Plugins/Alpha/Alpha.uplugin': edited });
    expect(naturalEdges(graph)).toEqual(naturalEdges(fresh.graph));

    fs.unlinkSync(file); await graph.sync();
    expect(moduleEdges(graph, source).filter(e => e.metadata?.ueDependencies)).toEqual([]);
    expect(moduleEdges(graph, source).find(e => e.metadata?.ueModuleDeclaration)?.metadata)
      .toMatchObject({ complete: false, unresolvedDependencies: [expect.objectContaining({ reason: 'plugin-descriptor-unavailable' })] });
    const { ['Plugins/Alpha/Alpha.uplugin']: _removed, ...remaining } = files;
    const without = await indexed(remaining);
    expect(naturalEdges(graph)).toEqual(naturalEdges(without.graph));
  }, 120_000);

  it('reopens in a fresh source process and refreshes descriptor-only edits without preloaded C# grammar', async () => {
    const descriptor = (dependency: string) => JSON.stringify({ Modules: [{ Name: 'AlphaModule' }], Plugins: [{ Name: dependency, Enabled: true }] });
    const files: Files = {
      'Plugins/Alpha/Alpha.uplugin': descriptor('Bravo'),
      'Plugins/Alpha/Source/AlphaModule/AlphaModule.Build.cs': rules('AlphaModule'),
      'Plugins/Bravo/Bravo.uplugin': JSON.stringify({ Modules: [{ Name: 'BravoModule' }] }),
      'Plugins/Bravo/Source/BravoModule/BravoModule.Build.cs': rules('BravoModule'),
      'Plugins/Delta/Delta.uplugin': JSON.stringify({ Modules: [{ Name: 'DeltaModule' }] }),
      'Plugins/Delta/Source/DeltaModule/DeltaModule.Build.cs': rules('DeltaModule'),
    };
    const { root, graph } = await indexed(files);
    graph.close(); graphs.splice(graphs.indexOf(graph), 1);
    const output = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS,
      path.resolve('node_modules/vite-node/vite-node.mjs'), '--script',
      path.resolve('__tests__/fixtures/ue-module-reopen.mts')], {
      cwd: path.resolve('.'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, UE_MODULE_TEST_ROOT: root, UE_MODULE_TEST_DESCRIPTOR: descriptor('Delta') },
    });
    const result = JSON.parse(output.split('\n').find(line => line.startsWith('UE_MODULE_RESULT '))!.slice('UE_MODULE_RESULT '.length));
    expect(result.parserInitiallyMissing).toBe(true);
    expect(result.sync).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    const fresh = await indexed({ ...files, 'Plugins/Alpha/Alpha.uplugin': descriptor('Delta') });
    expect(result.edges).toEqual(naturalEdges(fresh.graph));
  }, 120_000);

  it('removes only module-owned relationships when a Build.cs disappears', async () => {
    const { root, graph } = await indexed(core);
    expect(graph.getFileDependencies('Source/Main/Main.Build.cs')).toContain('Source/Dynamic/Dynamic.Build.cs');
    fs.unlinkSync(path.join(root, 'Source/Dynamic/Dynamic.Build.cs'));
    await graph.sync();
    expect(graph.getFileDependencies('Source/Main/Main.Build.cs')).not.toContain('Source/Dynamic/Dynamic.Build.cs');
    expect(moduleEdges(graph).find(e => e.metadata?.ueModuleDeclaration)?.metadata?.unresolvedDependencies)
      .toContainEqual(expect.objectContaining({ name: 'Dynamic', kind: 'dynamic', reason: 'module-not-indexed' }));
    const { ['Source/Dynamic/Dynamic.Build.cs']: _removed, ...remaining } = core;
    const fresh = await indexed(remaining);
    expect(naturalEdges(graph)).toEqual(naturalEdges(fresh.graph));
  }, 120_000);
});

describe('module-owned edge replacement', () => {
  it('deletes only matching owner and source, preserves malformed metadata, and joins rollback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-module-owner-'));
    roots.push(root);
    const connection = DatabaseConnection.initialize(path.join(root, 'test.db'));
    try {
      const queries = new QueryBuilder(connection.getDb());
      for (const name of ['A', 'B']) {
        const filePath = `${name}.Build.cs`;
        queries.upsertFile({ path: filePath, contentHash: 'test', language: 'csharp', size: 1,
          modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
        queries.insertNode({ id: `file:${filePath}`, kind: 'file', name: filePath, qualifiedName: filePath,
          filePath, language: 'csharp', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 1 });
      }
      const source = 'file:A.Build.cs';
      const target = 'file:B.Build.cs';
      queries.insertEdges([
        { source, target, kind: 'imports', line: 1, metadata: { synthesizedBy: 'ue-module' } },
        { source, target, kind: 'imports', line: 2, metadata: { synthesizedBy: 'other-owner' } },
        { source: target, target: source, kind: 'imports', line: 4, metadata: { synthesizedBy: 'ue-module' } },
      ]);
      connection.getDb().prepare('INSERT INTO edges(source,target,kind,line,metadata) VALUES(?,?,?,?,?)')
        .run(source, target, 'imports', 3, '{malformed');
      expect(queries.deleteSynthesizedEdgesByOwner('ue-module', [])).toBe(0);
      expect(() => queries.runInTransaction(() => {
        queries.deleteSynthesizedEdgesByOwner('ue-module', [source]);
        throw new Error('rollback projection');
      })).toThrow('rollback projection');
      expect(queries.getOutgoingEdges(source)).toHaveLength(3);
      expect(queries.deleteSynthesizedEdgesByOwner('ue-module', [source])).toBe(1);
      expect(queries.getOutgoingEdges(source)).toHaveLength(2);
      expect(queries.getOutgoingEdges(target)).toHaveLength(1);
    } finally { connection.close(); }
  });
});
