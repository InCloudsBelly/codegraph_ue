/** Physical lines whose `#` starts a new C/C++ logical line. */
export function ueDirectiveStarts(source: string, lexical: string): Set<number> {
  const original = source.split('\n');
  const code = lexical.split('\n');
  const starts = new Set<number>();
  let continued = false;
  for (let i = 0; i < original.length; i++) {
    if (!continued && /^\s*#/.test(code[i] ?? '')) starts.add(i + 1);
    // An immediately escaped newline is spliced before directive recognition.
    // Also conservatively allow whitespace before the newline.
    continued = /\\[ \t]*\r?$/.test(original[i] ?? '');
  }
  return starts;
}
