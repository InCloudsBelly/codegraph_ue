import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import { unrealCallableKey } from '../extraction/languages/ue-reflection';
import type { MaybeYield } from './cooperative-yield';
import { UnrealVisibility } from './ue-visibility';

/** Written UFUNCTION signatures only: UHT-generated RPC/_Implementation members are not inferred. */
export async function unrealDeclarationEdges(ctx: ResolutionContext, yieldToLoop: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const visibility = new UnrealVisibility(ctx);
  for (const declaration of (ctx.iterateNodesByKind?.('method') ?? ctx.getNodesByKind('method'))) {
    if (declaration.language !== 'cpp') continue;
    if (!declaration.decorators?.some(d => d.startsWith('UFUNCTION(')) || !declaration.signature?.endsWith(';')) continue;
    const declarationSource = ctx.readFile(declaration.filePath);
    const key = declarationSource !== null ? unrealCallableKey(declaration, declarationSource, ctx.getFileLines?.(declaration.filePath) ?? undefined) : undefined;
    if (!key) continue;
    const pause = yieldToLoop(); if (pause) await pause;
    const implementations = ctx.getNodesByQualifiedName(declaration.qualifiedName).filter(candidate => {
      if (candidate.id === declaration.id || candidate.language !== 'cpp' || candidate.kind !== 'method') return false;
      if (candidate.decorators?.some(d => d.startsWith('UFUNCTION(')) && candidate.signature?.endsWith(';')) return false;
      if (!visibility.isVisible(declaration, candidate.filePath, candidate.startLine, candidate.startColumn)) return false;
      const source = ctx.readFile(candidate.filePath);
      return source !== null && unrealCallableKey(candidate, source, ctx.getFileLines?.(candidate.filePath) ?? undefined) === key;
    });
    if (implementations.length !== 1) continue;
    edges.push({
      source: declaration.id, target: implementations[0]!.id, kind: 'calls',
      line: declaration.startLine, provenance: 'heuristic',
      metadata: { synthesizedBy: 'unreal-declaration', signature: key, registeredAt: `${declaration.filePath}:${declaration.startLine}` },
    });
  }
  return edges;
}
