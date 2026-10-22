import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { checkCppIncludeSnapshot } from '../src/resolution/cpp-include-environment';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe('UE compiler include environments', () => {
  let root: string;
  let graph: CodeGraph | undefined;
  let external: string | undefined;
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const database = (entries: Array<{ file: string; arguments: string[]; directory?: string }>) =>
    write('compile_commands.json', JSON.stringify(entries.map(e => ({ directory: root, ...e }))));
  const target = (file: string) => {
    const node = graph!.getNodesInFile(file).find(n => n.kind === 'file')!;
    return graph!.getOutgoingEdges(node.id).filter(e => e.kind === 'imports')
      .map(e => graph!.getNode(e.target)?.filePath);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-includes-')); });
  afterEach(() => {
    vi.clearAllMocks();
    graph?.destroy(); graph = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    if (external) fs.rmSync(external, { recursive: true, force: true });
    external = undefined;
  });

  it('resolves identical header names within each translation unit environment', async () => {
    write('A/Public/Config.h', 'struct AConfig {};');
    write('B/Public/Config.h', 'struct BConfig {};');
    write('A/Private/a.cpp', '#include "Config.h"\nvoid AUse() {}');
    write('B/Private/b.cpp', '#include "Config.h"\nvoid BUse() {}');
    database([
      { file: 'A/Private/a.cpp', arguments: ['clang++', '-IA/Public', '-c', 'A/Private/a.cpp'] },
      { file: 'B/Private/b.cpp', arguments: ['clang++', '-IB/Public', '-c', 'B/Private/b.cpp'] },
    ]);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(target('A/Private/a.cpp')).toEqual(['A/Public/Config.h']);
    expect(target('B/Private/b.cpp')).toEqual(['B/Public/Config.h']);
  });

  it('expands a UTF16 clang-cl response using compiler cwd and Windows quoting', async () => {
    write('Public 中文/Config.h', 'struct Included {};');
    write('src/a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('build/args.rsp', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('/I"Public 中文"', 'utf16le')]));
    database([{ file: 'src/a.cpp', arguments: ['clang-cl.exe', '@build/args.rsp', '/c', 'src/a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('src/a.cpp')).toEqual(['Public 中文/Config.h']);
  });

  it('maps physical P4 junction paths back to the existing logical file identities', async () => {
    external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-includes-p4-'));
    fs.symlinkSync(external, path.join(root, 'Client'), process.platform === 'win32' ? 'junction' : 'dir');
    write('Client/Plugins/A/Public/Config.h', 'struct Wrong {};');
    write('Client/Plugins/B/Public/Config.h', 'struct Right {};');
    write('Client/Plugins/A/Private/a.cpp', '#include "Config.h"\nvoid Use() {}');
    write('Client/build/args.rsp', '/I"Plugins/B/Public"');
    database([{ file: path.join(external, 'Plugins/A/Private/a.cpp'), directory: external,
      arguments: ['clang-cl.exe', '@build/args.rsp', '/c', 'Plugins/A/Private/a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Client/Plugins/A/Private/a.cpp')).toEqual(['Client/Plugins/B/Public/Config.h']);
  });

  it('rebinds persisted include edges after metadata-only changes across reopen', async () => {
    write('A/Config.h', 'struct A {};'); write('B/Config.h', 'struct B {};');
    write('src/a.cpp', '#include "Config.h"\nvoid Use() {}');
    database([{ file: 'src/a.cpp', arguments: ['clang++', '-IA', '-IB', '-c', 'src/a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('src/a.cpp')).toEqual(['A/Config.h']);
    graph.destroy(); graph = undefined;
    database([{ file: 'src/a.cpp', arguments: ['clang++', '-IB', '-IA', '-c', 'src/a.cpp'] }]);
    graph = await CodeGraph.open(root); await graph.sync();
    expect(target('src/a.cpp')).toEqual(['B/Config.h']);
  });

  it('uses the same scoped include for the graph and macro visibility', async () => {
    write('A/Macros.h', '#define ACTION() ignored()\n'); write('B/Macros.h', 'struct NoMacro {};');
    write('src/a.cpp', '#include <Macros.h>\nvoid AUse() {}');
    write('src/b.cpp', '#include <Macros.h>\nvoid ACTION() {}\nvoid BUse() { ACTION(); }');
    database([
      { file: 'src/a.cpp', arguments: ['clang++', '-IA', '-c', 'src/a.cpp'] },
      { file: 'src/b.cpp', arguments: ['clang++', '-IB', '-c', 'src/b.cpp'] },
    ]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    const caller = graph.getNodesInFile('src/b.cpp').find(n => n.name === 'BUse')!;
    expect(graph.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls')
      .map(e => graph!.getNode(e.target)?.name)).toContain('ACTION');
  });

  it('keeps a shared header ambiguous when its includer environments disagree', async () => {
    write('A/Config.h', 'struct A {};'); write('B/Config.h', 'struct B {};');
    write('Shared/Entry.h', '#include <Config.h>\nstruct Entry {};');
    write('a.cpp', '#include <Entry.h>\nvoid AUse() {}');
    write('b.cpp', '#include <Entry.h>\nvoid BUse() {}');
    database([
      { file: 'a.cpp', arguments: ['clang++', '-IShared', '-IA', '-c', 'a.cpp'] },
      { file: 'b.cpp', arguments: ['clang++', '-IShared', '-IB', '-c', 'b.cpp'] },
    ]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Shared/Entry.h')).toEqual([]);
  });

  it.each(['-iquote', '--sysroot', '/FI', '-isysroot'])('never guesses past an unsupported include-affecting flag %s', async flag => {
    write('Public/Config.h', 'struct Config {};'); write('a.cpp', '#include "Config.h"\nvoid Use() {}');
    database([{ file: 'a.cpp', arguments: ['clang++', '-IPublic', flag, 'unknown', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  });

  it('keeps quote lookup distinct from angle lookup and preserves variant ordering', async () => {
    write('src/Config.h', 'struct Local {};'); write('Public/Config.h', 'struct Public {};');
    write('src/a.cpp', '#include "Config.h"\n#include <Config.h>\nvoid Use() {}');
    database([{ file: 'src/a.cpp', arguments: ['clang++', '-IPublic', '-c', 'src/a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('src/a.cpp').sort()).toEqual(['Public/Config.h', 'src/Config.h']);
  });

  it('preserves joined system include directories before later system directories', async () => {
    write('Private/Config.h', 'struct Earlier {};'); write('Public/Config.h', 'struct Later {};');
    write('a.cpp', '#include <Config.h>\nvoid Use() {}');
    database([{ file: 'a.cpp', arguments: ['clang++', '-isystemPrivate', '-isystem', 'Public', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('a.cpp')).toEqual(['Private/Config.h']);
  });

  it('uses static UE module dependencies without exposing private dependencies through public headers', async () => {
    write('Plugins/P/P.uplugin', JSON.stringify({ Modules: [{ Name: 'A', Type: 'Runtime' }, { Name: 'B', Type: 'Runtime' }] }));
    write('Plugins/P/Source/A/A.Build.cs', 'using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) { PrivateDependencyModuleNames.AddRange(new string[] { "B" }); } }');
    write('Plugins/P/Source/B/B.Build.cs', 'using UnrealBuildTool; public class B : ModuleRules { public B(ReadOnlyTargetRules Target):base(Target) {} }');
    write('Plugins/P/Source/A/Private/a.cpp', '#include <BPublic.h>\nvoid Use() {}');
    write('Plugins/P/Source/A/Public/Facade.h', '#include <BPublic.h>\nstruct Facade {};');
    write('Plugins/P/Source/B/Public/BPublic.h', 'struct BPublic {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Plugins/P/Source/A/Private/a.cpp')).toEqual(['Plugins/P/Source/B/Public/BPublic.h']);
    expect(target('Plugins/P/Source/A/Public/Facade.h')).toEqual([]);
  });

  it('does not let a healthy watcher hide changed C++ metadata from MCP readers', async () => {
    write('A/Config.h', 'struct A {};'); write('B/Config.h', 'struct B {};');
    write('a.cpp', '#include <Config.h>\nvoid UEIncludeProbe() {}');
    database([{ file: 'a.cpp', arguments: ['clang++', '-IA', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    graph.watch({ inertForTests: true }); await graph.waitUntilWatcherReady();
    database([{ file: 'a.cpp', arguments: ['clang++', '-IB', '-c', 'a.cpp'] }]);
    expect(graph.getPendingFiles()).toEqual([]);
    const response = await new ToolHandler(graph).execute('codegraph_explore', { query: 'UEIncludeProbe' });
    expect(response.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('\n'))
      .toContain('C/C++ include environment');
    graph.unwatch();
  });

  it('drops a persisted edge when a newly created earlier header is excluded from indexing', async () => {
    write('Late/Config.h', 'struct Late {};'); write('a.cpp', '#include <Config.h>\nvoid Use() {}');
    database([{ file: 'a.cpp', arguments: ['clang++', '-IEarly', '-ILate', '-c', 'a.cpp'] }]);
    write('codegraph.json', JSON.stringify({ exclude: ['Early/**'] }));
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('a.cpp')).toEqual(['Late/Config.h']);
    write('Early/Config.h', 'struct Shadow {};');
    expect(graph.getCppIncludeEnvironmentStatus().changed).toBe(true);
    const result = await graph.sync();
    expect(result.filesAdded + result.filesModified).toBe(0);
    expect(target('a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().changed).toBe(false);
  });

  it.each(['cl.exe', 'clang-cl.exe', 'clang++'])('handles nested responses according to driver %s', async driver => {
    write('Public/Config.h', 'struct Config {};'); write('a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('build/first.rsp', '@second.rsp'); write('second.rsp', '-IPublic');
    database([{ file: 'a.cpp', arguments: [driver, '@build/first.rsp', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('a.cpp')).toEqual(driver === 'cl.exe' ? [] : ['Public/Config.h']);
  });

  it('rejects cyclic and unreadable responses instead of resolving through basename guesses', async () => {
    write('Public/Config.h', 'struct Config {};'); write('a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('cycle.rsp', '@cycle.rsp -IPublic');
    database([{ file: 'a.cpp', arguments: ['clang++', '@cycle.rsp', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  });

  it('does not assume a conditional UE private dependency is active', async () => {
    write('Source/A/A.Build.cs', 'using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) { if (Target.bBuildEditor) PrivateDependencyModuleNames.Add("B"); } }');
    write('Source/B/B.Build.cs', 'using UnrealBuildTool; public class B : ModuleRules { public B(ReadOnlyTargetRules Target):base(Target) {} }');
    write('Source/A/Private/a.cpp', '#include <BPublic.h>\nvoid Use() {}');
    write('Source/B/Public/BPublic.h', 'struct BPublic {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Source/A/Private/a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  });

  it('does not guess the base directory of a bare UE include path', async () => {
    write('Source/A/A.Build.cs', 'using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) { PublicIncludePaths.Add("Shadow"); } }');
    write('Source/A/Private/a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('Shadow/Config.h', 'struct WrongBase {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Source/A/Private/a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  });

  it('does not assume a platform-filtered plugin module is active', async () => {
    write('Plugins/P/P.uplugin', JSON.stringify({ Modules: [{ Name: 'A', Type: 'Runtime', PlatformAllowList: ['UnobservedTarget'] }] }));
    write('Plugins/P/Source/A/A.Build.cs', 'using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) {} }');
    write('Plugins/P/Source/A/Private/a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('Plugins/P/Source/A/Public/Config.h', 'struct Config {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Plugins/P/Source/A/Private/a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  });

  it('reports changed metadata even when an older snapshot has no affected file owners', () => {
    const result = checkCppIncludeSnapshot(root, JSON.stringify({ version: 1, complete: true, files: [], dependencies: [
      { path: 'missing.uplugin', kind: 'content', identity: 'prior-content', owners: ['*'] },
    ] }));
    expect(result.changed).toBe(true);
    expect(result.affectedFiles).toEqual([]);
  });

  it('accepts an explicit ModuleDirectory anchor without guessing a bare-path base', async () => {
    write('Source/A/A.Build.cs', 'using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) { PublicIncludePaths.Add(Path.Combine(ModuleDirectory, "Extra")); } }');
    write('Source/A/Private/a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('Source/A/Extra/Config.h', 'struct Config {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Source/A/Private/a.cpp')).toEqual(['Source/A/Extra/Config.h']);
  });

  it('reports a changed response-file symlink without reading its new external content', async () => {
    write('A/Config.h', 'struct Config {};'); write('a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('args.rsp', '-IA');
    database([{ file: 'a.cpp', arguments: ['clang++', '@args.rsp', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-rsp-outside-'));
    const outsideFile = path.join(external, 'new.rsp');
    fs.writeFileSync(outsideFile, '-IForbidden');
    fs.unlinkSync(path.join(root, 'args.rsp'));
    fs.symlinkSync(outsideFile, path.join(root, 'args.rsp'), 'file');
    const read = vi.mocked(fs.readFileSync); read.mockClear();
    expect(graph.getCppIncludeEnvironmentStatus().changed).toBe(true);
    expect(read.mock.calls.some(([file]) => {
      try { return typeof file === 'string' && fs.realpathSync.native(file) === fs.realpathSync.native(outsideFile); } catch { return false; }
    })).toBe(false);
  });

  it('recovers from a previously missing response file without changing source or compile commands', async () => {
    write('Public/Config.h', 'struct Config {};'); write('a.cpp', '#include "Common.h"\nvoid Use() {}');
    write('Common.h', '#include <Config.h>\nstruct Common {};');
    database([{ file: 'a.cpp', arguments: ['clang++', '@later.rsp', '-c', 'a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('a.cpp')).toEqual([]);
    write('later.rsp', '-IPublic');
    expect(graph.getCppIncludeEnvironmentStatus().changed).toBe(true);
    const result = await graph.sync();
    expect(result.filesAdded + result.filesModified).toBe(0);
    expect(target('a.cpp')).toEqual(['Common.h']);
    expect(target('Common.h')).toEqual(['Public/Config.h']);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(true);
  });

  it.each(['System.Action unused = () => PrivateDependencyModuleNames.Add("B");',
    'void Unused() { PrivateDependencyModuleNames.Add("B"); }'])('does not execute constructor-local declarations statically: %s', async declaration => {
    write('Source/A/A.Build.cs', `using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) { ${declaration} } }`);
    write('Source/B/B.Build.cs', 'using UnrealBuildTool; public class B : ModuleRules { public B(ReadOnlyTargetRules Target):base(Target) {} }');
    write('Source/A/Private/a.cpp', '#include <BPublic.h>\nvoid Use() {}');
    write('Source/B/Public/BPublic.h', 'struct BPublic {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Source/A/Private/a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
    const source = graph.getNodesInFile('Source/A/A.Build.cs').find(n => n.kind === 'file')!;
    expect(graph.getOutgoingEdges(source.id).filter(e => e.metadata?.synthesizedBy === 'ue-module')
      .flatMap(e => (e.metadata?.ueDependencies ?? []) as unknown[])).toEqual([]);
  });

  it.each(['RulesHelper.Configure(this);', 'var names = PrivateDependencyModuleNames; names.Add("B");'])('does not assume unknown rule mutations are complete: %s', async mutation => {
    write('Source/A/A.Build.cs', `using UnrealBuildTool; public class A : ModuleRules { public A(ReadOnlyTargetRules Target):base(Target) { ${mutation} } }`);
    write('Source/A/Private/a.cpp', '#include <Config.h>\nvoid Use() {}');
    write('Source/A/Public/Config.h', 'struct Config {};');
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Source/A/Private/a.cpp')).toEqual([]);
    expect(graph.getCppIncludeEnvironmentStatus().complete).toBe(false);
  });

  it('rechecks source bytes and persistent edges when a junction changes with identical file stats', async () => {
    external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-includes-swap-'));
    fs.symlinkSync(external, path.join(root, 'Client'), process.platform === 'win32' ? 'junction' : 'dir');
    write('Client/Late/Config.h', 'struct Config {};');
    write('Client/a.cpp', '#include <Config.h>\nvoid Before() {}');
    write('codegraph.json', JSON.stringify({ exclude: ['Client/Early/**'] }));
    database([{ file: 'Client/a.cpp', arguments: ['clang++', '-IClient/Early', '-IClient/Late', '-c', 'Client/a.cpp'] }]);
    graph = CodeGraph.initSync(root); await graph.indexAll();
    expect(target('Client/a.cpp')).toEqual(['Client/Late/Config.h']);
    const prior = fs.statSync(path.join(root, 'Client/a.cpp'));
    write('Client/next/a.cpp', '#include <Config.h>\nvoid After_() {}');
    write('Client/next/Late/Config.h', 'struct Config {};');
    write('Client/next/Early/Config.h', 'struct Shadow {};');
    fs.utimesSync(path.join(external, 'next/a.cpp'), prior.atime, prior.mtime);
    fs.unlinkSync(path.join(root, 'Client'));
    fs.symlinkSync(path.join(external, 'next'), path.join(root, 'Client'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(graph.getCppIncludeEnvironmentStatus().changed).toBe(true);
    await graph.sync();
    expect(graph.getNodesInFile('Client/a.cpp').map(n => n.name)).toContain('After_');
    expect(target('Client/a.cpp')).toEqual([]);
  });
});
