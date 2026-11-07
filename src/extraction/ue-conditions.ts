import { maskCppRawStrings } from './languages/c-cpp';
import { blankStringContents, stripCommentsForRegex } from '../resolution/strip-comments';
import { ueDirectiveStarts } from './ue-directives';

interface Frame { preceding: string[]; active: string }

/** Index directives once for all queried locations in one verified file. */
export function ueConditionLookup(source: string): (line: number) => string[] {
  const original = source.split('\n');
  const code = blankStringContents(stripCommentsForRegex(maskCppRawStrings(source).source, 'cpp'));
  const lexical = code.split('\n');
  const starts = ueDirectiveStarts(source, code);
  const directives: Array<{ line: number; op: string; normalized: string }> = [];
  for (let i = 0; i < lexical.length; i++) {
    const directive = starts.has(i + 1) ? lexical[i]!.match(/^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b/) : null;
    if (!directive) continue;
    const op = directive[1]!;
    const raw = original[i]!.replace(/^\s*#\s*\w+\b/, '').trim();
    const expression = /\\\s*$/.test(raw) ? 'unparsed multiline condition' : raw || 'unknown condition';
    const normalized = op === 'ifdef' || op === 'elifdef' ? `defined(${expression})`
      : op === 'ifndef' || op === 'elifndef' ? `!defined(${expression})` : expression;
    directives.push({ line: i + 1, op, normalized });
  }
  return line => {
    if (!Number.isInteger(line) || line < 1) return [];
    const stack: Frame[] = [];
    for (const { line: directiveLine, op, normalized } of directives) {
      if (directiveLine >= line) break;
      if (op === 'if' || op === 'ifdef' || op === 'ifndef') {
        stack.push({ preceding: [normalized], active: normalized });
      } else if ((op === 'elif' || op === 'elifdef' || op === 'elifndef') && stack.length) {
        const frame = stack[stack.length - 1]!;
        frame.active = `!(${frame.preceding.join(' || ')}) && (${normalized})`;
        frame.preceding.push(normalized);
      } else if (op === 'else' && stack.length) {
        const frame = stack[stack.length - 1]!;
        frame.active = `!(${frame.preceding.join(' || ')})`;
      } else if (op === 'endif' && stack.length) stack.pop();
    }
    return stack.map(frame => frame.active);
  };
}

/** Written preprocessor conditions surrounding a line; no build evaluation. */
export function ueConditionsAtLine(source: string, line: number): string[] {
  return ueConditionLookup(source)(line);
}
