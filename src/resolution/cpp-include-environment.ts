import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ResolutionContext } from './types';
import { readUeModuleRules, readUePluginDescriptor, type UeModuleRules, type UeModuleObservation } from './ue-module-environment';

export type CppIncludeQuote = '"' | '<' | 'unknown';
export type CppIncludeResolution =
  | { status: 'resolved'; file: string; environment: string }
  | { status: 'no-environment' | 'not-in-scope' | 'ambiguous' | 'incomplete'; reason?: string };

interface Environment {
  id: string;
  directories: string[];
  complete: boolean;
  heuristic?: boolean;
  metadataPaths?: Set<string>;
}

export const CPP_INCLUDE_SNAPSHOT_KEY = 'cpp_include_environment_v1';
const MAX_DEPENDENCIES = 100_000;
type Dependency = { path: string; kind: 'content' | 'probe' | 'directory'; identity: string; owners: string[] };
export interface CppIncludeSnapshot {
  version: 1;
  complete: boolean;
  files: string[];
  dependencies: Dependency[];
  bounded?: boolean;
  ueModules?: boolean;
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function identity(root: string, file: string, kind: Dependency['kind'], previous?: string): string {
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return 'refused';
  try {
    const stat = fs.statSync(full);
    const real = fs.realpathSync.native(full);
    if (kind === 'content') {
      // A status probe may inspect a changed target's identity, but only the controlled metadata reader may authorize its bytes.
      if (previous !== undefined && (previous.slice(0, previous.indexOf('\0')) !== real || !/\0[0-9a-f]{64}$/.test(previous))) {
        return `${real}\0unverified-content`;
      }
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) return 'unsupported';
      return `${real}\0${digest(fs.readFileSync(full))}`;
    }
    if (kind === 'directory') return `${real}\0${stat.dev}:${stat.ino}:${digest(fs.readdirSync(full).filter(f => /\.uplugin$/i.test(f)).sort().join('\0'))}`;
    return `${real}\0${stat.dev}:${stat.ino}:${stat.isFile() ? 'file' : 'directory'}`;
  } catch { return 'missing'; }
}

export function checkCppIncludeSnapshot(root: string, raw: string | null): {
  observed: boolean; complete: boolean; changed: boolean; affectedFiles: string[]; physicalRootsChanged?: boolean; reason?: string;
} {
  try {
    const snapshot = JSON.parse(raw ?? 'null') as CppIncludeSnapshot | null;
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.dependencies) || !Array.isArray(snapshot.files) ||
      snapshot.dependencies.length > MAX_DEPENDENCIES || snapshot.files.some(f => typeof f !== 'string')) throw new Error('unobserved');
    const affected = new Set<string>();
    let changed = snapshot.bounded === false;
    let ownerCount = 0;
    if (snapshot.bounded === false) for (const file of snapshot.files) affected.add(file);
    let physicalRootsChanged = false;
    for (const dep of snapshot.dependencies) {
      if (!dep || typeof dep.path !== 'string' || !['content', 'probe', 'directory'].includes(dep.kind) ||
        typeof dep.identity !== 'string' || !Array.isArray(dep.owners) || dep.owners.some(f => typeof f !== 'string')) throw new Error('invalid snapshot');
      ownerCount += dep.owners.length;
      if (ownerCount > 500_000) throw new Error('invalid snapshot budget');
      const now = identity(root, dep.path, dep.kind, dep.identity);
      if (now !== dep.identity) {
        changed = true;
        if (dep.kind === 'probe' && (dep.identity.endsWith(':directory') || now.endsWith(':directory'))) physicalRootsChanged = true;
        for (const owner of dep.owners.includes('*') ? snapshot.files : dep.owners) affected.add(owner);
      }
    }
    return { observed: true, complete: snapshot.complete === true, changed, affectedFiles: [...affected], physicalRootsChanged,
      ...(snapshot.complete ? {} : { reason: 'include-environment-incomplete' }) };
  } catch {
    return { observed: false, complete: false, changed: true, affectedFiles: [], reason: 'include-environment-unobserved' };
  }
}

function tokens(text: string, windows: boolean): string[] | null {
  const out: string[] = [];
  let token = '', active = false, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!quote && /\s/.test(c)) {
      if (active) out.push(token);
      token = ''; active = false; continue;
    }
    active = true;
    if (windows && c === '\\') {
      let end = i; while (text[end] === '\\') end++;
      const count = end - i;
      if (text[end] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) token += '"'; else quote = quote ? '' : '"';
        i = end; continue;
      }
      token += '\\'.repeat(count); i = end - 1; continue;
    }
    if (c === '"' || (!windows && c === "'")) {
      if (quote === c) quote = ''; else if (!quote) quote = c; else token += c;
    } else if (!windows && c === '\\' && quote !== "'") {
      if (++i >= text.length) return null;
      token += text[i];
    } else token += c;
  }
  if (quote) return null;
  if (active) out.push(token);
  return out;
}

function decode(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

/** Per resolver batch: compilation entries never share a union of search roots. */
export class CppIncludeEnvironment {
  private readonly byFile = new Map<string, Environment[]>();
  private readonly root: string;
  private readonly physicalRoot: string;
  private readonly junctions = new Map<string, string>();
  private junctionsDiscovered = false;
  private readonly dependencies = new Map<string, Dependency>();
  private readonly metadata = new Map<string, Buffer | null>();
  private metadataBytes = 0;
  private readonly dependencyOwners = new Map<string, Set<string>>();
  private ownerCount = 0;
  private readonly logicalCache = new Map<string, string | null>();
  private readonly environments = new Map<string, Environment>();
  private complete = true;
  private budgetExceeded = false;
  private databasePresent = false;
  private derivedEnvironments?: Map<string, Environment[]>;
  private derivedComplete = true;
  private modules?: UeModuleRules[];
  private readonly moduleObservations: UeModuleObservation[] = [];
  constructor(private readonly context: ResolutionContext) {
    this.root = context.getProjectRoot();
    this.physicalRoot = fs.realpathSync.native(this.root);
    this.observe('', 'probe', '*');
    for (const candidate of ['compile_commands.json', 'build/compile_commands.json', 'cmake-build-debug/compile_commands.json', 'cmake-build-release/compile_commands.json', 'out/compile_commands.json']) {
      let raw: unknown;
      const content = this.readMetadata(path.join(this.root, candidate), '*');
      if (content === null) {
        if (fs.existsSync(path.join(this.root, candidate))) { this.databasePresent = true; this.complete = false; break; }
        continue;
      }
      this.databasePresent = true;
      try { raw = JSON.parse(decode(content)); } catch { this.complete = false; break; }
      if (!Array.isArray(raw)) continue;
      for (const entry of raw) {
        if (!entry || typeof entry.file !== 'string' || typeof entry.directory !== 'string') continue;
        const file = this.logical(path.resolve(entry.directory, entry.file));
        if (file === null) continue;
        const command = typeof entry.command === 'string' ? entry.command : '';
        let args: string[] = Array.isArray(entry.arguments) && entry.arguments.every((a: unknown) => typeof a === 'string')
          ? entry.arguments : tokens(command, /(?:clang-cl|\bcl)(?:\.exe)?(?:"|\s)/i.test(command)) ?? [];
        const driver = path.basename(args[0] ?? '').replace(/\.exe$/i, '').toLowerCase();
        const windows = driver === 'cl' || driver === 'clang-cl' || args.includes('--driver-mode=cl');
        let complete = /^(?:cl|clang-cl|clang(?:\+\+)?|(?:[\w-]+-)?g(?:cc|\+\+))$/.test(driver);
        let totalBytes = 0, count = 0;
        const active = new Set<string>();
        const metadataPaths = new Set<string>();
        const expand = (input: string[], depth = 0): string[] => input.flatMap(arg => {
          if (!arg.startsWith('@')) return [arg];
          const absolute = path.resolve(entry.directory, arg.slice(1));
          const metadataPath = this.logical(absolute);
          if (depth >= 16 || ++count > 256 || (driver === 'cl' && depth > 0) || metadataPath === null) {
            complete = false; return [];
          }
          metadataPaths.add(metadataPath);
          try {
            const raw = this.readMetadata(absolute, file);
            if (raw === null) { complete = false; return []; }
            const canonical = fs.realpathSync.native(absolute);
            if (this.logical(canonical) === null || active.has(canonical)) { complete = false; return []; }
            totalBytes += raw.length;
            if (raw.length > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) { complete = false; return []; }
            const quoting = args.includes('--rsp-quoting=windows') ? true : args.includes('--rsp-quoting=posix') ? false : windows;
            const parsed = tokens(decode(raw), quoting);
            if (!parsed) { complete = false; return []; }
            active.add(canonical); const expanded = expand(parsed, depth + 1); active.delete(canonical);
            return expanded;
          } catch { complete = false; return []; }
        });
        args = expand(args);
        const directories: string[] = [], system: string[] = [];
        for (let i = 1; i < args.length; i++) {
          const arg = args[i]!;
          if (/^(?:-iquote|-idirafter|-iprefix|-iwithprefix|-isysroot|--sysroot|-include|-imacros|-nostdinc|-FI|\/FI|\/imsvc|\/external:I|\/X|\/link|-I-)/i.test(arg)) complete = false;
          let value: string | undefined;
          const isSystem = arg === '-isystem' || arg.startsWith('-isystem');
          if (arg === '-I' || arg === '/I' || arg === '-isystem') value = args[++i];
          else if (arg.startsWith('-isystem')) value = arg.slice('-isystem'.length);
          else if (arg.startsWith('-I') || arg.startsWith('/I')) value = arg.slice(2);
          if (value) {
            if (value.startsWith('=')) complete = false;
            const relative = this.logical(path.resolve(entry.directory, value));
            if (relative !== null) (isSystem ? system : directories).push(relative);
            else (isSystem ? system : directories).push(`\0outside:${digest(path.resolve(entry.directory, value))}`);
          } else if (arg === '-I' || arg === '/I' || arg === '-isystem') {
            complete = false;
          }
        }
        directories.push(...system);
        const id = digest(JSON.stringify([driver, entry.directory, directories, args.filter(a => /^[-/]D/.test(a)), complete]));
        let env = this.environments.get(id);
        if (!env) {
          env = { id, directories, complete, metadataPaths };
          if (this.environments.size < 16_384) this.environments.set(id, env);
        } else for (const metadata of metadataPaths) env.metadataPaths!.add(metadata);
        if (!complete) this.complete = false;
        const existing = this.byFile.get(file) ?? [];
        existing.push(env); this.byFile.set(file, existing);
      }
      break;
    }
  }

  private observe(file: string, kind: Dependency['kind'], owner: string, previous?: string): void {
    const key = `${kind}:${file}`;
    const existing = this.dependencies.get(key);
    if (existing) {
      const owners = this.dependencyOwners.get(key)!;
      if (!owners.has(owner)) {
        if (this.ownerCount >= 500_000) { this.complete = false; this.budgetExceeded = true; return; }
        this.ownerCount++; owners.add(owner); existing.owners.push(owner);
      }
      return;
    }
    if (this.dependencies.size >= MAX_DEPENDENCIES || this.ownerCount >= 500_000) { this.complete = false; this.budgetExceeded = true; return; }
    this.dependencies.set(key, { path: file, kind, identity: identity(this.root, file, kind, previous), owners: [owner] });
    this.dependencyOwners.set(key, new Set([owner]));
    this.ownerCount++;
  }

  private readMetadata(absolute: string, owner: string): Buffer | null {
    const logical = this.logical(absolute);
    if (logical === null) { this.complete = false; return null; }
    const cached = this.metadata.get(logical);
    if (this.metadata.has(logical)) {
      this.observe(logical, 'content', owner);
      this.metadata.delete(logical); this.metadata.set(logical, cached!);
      return cached!;
    }
    let value: Buffer | null = null;
    try {
      if (fs.statSync(absolute).size <= 256 * 1024 * 1024 && this.logical(fs.realpathSync.native(absolute)) !== null) value = fs.readFileSync(absolute);
      else this.complete = false;
    } catch { /* Missing compiler metadata is recorded as a negative dependency. */ }
    // Retain at most 32 MiB of raw metadata; environments retain paths and digests only.
    if (value === null || value.length <= 32 * 1024 * 1024) {
      this.metadata.set(logical, value); this.metadataBytes += value?.length ?? 0;
      while (this.metadataBytes > 32 * 1024 * 1024 || this.metadata.size > 4096) {
        const first = this.metadata.keys().next().value!;
        this.metadataBytes -= this.metadata.get(first)?.length ?? 0; this.metadata.delete(first);
      }
    }
    const key = `content:${logical}`;
    if (!this.dependencies.has(key) && this.dependencies.size < MAX_DEPENDENCIES && this.ownerCount < 500_000) {
      let fingerprint = 'missing';
      try { if (value) fingerprint = `${fs.realpathSync.native(absolute)}\0${digest(value)}`; } catch { /* The next sync observes a disappearing input. */ }
      this.dependencies.set(key, { path: logical, kind: 'content', identity: fingerprint, owners: [owner] });
      this.dependencyOwners.set(key, new Set([owner]));
      this.ownerCount++;
    } else this.observe(logical, 'content', owner);
    return value;
  }

  snapshot(previous?: string | null): CppIncludeSnapshot {
    const files = [...new Set([...this.context.getAllFiles().filter(file => {
      const language = this.context.getFileLanguage ? this.context.getFileLanguage(file) : this.context.getNodesInFile(file)[0]?.language;
      return language === 'c' || language === 'cpp';
    }), ...this.moduleObservations.filter(o => o.rules.isModuleRules).map(o => o.filePath)])];
    const indexed = new Set(files);
    if (files.length > 0 && !this.databasePresent && !this.modules?.length) this.complete = false;
    try {
      const old = JSON.parse(previous ?? 'null') as CppIncludeSnapshot | null;
      if (old?.version === 1 && Array.isArray(old.dependencies) && old.dependencies.length <= MAX_DEPENDENCIES) {
        let owners = 0;
        for (const dep of old.dependencies) {
          if (!dep || typeof dep.path !== 'string' || !['content', 'probe', 'directory'].includes(dep.kind) || !Array.isArray(dep.owners)) continue;
          owners += dep.owners.length;
          if (owners > 500_000) break;
          for (const owner of dep.owners) if (typeof owner === 'string' && (owner === '*' || indexed.has(owner))) this.observe(dep.path, dep.kind, owner, dep.identity);
        }
      }
    } catch { /* Older indexes have no include-environment snapshot. */ }
    return { version: 1, complete: this.complete, bounded: !this.budgetExceeded, ueModules: this.moduleObservations.some(o => o.rules.isModuleRules), files, dependencies: [...this.dependencies.values()] };
  }

  private logical(absolute: string): string | null {
    const cached = this.logicalCache.get(absolute);
    if (cached !== undefined || this.logicalCache.has(absolute)) return cached!;
    const original = absolute;
    const save = (value: string | null) => {
      if (this.logicalCache.size >= 100_000) this.logicalCache.delete(this.logicalCache.keys().next().value!);
      this.logicalCache.set(original, value); return value;
    };
    try { absolute = fs.realpathSync.native(absolute); } catch { /* Missing metadata remains a bounded negative probe. */ }
    for (const base of [this.root, this.physicalRoot]) {
      const relative = path.relative(base, absolute).replace(/\\/g, '/');
      if (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) return save(relative);
    }
    if (!this.junctionsDiscovered) {
      this.junctionsDiscovered = true;
      const seen = new Set<string>();
      for (const file of this.context.getAllFiles()) {
        const parts = file.replace(/\\/g, '/').split('/');
        for (let i = 1; i < parts.length; i++) {
          const logical = parts.slice(0, i).join('/');
          if (seen.has(logical)) continue;
          seen.add(logical);
          try {
            const full = path.join(this.root, logical);
            if (fs.lstatSync(full).isSymbolicLink()) {
              this.junctions.set(logical, fs.realpathSync.native(full));
              this.observe(logical, 'probe', '*');
            }
          } catch { /* A removed indexed directory is not an approved mapping. */ }
        }
      }
    }
    const matches: string[] = [];
    for (const [logical, physical] of this.junctions) {
      const suffix = path.relative(physical, absolute).replace(/\\/g, '/');
      if (suffix !== '..' && !suffix.startsWith('../') && !path.isAbsolute(suffix)) matches.push(path.posix.join(logical, suffix));
    }
    if (new Set(matches).size === 1) return save(matches[0]!);
    return save(null);
  }

  resolve(fromFile: string, spec: string, quote: CppIncludeQuote = 'unknown', line?: number): CppIncludeResolution {
    let envs = this.byFile.get(fromFile);
    if (!envs && this.databasePresent) {
      this.deriveHeaderEnvironments();
      if (!this.derivedComplete) return { status: 'incomplete', reason: 'include-environment-budget' };
      envs = this.derivedEnvironments?.get(fromFile);
    }
    if (!envs && !this.databasePresent) envs = this.moduleEnvironments(fromFile);
    if (!envs) {
      this.complete = false;
      return { status: this.databasePresent ? 'incomplete' : 'no-environment', reason: 'no-translation-unit-environment' };
    }
    return this.resolveInEnvironments(fromFile, spec, quote, line, envs);
  }

  /** Reopen newly reachable headers as well as the previous metadata owners after a TU environment changes. */
  affectedFiles(files: readonly string[]): string[] {
    this.deriveHeaderEnvironments();
    const affectedEnvironments = new Set(files.flatMap(file => this.byFile.get(file)?.map(env => env.id) ?? []));
    const affected = new Set(files);
    for (const [file, environments] of this.derivedEnvironments ?? []) {
      if (environments.some(env => affectedEnvironments.has(env.id))) affected.add(file);
    }
    return [...affected];
  }

  getUeModuleRules(): readonly UeModuleObservation[] {
    if (!this.modules) {
      this.modules = [];
      for (const source of this.context.getAllFiles().filter(f => /\.Build\.cs$/i.test(f))) {
        const content = this.readMetadata(path.join(this.root, source), source);
        if (!content) continue;
        let rule: UeModuleRules;
        try { rule = readUeModuleRules(source, decode(content)); } catch { this.complete = false; continue; }
        const observation: UeModuleObservation = { filePath: source, rules: rule };
        this.moduleObservations.push(observation);
        const sourceAt = source.lastIndexOf('/Source/');
        if (sourceAt >= 0 && /(?:^|\/)Plugins\//.test(source)) {
          const plugin = source.slice(0, sourceAt);
          this.observe(plugin, 'directory', source);
          let descriptors: string[] = [];
          try { descriptors = fs.readdirSync(path.join(this.root, plugin)).filter(f => /\.uplugin$/i.test(f)); } catch { /* Unavailable metadata is incomplete. */ }
          observation.pluginComplete = descriptors.length === 1;
          if (descriptors.length !== 1) rule.publicComplete = rule.privateComplete = false;
          else {
            const data = this.readMetadata(path.join(this.root, plugin, descriptors[0]!), source);
            let descriptor: ReturnType<typeof readUePluginDescriptor> | null = null;
            try { descriptor = data ? readUePluginDescriptor(decode(data)) : null; } catch { /* Invalid encoding is incomplete metadata. */ }
            observation.pluginComplete = descriptor?.complete === true;
            if (descriptor) observation.plugin = { filePath: `${plugin}/${descriptors[0]}`, name: descriptors[0]!.replace(/\.uplugin$/i, ''), descriptor };
            const module = descriptor?.modules.find(m => m.name === rule.name);
            if (!descriptor?.complete || !module || Object.keys(module.conditions).length > 0) rule.publicComplete = rule.privateComplete = false;
          }
        }
        this.modules.push(rule);
      }
    }
    return this.moduleObservations;
  }

  private moduleEnvironments(file: string): Environment[] | undefined {
    this.getUeModuleRules();
    const owner = this.modules!.filter(m => file.startsWith(m.directory + '/')).sort((a, b) => b.directory.length - a.directory.length)[0];
    if (!owner) return undefined;
    const observeModule = (module: UeModuleRules) => {
      const entry = this.moduleObservations.find(o => o.rules === module);
      if (!entry) return;
      this.observe(entry.filePath, 'content', file);
      if (entry.plugin) {
        this.observe(entry.plugin.filePath, 'content', file);
        this.observe(path.posix.dirname(entry.plugin.filePath), 'directory', file);
      }
    };
    observeModule(owner);
    const isPublic = file.startsWith(owner.directory + '/Public/') || file.startsWith(owner.directory + '/Classes/');
    let complete = owner.publicComplete && (isPublic || owner.privateComplete);
    const directories = [owner.directory + '/Public', owner.directory + '/Classes', ...owner.publicIncludePaths];
    if (!isPublic) directories.push(owner.directory + '/Private', ...owner.privateIncludePaths);
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const candidates = this.modules!.filter(m => m.name === name);
      if (candidates.length !== 1) { complete = false; return; }
      const module = candidates[0]!;
      observeModule(module);
      complete &&= module.publicComplete;
      directories.push(module.directory + '/Public', module.directory + '/Classes', ...module.publicIncludePaths);
      for (const dependency of [...module.publicDependencies, ...module.publicIncludeModules]) visit(dependency);
    };
    for (const dependency of [...owner.publicDependencies, ...owner.publicIncludeModules,
      ...(isPublic ? [] : [...owner.privateDependencies, ...owner.privateIncludeModules])]) visit(dependency);
    if (!complete) this.complete = false;
    return [{ id: `ue-static:${digest(JSON.stringify([owner.name, directories, complete]))}`, directories, complete, heuristic: true }];
  }

  private deriveHeaderEnvironments(): void {
    if (this.derivedEnvironments) return;
    this.derivedEnvironments = new Map();
    const queue: Array<[string, Environment]> = [];
    const seen = new Set<string>();
    const enqueue = (file: string, env: Environment) => {
      if (queue.length >= 100_000) { this.derivedComplete = false; this.complete = false; this.budgetExceeded = true; return; }
      queue.push([file, env]);
    };
    for (const [file, envs] of this.byFile) for (const env of envs) enqueue(file, env);
    for (let at = 0; at < queue.length; at++) {
      if (at >= 100_000) { this.complete = false; break; }
      const [file, env] = queue[at]!;
      const key = `${file}\0${env.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const environments = this.derivedEnvironments.get(file) ?? [];
      environments.push(env); this.derivedEnvironments.set(file, environments);
      for (const include of this.context.getNodesInFile(file).filter(n => n.kind === 'import')) {
        const quote = include.signature?.match(/^\s*#\s*include\s*(["<])/)?.[1] as CppIncludeQuote ?? 'unknown';
        const target = this.resolveInEnvironments(file, include.name, quote, include.startLine, [env]);
        if (target.status === 'resolved' && !seen.has(`${target.file}\0${env.id}`)) enqueue(target.file, env);
      }
    }
  }

  private resolveInEnvironments(fromFile: string, spec: string, quote: CppIncludeQuote, line: number | undefined, envs: Environment[]): CppIncludeResolution {
    if (quote === 'unknown' && line !== undefined) {
      const text = this.context.getFileLines?.(fromFile)?.[line - 1] ?? this.context.readFile(fromFile)?.split(/\r?\n/)[line - 1];
      quote = text?.match(/^\s*#\s*include\s*(["<])/)?.[1] as CppIncludeQuote ?? 'unknown';
    }
    if (quote === 'unknown') {
      const sites = this.context.getNodesInFile(fromFile).filter(n => n.kind === 'import' && n.name === spec);
      const forms = new Set(sites.map(n => n.signature?.match(/^\s*#\s*include\s*(["<])/)?.[1]).filter(Boolean));
      if (forms.size === 1) quote = [...forms][0] as CppIncludeQuote;
      else if (forms.size > 1) return { status: 'ambiguous', reason: 'include-delimiter-ambiguous' };
    }
    const targets: string[] = [];
    for (const env of envs) {
      for (const metadata of env.metadataPaths ?? []) this.observe(metadata, 'content', fromFile);
      if (!env.complete || this.budgetExceeded) return { status: 'incomplete' };
      const dirs = quote === '"' ? [path.posix.dirname(fromFile), ...env.directories] : env.directories;
      let target: string | undefined;
      let outsideBeforeTarget = false;
      for (const dir of dirs) {
        if (dir.startsWith('\0outside:')) { outsideBeforeTarget = true; continue; }
        const file = path.posix.normalize(path.posix.join(dir, spec.replace(/\\/g, '/')));
        if (file.startsWith('../') || path.posix.isAbsolute(file)) continue;
        this.observe(file, 'probe', fromFile);
        if (this.budgetExceeded) return { status: 'incomplete', reason: 'include-observation-budget' };
        if (this.context.fileExists(file)) {
          if (outsideBeforeTarget) { this.complete = false; return { status: 'incomplete', reason: 'outside-header-may-shadow-target' }; }
          if (this.context.isIndexedFile?.(file) === false) return { status: 'not-in-scope', reason: 'unindexed-header-shadow' };
          if (target && target !== file) return { status: 'ambiguous', reason: 'ue-static-header-ambiguous' };
          target = file;
          if (!env.heuristic || dir === path.posix.dirname(fromFile) && quote === '"') break;
        }
      }
      if (!target) return { status: 'not-in-scope' };
      targets.push(target);
    }
    if (new Set(targets).size !== 1) return { status: 'ambiguous' };
    return { status: 'resolved', file: targets[0]!, environment: envs.map(e => e.id).join('|') };
  }
}
