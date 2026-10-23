import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ReferenceResolver } from '../src/resolution';
import { cFnPointerDispatchEdges } from '../src/resolution/c-fnptr-synthesizer';
import type { Edge } from '../src/types';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const repeats = 20;
const repeat = (statement: string) => Array(repeats).fill(`  ${statement}`).join('\n');
const source = `struct LeftOps { int (*fn)(void); };
struct RightOps { int (*fn)(void); };
struct LeftContext { struct LeftOps *ops; struct RightOps *alt; };
struct RightContext { struct RightOps *ops; struct LeftOps *alt; };
struct Slot { int (*slot)(void); };
int left_handler(void) { return 1; }
int right_handler(void) { return 2; }
static struct LeftOps left_table = { left_handler };
static struct RightOps right_table = { right_handler };
void dispatch_left(struct LeftContext *same) {
${repeat('same->ops->fn();')}
${repeat('same->alt->fn();')}
}
void dispatch_right(struct RightContext *same) {
${repeat('same->ops->fn();')}
${repeat('same->alt->fn();')}
}
void dispatch_unknown(void) {
${repeat('mystery->fn();')}
}
void dispatch_known(struct LeftOps *mystery) {
${repeat('mystery->fn();')}
}
void propagate_left(struct Slot *dst, struct LeftOps *same) {
${repeat('dst->slot = same->fn;')}
${repeat('lost->slot = mystery->fn;')}
  dst->slot();
}
`;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function fixture() {
  vi.stubEnv('CODEGRAPH_KERNEL_CFNPTR', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnptr-memo-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'dispatch.c'), source);
  const graph = await CodeGraph.init(root, { index: true, silent: true }); graphs.push(graph);
  const resolver = new ReferenceResolver(root, graph.queries);
  const nodes = new Map(graph.getNodesInFile('dispatch.c').filter(node => node.kind === 'function').map(node => [node.name, node]));
  const expected = (caller: string, target: string, via: string, statement: string): Edge => {
    const fn = nodes.get(caller)!;
    const lines = source.split('\n');
    const line = lines.findIndex((text, index) => index >= fn.startLine - 1 && text.trim() === statement) + 1;
    return { source: fn.id, target: nodes.get(target)!.id, kind: 'calls', line, provenance: 'heuristic',
      metadata: { synthesizedBy: 'fn-pointer-dispatch', via, registeredAt: `dispatch.c:${line}` } };
  };
  return { graph, context: resolver.getResolutionContext(), expected: [
    expected('dispatch_left', 'left_handler', 'LeftOps.fn', 'same->ops->fn();'),
    expected('dispatch_left', 'right_handler', 'RightOps.fn', 'same->alt->fn();'),
    expected('dispatch_right', 'right_handler', 'RightOps.fn', 'same->ops->fn();'),
    expected('dispatch_right', 'left_handler', 'LeftOps.fn', 'same->alt->fn();'),
    expected('dispatch_known', 'left_handler', 'LeftOps.fn', 'mystery->fn();'),
    expected('propagate_left', 'left_handler', 'Slot.slot', 'dst->slot();'),
  ] };
}

it('preserves exact ordered dispatch and propagation edges across same-named receivers and unresolved types', async () => {
  const { graph, context, expected } = await fixture();
  expect(await cFnPointerDispatchEdges(graph.queries, context, async () => {})).toEqual(expected);
});

it('scans each exact receiver or variable once per function, including unresolved null results', async () => {
  const { graph, context, expected } = await fixture();
  const original = RegExp.prototype.exec;
  const counts = new Map<string, number>();
  const watched = [
    ['dispatch_left', 'same'], ['dispatch_right', 'same'],
    ['dispatch_unknown', 'mystery'], ['dispatch_known', 'mystery'],
    ['propagate_left', 'same'], ['propagate_left', 'lost'], ['propagate_left', 'mystery'],
  ];
  const hook = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
    if (this.source.startsWith('(?:(?:struct|union)')) for (const [fn, variable] of watched) {
      if (input.startsWith(`void ${fn}(`) && this.source.includes(`\\b${variable}\\b`)) {
        const key = `${fn}:${variable}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return original.call(this, input);
  });
  let edges: Edge[];
  try { edges = await cFnPointerDispatchEdges(graph.queries, context, async () => {}); }
  finally { hook.mockRestore(); }
  expect(edges).toEqual(expected);
  expect(Object.fromEntries(counts)).toEqual({
    'dispatch_left:same': 1, 'dispatch_right:same': 1,
    'dispatch_unknown:mystery': 2, 'dispatch_known:mystery': 1,
    'propagate_left:same': 1, 'propagate_left:lost': 1, 'propagate_left:mystery': 1,
  });
});
