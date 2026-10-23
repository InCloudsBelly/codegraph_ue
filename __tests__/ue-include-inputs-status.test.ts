import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { checkCppIncludeSnapshot } from '../src/resolution/cpp-include-environment';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync), readFileSync: vi.fn(actual.readFileSync) };
});

const CodeGraph = (require('../dist') as typeof import('../src')).default;
const { ToolHandler } = require('../dist/mcp/tools') as typeof import('../src/mcp/tools');
const { measureCppIncludeEnvironment, endFreshnessMeasurements } = require('../dist/mcp/index-freshness') as typeof import('../src/mcp/index-freshness');
const roots: string[] = [];
const graphs: Array<InstanceType<typeof CodeGraph>> = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-inputs-')); roots.push(dir); return dir; }
function snapshot(identity: string, bounded = true) {
  return JSON.stringify({ version: 1, complete: false, bounded, files: ['a.cpp'],
    dependencies: [{ path: 'Module.uplugin', kind: 'content', identity, owners: ['a.cpp'] }] });
}
function observed(dir: string) {
  fs.writeFileSync(path.join(dir, 'Module.uplugin'), '{"Modules":[]}');
  return `${fs.realpathSync.native(path.join(dir, 'Module.uplugin'))}\0${createHash('sha256').update('{"Modules":[]}').digest('hex')}`;
}

afterEach(async () => {
  await endFreshnessMeasurements();
  vi.restoreAllMocks(); vi.clearAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('C++ include input verification', () => {
  it('keeps dynamic UE coverage incomplete while reporting verified stable inputs through the SDK and CLI', async () => {
    const dir = root();
    for (const [name, body] of Object.entries({
      AlphaModule: 'if (Target.bBuildEditor) PrivateDependencyModuleNames.Add("BetaModule");', BetaModule: '',
    })) {
      const file = path.join(dir, `Source/${name}/${name}.Build.cs`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `using UnrealBuildTool; public class ${name} : ModuleRules { public ${name}(ReadOnlyTargetRules Target):base(Target) { ${body} } }`);
    }
    const graph = await CodeGraph.init(dir, { index: true }); graphs.push(graph);
    expect(graph.getCppIncludeEnvironmentStatus()).toMatchObject({ observed: true, complete: false,
      changed: false, inputsVerified: true });
    const tools = new ToolHandler(graph);
    for (const [name, args] of [['codegraph_explore', { query: 'AlphaModule' }], ['codegraph_status', {}]] as const) {
      const result = await tools.execute(name, args);
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      expect(text).toMatch(/tracked inputs verified; include coverage incomplete/i);
      expect(text).not.toContain('C/C++ include environment is unverified');
      if (name === 'codegraph_explore') expect(text).not.toContain('No relevant code found');
    }
    graph.close(); graphs.splice(graphs.indexOf(graph), 1);
    const status = JSON.parse(execFileSync(process.execPath,
      [...WASM_RUNTIME_FLAGS, path.resolve('dist/bin/codegraph.js'), 'status', dir, '--json'],
      { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30_000, env: process.env }));
    expect(status.cppIncludeEnvironment).toMatchObject({ complete: false, changed: false, inputsVerified: true });
    const human = execFileSync(process.execPath,
      [...WASM_RUNTIME_FLAGS, path.resolve('dist/bin/codegraph.js'), 'status', dir],
      { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30_000, env: process.env });
    expect(human).toMatch(/tracked inputs verified; include coverage incomplete/i);
    expect(await measureCppIncludeEnvironment(dir, 30_000)).toMatchObject({ complete: false, changed: false, inputsVerified: true });
  }, 120_000);

  it('reports no C++ or module inputs as verified', async () => {
    const graph = await CodeGraph.init(root(), { index: false }); graphs.push(graph);
    expect(graph.getCppIncludeEnvironmentStatus()).toMatchObject({ complete: true, inputsVerified: true });
  });

  it('rejects an actual plugin content drift without rewriting coverage completeness', () => {
    const dir = root(); const raw = snapshot(observed(dir));
    expect(checkCppIncludeSnapshot(dir, raw)).toMatchObject({ complete: false, changed: false, inputsVerified: true });
    fs.writeFileSync(path.join(dir, 'Module.uplugin'), '{"Modules":[{"Name":"Changed"}]}');
    expect(checkCppIncludeSnapshot(dir, raw)).toMatchObject({ complete: false, changed: true, inputsVerified: false });
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('does not mistake %s for an observed missing metadata file', code => {
    const dir = root();
    vi.mocked(fs.statSync).mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
    expect(checkCppIncludeSnapshot(dir, snapshot('missing'))).toMatchObject({ changed: true, inputsVerified: false });
  });

  it('accepts a verified negative metadata probe only while it remains missing', () => {
    const dir = root();
    expect(checkCppIncludeSnapshot(dir, snapshot('missing'))).toMatchObject({ changed: false, inputsVerified: true });
  });

  it('rejects unreadable content even when its last observed hash is valid', () => {
    const dir = root(); const raw = snapshot(observed(dir));
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(checkCppIncludeSnapshot(dir, raw)).toMatchObject({ changed: true, inputsVerified: false });
  });

  it.each(['refused', 'unsupported', 'unreadable:EACCES', 'elsewhere\0unverified-content'])('never verifies unsupported identity %s', identity => {
    const dir = root(); observed(dir);
    expect(checkCppIncludeSnapshot(dir, snapshot(identity))).toMatchObject({ inputsVerified: false });
  });

  it('rejects unknown, empty and over-budget observations', () => {
    const dir = root(); const identity = observed(dir);
    expect(checkCppIncludeSnapshot(dir, snapshot(identity, false))).toMatchObject({ inputsVerified: false });
    expect(checkCppIncludeSnapshot(dir, null)).toMatchObject({ observed: false, inputsVerified: false });
    expect(checkCppIncludeSnapshot(dir, JSON.stringify({ version: 1, complete: false, files: ['a.cpp'], dependencies: [] })))
      .toMatchObject({ inputsVerified: false });
    const dep = { path: 'Module.uplugin', kind: 'content', identity, owners: ['a.cpp'] };
    expect(checkCppIncludeSnapshot(dir, JSON.stringify({ version: 1, complete: true, files: ['a.cpp'],
      dependencies: Array(100_001).fill(dep) }))).toMatchObject({ observed: false, inputsVerified: false });
  });
});
