import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import { isUeTestOnlyFile, ueTestOnlyLines } from '../src/extraction/ue-test-scope';
import type { ExtractionOrchestrator } from '../src/extraction';

describe('UE scope preservation', () => {
  let root: string;
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-preserve-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('does not mistake directives inside a continued comment for test guards', async () => {
    const source = ['// comment \\', '#if WITH_DEV_AUTOMATION_TESTS', 'void Production() {}', '// comment \\', '#endif', ''].join('\r\n');
    expect([...ueTestOnlyLines(source)]).toEqual([]);
    expect(isUeTestOnlyFile(source)).toBe(false);
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', source);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('Production')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);

  it('ignores fake test guards inside continued macro definitions', async () => {
    const source = ['#define IGNORED_IF \\', '#if WITH_DEV_AUTOMATION_TESTS', 'void Production() {}', '#define IGNORED_ENDIF \\', '#endif', '#if WITH_DEV_AUTOMATION_TESTS', 'void TestOnly() {}', '#endif', ''].join('\n');
    expect([...ueTestOnlyLines(source)]).toEqual([7]);
    expect(isUeTestOnlyFile(source)).toBe(false);
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', source);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('Production')).toHaveLength(1);
      expect(graph.getNodesByName('TestOnly')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not expand a plugin from an include inside a continued macro', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', ['#define FAKE \\', '#include "Fake/Fake.h"', 'void EngineEntry() {}', ''].join('\n'));
    write('Engine/Plugins/Runtime/Fake/Fake.uplugin', '{}');
    write('Engine/Plugins/Runtime/Fake/Source/Fake/Public/Fake/Fake.h', 'class FFakePlugin {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('EngineEntry')).toHaveLength(1);
      expect(graph.getNodesByName('FFakePlugin')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('retains production branches behind elifdef and elifndef after test guards', async () => {
    const source = ['#if WITH_DEV_AUTOMATION_TESTS', 'void TestA() {}', '#elifdef PLATFORM_WINDOWS', 'void ProductionA() {}', '#endif', '#if WITH_DEV_AUTOMATION_TESTS', 'void TestB() {}', '#elifndef PLATFORM_WINDOWS', 'void ProductionB() {}', '#endif', ''].join('\n');
    expect([...ueTestOnlyLines(source)]).toEqual([2, 7]);
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', source);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('ProductionA')).toHaveLength(1);
      expect(graph.getNodesByName('ProductionB')).toHaveLength(1);
      expect(graph.getNodesByName('TestA')).toHaveLength(0);
      expect(graph.getNodesByName('TestB')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('refuses an ancestor junction before treating engine source as removed', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Outside/Runtime/Core/Core.cpp', 'void OutsideEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      fs.renameSync(path.join(root, 'Engine/Source'), path.join(root, 'Engine/OriginalSource'));
      fs.symlinkSync(path.join(root, 'Outside'), path.join(root, 'Engine/Source'), 'junction');
      await expect(graph.syncAutomatically()).rejects.toThrow(/link/i);
      expect(graph.getNodesByName('EngineEntry')).toHaveLength(1);
      expect(graph.getNodesByName('OutsideEntry')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('does not mark fresh when a source is transiently excluded during scanning', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    const file = 'Engine/Source/Runtime/Core/Core.cpp';
    const original = 'void EngineEntry() {}\n';
    write(file, original);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const extractor = (graph as unknown as { orchestrator: ExtractionOrchestrator }).orchestrator;
      const prepare = extractor.prepareScan.bind(extractor);
      const mock = vi.spyOn(extractor, 'prepareScan').mockImplementation(async (...args) => {
        write(file, '#if WITH_DEV_AUTOMATION_TESTS\nvoid EngineEntry() {}\n#endif\n');
        try { return await prepare(...args); } finally { write(file, original); }
      });
      try { await expect(graph.sync({ expandUePlugins: true })).rejects.toThrow(/source missing during verification/i); }
      finally { mock.mockRestore(); }
      expect(graph.getIndexState()).toBe('partial');
      await graph.sync();
      expect(graph.getNodesByName('EngineEntry')).toHaveLength(1);
      expect(graph.getIndexState()).toBe('complete');
    } finally { await graph.destroy(); }
  }, 60000);
});
