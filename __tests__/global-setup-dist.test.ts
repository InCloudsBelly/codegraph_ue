import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureTestDist } from './global-setup-dist';

let root: string;
let fixture: string;
let builds: string[];
function write(file: string, content = file): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
const engineOutputs = ['dist/bin/codegraph.js', 'dist/db/schema.sql',
  'dist/extraction/wasm/typescript.wasm', 'dist/resolution/resolve-worker.js'];
const viewerOutputs = ['dist/viewer/index.html', 'dist/viewer/assets/app.js', 'dist/viewer/assets/app.css'];
function build(part: 'engine' | 'viewer'): void {
  builds.push(part);
  for (const file of part === 'engine' ? engineOutputs : viewerOutputs) write(file);
}
function setup(): void { ensureTestDist(root, build); }

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-build-'));
  root = path.join(fixture, 'extensions', 'codegraph', 'codegraph_ue');
  fs.mkdirSync(root, { recursive: true });
  builds = [];
  for (const file of ['src/bin/codegraph.ts', 'src/db/schema.sql',
    'src/extraction/wasm/typescript.wasm', 'tsconfig.json', 'package.json',
    'package-lock.json', 'scripts/check-ui-build.mjs', 'ui/src/App.svelte',
    'ui/vite.config.ts', 'ui/svelte.config.js', 'ui/tsconfig.json', 'ui/package.json', 'ui/index.html']) write(file);
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe('test dist prerequisites', () => {
  it('refuses to rebuild a managed backend and preserves its existing build records', () => {
    setup();
    builds = [];
    const receipt = path.join(fixture, 'extensions', 'codegraph', '.build', 'codegraph-ue.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ sourcePath: root, status: 'built-and-verified' }));
    const registration = path.join(fixture, 'dependencies', 'locks', 'codegraph-ue.lock.yaml');
    fs.mkdirSync(path.dirname(registration), { recursive: true });
    fs.writeFileSync(registration, 'sourceId: codegraph-ue\n');
    const stamp = fs.readFileSync(path.join(root, 'dist/.test-build-engine.json'));
    write('src/bin/codegraph.ts', 'changed source');

    expect(setup).toThrow(/managed.*runtime/i);
    expect(builds).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'dist/.test-build-engine.json'))).toEqual(stamp);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).status).toBe('built-and-verified');
    fs.unlinkSync(receipt); // The managed receipt may be archived during an upgrade.
    expect(setup).toThrow(/managed.*runtime/i);
    expect(builds).toEqual([]);
  });

  it('does not mistake an unrelated sibling .build directory for a managed backend', () => {
    fs.mkdirSync(path.join(fixture, 'extensions', 'codegraph', '.build'), { recursive: true });
    setup();
    expect(builds).toEqual(['engine', 'viewer']);
  });

  it('does not claim a receipt that names a different checkout', () => {
    const receipt = path.join(fixture, 'extensions', 'codegraph', '.build', 'codegraph-ue.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ sourcePath: path.join(fixture, 'other-checkout') }));
    setup();
    expect(builds).toEqual(['engine', 'viewer']);
  });

  it('preserves an unreadable managed receipt instead of rebuilding', () => {
    const receipt = path.join(fixture, 'extensions', 'codegraph', '.build', 'codegraph-ue.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, '{');
    expect(setup).toThrow(/Cannot verify.*receipt/i);
    expect(builds).toEqual([]);
  });

  it('rejects an alias to a registered checkout before writing its dist', () => {
    const registration = path.join(fixture, 'dependencies', 'locks', 'codegraph-ue.lock.yaml');
    fs.mkdirSync(path.dirname(registration), { recursive: true });
    fs.writeFileSync(registration, 'sourceId: codegraph-ue\n');
    const alias = path.join(fixture, 'checkout-alias');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => ensureTestDist(alias, build)).toThrow(/managed.*runtime/i);
    expect(builds).toEqual([]);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
  });

  it.each(['dist', 'dist/viewer'])('rejects a linked output directory %s before building', link => {
    const target = path.join(fixture, 'external-output');
    fs.mkdirSync(target);
    fs.mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
    fs.symlinkSync(target, path.join(root, link), process.platform === 'win32' ? 'junction' : 'dir');
    expect(setup).toThrow(/linked.*output/i);
    expect(builds).toEqual([]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('rejects a linked dependency tree before a test build can write its cache', () => {
    const target = path.join(fixture, 'external-dependencies');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(setup).toThrow(/linked.*output/i);
    expect(builds).toEqual([]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(['node_modules/.vite', 'ui/node_modules/.vite'])('rejects a linked Vite cache %s', link => {
    const target = path.join(fixture, 'external-vite-cache');
    fs.mkdirSync(target);
    fs.mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
    fs.symlinkSync(target, path.join(root, link), process.platform === 'win32' ? 'junction' : 'dir');
    expect(setup).toThrow(/linked.*output/i);
    expect(builds).toEqual([]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('rejects hardlinked output files before a test build can overwrite them', () => {
    const target = path.join(fixture, 'external-file.js');
    fs.writeFileSync(target, 'preserve me');
    const output = path.join(root, 'dist', 'bin', 'codegraph.js');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.linkSync(target, output);
    expect(setup).toThrow(/linked.*output/i);
    expect(builds).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve me');
  });

  it('builds a cold checkout in dependency order and leaves a warm checkout untouched', () => {
    setup();
    expect(builds).toEqual(['engine', 'viewer']);
    builds = [];
    setup();
    expect(builds).toEqual([]);
  });

  it.each([...engineOutputs, ...viewerOutputs])('repairs missing output %s even with current sentinels', file => {
    setup();
    builds = [];
    fs.unlinkSync(path.join(root, file));
    setup();
    expect(builds).toEqual([file.startsWith('dist/viewer/') ? 'viewer' : 'engine']);
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  });

  it.each([
    ['src/bin/codegraph.ts', ['engine']],
    ['src/db/schema.sql', ['engine']],
    ['src/extraction/wasm/typescript.wasm', ['engine']],
    ['tsconfig.json', ['engine', 'viewer']],
    ['package.json', ['engine', 'viewer']],
    ['package-lock.json', ['engine', 'viewer']],
    ['scripts/check-ui-build.mjs', ['engine', 'viewer']],
    ['ui/src/App.svelte', ['viewer']],
    ['ui/vite.config.ts', ['viewer']],
    ['ui/svelte.config.js', ['viewer']],
    ['ui/tsconfig.json', ['viewer']],
    ['ui/package.json', ['viewer']],
    ['ui/index.html', ['viewer']],
  ])('invalidates changed input %s even with a preserved mtime', (file, expected) => {
    setup();
    builds = [];
    const stat = fs.statSync(path.join(root, file));
    write(file, 'changed');
    fs.utimesSync(path.join(root, file), stat.atime, stat.mtime);
    setup();
    expect(builds).toEqual(expected);
  });

  it('invalidates added and removed source files', () => {
    setup();
    builds = [];
    write('src/new-worker.ts');
    setup();
    fs.unlinkSync(path.join(root, 'src/new-worker.ts'));
    setup();
    expect(builds).toEqual(['engine', 'engine']);
  });

  it('fails directly when the checkout has no installed compiler', () => {
    expect(() => ensureTestDist(root)).toThrow(/engine build failed: Cannot find module/);
    expect(fs.existsSync(path.join(root, 'dist/.test-build-engine.json'))).toBe(false);
  });

  it('reports build errors directly and retries instead of recording partial success', () => {
    expect(() => ensureTestDist(root, () => {
      write('dist/bin/codegraph.js');
      throw new Error('compiler diagnostic');
    })).toThrow('[test setup] engine build failed: compiler diagnostic');
    expect(fs.existsSync(path.join(root, 'dist/.test-build-engine.json'))).toBe(false);
    setup();
    expect(builds).toEqual(['engine', 'viewer']);
  });
});
