import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fileLimits from '../src/file-limits';
import { loadIndexingConfig } from '../src/indexing-config';
import { buildUeEngineScopeAsync, UeScopeObservationCache } from '../src/extraction/ue-engine-scope';

describe('UE scope source observation', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads a source once per scope observation but rechecks later admission', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-scope-observation-'));
    roots.push(root);
    const relative = 'Engine/Source/Runtime/Core/Core.cpp';
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codegraph', 'indexing.json'), JSON.stringify({ ueEngine: { plugins: [] } }));
    fs.writeFileSync(file, '#include "Header.h"\nvoid EngineEntry() {}\n');
    const config = loadIndexingConfig(root).ueEngine!;
    const read = vi.spyOn(fileLimits, 'readBoundedSourceSync');
    const scope = await buildUeEngineScopeAsync(root, config, 1);
    expect(read.mock.calls.filter(([name]) => path.resolve(String(name)) === file)).toHaveLength(1);
    read.mockClear();
    const uncached = await buildUeEngineScopeAsync(root, config, 1, { observationCacheBytes: 0 });
    expect(read.mock.calls.filter(([name]) => path.resolve(String(name)) === file)).toHaveLength(2);
    expect(uncached.fingerprint).toBe(scope.fingerprint);
    read.mockClear();
    fs.writeFileSync(file, '#if WITH_DEV_AUTOMATION_TESTS\nvoid TestOnly() {}\n#endif\n');
    expect(scope.allows(relative)).toBe(false);
    expect(read.mock.calls.filter(([name]) => path.resolve(String(name)) === file)).toHaveLength(1);
  }, 15_000);

  it('reuses unchanged source across consecutive observations and rereads a changed file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-scope-shared-'));
    roots.push(root);
    const relative = 'Engine/Source/Runtime/Core/Core.cpp', file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codegraph', 'indexing.json'), JSON.stringify({ ueEngine: { plugins: [] } }));
    fs.writeFileSync(file, '#include "Header.h"\nvoid Before() {}\n');
    const config = loadIndexingConfig(root).ueEngine!;
    const cache = new UeScopeObservationCache();
    const read = vi.spyOn(fileLimits, 'readBoundedSourceSync');
    try {
      const first = await buildUeEngineScopeAsync(root, config, 1, { observationCache: cache });
      read.mockClear();
      const second = await buildUeEngineScopeAsync(root, config, 1, { observationCache: cache });
      expect(read.mock.calls.filter(([name]) => path.resolve(String(name)) === file)).toHaveLength(0);
      expect(second.fingerprint).toBe(first.fingerprint);
      const prior = fs.statSync(file);
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      fs.writeFileSync(file, '#include "Header.h"\nvoid After_() {}\n');
      fs.utimesSync(file, prior.atime, prior.mtime);
      expect(fs.statSync(file).size).toBe(prior.size);
      read.mockClear();
      const third = await buildUeEngineScopeAsync(root, config, 1, { observationCache: cache });
      expect(read.mock.calls.filter(([name]) => path.resolve(String(name)) === file)).toHaveLength(1);
      expect(third.fingerprint).not.toBe(first.fingerprint);
    } finally { cache.clear(); }
  }, 30_000);
});
