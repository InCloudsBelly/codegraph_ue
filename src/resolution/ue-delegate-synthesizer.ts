import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { cppMacroInvocations } from '../extraction/languages/cpp-macro-methods';
import { unrealCallableKey } from '../extraction/languages/ue-reflection';
import { scanCppBraceScopes } from '../extraction/languages/cpp-brace-scopes';
import { cppLiteralsBlanked, cppNonCodeLines } from './cpp-raw-strings';
import { stripCommentsForRegex } from './strip-comments';
import { enclosingFn, makeLineAt } from './synth-utils';
import { UnrealVisibility } from './ue-visibility';
import { escapeRegExp } from '../utils';

const METHODS = new Set(['AddUObject', 'BindUObject', 'Broadcast', 'Execute', 'ExecuteIfBound']);
const CLASS_KINDS = new Set(['class', 'struct']);
const isDeclaration = (node: Node): boolean => !!node.decorators?.some(d => /^UFUNCTION\(/.test(d)) && /;\s*$/.test(node.signature ?? '');

interface Channel {
  key: string;
  field: Pick<Node, 'id' | 'qualifiedName'>;
}
interface Registration extends Channel {
  target: Node;
  file: string;
  line: number;
  single: boolean;
}
interface Dispatch extends Channel {
  caller: Node;
  line: number;
}

/** Explicit UObject member-pointer bindings only; no dynamic names, lambdas or runtime alias guesses. */
export async function unrealDelegateEdges(ctx: ResolutionContext, maybeYield: MaybeYield): Promise<Edge[]> {
  const registrations: Registration[] = [];
  const dispatches: Dispatch[] = [];
  const fieldCache = new Map<string, Pick<Node, 'id' | 'qualifiedName'> | null>();
  const visibility = new UnrealVisibility(ctx);
  const forwards = new Map<string, Array<{ name: string; line: number; column: number }> | null>();
  const uniqueClass = (name: string, file: string, line: number, column: number): Node | undefined => {
    const candidates = ctx.getNodesByQualifiedName(name).filter(n => n.language === 'cpp' && CLASS_KINDS.has(n.kind) &&
      visibility.isVisible(n, file, line, column));
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const classInScope = (name: string, owner: Node, file: string, line: number, column: number): Node | undefined => {
    if (!name) return undefined;
    const parts = owner.qualifiedName.split('::');
    for (let length = parts.length; length >= 0; length--) {
      const qualified = [...parts.slice(0, length), name].join('::');
      const candidates = ctx.getNodesByQualifiedName(qualified).filter(n => n.language === 'cpp' &&
        ['class', 'struct', 'enum', 'union', 'type_alias'].includes(n.kind) && visibility.isVisible(n, file, line, column));
      if (candidates.length > 0) return candidates.length === 1 && CLASS_KINDS.has(candidates[0]!.kind) ? candidates[0] : undefined;
    }
    return undefined;
  };
  const callback = (written: string, owner: Node): Node | undefined => {
    const candidates = ctx.getNodesByQualifiedName(written).filter(n => n.language === 'cpp' && n.kind === 'method');
    const implementations = candidates.filter(n => !isDeclaration(n) &&
      visibility.isVisible(owner, n.filePath, n.startLine, n.startColumn ?? 0));
    if (implementations.length !== 1) return undefined;
    const implementation = implementations[0]!;
    if (implementation.isAbstract || implementation.isStatic) return undefined;
    const declarations = candidates.filter(n => isDeclaration(n) && visibility.isVisible(n, implementation.filePath,
      implementation.startLine, implementation.startColumn ?? 0));
    if (declarations.length > 0) {
      const source = ctx.readFile(implementation.filePath);
      const key = source === null ? undefined : unrealCallableKey(implementation, source);
      if (!key || declarations.some(n => unrealCallableKey(n, ctx.readFile(n.filePath) ?? '') !== key)) return undefined;
    }
    return implementation;
  };
  const code = (file: string, source: string): string => {
    const nonCode = cppNonCodeLines(file, ctx);
    return stripCommentsForRegex(source, 'cpp').split('\n')
      .map((line, i) => cppLiteralsBlanked(line, i + 1, nonCode)).join('\n');
  };
  const forwardDeclarations = (file: string) => {
    if (!forwards.has(file)) {
      const source = ctx.readFile(file);
      const scopes = source === null ? undefined : scanCppBraceScopes(source);
      if (!source || !scopes) forwards.set(file, null);
      else {
        const names: Array<{ name: string; line: number; column: number }> = [];
        const nodes = ctx.getNodesInFile(file);
        const lineAt = makeLineAt(source, 1);
        for (const match of code(file, source).matchAll(/\b(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)\s*;/g)) {
          const line = lineAt(match.index);
          const enclosing = scopes.atNamespaceScope(match.index) ? undefined : nodes
            .filter(n => CLASS_KINDS.has(n.kind) && n.startLine <= line && n.endLine >= line)
            .sort((a, b) => b.startLine - a.startLine)[0];
          names.push({ name: [enclosing?.qualifiedName ?? scopes.namespacesAt(match.index).join('::'), match[1]].filter(Boolean).join('::'),
            line, column: match.index - source.lastIndexOf('\n', match.index - 1) - 1 });
        }
        forwards.set(file, names);
      }
    }
    return forwards.get(file);
  };
  const knownDelegate = (type: string, owner: Node, at: number, source: string): boolean => {
    const line = makeLineAt(source, 1)(at);
    const column = at - source.lastIndexOf('\n', at - 1) - 1;
    const local = forwardDeclarations(owner.filePath);
    if (!local) return false;
    const declarations = new Set(local.filter(n => n.line < line || (n.line === line && n.column < column)).map(n => n.name));
    for (const included of visibility.includedFiles(owner.filePath, line, column) ?? []) {
      const foreign = forwardDeclarations(included);
      if (!foreign) return false;
      for (const declaration of foreign) declarations.add(declaration.name);
    }
    const parts = owner.qualifiedName.split('::');
    for (let length = parts.length; length >= 0; length--) {
      const qualified = [...parts.slice(0, length), type].join('::');
      if (declarations.has(qualified)) return false;
      // An unqualified outer type in a namespace may be shadowed by an unread forward header.
      if (length === 0 && parts.length > 1 && !type.includes('::')) return false;
      const candidates = ctx.getNodesByQualifiedName(qualified).filter(n => n.language === 'cpp' &&
        ['class', 'struct', 'enum', 'union', 'type_alias'].includes(n.kind) && visibility.isVisible(n, owner.filePath, line, column));
      if (candidates.length > 0) return candidates.length === 1 && candidates[0]!.kind === 'type_alias' && !!candidates[0]!.decorators?.some(d =>
        /^DECLARE_(?:[A-Z_]*DELEGATE\w*|EVENT\w*)\(/.test(d));
    }
    return false;
  };
  const fieldOf = (owner: Node, name: string): Pick<Node, 'id' | 'qualifiedName'> | undefined => {
    const qualifiedName = `${owner.qualifiedName}::${name}`;
    const cacheKey = `${owner.id}\0${name}`;
    if (fieldCache.has(cacheKey)) return fieldCache.get(cacheKey) ?? undefined;
    const fields = ctx.getNodesByQualifiedName(qualifiedName).filter(n => n.language === 'cpp' &&
      (n.kind === 'field' || n.kind === 'property') && n.filePath === owner.filePath && n.startLine >= owner.startLine && n.endLine <= owner.endLine);
    const source = ctx.readFile(owner.filePath);
    if (fields.length > 1 || source === null) { fieldCache.set(cacheKey, null); return undefined; }
    const pattern = new RegExp(`\\b((?:[A-Za-z_]\\w*::)*[A-Za-z_]\\w*)\\s+${escapeRegExp(name)}\\s*(?=[;={])`, 'g');
    const masked = code(owner.filePath, source);
    const start = masked.split('\n').slice(0, owner.startLine - 1).join('\n').length + (owner.startLine > 1 ? 1 : 0);
    const body = masked.slice(start, masked.split('\n').slice(0, owner.endLine).join('\n').length);
    const open = body.indexOf('{');
    const matches: Array<{ at: number; type: string }> = [];
    let braces = 0;
    let parens = 0;
    let cursor = open;
    for (const match of body.matchAll(pattern)) {
      if (open < 0 || match.index <= open) continue;
      for (; cursor < match.index; cursor++) {
        const c = body[cursor];
        if (c === '{') braces++;
        else if (c === '}') braces--;
        else if (c === '(') parens++;
        else if (c === ')') parens--;
      }
      // Native fields are not always indexed: retain only direct, simple owner declarations.
      if (braces === 1 && parens === 0) matches.push({ at: start + match.index, type: match[1]! });
    }
    const field = matches.length === 1 && knownDelegate(matches[0]!.type, owner, matches[0]!.at, source)
      ? fields[0] ?? { id: `unreal-field:${owner.filePath}:${matches[0]!.at}`, qualifiedName } : undefined;
    fieldCache.set(cacheKey, field ?? null);
    return field;
  };

  for (const file of ctx.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|inl|ipp|tcc|cc|cpp|cxx)$/i.test(file)) continue;
    const source = ctx.readFile(file);
    if (!source || !/\b(?:AddUObject|BindUObject|Broadcast|Execute|ExecuteIfBound)\s*\(/.test(source)) continue;
    const nodes = ctx.getNodesInFile(file);
    const masked = code(file, source);
    const lineAt = makeLineAt(source, 1);
    const lineStarts = [0];
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);

    for (const invocation of cppMacroInvocations(source, METHODS)) {
      const pause = maybeYield(); if (pause) await pause;
      const line = lineAt(invocation.at);
      const column = invocation.at - source.lastIndexOf('\n', invocation.at - 1) - 1;
      const caller = enclosingFn(nodes, line);
      if (!caller || caller.language !== 'cpp' || isDeclaration(caller)) continue;
      const scope = caller.qualifiedName.slice(0, caller.qualifiedName.lastIndexOf('::'));
      const owner = uniqueClass(scope, file, line, column);
      if (!owner) continue;
      const prefix = masked.slice(Math.max(0, invocation.at - 256), invocation.at);
      const expression = /(?<![\w.:>)\]])((?:this\s*->\s*)?[A-Za-z_]\w*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*)?)\s*\.\s*$/.exec(prefix)?.[1]?.replace(/\s+/g, '');
      if (!expression) continue;
      const before = masked.slice(lineStarts[caller.startLine - 1] ?? 0, invocation.at);
      // Only directly written local/parameter types, never names borrowed from another function.
      const localType = (name: string): string | undefined => {
        const re = new RegExp(`(?:^|[;{(,])\\s*(?:const\\s+)?((?:[A-Za-z_]\\w*::)*[A-Za-z_]\\w*)(?:\\s*[*&]\\s*|\\s+)${escapeRegExp(name)}\\s*(?=[,;)={])`, 'g');
        const matches = [...before.matchAll(re)];
        return matches.length === 1 ? matches[0]![1] : undefined;
      };
      const channel = (): Channel | undefined => {
        const match = /^(?:(this|[A-Za-z_]\w*)(?:->|\.))?([A-Za-z_]\w*)$/.exec(expression);
        if (!match) return undefined;
        const receiver = match[1];
        const fieldName = match[2]!;
        let fieldOwner = owner;
        let instance = '';
        if (receiver && receiver !== 'this') {
          if (new RegExp(`\\b${escapeRegExp(receiver)}\\s*=(?!=)`).test(before)) return undefined;
          const type = localType(receiver);
          const resolved = type ? classInScope(type, owner, file, line, column) : undefined;
          if (!resolved) return undefined;
          fieldOwner = resolved;
          instance = `\0${caller.id}\0${receiver}`;
        } else if (!receiver && localType(fieldName)) return undefined;
        const field = fieldOf(fieldOwner, fieldName);
        if (!field) return undefined;
        return { key: `${field.id}${instance}`, field };
      };
      const resolved = channel();
      if (!resolved) continue;
      if (invocation.name === 'AddUObject' || invocation.name === 'BindUObject') {
        const pointer = /^&\s*((?:[A-Za-z_]\w*::)+[A-Za-z_]\w*)$/.exec(invocation.args[1]?.trim() ?? '')?.[1];
        if (!pointer) continue;
        const split = pointer.lastIndexOf('::');
        const pointerOwner = classInScope(pointer.slice(0, split), owner, file, line, column);
        const target = pointerOwner ? callback(`${pointerOwner.qualifiedName}::${pointer.slice(split + 2)}`, pointerOwner) : undefined;
        if (!target) continue;
        const targetOwner = target.qualifiedName.slice(0, target.qualifiedName.lastIndexOf('::'));
        const object = invocation.args[0]?.trim();
        const objectType = object === 'this' ? owner : object && /^[A-Za-z_]\w*$/.test(object)
          ? classInScope(localType(object) ?? '', owner, file, line, column) : undefined;
        if (objectType?.qualifiedName !== targetOwner) continue;
        registrations.push({ ...resolved, target, file, line, single: invocation.name === 'BindUObject' });
      } else {
        dispatches.push({ ...resolved, caller, line });
      }
    }
  }
  const byChannel = new Map<string, Registration[]>();
  for (const registration of registrations) {
    const list = byChannel.get(registration.key) ?? [];
    list.push(registration);
    byChannel.set(registration.key, list);
  }
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const dispatch of dispatches) {
    const bindings = byChannel.get(dispatch.key) ?? [];
    const targets = new Set(bindings.map(binding => binding.target.id));
    if (targets.size > 40 || (bindings.some(binding => binding.single) && targets.size > 1)) continue;
    for (const registration of bindings) {
      const key = `${dispatch.caller.id}\0${registration.target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: dispatch.caller.id, target: registration.target.id, kind: 'calls', line: dispatch.line, provenance: 'heuristic',
        metadata: { synthesizedBy: 'unreal-delegate', via: dispatch.field.qualifiedName, registeredAt: `${registration.file}:${registration.line}` },
      });
    }
  }
  return edges;
}
