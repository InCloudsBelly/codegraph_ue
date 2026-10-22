/** Synthetic cold-query benchmark; never scans a checkout or opens a graph. */
import { performance } from 'node:perf_hooks';
import ignore from 'ignore';
import { GitIgnoredPaths } from '../src/extraction/git-ignored-paths.ts';

const count = Number(process.argv[2] ?? 57809);
const queryCount = Number(process.argv[3] ?? 300);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(queryCount) || queryCount < 1) {
  throw new Error('Usage: bench-ue-ignore.ts [positive rule count] [positive query count]');
}
const patterns = Array.from({ length: count }, (_, i) =>
  i % 6 === 0 ? `Engine/Plugin${i}/Intermediate/` : `Engine/Plugin${i}/Generated/Hidden${i}.cpp/`);
const queries = Array.from({ length: queryCount }, (_, i) => {
  const n = (i * 193) % count;
  return i % 3 === 0
    ? `Engine/Plugin${n}/Generated/Hidden${n}.cpp/Child.cpp`
    : `Engine/Plugin${n}/Source/Actual${i}.cpp`;
});
const samples: Array<Record<string, number>> = [];
for (let sample = 0; sample < 3; sample++) {
  const beforeLegacy = performance.now();
  const legacy = ignore().add(patterns);
  const legacyBuilt = performance.now();
  const answers = queries.map(query => legacy.ignores(query));
  const legacyQueried = performance.now();
  const fallback = ignore();
  const indexed = new GitIgnoredPaths(fallback, patterns);
  const optimizedBuilt = performance.now();
  const actual = queries.map(query => fallback.ignores(query) || indexed.ignores(query));
  const optimizedQueried = performance.now();
  if (actual.some((answer, i) => answer !== answers[i])) throw new Error('Legacy/optimized answers differ');
  samples.push({
    legacyBuildMs: legacyBuilt - beforeLegacy, legacyQueryMs: legacyQueried - legacyBuilt,
    optimizedBuildMs: optimizedBuilt - legacyQueried, optimizedQueryMs: optimizedQueried - optimizedBuilt,
  });
}
console.log(JSON.stringify({
  kind: 'synthetic-cold-distinct-queries', rules: count, queries: queryCount,
  samples, equalAnswers: true, realUeIndexBenchmarked: false,
}, null, 2));
