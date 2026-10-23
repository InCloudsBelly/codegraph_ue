import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import type { UeModuleObservation } from './ue-module-environment';
import { ensureUeModuleGrammar } from './ue-module-environment';

/** Static build metadata is evidence, never a claim about the selected UBT target. */
export const UE_MODULE_SYNTHESIZER = 'ue-module';
const MAX_PLUGIN_MODULES = 128;
type AnchoredModule = UeModuleObservation & { anchor: Node };
type Evidence = Record<string, unknown> & { name: string; kind: string; conditional: boolean };

/** One edge per file pair: synthesis's merge key must not discard dependency kinds. */
export async function unrealModuleEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  if (ctx.getAllFiles().some(file => /\.Build\.cs$/i.test(file))) await ensureUeModuleGrammar();
  // Missing the controlled reader means missing evidence, not permission to
  // invent another metadata reader whose inputs sync cannot invalidate.
  const modules: AnchoredModule[] = (ctx.getUeModuleRules?.() ?? []).flatMap(observation => {
    if (!observation.rules.isModuleRules) return [];
    const anchor = ctx.getNodesInFile(observation.filePath).find(n => n.kind === 'file');
    return anchor ? [{ ...observation, anchor }] : [];
  }).sort((a, b) => a.filePath.localeCompare(b.filePath));
  const byName = new Map<string, AnchoredModule[]>();
  const byPlugin = new Map<string, Map<string, AnchoredModule[]>>();
  for (const module of modules) {
    const named = byName.get(module.rules.name) ?? [];
    named.push(module); byName.set(module.rules.name, named);
    if (module.plugin && module.pluginComplete !== false && module.plugin.descriptor.complete &&
        module.plugin.descriptor.modules.some(m => m.name === module.rules.name)) {
      const owners = byPlugin.get(module.plugin.name) ?? new Map<string, AnchoredModule[]>();
      const owned = owners.get(module.plugin.filePath) ?? [];
      owned.push(module); owners.set(module.plugin.filePath, owned); byPlugin.set(module.plugin.name, owners);
    }
  }
  const edges: Edge[] = [];
  for (const module of modules) {
    await onYield();
    const targets = new Map<string, { module: AnchoredModule; evidence: Evidence[] }>();
    const unresolved: Array<Record<string, unknown>> = [];
    const add = (target: AnchoredModule, evidence: Evidence) => {
      if (target.anchor.id === module.anchor.id) return;
      const entry = targets.get(target.anchor.id) ?? { module: target, evidence: [] };
      entry.evidence.push(evidence); targets.set(target.anchor.id, entry);
    };
    for (const dependency of module.rules.dependencies) {
      const candidates = byName.get(dependency.name) ?? [];
      if (candidates.length !== 1) {
        unresolved.push({ ...dependency, reason: candidates.length ? 'ambiguous-module' : 'module-not-indexed' });
        continue;
      }
      add(candidates[0]!, { ...dependency, sourceKind: 'build-rules' });
    }
    const plugin = module.plugin;
    const pluginModule = plugin?.descriptor.modules.find(m => m.name === module.rules.name);
    const pluginDeclared = !!plugin && plugin.descriptor.complete && !!pluginModule && module.pluginComplete !== false;
    if (plugin && !pluginDeclared) unresolved.push({ name: plugin.name, kind: 'plugin-owner', reason: 'plugin-descriptor-incomplete' });
    if (module.pluginComplete === false && !plugin) unresolved.push({ kind: 'plugin-owner', reason: 'plugin-descriptor-unavailable' });
    if (pluginDeclared) for (const dependency of plugin!.descriptor.plugins) {
      const owners = byPlugin.get(dependency.name);
      const candidates = owners?.size === 1 ? [...owners.values()][0]! : [];
      if (owners?.size !== 1 || candidates.length > MAX_PLUGIN_MODULES) {
        unresolved.push({ name: dependency.name, kind: 'plugin', reason: owners && owners.size > 1
          ? 'ambiguous-plugin' : candidates.length > MAX_PLUGIN_MODULES ? 'plugin-module-limit' : 'plugin-not-indexed' });
        continue;
      }
      for (const target of candidates) add(target, {
        name: dependency.name, kind: 'plugin', conditional: true, sourceKind: 'plugin-descriptor',
        descriptorPath: plugin!.filePath, enabled: dependency.enabled, optional: dependency.optional,
        // Descriptor references and module loading constraints are descriptive;
        // they cannot establish an active runtime/compile dependency by themselves.
        conditions: dependency.conditions,
      });
    }
    for (const { module: target, evidence } of targets.values()) edges.push({
      source: module.anchor.id, target: target.anchor.id, kind: 'imports', provenance: 'heuristic',
      metadata: { synthesizedBy: UE_MODULE_SYNTHESIZER, ueModuleName: module.rules.name,
        targetUeModuleName: target.rules.name, ueDependencies: evidence, analysis: 'static-literals',
        complete: module.rules.publicComplete && module.rules.privateComplete && module.rules.dynamicComplete &&
          !evidence.some(item => item.conditional),
        registeredAt: `${module.filePath}:1` },
    });
    // Existing source nodes carry declaration/ownership evidence even for a
    // zero-dependency module. The class remains a C# class, not a synthetic module.
    const declarations = ctx.getNodesInFile(module.filePath).filter(n => n.kind === 'class' && n.name === module.rules.name);
    if (declarations.length === 1) edges.push({
      source: module.anchor.id, target: declarations[0]!.id, kind: 'references', provenance: 'heuristic',
      metadata: { synthesizedBy: UE_MODULE_SYNTHESIZER, ueModuleDeclaration: true,
        ueModuleName: module.rules.name, ruleEvidence: 'explicit-ModuleRules-base', analysis: 'static-literals',
        complete: module.rules.publicComplete && module.rules.privateComplete &&
          module.rules.dynamicComplete &&
          !module.rules.dependencies.some(d => d.conditional) && unresolved.length === 0,
        unresolvedDependencies: unresolved,
        ...(plugin ? { plugin: { name: plugin.name, descriptorPath: plugin.filePath, declared: pluginDeclared,
          module: pluginModule, complete: plugin.descriptor.complete } } : {}),
      },
    });
  }
  return edges;
}

/** Metadata-only sync refreshes this owner's edges, without rerunning other passes. */
export async function refreshUnrealModuleGraph(
  queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield,
): Promise<number> {
  const edges = await unrealModuleEdges(ctx, onYield);
  const sourceIds: string[] = [];
  for (const file of ctx.getAllFiles().filter(f => /\.Build\.cs$/i.test(f))) {
    const anchor = ctx.getNodesInFile(file).find(n => n.kind === 'file');
    if (!anchor) continue;
    sourceIds.push(anchor.id);
  }
  queries.runInTransaction(() => {
    queries.deleteSynthesizedEdgesByOwner(UE_MODULE_SYNTHESIZER, sourceIds);
    queries.insertEdges(edges);
  });
  return edges.length;
}
