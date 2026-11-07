import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ResolverPool } from '../src/resolution/resolver-pool';
import type { ReferenceResolver } from '../src/resolution';
import type { DatabaseConnection } from '../src/db';

describe('failed resolver pool cleanup', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('waits for a failed startup pool to close before resolution returns', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resolver-startup-'));
    fs.writeFileSync(path.join(root, 'entry.ts'), 'export function entry() { MissingCall(); }\n');
    const graph = CodeGraph.initSync(root);
    let release!: () => void;
    let operation: Promise<unknown> | undefined;
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const internal = graph as unknown as { db: DatabaseConnection; resolver: ReferenceResolver };
      internal.db.getDb().prepare("UPDATE unresolved_refs SET status = 'pending' WHERE reference_name = 'MissingCall'").run();
      const close = new Promise<void>(resolve => { release = resolve; });
      const failed = { ready: () => Promise.reject(new Error('injected pool startup failure')), destroy: vi.fn(() => close) };
      vi.stubEnv('CODEGRAPH_PARALLEL_RESOLVE_MIN', '0');
      vi.spyOn(ResolverPool, 'tryCreate').mockReturnValue(failed as unknown as ResolverPool);
      operation = internal.resolver.resolveAndPersistBatched(undefined, 500, undefined,
        { dbPath: path.join(root, '.codegraph', 'codegraph.db') }, false);
      await vi.waitFor(() => expect(failed.destroy).toHaveBeenCalled(), { timeout: 3000 });
      const settled = await Promise.race([
        operation.then(() => true, () => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
      ]);
      expect(settled).toBe(false);
    } finally {
      release?.();
      await operation?.catch(() => undefined);
      graph.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
