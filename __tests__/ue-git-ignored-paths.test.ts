import { describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { GitIgnoredPaths } from '../src/extraction/git-ignored-paths';

const compare = (rules: string[], patterns: string[], queries: string[]) => {
  const legacy = ignore().add(rules);
  for (const pattern of patterns) legacy.add(pattern);
  const fallback = ignore().add(rules);
  const indexed = new GitIgnoredPaths(fallback, patterns);
  for (const query of queries) {
    expect(fallback.ignores(query) || indexed.ignores(query), query).toBe(legacy.ignores(query));
  }
};

describe('Git snapshot directory rules agree with the original ignore matcher', () => {
  it('preserves rooted paths, unanchored basenames and legacy file entries', () => {
    compare(['Ignored/', '!Ignored/', '*.tmp', '!Keep.tmp'], [
      'Cache/', 'Root/Nested/', 'source.cpp/', 'Root/other.cpp/', 'Name+Tag/', 'User@Dir/', 'Dot.Name/',
    ], [
      'Cache', 'Cache/', 'Cache/Source.cpp', 'Deep/Cache/Source.cpp', 'Deep/CACHE/',
      'CacheSibling/Source.cpp', 'Root/Nested', 'Root/Nested/', 'Root/Nested/Source.cpp',
      'Deep/Root/Nested/Source.cpp', 'root/NESTED/Source.cpp', 'Root/NestedSibling/Source.cpp',
      'source.cpp', 'source.cpp/', 'Deep/source.cpp/Child.cpp', 'Root/other.cpp', 'Root/other.cpp/Child.cpp',
      'Deep/Root/other.cpp/Child.cpp', 'Name+Tag/Source.cpp', 'User@Dir/Source.cpp', 'Dot.Name/Source.cpp',
      'Ignored/Source.cpp', 'Keep.tmp', 'Other.tmp',
    ]);
  });

  it('does not let root negations override a later positive snapshot rule', () => {
    compare(['Hidden/', '!Hidden/', '!Hidden/Keep.cpp', '!Deep/Cache/'], ['Hidden/', 'Cache/'], [
      'Hidden/', 'Hidden/Keep.cpp', 'Deep/Cache/', 'Deep/Cache/Keep.cpp', 'Other/Keep.cpp',
    ]);
  });

  it('retains fallback ordering when a generated path begins with a negation', () => {
    compare(['Blocked/', 'Other/'], ['Blocked/', '!Blocked/', 'Blocked/Later/', 'Plain/'], [
      'Blocked/', 'Blocked/Keep.cpp', 'Blocked/Later/Source.cpp', 'Plain/Source.cpp', 'Other/Source.cpp',
    ]);
    compare([], ['Plain/', '!Plain/'], ['Plain/', 'Plain/Source.cpp', 'Deep/Plain/Source.cpp']);
  });

  it('preserves string-by-string rule splitting for a newline-containing path', () => {
    compare([], ['Cache/', 'Prefix\n!Cache/'], ['Cache/', 'Cache/Source.cpp', 'Prefix', 'Other/Source.cpp']);
  });

  it('retains glob, escape, comment, whitespace and Unicode interpretation', () => {
    compare(['Initial/', '!Initial/'], [
      'Simple/', 'Nested/[ab]/', 'Nested/?/Cache/', 'Glob*/', '#Comment/', '\\!Escaped/',
      'Space Dir/', 'Trailing /', '目录/', 'Nested/!Literal/', 'K/', 'S/',
    ], [
      'Simple/Source.cpp', 'Nested/a/Source.cpp', 'Nested/[ab]/Source.cpp', 'Nested/z/Cache/Source.cpp',
      'GlobThing/Source.cpp', '#Comment/Source.cpp', '!Escaped/Source.cpp', 'Space Dir/Source.cpp',
      'Trailing /Source.cpp', '目录/Source.cpp', 'Nested/!Literal/Source.cpp',
      'k/Source.cpp', 'K/Source.cpp', 's/Source.cpp', 'ſ/Source.cpp', 'Unrelated/Source.cpp',
    ]);
  });

  it.runIf(process.platform === 'win32')('preserves Windows path conversion and its exceptions', () => {
    compare([], ['Cache/', 'Root/Nested/'], [
      'Deep\\CACHE\\Source.cpp', 'root\\nested\\Source.cpp', 'Root\\NestedSibling\\Source.cpp',
      'Other"Name\\Cache\\Source.cpp', 'Other|Name\\Cache\\Source.cpp',
    ]);
  });

  it('agrees for thousands of distinct source-like file and directory entries', () => {
    const patterns = Array.from({ length: 2400 }, (_, i) => `Plugins/Plugin${i}/Generated${i}.cpp/`);
    patterns.push('Cache/', 'Special/[ab]/');
    const queries = Array.from({ length: 180 }, (_, i) => [
      `Plugins/Plugin${i * 11}/Generated${i * 11}.cpp`,
      `Plugins/Plugin${i * 11}/Generated${i * 11}.cpp/Child.cpp`,
      `Plugins/Plugin${i * 11}/Real.cpp`, `Other${i}/Cache/Source.cpp`, `Special/a/Source${i}.cpp`,
    ]).flat();
    compare([], patterns, queries);
  });
});
