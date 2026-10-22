import type { Node } from '../types';
import type { ResolutionContext } from './types';

const before = (line: number, column: number, limitLine: number, limitColumn: number): boolean =>
  line < limitLine || (line === limitLine && column < limitColumn);

/** A declaration is usable only where the structured C++ include resolver proves visibility. */
export class UnrealVisibility {
  private readonly includes = new Map<string, ReadonlySet<string> | null>();
  constructor(private readonly context: ResolutionContext) {}

  isVisible(declaration: Node, fromFile: string, beforeLine: number, beforeColumn = 0): boolean {
    if (declaration.filePath === fromFile) {
      const opensScope = ['class', 'struct', 'union', 'enum'].includes(declaration.kind);
      return before(opensScope ? declaration.startLine : declaration.endLine,
        (opensScope ? declaration.startColumn : declaration.endColumn) ?? 0, beforeLine, beforeColumn);
    }
    return this.includedFiles(fromFile, beforeLine, beforeColumn)?.has(declaration.filePath) === true;
  }

  /** Null means the environment or any required include site could not be proven complete. */
  includedFiles(fromFile: string, beforeLine: number, beforeColumn = 0): ReadonlySet<string> | null {
    const imports = (file: string) => this.context.getNodesInFile(file)
      .filter(node => node.kind === 'import' && (node.language === 'c' || node.language === 'cpp'))
      .sort((a, b) => a.startLine - b.startLine || (a.startColumn ?? 0) - (b.startColumn ?? 0));
    const initial = imports(fromFile).filter(node => before(node.startLine, node.startColumn ?? 0, beforeLine, beforeColumn));
    const key = `${fromFile}\0${initial.map(node => node.id).join('\0')}`;
    if (this.includes.has(key)) return this.includes.get(key)!;
    const files = new Set<string>();
    const visited = new Set([fromFile]);
    const pending = initial.map(node => ({ file: fromFile, node }));
    for (let at = 0; at < pending.length; at++) {
      // A partial proof never authorizes a bridge, even when it already reached a namesake.
      if (pending.length > 32768 || visited.size > 4096) { this.includes.set(key, null); return null; }
      const { file, node } = pending[at]!;
      const resolved = this.context.resolveCppInclude?.(file, node.name, 'unknown', node.startLine);
      if (!resolved || resolved.status !== 'resolved') { this.includes.set(key, null); return null; }
      if (visited.has(resolved.file)) continue;
      visited.add(resolved.file);
      files.add(resolved.file);
      for (const included of imports(resolved.file)) pending.push({ file: resolved.file, node: included });
    }
    this.includes.set(key, files);
    return files;
  }
}
