import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Exercise the shipped worker beside the compiled resolver.
const testDist = process.env.CODEGRAPH_TEST_DIST ?? path.resolve('dist');
const CodeGraph = (require(testDist) as typeof import('../src')).default;
const { DatabaseConnection } = require(path.join(testDist, 'db')) as typeof import('../src/db');
const { QueryBuilder } = require(path.join(testDist, 'db/queries')) as typeof import('../src/db/queries');
const { ReferenceResolver } = require(path.join(testDist, 'resolution')) as typeof import('../src/resolution');
const { ResolverPool } = require(path.join(testDist, 'resolution/resolver-pool')) as typeof import('../src/resolution/resolver-pool');

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('UE static worker resolution', () => {
  it('preserves uncertain include, call, inheritance and type candidates across worker chunks', async () => {
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph');
    vi.stubEnv('CODEGRAPH_NO_PARALLEL_RESOLVE', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-static-pool-'));
    roots.push(root);
    const write = (file: string, contents: string): void => {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const file = 'Engine/Source/Runtime/Core/Private/Use.cpp';
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/One/Public/One.h', 'class FSharedBase {};\nclass FTypeShared {};\nvoid SharedCall() {}\nvoid UniqueCall() {}\n');
    write('Engine/Source/Runtime/Two/Public/Two.h', 'class FSharedBase {};\nclass FTypeShared {};\nvoid SharedCall() {}\n');
    write('Engine/Source/Runtime/One/Public/Other/Shared.h', 'class FOne {};\n');
    write('Engine/Source/Runtime/Two/Public/Other/Shared.h', 'class FTwo {};\n');
    write(file, '#include "Other/Shared.h"\nclass FChild : public FSharedBase {};\nvoid NeedsType(FTypeShared* value);\nvoid Caller() { SharedCall(); UniqueCall(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    let connection: InstanceType<typeof DatabaseConnection> | undefined;
    let pool: ReturnType<typeof ResolverPool.tryCreate> = null;
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const uncertain = graph.getUnresolvedReferencesInFile(file).filter(ref =>
        ['Other/Shared.h', 'FSharedBase', 'FTypeShared', 'SharedCall'].includes(ref.referenceName));
      expect(uncertain).toHaveLength(4);
      for (const ref of uncertain) expect(ref.candidates).toHaveLength(2);
      const caller = graph.getNodesByName('Caller')[0]!;
      const one = { fromNodeId: caller.id, referenceName: 'UniqueCall', referenceKind: 'calls' as const,
        filePath: file, language: 'cpp' as const, line: 4, column: 30 };
      // More than one worker chunk, with fresh objects for each resolver.
      const refs = Array.from({ length: 200 }, () => [...uncertain.map(ref => ({ ...ref, candidates: undefined })), { ...one }]).flat();
      connection = DatabaseConnection.open(path.join(root, '.codegraph/codegraph.db'));
      const queries = new QueryBuilder(connection.getDb());
      const resolver = new ReferenceResolver(root, queries);
      resolver.initialize();
      const main = resolver.resolveListForAdmission(structuredClone(refs));
      vi.stubEnv('CODEGRAPH_NO_PARALLEL_RESOLVE', '0');
      vi.stubEnv('CODEGRAPH_RESOLVE_WORKERS', '2');
      pool = ResolverPool.tryCreate(path.join(root, '.codegraph/codegraph.db'), root);
      expect(pool).not.toBeNull();
      await pool!.ready();
      const worker = await pool!.resolveBatch(structuredClone(refs));
      expect(worker).toEqual(main);
      expect(worker.resolved.some(ref => ref.original.referenceName === 'UniqueCall')).toBe(true);
      for (const name of ['Other/Shared.h', 'FSharedBase', 'FTypeShared', 'SharedCall']) {
        expect(worker.unresolved.find(ref => ref.referenceName === name)?.candidates).toHaveLength(2);
      }
    } finally {
      await pool?.destroy();
      connection?.close();
      graph.destroy();
    }
  }, 120000);
});
