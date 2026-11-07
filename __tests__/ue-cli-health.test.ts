import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

describe('UE CLI status health', () => {
  it('distinguishes partial parsing and gives a safe recovery instruction', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-cli-health-'));
    const source = path.join(root, 'Engine/Source/Runtime/Core/PartlyBroken.h');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), JSON.stringify({ ueEngine: { plugins: [] } }));
    fs.writeFileSync(source, 'class FUsable {};\ninline void Broken() { int n = ; }\n');
    expect(spawnSync('git', ['init', '-q', root], { windowsHide: true }).status).toBe(0);
    const dist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
    const CodeGraph = require(dist).default;
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('FUsable')).toHaveLength(1);
      graph.destroy();
      const bin = path.join(dist, 'bin/codegraph.js');
      const status = (...options: string[]) => {
        const result = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, bin, 'status', root, ...options], {
          encoding: 'utf8', windowsHide: true, timeout: 30_000,
          env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', NO_COLOR: '1' },
        });
        expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0);
        return (result.stdout ?? '') + (result.stderr ?? '');
      };
      const incomplete = status();
      expect(incomplete).toMatch(/parse errors.*symbols and relationships may be incomplete/i);
      expect(incomplete).not.toMatch(/could not be parsed, so its symbols are missing/i);

      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'));
      try { db.prepare("UPDATE project_metadata SET value='partial' WHERE key='index_state'").run(); }
      finally { db.close(); }
      const recovery = status();
      expect(recovery).toMatch(/preserv.*codegraph sync/i);
      expect(recovery).not.toMatch(/Re-run "codegraph index"/i);
      fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), '{');
      const invalid = status();
      expect(invalid).toMatch(/preserv.*codegraph sync/i);
      expect(invalid).not.toMatch(/Re-run "codegraph index"/i);
      const metadataOnly = status('--metadata-only');
      expect(metadataOnly).toMatch(/preserv.*codegraph sync/i);
      expect(metadataOnly).not.toMatch(/Re-run "codegraph index"/i);
    } finally {
      graph.destroy();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 90_000);
});
