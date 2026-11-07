import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseConnection } from '../src/db';
import type { QueryBuilder } from '../src/db/queries';

const CodeGraph = require(process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist')).default as typeof import('../src').default;

describe('UE freshness with unfinished work', () => {
  it('does not report fresh while synthesis or reference work is pending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-status-pending-'));
    const file = path.join(root, 'Engine/Source/Runtime/Core/Core.cpp');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), JSON.stringify({ ueEngine: { plugins: [] } }));
    fs.writeFileSync(file, 'void Caller() { MissingCall(); }\n');
    expect(spawnSync('git', ['init', '-q', root], { windowsHide: true }).status).toBe(0);
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const internal = graph as unknown as { queries: QueryBuilder; db: DatabaseConnection };
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      internal.queries.setMetadata('synthesis_pending', '1');
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
      internal.queries.setMetadata('synthesis_pending', '0');
      internal.db.getDb().prepare("UPDATE unresolved_refs SET status = 'pending' WHERE reference_name = 'MissingCall'").run();
      expect(graph.getPendingReferenceCount()).toBeGreaterThan(0);
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
    } finally {
      graph.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
