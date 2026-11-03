import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';

describe('UE C++ source extensions', () => {
  let root: string;
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-extensions-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('indexes .hh as C++ and detects later updates within a UE profile', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const header = 'Engine/Source/Runtime/Core/Public/Extra.hh';
    write(header, 'class FInitialHeader {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FInitialHeader')).toHaveLength(1);
      write(header, 'class FUpdatedHeader {};\n');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('FInitialHeader')).toHaveLength(0);
      expect(graph.getNodesByName('FUpdatedHeader')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 60000);
});
