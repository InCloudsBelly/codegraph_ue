import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import CodeGraph from '../src';
import { endFreshnessMeasurements, measureCppIncludeEnvironment } from '../src/mcp/index-freshness';

let root: string | undefined;
let graph: CodeGraph | undefined;
afterEach(async () => {
  await endFreshnessMeasurements();
  graph?.destroy(); graph = undefined;
  if (root) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^cg-ue-freshness-worker-/);
    fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
}, 30000);

it('measures current and metadata-only drift through the actual compiled worker without rewriting the database', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-freshness-worker-'));
  for (const dir of ['A', 'B']) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, 'Config.h'), `int ${dir}Config;\n`);
  }
  fs.writeFileSync(path.join(root, 'Main.cpp'), '#include <Config.h>\nint MainValue() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'args.rsp'), '-I A');
  fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([
    { directory: root, file: 'Main.cpp', arguments: ['clang++', '@args.rsp', '-c', 'Main.cpp'] },
  ]));
  graph = CodeGraph.initSync(root);
  await graph.indexAll();
  graph.destroy(); graph = undefined;
  const db = path.join(root, '.codegraph/codegraph.db');
  const hash = () => createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  const initialHash = hash();
  expect(await measureCppIncludeEnvironment(root, 30000)).toMatchObject({ observed: true, complete: true, changed: false });
  await endFreshnessMeasurements();
  expect(hash()).toBe(initialHash);
  fs.writeFileSync(path.join(root, 'args.rsp'), '-I B');
  expect(await measureCppIncludeEnvironment(root, 30000)).toMatchObject({ observed: true, complete: true, changed: true });
  await endFreshnessMeasurements();
  expect(hash()).toBe(initialHash);
  graph = await CodeGraph.open(root, { sync: false });
  await graph.sync();
  graph.destroy(); graph = undefined;
  expect(await measureCppIncludeEnvironment(root, 30000)).toMatchObject({ observed: true, complete: true, changed: false });
}, 120000);
