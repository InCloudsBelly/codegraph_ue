import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { DatabaseConnection, getDatabasePath } from '../src';
import { ToolHandler } from '../src/mcp/tools';

function sourceFiles(text: string): string[] {
  return [...text.matchAll(/^\*\*`([^`]+)`\*\* —/gm)].map((m) => m[1]!);
}

describe('UE explore anchors', () => {
  let root: string;
  let cg: CodeGraph;
  const cases = [
    ['MirrorCaptureComponent', 'U', 'class'],
    ['ReflectionCaptureActor', 'A', 'class'],
    ['ReflectionBakeData', 'F', 'struct'],
    ['ReflectionBakeProvider', 'I', 'class'],
    ['ReflectionBakeMode', 'E', 'enum'],
  ] as const;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-anchors-'));
    fs.mkdirSync(path.join(root, 'runtime'));
    fs.mkdirSync(path.join(root, 'other'));
    for (const [token, prefix, kind] of cases) {
      const body = kind === 'enum' ? 'First, Second' : 'public: int Value = 1;';
      fs.writeFileSync(path.join(root, 'runtime', `${prefix}Runtime.cpp`),
        `${kind} ${prefix}${token} { ${body} };\n`);
      fs.writeFileSync(path.join(root, 'other', `${prefix}Namesake.cpp`),
        `int ${token}() { return 1; }\n`
        + (prefix === 'U' ? 'int WrongComponentCaller() { return MirrorCaptureComponent(); }\n' : ''));
    }
    fs.writeFileSync(path.join(root, 'runtime', 'KGPlanarReflectionRendering.cpp'),
      'int BuildReflectionCache() { return 42; }\n'
      + 'int BakeReflectionScene() { return BuildReflectionCache(); }\n'
      + 'int SceneCaller() { return BakeReflectionScene(); }\n'
      + 'int TriggerSceneCaller() { return SceneCaller(); }\n');
    fs.writeFileSync(path.join(root, 'other', 'RendererNamesake.cpp'),
      'namespace Renderer {\nint KGPlanarReflectionRendering() { return 0; }\n'
      + 'int WrongRendererCaller() { return KGPlanarReflectionRendering(); }\n}\n');
    fs.writeFileSync(path.join(root, 'runtime', 'CameraType.cpp'), 'class UCamera { public: int Value = 1; };\n');
    fs.writeFileSync(path.join(root, 'other', 'CameraFunction.cpp'), 'int Camera() { return 1; }\n');
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.cpp'], exclude: [] } });
    await cg.indexAll();
    const connection = DatabaseConnection.open(getDatabasePath(root));
    try {
      connection.getDb().exec(`
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 500)
        INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count)
        SELECT 'fixture-padding/' || n || '.cpp', 'fixture', 'cpp', 0, 0, 0, 0 FROM numbers
      `);
    } finally {
      connection.close();
    }
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(cases)('finds the %s type when its %s prefix is omitted', async (token, prefix) => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: token, maxFiles: 1 });
    expect(sourceFiles(result.content[0]!.text!)[0]).toBe(`runtime/${prefix}Runtime.cpp`);
    expect(result.content[0]!.text).toContain(`${prefix}${token}`);
  });

  it('keeps an explicitly pinned file ahead of inferred UE type anchors', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'other/UNamesake.cpp MirrorCaptureComponent', maxFiles: 1,
    });
    expect(sourceFiles(result.content[0]!.text!)[0]).toBe('other/UNamesake.cpp');
  });

  it('does not turn an ordinary capitalized word into a UE prefix anchor', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Camera', maxFiles: 1 });
    expect(sourceFiles(result.content[0]!.text!)[0]).toBe('other/CameraFunction.cpp');
  });

  it('retains upstream filename pinning for a file basename', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'KGPlanarReflectionRendering.cpp', maxFiles: 1,
    });
    expect(sourceFiles(result.content[0]!.text!)[0]).toBe('runtime/KGPlanarReflectionRendering.cpp');
  });

  it('finds a distinctive file basename without its extension ahead of a namesake symbol', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'KGPlanarReflectionRendering', maxFiles: 1,
    });
    expect(sourceFiles(result.content[0]!.text!)[0]).toBe('runtime/KGPlanarReflectionRendering.cpp');
  });

  it('keeps the blast radius and relationships about the anchored file', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'KGPlanarReflectionRendering', maxFiles: 1,
    });
    const text = result.content[0]!.text!;
    const beforeSource = text.split('**Source Code**')[0]!;
    expect(beforeSource).toMatch(/Blast radius[\s\S]*`BakeReflectionScene`/);
    expect(beforeSource).not.toContain('`KGPlanarReflectionRendering` (other/RendererNamesake.cpp');
    expect(beforeSource).not.toContain('WrongRendererCaller → KGPlanarReflectionRendering');
  });

  it('preserves an explicit qualified target and its relationships alongside a UE anchor', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'MirrorCaptureComponent Renderer::WrongRendererCaller', maxFiles: 2,
    });
    const text = result.content[0]!.text!;
    expect(sourceFiles(text)[0]).toBe('other/RendererNamesake.cpp');
    expect(text.split('**Source Code**')[0]).toContain('WrongRendererCaller → KGPlanarReflectionRendering');
  });

  it('preserves another bare callable alongside a UE anchor without restoring the anchor namesake', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'MirrorCaptureComponent SceneCaller', maxFiles: 2,
    });
    const text = result.content[0]!.text!;
    expect(sourceFiles(text)).toContain('runtime/KGPlanarReflectionRendering.cpp');
    const beforeSource = text.split('**Source Code**')[0]!;
    expect(beforeSource).toMatch(/Blast radius[\s\S]*`SceneCaller`/);
    expect(beforeSource).toContain('SceneCaller → BakeReflectionScene');
    expect(beforeSource).not.toContain('`MirrorCaptureComponent` (other/UNamesake.cpp');
    expect(beforeSource).not.toContain('WrongComponentCaller → MirrorCaptureComponent');
  });
});
