// A separate source process proves that no parser or resolver cache survives reopen.
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../src/index';
import { getParser } from '../../src/extraction/grammars';

const root = process.env.UE_MODULE_TEST_ROOT!;
const parserInitiallyMissing = getParser('csharp') === null;
if (!parserInitiallyMissing) throw new Error('fresh-process C# grammar was unexpectedly loaded');
const graph = await CodeGraph.open(root, { sync: false });
try {
  const descriptor = path.join(root, 'Plugins/Alpha/Alpha.uplugin');
  const before = fs.statSync(descriptor);
  fs.writeFileSync(descriptor, process.env.UE_MODULE_TEST_DESCRIPTOR!);
  fs.utimesSync(descriptor, before.atime, before.mtime);
  const after = fs.statSync(descriptor);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('metadata stat was not preserved');
  const sync = await graph.sync();
  const edges = graph.getFiles().flatMap(file => {
    const node = graph.getNodesInFile(file.path).find(n => n.kind === 'file');
    return node ? graph.getOutgoingEdges(node.id).filter(e => e.metadata?.synthesizedBy === 'ue-module') : [];
  }).map(e => [graph.getNode(e.source)?.filePath, graph.getNode(e.target)?.qualifiedName,
    e.kind, e.provenance, e.metadata]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  console.log(`UE_MODULE_RESULT ${JSON.stringify({ parserInitiallyMissing, sync, edges })}`);
} finally { graph.close(); }
