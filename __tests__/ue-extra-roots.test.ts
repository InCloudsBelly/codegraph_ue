import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';
import { loadIndexingConfig } from '../src/indexing-config';

describe('UE optional source roots', () => {
  let root: string;
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-extra-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('indexes only explicitly selected Samples and Templates paths and removes deselected paths', async () => {
    const config = (extraRoots: string[]) => write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots } }));
    config(['Samples/Chosen/Source', 'Templates/Chosen/Source']);
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Samples/Chosen/Source/Sample.cpp', 'void SelectedSample() {}\n');
    write('Templates/Chosen/Source/Template.cpp', 'void SelectedTemplate() {}\n');
    write('Samples/Other/Source/Other.cpp', 'void UnselectedSample() {}\n');
    write('Templates/Other/Source/Other.cpp', 'void UnselectedTemplate() {}\n');
    write('Client/Source/Private.cpp', 'void ClientEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['add', 'Samples/Chosen/Source/Sample.cpp'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      for (const name of ['EngineEntry', 'SelectedSample', 'SelectedTemplate']) expect(graph.getNodesByName(name), name).toHaveLength(1);
      for (const name of ['UnselectedSample', 'UnselectedTemplate', 'ClientEntry']) expect(graph.getNodesByName(name), name).toHaveLength(0);
      write('Samples/Chosen/Source/Sample.cpp', 'void UpdatedSample() {}\n');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('SelectedSample')).toHaveLength(0);
      expect(graph.getNodesByName('UpdatedSample')).toHaveLength(1);
      config(['Samples/Chosen/Source']);
      await graph.syncAutomatically();
      expect(graph.getNodesByName('SelectedTemplate')).toHaveLength(0);
      expect(graph.getNodesByName('UpdatedSample')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 60000);

  it('discovers a selected source root below an embedded sample repository', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots: ['Samples/Chosen/Source'] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Samples/Chosen/Source/Example.cpp', 'void NestedExample() {}\n');
    write('Samples/Chosen/Other/Other.cpp', 'void NestedOther() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Samples/Chosen'), windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('NestedExample')).toHaveLength(1);
      expect(graph.getNodesByName('NestedOther')).toHaveLength(0);
      write('Samples/Chosen/Source/Example.cpp', 'void UpdatedNestedExample() {}\n');
      await graph.syncAutomatically();
      expect(graph.getNodesByName('UpdatedNestedExample')).toHaveLength(1);
      expect(graph.getNodesByName('NestedOther')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 60000);

  it('follows only the selected path through two nested sample Git boundaries', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots: ['Samples/Chosen/Source/Allowed'] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Samples/Chosen/Source/Allowed/Core.cpp', 'void DeepAllowed() {}\n');
    write('Samples/Chosen/Source/Other/Core.cpp', 'void DeepOther() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Samples/Chosen'), windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Samples/Chosen/Source'), windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('DeepAllowed')).toHaveLength(1);
      expect(graph.getNodesByName('DeepOther')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('refuses a junction in the ancestors of an explicitly selected example path', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots: ['Samples/Chosen/Source'] } }));
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Client/Source/Secret.cpp', 'void ClientEntry() {}\n');
    fs.mkdirSync(path.join(root, 'Samples'), { recursive: true });
    fs.symlinkSync(path.join(root, 'Client'), path.join(root, 'Samples/Chosen'), 'junction');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      await expect(graph.indexAll()).rejects.toThrow(/link/i);
      expect(graph.getNodesByName('ClientEntry')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);

  it('excludes the confirmed replication test program and test plugin without dropping EnvQueryTest production code', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ exclude: ['Engine/Source/Programs/ReplicationSystemTest/'], ueEngine: { plugins: [], excludePlugins: ['Engine/Plugins/Runtime/ReplicationSystemTestPlugin'] } }));
    write('Engine/Source/Programs/ReplicationSystemTest/Private/Main.cpp', '#include "ReplicationSystemTestPlugin/Test.h"\nvoid TestProgram() {}\n');
    write('Engine/Source/Runtime/AIModule/Classes/EnvironmentQuery/Tests/EnvQueryTest_Distance.h', 'class UEnvQueryTest_Distance {};\n');
    write('Engine/Plugins/Runtime/ReplicationSystemTestPlugin/ReplicationSystemTestPlugin.uplugin', '{"Description":"Unit and functional tests"}');
    write('Engine/Plugins/Runtime/ReplicationSystemTestPlugin/Source/ReplicationSystemTestPlugin/Public/ReplicationSystemTestPlugin/Test.h', 'class FTestPlugin {};\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      expect(graph.getNodesByName('TestProgram')).toHaveLength(0);
      expect(graph.getNodesByName('FTestPlugin')).toHaveLength(0);
      expect(graph.getNodesByName('UEnvQueryTest_Distance')).toHaveLength(1);
    } finally { await graph.destroy(); }
  }, 30000);

  it('rejects broad Samples or Templates roots and any Client root', async () => {
    for (const extra of ['Samples', 'Templates', 'Client/Source']) {
      write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [], extraRoots: [extra] } }));
      expect(() => loadIndexingConfig(root), extra).toThrow();
    }
  });
});
