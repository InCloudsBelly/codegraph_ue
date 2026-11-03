import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src';

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

describe('UE Git discovery boundary', () => {
  let root: string;
  const write = (relative: string, source: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ue-git-scope-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

  it('rejects an opaque Git directory that is a junction before entering it', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('Client/Runtime/Core/Core.cpp', 'void ClientEntry() {}\n');
    fs.mkdirSync(path.join(root, 'Engine'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Client'), windowsHide: true });
    fs.symlinkSync(path.join(root, 'Client'), path.join(root, 'Engine/Source'), 'junction');
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const originalMock = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation(((command: string, args: string[], options: { cwd?: string; encoding?: string }) => {
      const result = actual.execFileSync(command, args, options as never);
      if (command === 'git' && args.includes('ls-files') && args.includes('-o') && !args.includes('-i') && !args.includes('--directory') && options.cwd === root) {
        return String(result) + 'Engine/Source/\0';
      }
      return result;
    }) as typeof execFileSync);
    const graph = CodeGraph.initSync(root);
    try {
      await expect(graph.indexAll()).rejects.toThrow(/link/i);
      const entered = vi.mocked(execFileSync).mock.calls.some(call => {
        const options = call[2] as { cwd?: string } | undefined;
        return options?.cwd && path.resolve(options.cwd).toLowerCase() === path.join(root, 'Engine/Source').toLowerCase();
      });
      expect(entered).toBe(false);
    } finally {
      await graph.destroy();
      if (originalMock) vi.mocked(execFileSync).mockImplementation(originalMock);
    }
  }, 30000);

  it('limits ignored-directory enumeration to Engine', async () => {
    write('.codegraph/indexing.json', JSON.stringify({ ueEngine: { plugins: [] } }));
    write('codegraph.json', JSON.stringify({ includeIgnored: ['Client/**'] }));
    write('.gitignore', 'Client/\n');
    write('Engine/Source/Runtime/Core/Core.cpp', 'void EngineEntry() {}\n');
    write('Client/Source/Client.cpp', 'void ClientEntry() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    vi.mocked(execFileSync).mockClear();
    const graph = CodeGraph.initSync(root);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const calls = vi.mocked(execFileSync).mock.calls.filter(call => {
        const args = call[1] as string[];
        return call[0] === 'git' && Array.isArray(args) && args.includes('ls-files') && args.includes('-i');
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect((call[1] as string[]).slice(-2)).toEqual(['--', 'Engine']);
      expect(graph.getNodesByName('ClientEntry')).toHaveLength(0);
    } finally { await graph.destroy(); }
  }, 30000);
});
