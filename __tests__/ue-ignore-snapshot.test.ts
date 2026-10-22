import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildScopeIgnore, scanDirectory } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';

describe('Git ignored snapshot at the public scan/scope boundary', () => {
  let root: string;
  const write = (relative: string, text = 'void Source() {}\n') => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ignore-snapshot-'));
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    const resolved = path.resolve(root);
    const temporary = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporary) || !path.basename(resolved).startsWith('cg-ignore-snapshot-')) {
      throw new Error('Refusing to remove a non-fixture directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('preserves root negation, nested ignores, case folding and legacy file-as-directory rules', () => {
    write('.gitignore', 'Ignored/\n!Ignored/\n*.tmp\n');
    write('Ignored/Keep.cpp');
    write('Nested/.gitignore', 'Hidden/\nFiltered.cpp\n');
    write('Nested/Hidden/Inside.cpp');
    write('Nested/Filtered.cpp');
    write('Nested/Visible.cpp');
    const scope = buildScopeIgnore(root);
    expect(scanDirectory(root).sort()).toEqual(['Ignored/Keep.cpp', 'Nested/Visible.cpp']);
    expect(scope.ignores('Ignored/Keep.cpp')).toBe(false);
    expect(scope.ignores('Nested/Hidden/')).toBe(true);
    expect(scope.ignores('nested/hidden/Inside.cpp')).toBe(true);
    expect(scope.ignores('Nested/HiddenSibling/Inside.cpp')).toBe(false);
    // Characterize the existing snapshot, which appends '/' even to file entries.
    expect(scope.ignores('Nested/Filtered.cpp')).toBe(false);
    expect(scope.ignores('Nested/Filtered.cpp/Child.cpp')).toBe(true);
  });

  it('keeps explicit exclusions and hard exclusions above private include and public include', () => {
    write('.gitignore', 'Client/\nvendor/\n');
    write('Client/Plugins/Keep.cpp');
    write('Client/Plugins/Skip.cpp');
    write('vendor/Own.cpp');
    write('codegraph.json', JSON.stringify({ include: ['Client/Plugins/**'] }));
    write('.codegraph/indexing.json', JSON.stringify({
      include: ['Client/**', 'vendor/**'], exclude: ['Client/Plugins/Skip.cpp'],
    }));
    const scope = buildScopeIgnore(root);
    expect(scanDirectory(root).sort()).toEqual(['Client/Plugins/Keep.cpp', 'vendor/Own.cpp']);
    expect(scope.ignores('Client/')).toBe(false);
    expect(scope.ignores('Client/Plugins/Keep.cpp')).toBe(false);
    expect(scope.ignores('Client/Plugins/Skip.cpp')).toBe(true);
    expect(scope.ignores('vendor/Own.cpp')).toBe(false);
    expect(scope.ignores('vendor/.git/Internal.cpp')).toBe(true);
    expect(scope.ignores('vendor/.codegraph-candidate/Graph.cpp')).toBe(true);
  });

  it('preserves single-component snapshot rules at any directory depth', () => {
    write('.gitignore', '/Cache/\n');
    write('Cache/Hidden.cpp');
    write('Deep/Cache/VisibleToGit.cpp');
    write('Deep/CacheSibling/Visible.cpp');
    const scope = buildScopeIgnore(root);
    // The root-anchored source rule generates the legacy unanchored "Cache/" rule.
    expect(scope.ignores('Deep/Cache/VisibleToGit.cpp')).toBe(true);
    expect(scope.ignores('Deep/CACHE/')).toBe(true);
    expect(scope.ignores('Deep/CacheSibling/Visible.cpp')).toBe(false);
    expect(scanDirectory(root)).toEqual(['Deep/CacheSibling/Visible.cpp']);
  });

  it('preserves fallback pattern interpretation for special and negated path names', () => {
    write('Nested/.gitignore', '*/\n');
    write('Nested/[ab]/Hidden.cpp');
    write('Nested/!Other/Hidden.cpp');
    write('Nested/目录/Hidden.cpp');
    write('Ordinary/Visible.cpp');
    const scope = buildScopeIgnore(root);
    expect(scope.ignores('Nested/a/Child.cpp')).toBe(true);
    expect(scope.ignores('Nested/[ab]/Child.cpp')).toBe(false);
    expect(scope.ignores('Nested/!Other/Child.cpp')).toBe(true);
    expect(scope.ignores('Nested/目录/Child.cpp')).toBe(true);
    expect(scope.ignores('Ordinary/Visible.cpp')).toBe(false);
    expect(scanDirectory(root)).toEqual(['Ordinary/Visible.cpp']);
  });

  it('rebuilds a public scope after nested ignore and private scope changes', () => {
    write('Nested/.gitignore', 'Hidden/\n');
    write('Nested/Hidden/Source.cpp');
    expect(buildScopeIgnore(root).ignores('Nested/Hidden/Source.cpp')).toBe(true);
    write('.codegraph/indexing.json', JSON.stringify({ include: ['Nested/Hidden/**'] }));
    expect(buildScopeIgnore(root).ignores('Nested/Hidden/Source.cpp')).toBe(false);
    write('.codegraph/indexing.json', JSON.stringify({ include: ['Nested/Hidden/**'], exclude: ['Nested/Hidden/**'] }));
    expect(buildScopeIgnore(root).ignores('Nested/Hidden/Source.cpp')).toBe(true);
    fs.unlinkSync(path.join(root, '.codegraph/indexing.json'));
    write('Nested/.gitignore', 'Elsewhere/\n');
    expect(buildScopeIgnore(root).ignores('Nested/Hidden/Source.cpp')).toBe(false);
  });

  it('lets an opted-in embedded repository retain its own ignore boundary', () => {
    write('.gitignore', 'Repos/\n');
    write('codegraph.json', JSON.stringify({ includeIgnored: ['Repos/Embedded/'] }));
    write('Root.cpp');
    write('Repos/Embedded/.gitignore', 'Generated/\n');
    write('Repos/Embedded/Source.cpp');
    write('Repos/Embedded/Generated/Hidden.cpp');
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'Repos/Embedded'), windowsHide: true });
    const scope = buildScopeIgnore(root);
    expect(scope.ignores('Repos/')).toBe(false);
    expect(scope.ignores('Repos/Embedded/Source.cpp')).toBe(false);
    expect(scope.ignores('Repos/Embedded/Generated/Hidden.cpp')).toBe(true);
    expect(scanDirectory(root).sort()).toEqual(['Repos/Embedded/Source.cpp', 'Root.cpp']);
  });
});
