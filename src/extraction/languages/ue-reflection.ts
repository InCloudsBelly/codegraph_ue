/** Unreal annotations supplement the ordinary C++ parse; they are never expanded as UHT. */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractionResult, Node, NodeKind } from '../../types';
import { getParser } from '../grammars';
import { getChildByField, NodeIdAllocator } from '../tree-sitter-helpers';
import { cppMacroInvocations } from './cpp-macro-methods';
import { scanCppBraceScopes } from './cpp-brace-scopes';
import { unrealMacroNames, mayHaveUnrealReflection } from './unreal-macros';

const DECLARATIONS = new Set(['class_specifier', 'struct_specifier', 'enum_specifier', 'field_declaration', 'declaration', 'function_definition']);
export { mayHaveUnrealReflection } from './unreal-macros';

/** Exact written parameter types, without parameter names/defaults. Unsupported declarators stay unlinked. */
export function unrealCallableKey(node: Node, source: string, sourceLines?: readonly string[]): string | undefined {
  const lines = node.signature ? undefined : (sourceLines ?? source.split('\n')).slice(node.startLine - 1, node.endLine);
  if (lines?.length) {
    if (lines.length === 1) lines[0] = lines[0]!.slice(node.startColumn, node.endColumn);
    else {
      lines[0] = lines[0]!.slice(node.startColumn);
      lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, node.endColumn);
    }
  }
  const text = node.signature ?? lines?.join('\n') ?? '';
  const head = text.split('{', 1)[0]!;
  const name = node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${name}\\s*\\(([^()]*)\\)\\s*([^;{]*)`).exec(head);
  if (!match) return undefined;
  const parts = splitParameters(match[1]!);
  if (!parts) return undefined;
  const types: string[] = [];
  for (let part of parts) {
    part = part.split('=', 1)[0]!.trim();
    if (!part || part === 'void') continue;
    if (/[()[\]{}]|\.\.\./.test(part)) return undefined;
    if (/\b(?:struct|class|enum|union)\b/.test(part)) return undefined;
    // A trailing identifier is a parameter name only when a type precedes it.
    const named = /^(.*[\s*&>])([A-Za-z_]\w*)$/.exec(part);
    if (named && named[1]!.trim() && !/^(?:const|volatile|unsigned|signed|long|short|struct|class|enum)\s*$/.test(named[1]!) &&
      !/^(?:const|volatile|unsigned|signed|long|short|void|bool|char|wchar_t|char8_t|char16_t|char32_t|int|float|double|auto)$/.test(named[2]!)) part = named[1]!.trim();
    types.push(part.replace(/\s+/g, ''));
  }
  const qualifiers = match[2]!.replace(/\b(?:override|final)\b/g, '').trim();
  // Don't guess through requires/noexcept expressions, attributes or other macro suffixes.
  if (qualifiers && !/^(?:(?:const|volatile|noexcept)\s*|&&?\s*)+$/.test(qualifiers)) return undefined;
  return `${node.qualifiedName}(${types.join(',')})${qualifiers.replace(/\s+/g, '')}`;
}

function splitParameters(text: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') { if (--depth < 0) return undefined; }
    else if (text[i] === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0) return undefined;
  out.push(text.slice(start));
  return out;
}

/** Both native and WASM routes use this raw-source supplement. Ordinary C++ pays only the cheap gate. */
export function appendUnrealReflection(result: ExtractionResult, filePath: string, source: string, preParse: (text: string) => string, parsedRoot?: SyntaxNode): void {
  if (!mayHaveUnrealReflection(source)) return;
  const invocations = cppMacroInvocations(source, unrealMacroNames(source));
  if (invocations.length === 0) return;
  const tree = parsedRoot ? undefined : getParser('cpp')?.parse(preParse(source));
  const root = parsedRoot ?? tree?.rootNode;
  if (!root) {
    result.errors.push({ filePath, message: 'Unreal reflection supplement requires the loaded C++ grammar', severity: 'warning' });
    return;
  }
  try {
    const byStart = new Map<number, SyntaxNode>();
    const fields: SyntaxNode[] = [];
    const owners: SyntaxNode[] = [];
    const visit = (node: SyntaxNode) => {
      if (DECLARATIONS.has(node.type) && !byStart.has(node.startIndex)) byStart.set(node.startIndex, node);
      if (node.type === 'field_declaration') fields.push(node);
      if (['class_specifier', 'struct_specifier', 'enum_specifier', 'union_specifier'].includes(node.type) && getChildByField(node, 'body')) owners.push(node);
      if (node.type === 'function_definition') return;
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    const ids = new NodeIdAllocator();
    const scopes = scanCppBraceScopes(source);
    for (const n of result.nodes) ids.generate(filePath, n.kind, n.name, n.startLine, n.startColumn ?? 0);
    const ownerAt = (offset: number) => {
      const ast = owners.filter(n => n.startIndex < offset && offset < n.endIndex)
        .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
      if (!ast) return undefined;
      const name = getChildByField(ast, 'name')?.text;
      return result.nodes.find(n => ['class', 'struct', 'enum', 'union'].includes(n.kind) && n.name === name &&
        n.startLine === ast.startPosition.row + 1 && n.startColumn === ast.startPosition.column);
    };
    const mint = (kind: NodeKind, name: string, ast: SyntaxNode | undefined, start: number, end: number, annotation?: { macro: string; specifiers: string }) => {
      const position = scopes?.positionOf(start);
      const line = position?.line ?? source.slice(0, start).split('\n').length;
      const column = position?.column ?? start - source.lastIndexOf('\n', start - 1) - 1;
      const endLine = scopes?.positionOf(end).line ?? source.slice(0, end).split('\n').length;
      const existing = result.nodes.find(n => n.kind === kind && n.name === name && n.startLine === line && (n.startColumn ?? 0) === column);
      const owner = ownerAt(start);
      if ((kind === 'field' || kind === 'method') && !owner) return undefined;
      const node: Node = existing ?? {
        id: ids.generate(filePath, kind, name, line, column), kind, name,
        qualifiedName: owner ? `${owner.qualifiedName}::${name}` : [...(scopes?.namespacesAt(start) ?? []), name].join('::'),
        filePath, language: 'cpp', startLine: line, endLine, startColumn: column,
        endColumn: end - source.lastIndexOf('\n', end - 1) - 1,
        signature: source.slice(start, end).trim(), updatedAt: Date.now(),
      };
      if (annotation) node.decorators = [...new Set([...(node.decorators ?? []), `${annotation.macro}(${annotation.specifiers})`])];
      if (existing && kind === 'method' && !getChildByField(ast!, 'body')) node.signature = source.slice(start, end).trim();
      if (!existing) {
        result.nodes.push(node);
        result.edges.push({ source: owner?.id ?? `file:${filePath}`, target: node.id, kind: 'contains' });
      }
      if (kind === 'field' && ast) {
        const type = getChildByField(ast, 'type');
        const refs = new Set<string>();
        const collect = (n: SyntaxNode) => { if (n.type === 'type_identifier') refs.add(n.text); for (const c of n.namedChildren) collect(c); };
        if (type) collect(type);
        for (const referenceName of refs) result.unresolvedReferences.push({ fromNodeId: node.id, referenceName, referenceKind: 'references', line, column });
      }
      return node;
    };
    for (const invocation of invocations) {
      const { name: macro, at, end } = invocation;
      const specifiers = source.slice(source.indexOf('(', at) + 1, end - 1).trim();
      if (macro.startsWith('DECLARE_')) {
        // RetVal macros put the return type first; events put the owning type first.
        const index = /RetVal|^DECLARE_EVENT/.test(macro) ? 1 : 0;
        const name = invocation.args[index]?.trim();
        if (name && /^[A-Za-z_]\w*$/.test(name)) mint('type_alias', name, undefined, at, end, { macro, specifiers });
        continue;
      }
      let next = end;
      // An annotation must be adjacent to its declaration; never reach past unrelated code.
      for (;;) {
        const skip = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))/.exec(source.slice(next));
        if (!skip) break;
        next += skip[0].length;
      }
      const ast = byStart.get(next);
      if (!ast) continue;
      if (['UCLASS', 'USTRUCT', 'UENUM'].includes(macro)) {
        const line = ast.startPosition.row + 1;
        const node = result.nodes.find(n => ['class', 'struct', 'enum'].includes(n.kind) && n.startLine === line &&
          n.startColumn === ast.startPosition.column && n.name === getChildByField(ast, 'name')?.text);
        if (node) node.decorators = [...new Set([...(node.decorators ?? []), `${macro}(${specifiers})`])];
      } else {
        if (ast.hasError) continue;
        let declarator = getChildByField(ast, 'declarator');
        let callable = false;
        while (declarator && !['identifier', 'field_identifier', 'qualified_identifier'].includes(declarator.type)) {
          if (declarator.type === 'function_declarator') callable = true;
          if (declarator.type === 'parenthesized_declarator') { declarator = null; break; }
          declarator = getChildByField(declarator, 'declarator');
        }
        if (!declarator || (macro === 'UFUNCTION') !== callable) continue;
        const name = declarator.text.split('::').pop()!;
        mint(callable ? 'method' : 'field', name, ast, ast.startIndex, ast.endIndex, { macro, specifiers });
      }
    }
    // Native delegate members cannot be UPROPERTYs. Recover only a directly
    // written member of a delegate type this file actually declares.
    const delegateNames = new Set(result.nodes.filter(n => n.kind === 'type_alias' &&
      n.decorators?.some(d => /^DECLARE_.*(?:DELEGATE|EVENT)/.test(d))).map(n => n.name));
    for (const field of fields) {
      const type = getChildByField(field, 'type');
      const declarator = getChildByField(field, 'declarator');
      if (!type || !delegateNames.has(type.text) || !declarator || declarator.type !== 'field_identifier' || field.hasError) continue;
      mint('field', declarator.text, field, field.startIndex, field.endIndex);
    }
  } finally { tree?.delete(); }
}
