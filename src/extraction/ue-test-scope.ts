import { maskCppRawStrings } from './languages/c-cpp';
import { blankStringContents, stripCommentsForRegex } from '../resolution/strip-comments';
import { ueDirectiveStarts } from './ue-directives';

type Truth = boolean | undefined;
const TEST_FLAGS = new Set(['WITH_DEV_AUTOMATION_TESTS', 'WITH_PERF_AUTOMATION_TESTS', 'WITH_AUTOMATION_TESTS', 'WITH_LOW_LEVEL_TESTS']);
const not = (a: Truth): Truth => a === undefined ? undefined : !a;
const and = (a: Truth, b: Truth): Truth => a === false || b === false ? false : a === true && b === true ? true : undefined;
const or = (a: Truth, b: Truth): Truth => a === true || b === true ? true : a === false && b === false ? false : undefined;

/** Evaluate only the small preprocessor subset we can prove with all test flags off. */
function condition(expression: string): { value: Truth; usesTest: boolean } {
  const usesTest = [...TEST_FLAGS].some(flag => new RegExp(`\\b${flag}\\b`).test(expression));
  const tokens = expression.match(/defined|[A-Za-z_]\w*|\d+|&&|\|\||!|\(|\)/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s+/g, '')) return { value: undefined, usesTest };
  let index = 0;
  let valid = true;
  const primary = (): Truth => {
    const token = tokens[index++];
    if (token === '!') return not(primary());
    if (token === '(') { const value = disjunction(); if (tokens[index++] !== ')') valid = false; return value; }
    if (token === 'defined') {
      const grouped = tokens[index] === '(';
      if (grouped) index++;
      const name = tokens[index++];
      if (!name || !/^[A-Za-z_]\w*$/.test(name) || (grouped && tokens[index++] !== ')')) valid = false;
      // UE often defines these macros to 0: `defined(TEST)` is therefore
      // independent of whether test code is enabled and cannot be pruned.
      return undefined;
    }
    if (!token) { valid = false; return undefined; }
    if (/^\d+$/.test(token)) return Number(token) !== 0;
    return TEST_FLAGS.has(token) ? false : undefined;
  };
  const conjunction = (): Truth => {
    let value = primary();
    while (tokens[index] === '&&') { index++; value = and(value, primary()); }
    return value;
  };
  const disjunction = (): Truth => {
    let value = conjunction();
    while (tokens[index] === '||') { index++; value = or(value, conjunction()); }
    return value;
  };
  const value = disjunction();
  return { value: valid && index === tokens.length ? value : undefined, usesTest };
}

interface BranchFrame { parentMasked: boolean; taken: Truth; usesTest: boolean }

/** One-based lines proven to belong exclusively to an enabled UE test branch. */
export function ueTestOnlyLines(source: string): Set<number> {
  if (![...TEST_FLAGS].some(flag => source.includes(flag))) return new Set();
  // Comments, strings and raw strings may contain apparent preprocessor lines.
  const lexical = blankStringContents(stripCommentsForRegex(maskCppRawStrings(source).source, 'cpp'));
  const lines = lexical.split(/\n/);
  const starts = ueDirectiveStarts(source, lexical);
  const masked = new Set<number>();
  const frames: BranchFrame[] = [];
  let activeMask = false;
  for (let i = 0; i < lines.length; i++) {
    const directive = starts.has(i + 1) ? lines[i]!.match(/^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b(.*)$/) : null;
    if (!directive) { if (activeMask) masked.add(i + 1); continue; }
    const op = directive[1]!;
    const text = directive[2]!.trim();
    if (op === 'if' || op === 'ifdef' || op === 'ifndef') {
      const expr = op === 'if' ? condition(text) : condition(`${op === 'ifndef' ? '!' : ''}defined(${text})`);
      frames.push({ parentMasked: activeMask, taken: expr.value, usesTest: expr.usesTest });
      activeMask = activeMask || (expr.usesTest && expr.value === false);
    } else if ((op === 'elif' || op === 'elifdef' || op === 'elifndef') && frames.length) {
      const frame = frames[frames.length - 1]!;
      const expr = op === 'elif' ? condition(text) : condition(`${op === 'elifndef' ? '!' : ''}defined(${text})`);
      const branch = and(not(frame.taken), expr.value);
      frame.taken = or(frame.taken, expr.value);
      frame.usesTest ||= expr.usesTest;
      activeMask = frame.parentMasked || (frame.usesTest && branch === false);
    } else if (op === 'else' && frames.length) {
      const frame = frames[frames.length - 1]!;
      activeMask = frame.parentMasked || (frame.usesTest && not(frame.taken) === false);
      frame.taken = true;
    } else if (op === 'endif' && frames.length) {
      activeMask = frames.pop()!.parentMasked;
    }
  }
  // An unterminated conditional cannot prove anything after its opening line.
  return frames.length ? new Set() : masked;
}

/** Omit a whole file only if all non-directive code is inside proven test lines. */
export function isUeTestOnlyFile(source: string): boolean {
  const masked = ueTestOnlyLines(source);
  if (!masked.size) return false;
  const lexical = blankStringContents(stripCommentsForRegex(maskCppRawStrings(source).source, 'cpp'));
  return lexical.split(/\n/).every((line, index) => masked.has(index + 1) ||
    /^\s*(?:#\s*(?:(?:if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b.*|pragma\s+once\b.*))?\s*$/.test(line));
}

/** Hide proven test branches from downstream source inference, preserving coordinates. */
export function maskUeTestOnlyCode(source: string): string {
  const lines = ueTestOnlyLines(source);
  if (!lines.size) return source;
  return source.split('\n').map((line, index) => lines.has(index + 1) ? line.replace(/[^\r]/g, ' ') : line).join('\n');
}
