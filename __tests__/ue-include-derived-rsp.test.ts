import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';

const roots: string[] = [];
const graphs = new Set<CodeGraph>();
const FIXED_TIME = 1_700_000_000;
type Files = Record<string, string>;

function write(root: string, files: Files): void {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, FIXED_TIME, FIXED_TIME);
  }
}

async function indexed(files: Files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-derived-rsp-'));
  roots.push(root);
  write(root, files);
  write(root, { 'compile_commands.json': JSON.stringify([{
    directory: root, file: 'Source/TU.cpp', arguments: ['clang++', '@args.rsp', '-c', 'Source/TU.cpp'],
  }]) });
  const graph = await CodeGraph.init(root, { index: true });
  graphs.add(graph);
  return { root, graph };
}

function imports(graph: CodeGraph, file: string): string[] {
  const anchor = graph.getNodesInFile(file).find(n => n.kind === 'file');
  expect(anchor).toBeDefined();
  return graph.getOutgoingEdges(anchor!.id, ['imports'])
    .map(edge => graph.getNode(edge.target)?.filePath).filter((target): target is string => target !== undefined && target !== file).sort();
}

function persistentIncludes(graph: CodeGraph) {
  return graph.getFiles().flatMap(file => {
    const anchor = graph.getNodesInFile(file.path).find(n => n.kind === 'file');
    return anchor ? graph.getOutgoingEdges(anchor.id, ['imports']).flatMap(edge => {
      const target = graph.getNode(edge.target);
      // Environment IDs include the absolute compilation directory. Compare
      // their semantic edges across independently rooted fixture projects.
      const { cppIncludeEnvironment: _rootSpecificEnvironment, ...metadata } = edge.metadata ?? {};
      return target && target.filePath !== file.path
        ? [[file.path, target.filePath, edge.kind, metadata, edge.provenance]] : [];
    }) : [];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}, 30_000);

describe('derived header response-file invalidation', () => {
  it.each(['Common.h', 'Header.custom'])(
    'rebinds persistent %s imports after response-only changes across reopen',
    async header => {
      const files: Files = {
        'codegraph.json': JSON.stringify({ extensions: { '.custom': 'cpp' } }),
        'args.rsp': '-IA',
        'Source/TU.cpp': `#include "${header}"\nvoid UseDerivedHeader() {}\n`,
        [`Source/${header}`]: '#include <Config.h>\nstruct CommonHeader {};\n',
        'A/Config.h': 'struct AConfig {};\n',
        'B/Config.h': 'struct BConfig {};\n',
      };
      const initial = await indexed(files);
      let graph = initial.graph;
      const { root } = initial;
      const language = graph.getFiles().find(f => f.path === `Source/${header}`)?.language;
      expect(header.endsWith('.custom') ? language === 'cpp' : language === 'c' || language === 'cpp').toBe(true);
      expect(imports(graph, `Source/${header}`)).toEqual(['A/Config.h']);
      expect(graph.getCppIncludeEnvironmentStatus()).toMatchObject({ observed: true, changed: false });
      graph.destroy(); graphs.delete(graph);

      // Reopen a persisted graph with automatic sync disabled: the assertion
      // below exercises the explicit SDK sync, not open() side effects.
      graph = await CodeGraph.open(root, { sync: false }); graphs.add(graph);
      const response = path.join(root, 'args.rsp');
      const before = fs.statSync(response);
      write(root, { 'args.rsp': '-IB' });
      const after = fs.statSync(response);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(graph.getCppIncludeEnvironmentStatus()).toMatchObject({ observed: true, changed: true });
      const sync = await graph.sync();
      expect(sync).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });

      // Query the persisted imports, rather than only querying a newly built
      // in-memory include environment that could hide a stale graph edge.
      expect(imports(graph, `Source/${header}`)).toEqual(['B/Config.h']);
      const fresh = await indexed({ ...files, 'args.rsp': '-IB' });
      expect(persistentIncludes(graph)).toEqual(persistentIncludes(fresh.graph));
      expect(graph.getCppIncludeEnvironmentStatus()).toMatchObject({ observed: true, changed: false });
    }, 120_000,
  );
});
