import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src';
import type { DatabaseConnection } from '../src/db';
import type { ReferenceResolver } from '../src/resolution';
import type { QueryBuilder } from '../src/db/queries';

describe('scoped UE candidate refresh', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['line shift', 'delete', 'rename'] as const)(
    'rechecks the affected name after a %s without revisiting unrelated candidates', async change => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-candidate-refresh-'));
      roots.push(root);
      const write = (relative: string, contents: string): void => {
        const full = path.join(root, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, contents);
      };
      const base = 'Engine/Source/Runtime/Core';
      const changed = `${base}/HotA.cpp`, callerFile = `${base}/Caller.cpp`;
      write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
      write(changed, 'void Hot() {}\n');
      write(`${base}/HotB.cpp`, 'void Hot() {}\n');
      write(`${base}/ColdA.cpp`, 'void Cold() {}\n');
      write(`${base}/ColdB.cpp`, 'void Cold() {}\n');
      write(callerFile, 'void Caller() { Hot(); Cold(); }\n');
      execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
      const graph = CodeGraph.initSync(root);
      try {
        expect((await graph.indexAll()).success).toBe(true);
        const find = (name: string) => graph.getUnresolvedReferencesInFile(callerFile)
          .find(ref => ref.referenceName === name);
        expect(find('Hot')?.candidates).toHaveLength(2);
        const cold = find('Cold')?.candidates;
        expect(cold).toHaveLength(2);
        const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
        const caller = graph.getNodesByName('Caller')[0]!;
        const arrow = resolver.resolveListForAdmission([{
          fromNodeId: caller.id, referenceName: 'value->Hot/1000', referenceKind: 'calls',
          filePath: callerFile, language: 'cpp', line: 1, column: 1,
        }]);
        expect(arrow.unresolved[0]?.nameTail).toBe('Hot');
        const resolutions = vi.spyOn(resolver, 'resolveAndPersistListYielding');
        if (change === 'delete') fs.unlinkSync(path.join(root, changed));
        else write(changed, change === 'rename' ? 'void Replacement() {}\n' : '\nvoid Hot() {}\n');
        const phases: Array<{ phase: string; current: number; total: number }> = [];
        await graph.syncAutomatically({ onProgress: progress => phases.push(progress) });
        expect(phases.some(progress => progress.phase === 'refreshing' && progress.total === 0)).toBe(true);
        expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
        const retried = resolutions.mock.calls.flatMap(([refs]) => refs.map(ref => ref.referenceName));
        expect(retried).toContain('Hot');
        expect(retried).not.toContain('Cold');
        expect(find('Cold')?.candidates).toEqual(cold);
        if (change === 'line shift') expect(find('Hot')?.candidates).toContain(`${changed}:2 Hot`);
        else expect(find('Hot')?.candidates?.some(candidate => candidate.includes('HotA.cpp')) ?? false).toBe(false);
      } finally { graph.destroy(); }
    }, 90_000,
  );

  it('falls back to all candidates when the tail format has not been verified', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-candidate-legacy-'));
    roots.push(root);
    const write = (relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const base = 'Engine/Source/Runtime/Core';
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    for (const name of ['Hot', 'Cold']) for (const suffix of ['A', 'B']) write(`${base}/${name}${suffix}.cpp`, `void ${name}() {}\n`);
    write(`${base}/Caller.cpp`, 'void Caller() { Hot(); Cold(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const internals = graph as unknown as { queries: QueryBuilder; resolver: ReferenceResolver };
      expect(internals.queries.getMetadata('ue_candidate_tail_version')).toBe('1');
      internals.queries.setMetadata('ue_candidate_tail_version', '');
      const resolutions = vi.spyOn(internals.resolver, 'resolveAndPersistListYielding');
      write(`${base}/HotA.cpp`, '\nvoid Hot() {}\n');
      await graph.syncAutomatically();
      const retried = resolutions.mock.calls.flatMap(([refs]) => refs.map(ref => ref.referenceName));
      expect(retried).toContain('Hot');
      expect(retried).toContain('Cold');
    } finally { graph.destroy(); }
  }, 90_000);

  it('rechecks include candidates when a matching header is added', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-candidate-include-'));
    roots.push(root);
    const write = (relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const caller = 'Engine/Source/Runtime/Core/Caller.cpp';
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/One/Public/Nested/Shared.h', 'class FOne {};\n');
    write(caller, '#include "Nested/Shared.h"\nvoid Caller() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const ref = () => graph.getUnresolvedReferencesInFile(caller).find(value => value.referenceName === 'Nested/Shared.h');
      expect(ref()?.candidates).toHaveLength(1);
      write('Engine/Source/Runtime/Two/Public/Nested/Shared.h', 'class FTwo {};\n');
      await graph.syncAutomatically();
      expect(ref()?.candidates).toHaveLength(2);
    } finally { graph.destroy(); }
  }, 90_000);

  it('rechecks an empty candidate even when its name is not in the changed file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-candidate-empty-'));
    roots.push(root);
    const write = (relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const base = 'Engine/Source/Runtime/Core', caller = `${base}/Caller.cpp`;
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    for (const name of ['Hot', 'Cold']) for (const suffix of ['A', 'B']) write(`${base}/${name}${suffix}.cpp`, `void ${name}() {}\n`);
    write(caller, 'void Caller() { Hot(); Cold(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const cold = graph.getUnresolvedReferencesInFile(caller).find(ref => ref.referenceName === 'Cold')!;
      const db = (graph as unknown as { db: DatabaseConnection }).db.getDb();
      db.prepare("UPDATE unresolved_refs SET candidates = '[]' WHERE id = ?").run(cold.rowId!);
      write(`${base}/HotA.cpp`, '\nvoid Hot() {}\n');
      await graph.syncAutomatically();
      expect(graph.getUnresolvedReferencesInFile(caller).find(ref => ref.referenceName === 'Cold')?.candidates).toHaveLength(2);
    } finally { graph.destroy(); }
  }, 90_000);

  it('uses a full candidate refresh after an interrupted scoped refresh', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-candidate-recovery-'));
    roots.push(root);
    const write = (relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const base = 'Engine/Source/Runtime/Core', caller = `${base}/Caller.cpp`;
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    for (const name of ['Hot', 'Cold']) for (const suffix of ['A', 'B']) write(`${base}/${name}${suffix}.cpp`, `void ${name}() {}\n`);
    write(caller, 'void Caller() { Hot(); Cold(); }\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    let graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const actual = resolver.refreshUeIncludeCandidates.bind(resolver);
      const failure = vi.spyOn(resolver, 'refreshUeIncludeCandidates').mockImplementationOnce(async names => {
        await actual(names);
        throw new Error('injected candidate refresh interruption');
      });
      write(`${base}/HotA.cpp`, '\nvoid Hot() {}\n');
      await expect(graph.syncAutomatically()).rejects.toThrow('injected candidate refresh interruption');
      failure.mockRestore();
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
      graph.destroy();
      graph = CodeGraph.openSync(root);
      const reopened = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const refresh = vi.spyOn(reopened, 'refreshUeIncludeCandidates');
      await graph.sync();
      expect(refresh.mock.calls[0]?.[0]).toBeUndefined();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
      expect(graph.getUnresolvedReferencesInFile(caller).find(ref => ref.referenceName === 'Hot')?.candidates)
        .toContain(`${base}/HotA.cpp:2 Hot`);
    } finally { graph.destroy(); }
  }, 90_000);

  it('keeps candidates when a transitive macro include is uncertain', async () => {
    const base = 'Engine/Source/Runtime/Core';
    const caller = `${base}/Caller.cpp`;
    const write = (root: string, relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const create = (withInclude: boolean): string => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-macro-candidate-'));
      roots.push(root);
      write(root, '.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
      write(root, `${base}/HotA.cpp`, 'void Hot() {}\n');
      write(root, `${base}/HotB.cpp`, 'void Hot() {}\n');
      write(root, `${base}/Macros.h`, '#define Hot() 1\n');
      write(root, `${base}/Middle.h`, withInclude ? '#include "Macros.h"\n' : '\n');
      write(root, caller, '#include "Middle.h"\nvoid Caller() { Hot(); }\n');
      execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
      return root;
    };
    const incrementalRoot = create(false), rebuiltRoot = create(true);
    const incremental = CodeGraph.initSync(incrementalRoot), rebuilt = CodeGraph.initSync(rebuiltRoot);
    const candidates = (graph: CodeGraph) => graph.getUnresolvedReferencesInFile(caller)
      .find(ref => ref.referenceName === 'Hot')?.candidates;
    try {
      expect((await incremental.indexAll()).success).toBe(true);
      expect(candidates(incremental)).toHaveLength(2);
      write(incrementalRoot, `${base}/Middle.h`, '#include "Macros.h"\n');
      await incremental.syncAutomatically();
      expect((await rebuilt.indexAll()).success).toBe(true);
      // A UE include target is a static candidate, not proof of macro visibility.
      expect(candidates(rebuilt)).toHaveLength(2);
      expect(candidates(incremental)).toEqual(candidates(rebuilt));
    } finally { incremental.destroy(); rebuilt.destroy(); }
  }, 90_000);

  it('matches a clean rebuild after a source edit and a header is added', async () => {
    const rootsForTest = ['incremental', 'rebuilt'].map(label => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-ue-${label}-`));
      roots.push(root);
      return root;
    });
    const write = (root: string, relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };
    const base = 'Engine/Source/Runtime', caller = `${base}/Core/Caller.cpp`;
    const populate = (root: string, final: boolean): void => {
      write(root, '.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
      write(root, `${base}/Core/HotA.cpp`, `${final ? '\n' : ''}void Hot() {}\n`);
      write(root, `${base}/Core/HotB.cpp`, 'void Hot() {}\n');
      write(root, `${base}/Core/ColdA.cpp`, 'void Cold() {}\n');
      write(root, `${base}/Core/ColdB.cpp`, 'void Cold() {}\n');
      write(root, `${base}/One/Public/Nested/Shared.h`, 'class FOne {};\n');
      if (final) write(root, `${base}/Two/Public/Nested/Shared.h`, 'class FTwo {};\n');
      write(root, caller, '#include "Nested/Shared.h"\nvoid Caller() { Hot(); Cold(); }\n');
      execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    };
    populate(rootsForTest[0]!, false);
    populate(rootsForTest[1]!, true);
    const incremental = CodeGraph.initSync(rootsForTest[0]!);
    const rebuilt = CodeGraph.initSync(rootsForTest[1]!);
    try {
      expect((await incremental.indexAll()).success).toBe(true);
      write(rootsForTest[0]!, `${base}/Core/HotA.cpp`, '\nvoid Hot() {}\n');
      write(rootsForTest[0]!, `${base}/Two/Public/Nested/Shared.h`, 'class FTwo {};\n');
      await incremental.syncAutomatically();
      expect((await rebuilt.indexAll()).success).toBe(true);
      const observations = (graph: CodeGraph) => graph.getUnresolvedReferencesInFile(caller)
        .filter(ref => ['Hot', 'Cold', 'Nested/Shared.h'].includes(ref.referenceName))
        .map(ref => ({ name: ref.referenceName, candidates: ref.candidates?.slice().sort() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(observations(incremental)).toEqual(observations(rebuilt));
      expect(observations(incremental)).toHaveLength(3);
    } finally { incremental.destroy(); rebuilt.destroy(); }
  }, 90_000);
});
