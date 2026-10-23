import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { CPP_INCLUDE_SNAPSHOT_KEY, checkCppIncludeSnapshot } from '../src/resolution/cpp-include-environment';
import { resurrectRefFromDroppedEdge } from '../src/resolution/resurrect-ref';

// Load the shipped pool and worker together: the source pool deliberately
// declines to start when resolver-worker.js is absent beside its .ts file.
const CodeGraph = (require('../dist') as typeof import('../src')).default;
const { ResolverPool } = require('../dist/resolution/resolver-pool') as typeof import('../src/resolution/resolver-pool');
const { ReferenceResolver } = require('../dist/resolution') as typeof import('../src/resolution');
const { SYNTH_PASSES } = require('../dist/resolution/callback-synthesizer') as typeof import('../src/resolution/callback-synthesizer');
const roots: string[] = [];
const graphs: Array<InstanceType<typeof CodeGraph>> = [];
const rules = (name: string, body = '', base = 'ModuleRules') =>
  `using UnrealBuildTool; public class ${name} : ${base} { public ${name}(ReadOnlyTargetRules Target) : base(Target) { ${body} } }`;
const source = 'Plugins/Main/Source/Main/Main.Build.cs';
const target = 'Source/Shared/Shared.Build.cs';

async function indexed(ordinary = false, additional: Record<string, string> = {}) {
  vi.stubEnv('CODEGRAPH_PARALLEL_RESOLVE_MIN', '0');
  vi.stubEnv('CODEGRAPH_RESOLVE_WORKERS', '1');
  vi.stubEnv('CODEGRAPH_NO_PARALLEL_RESOLVE', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-pooled-'));
  roots.push(root);
  for (const [file, content] of Object.entries({
    [source]: rules('Main', 'PublicDependencyModuleNames.Add("Shared");', ordinary ? 'OrdinaryBase' : 'ModuleRules'),
    [target]: rules('Shared', '', ordinary ? 'OrdinaryBase' : 'ModuleRules'),
    'Plugins/Main/Main.uplugin': JSON.stringify({ Modules: [{ Name: 'Main' }] }),
    ...additional,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
    fs.utimesSync(path.join(root, file), 1_700_000_000, 1_700_000_000);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return { root, graph };
}

function close(graph: InstanceType<typeof CodeGraph>) {
  graph.close();
  graphs.splice(graphs.indexOf(graph), 1);
}

function database(root: string) {
  const connection = DatabaseConnection.open(path.join(root, '.codegraph/codegraph.db'));
  return { connection, queries: new QueryBuilder(connection.getDb()) };
}

function includeTargets(graph: InstanceType<typeof CodeGraph>, file: string) {
  const anchor = graph.getNodesInFile(file).find(node => node.kind === 'file')!;
  return graph.getOutgoingEdges(anchor.id).filter(edge => edge.kind === 'imports')
    .map(edge => graph.getNode(edge.target)?.filePath);
}

async function legacyIncludes(missingSnapshot = false) {
  const implementation = 'Plugins/Main/Source/Main/Private/use.cpp';
  const included = 'Source/Shared/Public/SharedThing.h';
  const second = 'Source/Shared/Public/SecondThing.h';
  const wrong = 'Source/Unrelated/Public/SecondThing.h';
  const { root, graph } = await indexed(false, {
    [implementation]: '#include <SharedThing.h>\n#include <SecondThing.h>\nvoid Keep() {}\nvoid Use() { Keep(); }',
    [included]: 'struct SharedThing {};', [second]: 'struct SecondThing {};', [wrong]: 'struct WrongThing {};',
  });
  close(graph);
  const { connection, queries } = database(root);
  try {
    const anchor = queries.getNodesByFile(implementation).find(node => node.kind === 'file')!;
    const edges = queries.getResolutionEdgesFromFiles('cpp', [implementation]).filter(edge => edge.kind === 'imports');
    const failed = edges.find(edge => edge.metadata?.refName === 'SharedThing.h')!;
    const stale = edges.find(edge => edge.metadata?.refName === 'SecondThing.h')!;
    expect(failed).toBeDefined(); expect(stale).toBeDefined();
    const ref = resurrectRefFromDroppedEdge(failed)!;
    queries.deleteEdgesByIds([failed.edgeId, stale.edgeId]);
    const wrongAnchor = queries.getNodesByFile(wrong).find(node => node.kind === 'file')!;
    queries.insertEdges([{ ...stale, target: wrongAnchor.id }, {
      source: anchor.id, target: wrongAnchor.id, kind: 'references', line: 7,
      metadata: { refName: 'PreserveThisReference', refKind: 'references' },
    }]);
    queries.insertUnresolvedRefsBatch([ref,
      { ...ref, referenceKind: 'calls', line: 8 },
      { ...ref, referenceKind: 'references', line: 9 },
    ]);
    const pending = queries.getUnresolvedReferencesFromNodes([anchor.id], ['imports', 'calls', 'references']);
    queries.markReferencesFailedByRowIds(pending.map(ref => ({ rowId: ref.rowId!, referenceName: ref.referenceName,
      referenceKind: ref.referenceKind })));
    const preserved = queries.getResolutionEdgesFromFiles('cpp', [implementation]).filter(edge => edge.kind !== 'imports');
    const failedNonImports = queries.getUnresolvedReferencesFromNodes([anchor.id], ['calls', 'references']);
    const files = queries.getAllFiles();
    const observedSnapshot = queries.getMetadata(CPP_INCLUDE_SNAPSHOT_KEY)!;
    queries.setMetadata('ue_module_metadata_observed', '0');
    connection.getDb().prepare('DELETE FROM project_metadata WHERE key = ?').run('ue_module_metadata_version');
    if (missingSnapshot) connection.getDb().prepare('DELETE FROM project_metadata WHERE key = ?').run(CPP_INCLUDE_SNAPSHOT_KEY);
    else queries.setMetadata(CPP_INCLUDE_SNAPSHOT_KEY, JSON.stringify({ version: 1, complete: false, bounded: true,
      ueModules: false, files: [implementation, included, second, wrong], dependencies: [] }));
    return { root, implementation, included, second, wrong, anchor, preserved, failedNonImports, files, observedSnapshot };
  } finally { connection.close(); }
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

describe('pooled UE module metadata', () => {
  it.each([false, true])('repairs only legacy include imports once without synthesis (missing snapshot: %s)', async missing => {
    const fixture = await legacyIncludes(missing);
    const passes = SYNTH_PASSES.map(pass => vi.spyOn(pass, 'run'));
    const poolPasses = vi.spyOn(ResolverPool.prototype, 'runSynthPass');
    const resolve = vi.spyOn(ReferenceResolver.prototype, 'resolveAndPersist');
    const graph = await CodeGraph.open(fixture.root, { sync: false }); graphs.push(graph);
    expect(await graph.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(includeTargets(graph, fixture.implementation)).toEqual(expect.arrayContaining([fixture.included, fixture.second]));
    expect(includeTargets(graph, fixture.implementation)).not.toContain(fixture.wrong);
    expect(resolve.mock.calls.flatMap(([refs]) => refs).map(ref => ref.referenceKind)).not.toEqual([]);
    expect(resolve.mock.calls.flatMap(([refs]) => refs).every(ref => ref.referenceKind === 'imports')).toBe(true);
    for (const pass of passes) expect(pass).not.toHaveBeenCalled();
    expect(poolPasses).not.toHaveBeenCalled();
    const decisions = resolve.mock.calls.length;
    await graph.sync();
    expect(resolve).toHaveBeenCalledTimes(decisions);
    close(graph);
    const { connection, queries } = database(fixture.root);
    try {
      expect(queries.getAllFiles()).toEqual(fixture.files);
      expect(queries.getResolutionEdgesFromFiles('cpp', [fixture.implementation]).filter(edge => edge.kind !== 'imports'))
        .toEqual(fixture.preserved);
      expect(queries.getUnresolvedReferencesFromNodes([fixture.anchor.id], ['calls', 'references'])).toEqual(fixture.failedNonImports);
      expect(queries.getUnresolvedReferencesFromNodes([fixture.anchor.id], ['imports'])).toEqual([]);
      expect(queries.getMetadata('ue_module_metadata_version')).toBe('1');
      expect(queries.getMetadata('ue_module_metadata_observed')).toBe('1');
    } finally { connection.close(); }
  }, 120_000);

  it('rolls back a failed legacy include batch and leaves its repair marker unadvanced', async () => {
    const fixture = await legacyIncludes();
    vi.spyOn(ReferenceResolver.prototype, 'resolveAndPersist').mockImplementationOnce(() => {
      throw new Error('legacy include retry failure');
    });
    const graph = await CodeGraph.open(fixture.root, { sync: false }); graphs.push(graph);
    await expect(graph.sync()).rejects.toThrow('legacy include retry failure');
    close(graph);
    const { connection, queries } = database(fixture.root);
    try {
      expect(queries.getMetadata('ue_module_metadata_version')).toBeNull();
      expect(queries.getOutgoingEdges(fixture.anchor.id).filter(edge => edge.kind === 'imports')
        .map(edge => queries.getNodeById(edge.target)?.filePath)).toEqual([fixture.wrong]);
      expect(queries.getUnresolvedReferencesFromNodes([fixture.anchor.id], ['calls', 'references'])).toEqual(fixture.failedNonImports);
    } finally { connection.close(); }
  }, 120_000);

  it('preserves normal invalidation when a legacy snapshot proves real plugin metadata changed', async () => {
    const fixture = await legacyIncludes();
    const { connection, queries } = database(fixture.root);
    try {
      queries.setMetadata(CPP_INCLUDE_SNAPSHOT_KEY, JSON.stringify({ ...JSON.parse(fixture.observedSnapshot),
        ueModules: false, complete: false }));
    } finally { connection.close(); }
    fs.writeFileSync(path.join(fixture.root, 'Plugins/Main/Main.uplugin'), JSON.stringify({ Modules: [] }));
    const passes = SYNTH_PASSES.map(pass => vi.spyOn(pass, 'run'));
    const graph = await CodeGraph.open(fixture.root, { sync: false }); graphs.push(graph);
    expect(graph.getCppIncludeEnvironmentStatus()).toMatchObject({ observed: true, changed: true });
    expect(await graph.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(passes.some(pass => pass.mock.calls.length > 0)).toBe(true);
    expect(includeTargets(graph, fixture.implementation)).not.toContain(fixture.included);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  }, 120_000);

  it('resolves actual worker C++ includes with the same private dependency scope as the main resolver', async () => {
    const implementation = 'Plugins/Main/Source/Main/Private/use.cpp';
    const facade = 'Plugins/Main/Source/Main/Public/Facade.h';
    const included = 'Source/Shared/Public/SharedThing.h';
    const { root, graph } = await indexed(false, {
      [source]: rules('Main', 'PrivateDependencyModuleNames.Add("Shared");'),
      [implementation]: '#include <SharedThing.h>\nvoid Use() {}',
      [facade]: '#include <SharedThing.h>\nstruct Facade {};',
      [included]: 'struct SharedThing {};',
      'Source/Unrelated/Public/SharedThing.h': 'struct Unrelated {};',
    });
    const refs = [implementation, facade].map(filePath => ({
      fromNodeId: graph.getNodesInFile(filePath).find(node => node.kind === 'file')!.id,
      referenceName: 'SharedThing.h', referenceKind: 'imports' as const,
      filePath, language: 'cpp' as const, line: 1, column: 0,
    }));
    const { connection, queries } = database(root);
    const pool = ResolverPool.tryCreate(path.join(root, '.codegraph/codegraph.db'), root);
    expect(pool).not.toBeNull();
    try {
      const resolver = new ReferenceResolver(root, queries); resolver.initialize();
      const main = resolver.resolveListForAdmission(refs);
      expect(main.resolved.map(result => graph.getNode(result.targetNodeId)?.filePath)).toEqual([included]);
      expect(main.unresolved.map(ref => ref.filePath)).toEqual([facade]);
      await pool!.ready();
      const worker = await pool!.resolveBatch(refs);
      expect(worker.resolved).toEqual(main.resolved);
      expect(worker.unresolved).toEqual(main.unresolved);
    } finally { await pool?.destroy(); connection.close(); }
  }, 120_000);

  it('keeps module observations on the main thread while real workers synthesize the other passes', async () => {
    const passes = vi.spyOn(ResolverPool.prototype, 'runSynthPass');
    const modulePass = vi.spyOn(SYNTH_PASSES.find(pass => pass.name === 'unrealModules')!, 'run');
    const { root, graph } = await indexed();
    expect(passes.mock.calls.length).toBeGreaterThan(0);
    await Promise.all(passes.mock.results.map(result => result.value));
    expect(graph.getFileDependencies(source)).toContain(target);
    expect(passes.mock.calls.map(([name]) => name)).not.toContain('unrealModules');
    expect(modulePass).toHaveBeenCalledTimes(1);
    const edges = await modulePass.mock.results[0]!.value;
    expect(edges).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'imports', metadata: expect.objectContaining({ synthesizedBy: 'ue-module', targetUeModuleName: 'Shared' }),
    })]));
    close(graph);
    const { connection, queries } = database(root);
    try {
      const raw = queries.getMetadata(CPP_INCLUDE_SNAPSHOT_KEY)!;
      expect(queries.getMetadata('ue_module_metadata_observed')).toBe('1');
      expect(JSON.parse(raw)).toMatchObject({ complete: true, bounded: true, ueModules: true,
        files: expect.arrayContaining([source, target]),
        dependencies: expect.arrayContaining([
          expect.objectContaining({ path: source, kind: 'content', owners: expect.arrayContaining([source]) }),
          expect.objectContaining({ path: 'Plugins/Main/Main.uplugin', kind: 'content' }),
        ]),
      });
      expect(checkCppIncludeSnapshot(root, raw)).toMatchObject({ observed: true, complete: true, changed: false });
    } finally { connection.close(); }
    fs.writeFileSync(path.join(root, 'Plugins/Main/Main.uplugin'), JSON.stringify({ Modules: [] }));
    const reopened = await CodeGraph.open(root, { sync: false }); graphs.push(reopened);
    expect(reopened.getCppIncludeEnvironmentStatus().changed).toBe(true);
  }, 120_000);

  it.each([false, true])('repairs legacy metadata once without source changes (ordinary C#: %s)', async ordinary => {
    const { root, graph } = await indexed(ordinary);
    close(graph);
    const { connection, queries } = database(root);
    const before = queries.getAllFiles();
    try {
      for (const file of queries.getAllFilePaths()) {
        const anchor = queries.getNodesByFile(file).find(node => node.kind === 'file');
        if (anchor) queries.deleteSynthesizedEdgesByOwner('ue-module', [anchor.id]);
      }
      queries.setMetadata('ue_module_metadata_observed', '0');
      connection.getDb().prepare('DELETE FROM project_metadata WHERE key = ?').run('ue_module_metadata_version');
      queries.setMetadata(CPP_INCLUDE_SNAPSHOT_KEY, JSON.stringify({ version: 1, complete: false, bounded: true,
        ueModules: false, files: [], dependencies: [] }));
    } finally { connection.close(); }
    const refresh = vi.spyOn(ReferenceResolver.prototype, 'refreshUeModuleGraph');
    const passes = vi.spyOn(ResolverPool.prototype, 'runSynthPass');
    const reopened = await CodeGraph.open(root, { sync: false }); graphs.push(reopened);
    expect(await reopened.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(passes).not.toHaveBeenCalled();
    expect(reopened.getFileDependencies(source).includes(target)).toBe(!ordinary);
    expect(await reopened.sync()).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(refresh).toHaveBeenCalledTimes(1);
    close(reopened);
    const persisted = database(root);
    try {
      expect(persisted.queries.getAllFiles()).toEqual(before);
      expect(persisted.queries.getMetadata('ue_module_metadata_version')).toBe('1');
      expect(persisted.queries.getMetadata('ue_module_metadata_observed')).toBe(ordinary ? '0' : '1');
    } finally { persisted.connection.close(); }
  }, 120_000);
});
