import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';

describe('Unreal inline implementation files', () => {
  let root: string;
  let graph: CodeGraph | undefined;
  const plugin = 'Engine/Plugins/InlineProbe/Source/InlineProbe/Private';
  const inlineFile = `${plugin}/InlineMath.inl`;
  const callerFile = `${plugin}/InlineProbe.cpp`;
  function write(file: string, source: string) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-inl-'));
  });
  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^cg-ue-inl-/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists .inl as C++ and resolves its symbols, includes and calls without an override', async () => {
    write(inlineFile, 'namespace UEInline { inline int Scale(int value) { return value * 2; } }\n');
    write(callerFile, '#include "InlineMath.inl"\nint UseInlineValue() { return UEInline::Scale(21); }\n');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(graph.getFile(inlineFile)?.language).toBe('cpp');
    graph.destroy();
    graph = await CodeGraph.open(root);
    const scale = graph.getNodesByName('Scale').find(node => node.filePath === inlineFile);
    const caller = graph.getNodesByName('UseInlineValue').find(node => node.filePath === callerFile);
    expect(scale).toMatchObject({ language: 'cpp', kind: 'function' });
    expect(caller).toBeDefined();
    expect(graph.getCallees(caller!.id).map(result => result.node.id)).toContain(scale!.id);
    expect(graph.getFileDependencies(callerFile)).toContain(inlineFile);
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'InlineMath.inl Scale' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(inlineFile);
    expect(text).toContain('return value * 2');
  });

  it('syncs added, edited and deleted uppercase inline files in a private plugin scope', async () => {
    write('.gitignore', 'Client/\n');
    write('.codegraph/indexing.json', JSON.stringify({ include: ['Client/Plugins/**'] }));
    const file = 'Client/Plugins/InlineProbe/Source/InlineProbe/Private/InlineExtra.INL';
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    write(file, 'template <typename T> T UEInlineOriginal(T value) { return value; }\n');
    const added = await graph.sync();
    expect(added.filesAdded).toBe(1);
    expect(graph.getFile(file)?.language).toBe('cpp');
    expect(graph.getNodesByName('UEInlineOriginal').map(node => node.filePath)).toContain(file);
    write(file, 'template <typename T> T UEInlineUpdated(T value) { return value + value; }\n');
    const modified = await graph.sync();
    expect(modified.filesModified).toBe(1);
    expect(graph.getNodesByName('UEInlineOriginal')).toEqual([]);
    expect(graph.getNodesByName('UEInlineUpdated').map(node => node.filePath)).toContain(file);
    fs.unlinkSync(path.join(root, file));
    const removed = await graph.sync();
    expect(removed.filesRemoved).toBe(1);
    expect(graph.getFile(file)).toBeNull();
    expect(graph.getNodesByName('UEInlineUpdated')).toEqual([]);
  });

  it('normal sync discovers a committed inline file omitted from an existing index', async () => {
    write('.gitignore', '.codegraph/\n');
    write(inlineFile, 'inline int ExistingInlineValue() { return 42; }\n');
    write(callerFile, '#include "InlineMath.inl"\nint ReadExistingInline() { return ExistingInlineValue(); }\n');
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    graph = CodeGraph.initSync(root);
    await graph.indexFiles([callerFile]);
    expect(graph.getFile(inlineFile)).toBeNull();
    expect(git('status', '--porcelain')).toBe('');
    const synced = await graph.sync();
    expect(synced).toMatchObject({ filesAdded: 1, filesModified: 0, filesRemoved: 0 });
    expect(graph.getFile(inlineFile)?.language).toBe('cpp');
    const caller = graph.getNodesByName('ReadExistingInline')[0]!;
    expect(graph.getCallees(caller.id).map(result => result.node.name)).toContain('ExistingInlineValue');
    expect(git('status', '--porcelain')).toBe('');
  });
});
