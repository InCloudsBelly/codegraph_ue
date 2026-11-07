import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import type { ReferenceResolver } from '../src/resolution';

describe('initial UE index completeness', () => {
  it('commits build version only after final scope verification succeeds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-initial-version-'));
    const file = path.join(root, 'Engine/Source/Runtime/Core/Core.cpp');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), JSON.stringify({ ueEngine: { plugins: [] } }));
    fs.writeFileSync(file, 'void Entry() {}\n');
    const graph = CodeGraph.initSync(root);
    try {
      const internal = graph as unknown as { verifyUeIndexedHashes: () => Promise<void> };
      const fail = vi.spyOn(internal, 'verifyUeIndexedHashes').mockRejectedValueOnce(new Error('injected final verification failure'));
      try { await expect(graph.indexAll()).rejects.toThrow('injected final verification failure'); }
      finally { fail.mockRestore(); }
      expect(graph.getIndexBuildInfo()).toEqual({ version: null, extractionVersion: null });
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
      await graph.sync();
      expect(graph.getIndexBuildInfo().version).toBeTruthy();
      expect(graph.getIndexBuildInfo().extractionVersion).not.toBeNull();
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally {
      vi.restoreAllMocks();
      graph.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('does not publish a fresh scope when a resolution pass leaves pending references', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-initial-pending-'));
    const file = path.join(root, 'Engine/Source/Runtime/Core/Core.cpp');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codegraph/indexing.json'), JSON.stringify({ ueEngine: { plugins: [] } }));
    fs.writeFileSync(file, 'void Caller() { MissingCall(); }\n');
    const graph = CodeGraph.initSync(root);
    try {
      const resolver = (graph as unknown as { resolver: ReferenceResolver }).resolver;
      const resolution = vi.spyOn(resolver, 'resolveAndPersistBatched').mockResolvedValue({
        resolved: [], unresolved: [], stats: { total: 0, resolved: 0, unresolved: 0, byMethod: {} },
      });
      const result = await graph.indexAll();
      expect(result.success).toBe(false);
      expect(graph.getPendingReferenceCount()).toBeGreaterThan(0);
      expect((await graph.getUeScopeStatus())?.state).not.toBe('fresh');
      resolution.mockRestore();
      await graph.sync();
      expect(graph.getPendingReferenceCount()).toBe(0);
      expect((await graph.getUeScopeStatus())?.state).toBe('fresh');
    } finally {
      vi.restoreAllMocks();
      graph.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
