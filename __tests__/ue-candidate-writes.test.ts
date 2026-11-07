import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import type { DatabaseConnection } from '../src/db';
import type { QueryBuilder } from '../src/db/queries';

describe('UE candidate persistence', () => {
  it('does not rewrite unchanged candidates or failed state and still saves changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-candidate-writes-'));
    const write = (relative: string, text: string): void => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/A.cpp', 'void Shared() {}\n');
    write('Engine/Source/Runtime/Core/B.cpp', 'void Shared() {}\n');
    const caller = 'Engine/Source/Runtime/Core/Caller.cpp';
    write(caller, 'void Caller() { Shared(); }\n');
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const ref = graph.getUnresolvedReferencesInFile(caller).find(value => value.referenceName === 'Shared');
      expect(ref?.candidates).toHaveLength(2);
      const internal = graph as unknown as { db: DatabaseConnection; queries: QueryBuilder };
      const db = internal.db.getDb();
      const changes = (): number => (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
      const before = changes();
      internal.queries.markReferencesFailedByRowIds([{
        rowId: ref!.rowId!, referenceName: ref!.referenceName, referenceKind: ref!.referenceKind,
      }], true);
      expect(changes()).toBe(before);
      internal.queries.updateUeCandidates([{ rowId: ref!.rowId!, candidates: ref!.candidates! }]);
      expect(changes()).toBe(before);
      internal.queries.updateUeCandidates([{ rowId: ref!.rowId!, candidates: ['new.cpp:1 Shared'] }]);
      expect(changes()).toBe(before + 1);
      expect(graph.getUnresolvedReferencesInFile(caller).find(value => value.referenceName === 'Shared')?.candidates)
        .toEqual(['new.cpp:1 Shared']);
      db.prepare("UPDATE unresolved_refs SET status = 'pending' WHERE id = ?").run(ref!.rowId!);
      expect(internal.queries.markReferencesFailedByRowIds([{
        rowId: ref!.rowId!, referenceName: ref!.referenceName, referenceKind: ref!.referenceKind,
      }], true)).toBe(1);
      expect((db.prepare('SELECT status FROM unresolved_refs WHERE id = ?').get(ref!.rowId!) as { status: string }).status).toBe('failed');
    } finally {
      graph.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
