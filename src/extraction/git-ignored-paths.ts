import type { Ignore } from 'ignore';

/** The legacy Git snapshot appends '/' to every entry, including file entries. */
export class GitIgnoredPaths {
  private readonly rooted = new Set<string>();
  private readonly basenames = new Set<string>();

  constructor(rootMatcher: Ignore, directoryPatterns: string[]) {
    // Negations (also after a filename newline) must keep their ordering against all rules.
    if (directoryPatterns.some(pattern => pattern.startsWith('!') || /[\r\n]/.test(pattern))) {
      for (const pattern of directoryPatterns) rootMatcher.add(pattern);
      return;
    }
    for (const pattern of directoryPatterns) {
      // Leave glob, escaped, Unicode, comment and whitespace semantics to ignore.
      if (!/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*\/$/.test(pattern) ||
        pattern.split('/').some(segment => segment === '.' || segment === '..')) {
        rootMatcher.add(pattern);
        continue;
      }
      const key = pattern.toLowerCase();
      if (key.slice(0, -1).includes('/')) this.rooted.add(key);
      else this.basenames.add(key.slice(0, -1));
    }
  }

  ignores(relativePath: string): boolean {
    if (this.rooted.size === 0 && this.basenames.size === 0) return false;
    // Mirror ignore's Windows path conversion without folding Unicode into ASCII.
    let candidate = process.platform === 'win32' && !/^\\\\\?\\/.test(relativePath) &&
      !/["<>|\u0000-\u001f]/.test(relativePath) ? relativePath.replace(/\\/g, '/') : relativePath;
    candidate = candidate.replace(/[A-Z]/g, character => character.toLowerCase());
    let start = 0;
    for (let slash = candidate.indexOf('/'); slash !== -1; slash = candidate.indexOf('/', start)) {
      if (this.rooted.has(candidate.slice(0, slash + 1)) || this.basenames.has(candidate.slice(start, slash))) return true;
      start = slash + 1;
    }
    return false;
  }
}
