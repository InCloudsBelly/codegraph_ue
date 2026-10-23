import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

// Only the failing operating-system calls are replaced. Parsing and the
// persisted graph always use real files and a real SQLite database.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }), readdirSync: vi.fn(actual.readdirSync), statSync: vi.fn(actual.statSync), readFileSync: vi.fn(actual.readFileSync) };
});

describe('incomplete discovery preserves the last-good graph', () => {
  let root: string;
  let cg: CodeGraph;
  let realFs: typeof import('fs');
  let realCp: typeof import('child_process');
  const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const snapshot = () => {
    const db = (cg as any).db.getDb();
    return Object.fromEntries(['files', 'nodes', 'edges', 'project_metadata', 'name_segment_vocab'].map(table =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  };
  const modifyAndDelete = () => {
    fs.writeFileSync(path.join(root, 'caller.ts'), 'export function replacementCaller() { return 2; }\n');
    fs.unlinkSync(path.join(root, 'deleted.ts'));
  };
  const reopen = () => { cg.close(); cg = CodeGraph.openSync(root); };
  const ioError = (code: string, file: string) => Object.assign(new Error(`Injected ${code}: ${file}`), { code });

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import('fs')>('fs');
    realCp = await vi.importActual<typeof import('child_process')>('child_process');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-last-good-scan-'));
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'target.ts'), 'export function target() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'caller.ts'), "import { target } from './nested/target'; export function caller() { return target(); }\n");
    fs.writeFileSync(path.join(root, 'deleted.ts'), 'export const deletedValue = 1;\n');
    git('add', '-A'); git('commit', '-q', '-m', 'baseline');
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    reopen();
    expect(cg.getStats().edgeCount).toBeGreaterThan(0);
  });
  afterEach(() => { vi.restoreAllMocks(); cg?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it.each([
    ['sync', 'realpathSync'], ['sync', 'readdirSync'], ['index', 'realpathSync'], ['index', 'readdirSync'],
  ] as const)('rejects %s when a non-Git filesystem walk %s fails, before any persisted update', async (mode, operation) => {
    const before = snapshot();
    modifyAndDelete();
    // A genuinely non-Git project uses the filesystem scanner. A failed
    // listing in a known Git repo must instead fail before switching scopes.
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    const actual = realFs[operation];
    let injected = 0;
    const failure = vi.spyOn(fs, operation).mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === path.join(root, 'nested')) { injected++; throw ioError('EACCES', String(file)); }
      return (actual as any)(file, ...args);
    }) as any);
    let rejected: unknown;
    try { await (mode === 'sync' ? cg.sync() : cg.indexAll()); } catch (error) { rejected = error; }
    expect(injected).toBeGreaterThan(0);
    failure.mockRestore();
    reopen();
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toMatch(/nested/);
    expect(cg.getChangedFiles().modified).toContain('caller.ts');
    expect(cg.getChangedFiles().removed).toContain('deleted.ts');
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).not.toContain('deleted.ts');
    expect(cg.searchNodes('replacementCaller').length).toBeGreaterThan(0);
  }, 60_000);

  it.each(['root files', 'embedded files', 'ignored directories'] as const)('preserves embedded-repo opt-ins when Git cannot enumerate %s', async listing => {
    const embedded = path.join(root, 'clones', 'first-party');
    fs.mkdirSync(embedded, { recursive: true });
    realCp.execFileSync('git', ['init', '-q'], { cwd: embedded, stdio: 'pipe' });
    fs.writeFileSync(path.join(embedded, 'kept.ts'), 'export const keptEmbeddedSource = 1;\n');
    realCp.execFileSync('git', ['add', '-A'], { cwd: embedded, stdio: 'pipe' });
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\nclones/\n');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ includeIgnored: ['clones/'] }));
    await cg.sync(); reopen();
    expect(cg.getFiles().map(file => file.path)).toContain('clones/first-party/kept.ts');
    const before = snapshot();
    modifyAndDelete();
    let injected = 0;
    const failure = vi.spyOn(cp, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
      const listingCwd = path.resolve(options?.cwd ?? root);
      const shouldFail = listing === 'ignored directories'
        ? listingCwd === path.resolve(root) && args.includes('-i')
        : listingCwd === path.resolve(listing === 'root files' ? root : embedded) && args.includes('-s');
      if (command === 'git' && args[0] === 'ls-files' && shouldFail) {
        injected++;
        throw ioError('EIO', listingCwd);
      }
      return (realCp.execFileSync as any)(command, args, options);
    }) as typeof cp.execFileSync);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore(); reopen();
    expect(injected).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toMatch(/Git|git/);
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).toContain('clones/first-party/kept.ts');
    expect(cg.searchNodes('replacementCaller').length).toBeGreaterThan(0);
  }, 60_000);

  it.each(['timeout', 'repository I/O error'] as const)('does not treat a Git root probe %s as a non-Git project', async reason => {
    const before = snapshot();
    modifyAndDelete();
    let injected = 0;
    const failure = vi.spyOn(cp, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
      if (command === 'git' && args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
        injected++;
        throw reason === 'timeout'
          ? Object.assign(new Error('Injected Git timeout'), { code: 'ETIMEDOUT', signal: 'SIGTERM' })
          : Object.assign(new Error('Injected Git I/O failure'), { status: 128, stderr: 'fatal: unable to read .git/config: Input/output error' });
      }
      return (realCp.execFileSync as any)(command, args, options);
    }) as typeof cp.execFileSync);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore(); reopen();
    expect(injected).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toMatch(/Git|git/);
    await cg.sync();
  }, 60_000);

  it.each(['statSync', 'readdirSync'] as const)('rejects incomplete embedded-repo discovery when %s fails', async operation => {
    const clones = path.join(root, 'clones');
    const embedded = path.join(clones, 'first-party');
    fs.mkdirSync(embedded, { recursive: true });
    realCp.execFileSync('git', ['init', '-q'], { cwd: embedded, stdio: 'pipe' });
    fs.writeFileSync(path.join(embedded, 'kept.ts'), 'export const keptEmbeddedSource = 1;\n');
    realCp.execFileSync('git', ['add', '-A'], { cwd: embedded, stdio: 'pipe' });
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\nclones/\n');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ includeIgnored: ['clones/'] }));
    await cg.sync(); reopen();
    expect(cg.getFiles().map(file => file.path)).toContain('clones/first-party/kept.ts');
    const before = snapshot();
    modifyAndDelete();
    const failedPath = operation === 'statSync' ? path.join(embedded, '.git') : clones;
    let injected = 0;
    const failure = vi.spyOn(fs, operation).mockImplementation(((file: any, ...args: any[]) => {
      if (path.resolve(String(file)) === failedPath) { injected++; throw ioError('EIO', String(file)); }
      return (realFs[operation] as any)(file, ...args);
    }) as any);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore(); reopen();
    expect(injected).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toContain(failedPath);
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).toContain('clones/first-party/kept.ts');
  }, 60_000);

  it('rejects an unknown parent check-ignore failure rather than interpreting it as not ignored', async () => {
    cg.close();
    const child = path.join(root, 'child-project');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, 'app.ts'), 'export const originalChild = 1;\n');
    cg = CodeGraph.initSync(child);
    await cg.indexAll();
    const before = snapshot();
    fs.writeFileSync(path.join(child, 'app.ts'), 'export const modifiedChild = 2;\n');
    let injected = 0;
    const failure = vi.spyOn(cp, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
      if (command === 'git' && args[0] === 'check-ignore' && path.resolve(options?.cwd ?? root) === child) {
        injected++;
        throw ioError('EIO', child);
      }
      return (realCp.execFileSync as any)(command, args, options);
    }) as typeof cp.execFileSync);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore();
    cg.close(); cg = CodeGraph.openSync(child);
    expect(injected).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toMatch(/Git|git/);
    await cg.sync();
    expect(cg.searchNodes('modifiedChild').length).toBeGreaterThan(0);
  }, 60_000);

  it('still reconciles scoped changes in a confirmed non-Git project', async () => {
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    modifyAndDelete();
    await cg.sync({ paths: ['caller.ts', 'deleted.ts'] });
    expect(cg.searchNodes('replacementCaller').length).toBeGreaterThan(0);
    expect(cg.getFiles().map(file => file.path)).not.toContain('deleted.ts');
  }, 60_000);

  it.each(['EACCES', 'EPERM', 'EIO'])('rejects full and scoped reconciliation when stat returns %s', async code => {
    const before = snapshot();
    modifyAndDelete();
    const actual = realFs.statSync;
    let injected = 0;
    const failure = vi.spyOn(fs, 'statSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === path.join(root, 'nested', 'target.ts')) { injected++; throw ioError(code, String(file)); }
      return (actual as any)(file, ...args);
    }) as typeof fs.statSync);
    const rejected: unknown[] = [];
    try { await cg.sync(); } catch (error) { rejected.push(error); }
    try { await cg.sync({ paths: ['caller.ts', 'deleted.ts', 'nested/target.ts'] }); } catch (error) { rejected.push(error); }
    expect(injected).toBeGreaterThan(0);
    failure.mockRestore();
    reopen();
    expect(snapshot()).toEqual(before);
    expect(rejected).toHaveLength(2);
    expect(rejected.every(error => /target\.ts/.test(String(error)))).toBe(true);
    // Both rejected runs released the lock; a later normal sync can repair it.
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).not.toContain('deleted.ts');
  }, 60_000);

  it('rejects an incomplete include walk, but accepts a truly removed include root', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\nnested/\n');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: ['nested/**/*.ts'] }));
    await cg.sync(); reopen();
    const before = snapshot();
    modifyAndDelete();
    const actual = realFs.readdirSync;
    let injected = 0;
    const failure = vi.spyOn(fs, 'readdirSync').mockImplementation(((file: any, ...args: any[]) => {
      if (path.resolve(String(file)) === path.join(root, 'nested')) { injected++; throw ioError('EIO', String(file)); }
      return (actual as any)(file, ...args);
    }) as typeof fs.readdirSync);
    await expect(cg.sync()).rejects.toThrow(/nested/);
    expect(injected).toBeGreaterThan(0);
    failure.mockRestore(); reopen();
    expect(snapshot()).toEqual(before);
    fs.rmSync(path.join(root, 'nested'), { recursive: true });
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).not.toContain('nested/target.ts');
  }, 60_000);

  it.each(['.gitignore', 'codegraph.json'])('preserves files admitted by %s when its rules become unreadable', async rulesFile => {
    const folder = rulesFile === '.gitignore' ? 'vendor' : 'private-source';
    fs.mkdirSync(path.join(root, folder));
    fs.writeFileSync(path.join(root, folder, 'firstParty.ts'), 'export const firstParty = 1;\n');
    fs.writeFileSync(path.join(root, '.gitignore'), `.codegraph/\n${rulesFile === '.gitignore' ? '!vendor/' : `${folder}/`}\n`);
    if (rulesFile === 'codegraph.json') fs.writeFileSync(path.join(root, rulesFile), JSON.stringify({ include: [`${folder}/**/*.ts`] }));
    await cg.sync(); reopen();
    expect(cg.getFiles().map(file => file.path)).toContain(`${folder}/firstParty.ts`);
    const before = snapshot();
    // Invalidate the permissive project-config parser's memo without changing
    // the rules, so an unreadable config cannot silently become empty scope.
    fs.appendFileSync(path.join(root, rulesFile), '\n ');
    const failure = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === path.join(root, rulesFile)) throw ioError('EIO', String(file));
      return (realFs.readFileSync as any)(file, ...args);
    }) as typeof fs.readFileSync);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore(); reopen();
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toContain(rulesFile);
    await cg.sync();
  }, 60_000);

  it.each(['read', 'stat'])('rejects an actual project-config parser %s failure after preflight succeeded', async operation => {
    const configPath = path.join(root, 'codegraph.json');
    fs.mkdirSync(path.join(root, 'private-source'));
    fs.writeFileSync(path.join(root, 'private-source', 'kept.ts'), 'export const keptByConfig = 1;\n');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\nprivate-source/\n');
    fs.writeFileSync(configPath, JSON.stringify({ include: ['private-source/**/*.ts'] }));
    await cg.sync(); reopen();
    expect(cg.getFiles().map(file => file.path)).toContain('private-source/kept.ts');
    const before = snapshot();
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(configPath, later, later);
    let attempts = 0;
    const method = operation === 'read' ? 'readFileSync' : 'statSync';
    const failure = vi.spyOn(fs, method).mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === configPath && ++attempts === 2) throw ioError('EIO', String(file));
      return (realFs[method] as any)(file, ...args);
    }) as any);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore(); reopen();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toContain('codegraph.json');
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).toContain('private-source/kept.ts');
  }, 60_000);

  it('preserves global-rule opt-ins when querying core.excludesFile times out', async () => {
    fs.mkdirSync(path.join(root, 'vendor'));
    fs.writeFileSync(path.join(root, 'vendor', 'kept.ts'), 'export const keptByGlobalRules = 1;\n');
    const globalRules = path.join(root, 'global-ignore');
    fs.writeFileSync(globalRules, '!vendor/\n');
    git('config', 'core.excludesFile', globalRules);
    await cg.sync(); reopen();
    expect(cg.getFiles().map(file => file.path)).toContain('vendor/kept.ts');
    const before = snapshot();
    let injected = 0;
    const failure = vi.spyOn(cp, 'execFileSync').mockImplementation(((command: any, args: any, options: any) => {
      if (command === 'git' && args.includes('config') && args.includes('core.excludesFile')) {
        injected++;
        throw Object.assign(new Error('Injected core.excludesFile timeout'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout: '', stderr: '' });
      }
      return (realCp.execFileSync as any)(command, args, options);
    }) as typeof cp.execFileSync);
    let rejected: unknown;
    try { await cg.sync(); } catch (error) { rejected = error; }
    failure.mockRestore(); reopen();
    expect(injected).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(String(rejected)).toContain('core.excludesFile');
    await cg.sync();
  }, 60_000);

  it('does not claim a commit made after a prepared file stat was captured', async () => {
    const oldHead = git('rev-parse', 'HEAD').trim();
    let committed = false;
    const failure = vi.spyOn(fs, 'statSync').mockImplementation(((file: any, ...args: any[]) => {
      const result = (realFs.statSync as any)(file, ...args);
      // Git lists caller.ts before nested/target.ts. Its old stat is already
      // cached when this last stat races a clean committed source update.
      if (!committed && String(file) === path.join(root, 'nested', 'target.ts')) {
        committed = true;
        fs.writeFileSync(path.join(root, 'caller.ts'), 'export function laterCommit() { return 2; }\n');
        git('add', '-A'); git('commit', '-q', '-m', 'commit during discovery');
      }
      return result;
    }) as typeof fs.statSync);
    await cg.sync();
    failure.mockRestore();
    expect(committed).toBe(true);
    expect((cg as any).queries.getMetadata('indexed_at_commit')).toBe(oldHead);
    reopen();
    expect(cg.getChangedFiles().modified).toContain('caller.ts');
    await cg.sync();
    expect(cg.searchNodes('laterCommit').length).toBeGreaterThan(0);
  }, 60_000);

  it('still applies committed branch changes, ignore changes, and scoped directory deletions', async () => {
    const branch = git('branch', '--show-current').trim();
    git('checkout', '-q', '-b', 'other');
    fs.rmSync(path.join(root, 'nested'), { recursive: true });
    git('add', '-A'); git('commit', '-q', '-m', 'remove directory');
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).not.toContain('nested/target.ts');
    git('checkout', '-q', branch);
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).toContain('nested/target.ts');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\nnested/\n');
    git('rm', '--cached', '-r', 'nested');
    await cg.sync();
    expect(cg.getFiles().map(file => file.path)).not.toContain('nested/target.ts');
    fs.unlinkSync(path.join(root, 'deleted.ts'));
    await cg.sync({ paths: ['deleted.ts'] });
    expect(cg.getFiles().map(file => file.path)).not.toContain('deleted.ts');
  }, 60_000);
});
