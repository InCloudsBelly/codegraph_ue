import * as path from 'path';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';

/** Module metadata readers use the C# AST even when extraction ran in workers. */
export async function ensureUeModuleGrammar(): Promise<void> {
  await loadGrammarsForLanguages(['csharp']);
  if (!getParser('csharp')) throw new Error('UE module metadata requires the C# grammar');
}

export type UeDependencyKind = 'public' | 'private' | 'public-include' | 'private-include' | 'dynamic';
export interface UeModuleRules {
  name: string;
  directory: string;
  isModuleRules: boolean;
  dependencies: Array<{ name: string; kind: UeDependencyKind; line: number; conditional: boolean }>;
  publicDependencies: string[];
  privateDependencies: string[];
  publicIncludeModules: string[];
  privateIncludeModules: string[];
  publicIncludePaths: string[];
  privateIncludePaths: string[];
  dynamicModules: string[];
  publicComplete: boolean;
  privateComplete: boolean;
  dynamicComplete: boolean;
}

export interface UeModuleObservation {
  filePath: string;
  rules: UeModuleRules;
  plugin?: { filePath: string; name: string; descriptor: ReturnType<typeof readUePluginDescriptor> };
  pluginComplete?: boolean;
}

/** Read literals from the constructor AST; never execute arbitrary build rules. */
export function readUeModuleRules(filePath: string, source: string): UeModuleRules {
  const directory = path.posix.dirname(filePath.replace(/\\/g, '/'));
  const result: UeModuleRules = {
    name: path.posix.basename(filePath).replace(/\.Build\.cs$/i, ''), directory, isModuleRules: false, dependencies: [],
    publicDependencies: [], privateDependencies: [], publicIncludeModules: [], privateIncludeModules: [],
    publicIncludePaths: [], privateIncludePaths: [], dynamicModules: [], publicComplete: true, privateComplete: true, dynamicComplete: true,
  };
  const properties = new Map<string, [keyof UeModuleRules, UeDependencyKind | null]>([
    ['PublicDependencyModuleNames', ['publicDependencies', 'public']],
    ['PrivateDependencyModuleNames', ['privateDependencies', 'private']],
    ['PublicIncludePathModuleNames', ['publicIncludeModules', 'public-include']],
    ['PrivateIncludePathModuleNames', ['privateIncludeModules', 'private-include']],
    ['PublicIncludePaths', ['publicIncludePaths', null]], ['PrivateIncludePaths', ['privateIncludePaths', null]],
    ['DynamicallyLoadedModuleNames', ['dynamicModules', 'dynamic']],
  ]);
  const invalidate = (property?: string) => {
    if (!property || property.startsWith('Public')) result.publicComplete = false;
    if (!property || property.startsWith('Private')) result.privateComplete = false;
    if (!property || property === 'DynamicallyLoadedModuleNames') result.dynamicComplete = false;
  };
  const value = (node: SyntaxNode): string | null => {
    if (node.type === 'argument' && node.namedChildCount === 1) return value(node.namedChild(0)!);
    const text = node.text;
    if (node.type === 'string_literal' && /^"(?:[^"\\]|\\.)*"$/s.test(text)) {
      try { return JSON.parse(text) as string; } catch { return null; }
    }
    if (node.type === 'verbatim_string_literal') return text.slice(2, -1).replace(/""/g, '"');
    if (text === 'ModuleDirectory') return directory;
    if (text === 'PluginDirectory' && directory.includes('/Source/')) return directory.slice(0, directory.lastIndexOf('/Source/'));
    if (node.type === 'invocation_expression' && node.childForFieldName('function')?.text === 'Path.Combine') {
      const pieces = node.childForFieldName('arguments')?.namedChildren.map(value) ?? [];
      if (pieces.length > 0 && pieces.every((p): p is string => p !== null) &&
        pieces.slice(1).every(p => !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p))) {
        return path.posix.join(...pieces.map(p => p.replace(/\\/g, '/')));
      }
    }
    return null;
  };
  const anchoredInclude = (node: SyntaxNode): boolean => {
    if (node.type === 'argument' && node.namedChildCount === 1) return anchoredInclude(node.namedChild(0)!);
    if (node.text === 'ModuleDirectory' || node.text === 'PluginDirectory') return true;
    return node.type === 'invocation_expression' && node.childForFieldName('function')?.text === 'Path.Combine' &&
      !!node.childForFieldName('arguments')?.namedChild(0) && anchoredInclude(node.childForFieldName('arguments')!.namedChild(0)!);
  };
  let tree: Tree | undefined;
  try {
    const parser = getParser('csharp');
    if (!parser) { invalidate(); return result; }
    tree = parser.parse(source) ?? undefined;
    if (!tree || tree.rootNode.hasError) { invalidate(); return result; }
    let foundConstructor = false;
    const walk = (node: SyntaxNode, conditional: boolean, constructor: boolean, ruleClass: boolean): void => {
      if (node.type === 'class_declaration') {
        ruleClass = node.childForFieldName('name')?.text === result.name &&
          (node.namedChildren.find(c => c.type === 'base_list')?.namedChildren.some(c => /^(?:global::)?(?:UnrealBuildTool\.)?ModuleRules$/.test(c.text)) ?? false);
        result.isModuleRules ||= ruleClass;
      }
      conditional ||= /^(?:if_statement|switch_statement|for_statement|foreach_statement|while_statement|do_statement|try_statement|preproc_)/.test(node.type);
      if (node.type === 'constructor_declaration') {
        constructor = ruleClass && node.childForFieldName('name')?.text === result.name;
        foundConstructor ||= constructor;
      }
      if (constructor && /^(?:lambda_expression|anonymous_method_expression|local_function_statement)$/.test(node.type)) {
        invalidate();
        return;
      }
      if (constructor && node.type === 'assignment_expression') {
        const left = node.childForFieldName('left')?.text.replace(/^this\./, '');
        if (left && properties.has(left)) invalidate(left);
      }
      if (constructor && node.type === 'invocation_expression') {
        const fn = node.childForFieldName('function');
        const expression = fn?.childForFieldName('expression')?.text.replace(/^this\./, '');
        const method = fn?.childForFieldName('name')?.text;
        const property = expression && properties.get(expression);
        if (property) {
          if (conditional || (method !== 'Add' && method !== 'AddRange')) invalidate(expression);
          const argumentsNode = node.childForFieldName('arguments');
          const first = argumentsNode?.namedChildren[0]?.namedChildren[0];
          let values: Array<string | null> = [];
          let expressions: SyntaxNode[] = [];
          if (method === 'Add' && argumentsNode?.namedChildCount === 1 && first) values = [value(first)];
          if (method === 'Add' && first) expressions = [first];
          if (method === 'AddRange' && argumentsNode?.namedChildCount === 1 && first) {
            const initializer = first.type === 'collection_expression' ? first : first.namedChildren.find(n => n.type === 'initializer_expression');
            values = initializer?.namedChildren.map(n => value(n)) ?? [null];
            expressions = initializer?.namedChildren ?? [];
          }
          // A bare relative path has a UBT-dependent base. Only explicit ModuleDirectory/PluginDirectory anchors prove a scope.
          if (property[1] === null && expressions.some(n => !anchoredInclude(n))) { invalidate(expression); values = []; }
          if (values.some(v => v === null)) invalidate(expression);
          for (const name of values) if (name !== null) {
            (result[property[0]] as string[]).push(name);
            if (property[1]) result.dependencies.push({ name, kind: property[1], line: node.startPosition.row + 1, conditional });
          }
        } else if (fn?.text !== 'Path.Combine') invalidate();
      }
      for (const child of node.namedChildren) walk(child, conditional, constructor, ruleClass);
    };
    walk(tree.rootNode, false, false, false);
    if (!foundConstructor || !result.isModuleRules) invalidate();
  } catch { invalidate(); }
  finally { tree?.delete(); }
  return result;
}

export function readUePluginDescriptor(source: string): {
  modules: Array<{ name: string; type?: string; loadingPhase?: string; conditions: Record<string, unknown> }>;
  plugins: Array<{ name: string; enabled?: boolean; optional?: boolean; conditions: Record<string, unknown> }>;
  complete: boolean;
} {
  try {
    const raw = JSON.parse(source);
    if (!raw || typeof raw !== 'object' || (raw.Modules !== undefined && !Array.isArray(raw.Modules)) ||
      (raw.Plugins !== undefined && !Array.isArray(raw.Plugins))) throw new Error('invalid plugin descriptor');
    return {
      modules: (raw.Modules ?? []).map((m: Record<string, unknown>) => {
        if (!m || typeof m.Name !== 'string') throw new Error('invalid module');
        return { name: m.Name, type: typeof m.Type === 'string' ? m.Type : undefined,
          loadingPhase: typeof m.LoadingPhase === 'string' ? m.LoadingPhase : undefined,
          conditions: Object.fromEntries(Object.entries(m).filter(([key]) => /AllowList|DenyList|Whitelist|Blacklist/.test(key))) };
      }),
      plugins: (raw.Plugins ?? []).map((p: Record<string, unknown>) => {
        if (!p || typeof p.Name !== 'string') throw new Error('invalid plugin reference');
        return { name: p.Name, enabled: typeof p.Enabled === 'boolean' ? p.Enabled : undefined,
          optional: typeof p.Optional === 'boolean' ? p.Optional : undefined,
          conditions: Object.fromEntries(Object.entries(p).filter(([key]) => /AllowList|DenyList|Whitelist|Blacklist/.test(key))) };
      }), complete: true,
    };
  } catch { return { modules: [], plugins: [], complete: false }; }
}
