import type CodeGraph from '../index';
import type { Edge } from '../types';

export interface UeModuleRelation {
  from: string;
  to: string;
  inferred: true;
  evidence: Array<{ file: string; line: number; kind: string; target: string }>;
}

/** Infer an owner from the source layout; this is not Build.cs metadata. */
export function ueModuleForSource(file: string): string | null {
  const parts = file.replace(/\\/g, '/').split('/');
  if (parts[0]?.toLowerCase() !== 'engine') return null;
  const lower = parts.map(part => part.toLowerCase());
  const source = lower.indexOf('source');
  if (source >= 0 && lower.slice(0, source).includes('plugins')) {
    return parts[source + 1] ? parts.slice(0, source + 2).join('/') : null;
  }
  if (source >= 0) {
    let start = source + 1;
    if (['runtime', 'editor', 'developer', 'programs'].includes(lower[start] ?? '')) start++;
    const marker = lower.findIndex((part, index) => index > start && ['public', 'private', 'classes'].includes(part));
    const end = marker > start ? marker : start + 1;
    return parts[end - 1] && end < parts.length ? parts.slice(0, end).join('/') : null;
  }
  if (lower[1] === 'programs' && parts[2]) return parts.slice(0, 3).join('/');
  return null;
}

/** Query-local module associations from indexed C/C++ edges and candidate sites. */
export function inferUeModuleRelations(cg: Pick<CodeGraph, 'getFile' | 'getNode' | 'getNodesInFile' |
  'getOutgoingEdgesFrom' | 'getUnresolvedReferencesInFile'>, files: readonly string[]): { relations: UeModuleRelation[]; truncated: boolean } {
  const links = new Map<string, UeModuleRelation>();
  let truncated = files.length > 8;
  const known = new Map<string, boolean>();
  const indexed = (file: string): boolean => {
    if (!known.has(file)) known.set(file, !!cg.getFile(file));
    return known.get(file)!;
  };
  const add = (file: string, line: number, kind: string, target: string): void => {
    const from = ueModuleForSource(file), to = ueModuleForSource(target);
    if (!from || !to || from === to || !indexed(target)) return;
    const key = `${from}\0${to}`;
    const link = links.get(key) ?? { from, to, inferred: true as const, evidence: [] };
    if (link.evidence.length < 3) link.evidence.push({ file, line, kind, target });
    links.set(key, link);
  };
  for (const file of [...new Set(files)].slice(0, 8)) {
    const nodes = cg.getNodesInFile(file);
    if (nodes.length > 512) truncated = true;
    const edges = cg.getOutgoingEdgesFrom(nodes.slice(0, 512).map(node => node.id),
      ['calls', 'imports', 'extends', 'implements', 'references'] as Edge['kind'][]);
    if (edges.length > 2000) truncated = true;
    for (const edge of edges.slice(0, 2000)) {
      const target = cg.getNode(edge.target);
      if (target && (target.language === 'c' || target.language === 'cpp')) add(file, edge.line ?? 0, edge.kind, target.filePath);
    }
    const refs = cg.getUnresolvedReferencesInFile(file, 5000);
    if (refs.length >= 5000) truncated = true;
    for (const ref of refs) for (const candidate of ref.candidates ?? []) {
      const target = candidate.match(/^(Engine\/[^:]+):\d+\s/)?.[1] ?? candidate;
      if (target.startsWith('Engine/')) add(file, ref.line, `${ref.referenceKind}-candidate`, target);
      if (candidate.startsWith('… ')) truncated = true;
    }
  }
  return { relations: [...links.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)), truncated };
}
