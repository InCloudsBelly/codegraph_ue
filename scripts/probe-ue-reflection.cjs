// Read-only probe of real UE source files against the built extractor.
// node --liftoff-only scripts/probe-ue-reflection.cjs <header> ...
const fs = require('node:fs');
const { loadGrammarsForLanguages } = require('../dist/extraction/grammars');
const { extractFromSource } = require('../dist/extraction/tree-sitter');

(async () => {
  if (process.argv.length < 3) throw new Error('Supply one or more Unreal source files');
  await loadGrammarsForLanguages(['cpp']);
  for (const file of process.argv.slice(2)) {
    const source = fs.readFileSync(file, 'utf8');
    const start = performance.now();
    const result = extractFromSource(file, source, 'cpp');
    const reflected = result.nodes.filter(n => n.decorators?.some(d => /^(?:UCLASS|USTRUCT|UENUM|UPROPERTY|UFUNCTION|DECLARE_)/.test(d)));
    const kinds = {};
    for (const n of reflected) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    console.log(JSON.stringify({ file, bytes: Buffer.byteLength(source), elapsedMs: performance.now() - start,
      nodes: result.nodes.length, reflected: reflected.length, kinds, errors: result.errors }));
    if (reflected.length === 0 || result.errors.some(e => e.severity === 'error')) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
