import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import CodeGraph from '../src';
import { ReferenceResolver } from '../src/resolution';
import { CppIncludeEnvironment, checkCppIncludeSnapshot } from '../src/resolution/cpp-include-environment';
import { ensureUeModuleGrammar } from '../src/resolution/ue-module-environment';
import type { ResolutionContext } from '../src/resolution/types';

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const rules = (name: string, body = '') =>
  `using UnrealBuildTool; public class ${name} : ModuleRules { public ${name}(ReadOnlyTargetRules Target):base(Target) { ${body} } }`;
const main = 'Plugins/Main/Source/Main';
const mainRules = `${main}/Main.Build.cs`;
const first = `${main}/Private/first.cpp`;
const second = `${main}/Private/second.cpp`;
const shared = 'Source/Shared/Shared.Build.cs';

function fixture(additional: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-include-cache-'));
  roots.push(root);
  const files: Record<string, string> = {
    'Plugins/Main/Main.uplugin': JSON.stringify({ Modules: [{ Name: 'Main' }] }),
    [mainRules]: rules('Main', 'PublicDependencyModuleNames.Add("Shared"); PrivateDependencyModuleNames.Add("Secret");'),
    [shared]: rules('Shared', 'PublicDependencyModuleNames.Add("Leaf");'),
    'Source/Leaf/Leaf.Build.cs': rules('Leaf', 'PublicDependencyModuleNames.Add("Shared");'),
    'Source/Secret/Secret.Build.cs': rules('Secret'),
    'Source/Leaf/Public/Shared.h': 'struct SharedHeader {};',
    'Source/Secret/Public/Secret.h': 'struct SecretHeader {};',
    [first]: '', [second]: '', [`${main}/Public/api.h`]: '',
    ...additional,
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
    fs.utimesSync(path.join(root, file), 1_700_000_000, 1_700_000_000);
  }
  const context = {
    getProjectRoot: () => root,
    getAllFiles: () => Object.keys(files).filter(file => !file.endsWith('.uplugin')),
    getFileLanguage: (file: string) => file.endsWith('.cs') ? 'csharp' : 'cpp',
    getNodesInFile: () => [],
    fileExists: (file: string) => fs.existsSync(path.join(root, file)),
    isIndexedFile: (file: string) => Object.hasOwn(files, file),
  } as unknown as ResolutionContext;
  return { root, files, context, environment: new CppIncludeEnvironment(context) };
}

beforeAll(async () => { await ensureUeModuleGrammar(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('UE include environment batch caches', () => {
  it('walks a module scope once, records module owners and still probes each include', () => {
    const { root, environment } = fixture();
    const observations = environment.getUeModuleRules();
    let dependencyReads = 0;
    for (const observation of observations) {
      const dependencies = observation.rules.publicDependencies;
      Object.defineProperty(observation.rules, 'publicDependencies', { get: () => { dependencyReads++; return dependencies; } });
    }
    const read = vi.spyOn(fs, 'readFileSync');
    const observe = vi.spyOn(environment as any, 'observe');
    expect(environment.resolve(first, 'Shared.h', '<')).toMatchObject({ status: 'resolved', file: 'Source/Leaf/Public/Shared.h' });
    const firstWalk = dependencyReads;
    expect(firstWalk).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      expect(environment.resolve(i % 2 ? first : second, 'Shared.h', '<').status).toBe('resolved');
    }
    expect(dependencyReads).toBe(firstWalk);
    expect(observe.mock.calls.filter(([input, kind, owner]) => input === shared && kind === 'content' && owner === mainRules)).toHaveLength(1);
    expect(read.mock.calls.filter(([file]) => /\.Build\.cs$/i.test(String(file)))).toHaveLength(0);
    const snapshot = environment.snapshot();
    for (const file of [shared, 'Source/Leaf/Leaf.Build.cs', 'Plugins/Main/Main.uplugin', 'Plugins/Main']) {
      const owners = snapshot.dependencies.find(dep => dep.path === file)?.owners ?? [];
      expect(owners).toContain(mainRules);
      expect(owners).not.toContain(first);
      expect(owners).not.toContain(second);
    }
    fs.unlinkSync(path.join(root, 'Source/Leaf/Public/Shared.h'));
    expect(environment.resolve(first, 'Shared.h', '<').status).toBe('not-in-scope');
  });

  it('expands module owners by their old directory after rules deletion or rename, preserving legacy file owners', () => {
    const inline = `${main}/Private/body.inl`;
    const { environment } = fixture({ [inline]: 'inline void Use() {}' });
    const affected = environment.affectedFiles([`${main}/Removed.Build.cs`, 'Source/Shared/Deleted.Build.cs', first]);
    expect(affected).toEqual(expect.arrayContaining([first, second, `${main}/Public/api.h`, inline]));
    expect(affected).not.toContain('Source/Secret/Public/Secret.h');
    expect(environment.affectedFiles([first])).toEqual([first]);
  });

  it('compacts legacy UE metadata owners without changing identities or response/header owners', () => {
    const { root, environment } = fixture({ 'build/args.rsp': '-I Source/Leaf/Public' });
    environment.getUeModuleRules();
    const initial = environment.snapshot();
    const legacy = initial.dependencies.find(dep => dep.path === shared)!;
    const response = path.join(root, 'build/args.rsp');
    const responseIdentity = `${fs.realpathSync.native(response)}\0${createHash('sha256').update(fs.readFileSync(response)).digest('hex')}`;
    const header = path.join(root, 'Source/Leaf/Public/Shared.h');
    const stat = fs.statSync(header);
    const headerIdentity = `${fs.realpathSync.native(header)}\0${stat.dev}:${stat.ino}:file`;
    const retired = `${main}/Removed.Build.cs`;
    const snapshot = environment.snapshot(JSON.stringify({ ...initial, dependencies: [
      { ...legacy, owners: [first, second, retired] },
      { path: 'build/args.rsp', kind: 'content', identity: responseIdentity, owners: [first, second] },
      { path: 'Source/Leaf/Public/Shared.h', kind: 'probe', identity: headerIdentity, owners: [first, second] },
    ] }));
    expect(snapshot.dependencies.find(dep => dep.path === shared)).toMatchObject({ identity: legacy.identity,
      owners: expect.arrayContaining([mainRules, retired]) });
    expect(snapshot.dependencies.find(dep => dep.path === shared)?.owners).not.toContain(first);
    expect(snapshot.dependencies.find(dep => dep.path === 'build/args.rsp')).toMatchObject({ identity: responseIdentity, owners: [first, second] });
    expect(snapshot.dependencies.find(dep => dep.path === 'Source/Leaf/Public/Shared.h')).toMatchObject({ identity: headerIdentity, owners: [first, second] });
    expect(checkCppIncludeSnapshot(root, JSON.stringify(snapshot))).toMatchObject({ changed: false, inputsVerified: true });
  });

  it('does not claim compaction recovered observations from an already truncated snapshot', () => {
    const { environment } = fixture();
    environment.getUeModuleRules();
    const previous = environment.snapshot();
    expect(environment.snapshot(JSON.stringify({ ...previous, bounded: false }))).toMatchObject({ bounded: false, complete: false });
  });

  it('passes expanded module files through compiler-derived header environments', () => {
    const included = 'External/Public/External.h';
    const { root, context } = fixture({ [included]: 'struct ExternalHeader {};' });
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{ file: first, directory: root,
      arguments: ['clang++', '-IExternal/Public', '-c', first] }]));
    context.getNodesInFile = file => file === first ? [{ kind: 'import', name: 'External.h',
      signature: '#include <External.h>', startLine: 1 }] as any : [];
    const environment = new CppIncludeEnvironment(context);
    expect(environment.resolve(first, 'External.h', '<')).toMatchObject({ status: 'resolved', file: included });
    expect(environment.affectedFiles([mainRules])).toEqual(expect.arrayContaining([first, second, included]));
  });

  it('keeps public/private scopes, nested ownership, duplicate module names and unknown owners distinct', () => {
    const { environment } = fixture({
      'Plugins/Main/Main.uplugin': JSON.stringify({ Modules: [{ Name: 'Main' }, { Name: 'Nested' }] }),
      [`${main}/Nested/Nested.Build.cs`]: rules('Nested'),
      [`${main}/Nested/Private/use.cpp`]: '',
      'Other/Shared/Shared.Build.cs': rules('Shared'),
      'orphan.cpp': '',
    });
    expect(environment.resolve(first, 'Shared.h', '<').status).toBe('incomplete');
    expect(environment.resolve(`${main}/Nested/Private/use.cpp`, 'Secret.h', '<').status).toBe('not-in-scope');
    expect(environment.resolve('orphan.cpp', 'Secret.h', '<').status).toBe('no-environment');
    const ordinary = fixture().environment;
    expect(ordinary.resolve(first, 'Secret.h', '<').status).toBe('resolved');
    expect(ordinary.resolve(`${main}/Public/api.h`, 'Secret.h', '<').status).toBe('not-in-scope');
  });

  it('preserves observation budgets when another source attaches a cached scope', () => {
    const { environment } = fixture();
    expect(environment.resolve(first, 'Shared.h', '<').status).toBe('resolved');
    (environment as any).ownerCount = 500_000;
    expect(environment.resolve(second, 'Shared.h', '<').status).toBe('incomplete');
    expect(environment.resolve(first, 'Shared.h', '<').status).toBe('incomplete');
    expect(environment.snapshot()).toMatchObject({ complete: false, bounded: false });
  });

  it('drops scope caches on resolver clearCaches after same-size, restored-mtime rules edits', () => {
    const { root, files } = fixture();
    const graph = CodeGraph.initSync(root); graphs.push(graph);
    for (const [file, content] of Object.entries(files)) {
      if (file.endsWith('.uplugin')) continue;
      graph.queries.upsertFile({ path: file, contentHash: createHash('sha256').update(content).digest('hex'),
        language: file.endsWith('.cs') ? 'csharp' : 'cpp', size: Buffer.byteLength(content),
        modifiedAt: fs.statSync(path.join(root, file)).mtimeMs, indexedAt: Date.now(), nodeCount: 0 });
    }
    const resolver = new ReferenceResolver(root, graph.queries);
    const context = resolver.getResolutionContext();
    expect(context.resolveCppInclude!(first, 'Shared.h', '<').status).toBe('resolved');
    const snapshot = JSON.stringify(resolver.getCppIncludeSnapshot());
    const file = path.join(root, `${main}/Main.Build.cs`);
    const before = fs.statSync(file);
    fs.writeFileSync(file, files[`${main}/Main.Build.cs`]!.replace('"Shared"', '"Absent"'));
    fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).size).toBe(before.size);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(checkCppIncludeSnapshot(root, snapshot)).toMatchObject({ changed: true, inputsVerified: false });
    expect(context.resolveCppInclude!(first, 'Shared.h', '<').status).toBe('resolved');
    resolver.clearCaches();
    expect(context.resolveCppInclude!(first, 'Shared.h', '<').status).toBe('incomplete');
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('never records %s metadata reads as trusted absence', code => {
    const { root, context } = fixture();
    const actual = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (String(file) === path.join(root, shared)) throw Object.assign(new Error(code), { code });
      return (actual as any)(file, ...args);
    }) as typeof fs.readFileSync);
    const environment = new CppIncludeEnvironment(context);
    environment.getUeModuleRules();
    const snapshot = environment.snapshot();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.dependencies.find(dep => dep.path === shared)?.identity).toBe(`unreadable:${code}`);
    expect(checkCppIncludeSnapshot(root, JSON.stringify(snapshot)).inputsVerified).toBe(false);
    expect(environment.resolve(first, 'Shared.h', '<').status).toBe('incomplete');
  });

  it('retains the identity of bytes read before metadata disappears, rather than verifying trusted absence', () => {
    const { root, context } = fixture();
    const actual = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      const value = (actual as any)(file, ...args);
      if (String(file) === path.join(root, shared)) fs.unlinkSync(file);
      return value;
    }) as typeof fs.readFileSync);
    const environment = new CppIncludeEnvironment(context);
    environment.getUeModuleRules();
    const snapshot = environment.snapshot();
    expect(snapshot.dependencies.find(dep => dep.path === shared)?.identity).toMatch(/\0[0-9a-f]{64}$/);
    expect(checkCppIncludeSnapshot(root, JSON.stringify(snapshot))).toMatchObject({ changed: true, inputsVerified: false });
  });
});
