import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import ignore from 'ignore';
import { UeEngineConfig, loadIndexingConfig } from '../indexing-config';
import { loadExcludePatterns, clearProjectConfigCache } from '../project-config';
import { loadUeAwareExtensionOverrides as loadExtensionOverrides } from './ue-source-extensions';
import { ConfigError } from '../errors';
import { readBoundedSourceSync, oversizeStamp } from '../file-limits';
import { isUeTestOnlyFile, ueTestOnlyLines } from './ue-test-scope';
import { ueDirectiveStarts } from './ue-directives';
import { maskCppRawStrings } from './languages/c-cpp';
import { blankStringContents, stripCommentsForRegex } from '../resolution/strip-comments';
import { detectLanguage } from './grammars';
import { detectGeneratedFile, isGeneratedFile } from './generated-detection';

const CPP_FILE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;
const CPP_HEADER = /\.(?:h|hh|hpp|hxx|inl)$/i;
const UE_GENERATED = /(?:\.generated\.h|\.gen\.cpp)$/i;
const HARD_EXCLUDES = new Set(['.git', 'binaries', 'intermediate', 'deriveddatacache', 'saved', 'content', 'thirdparty', 'thirdpartynotue', 'vcpkg-installed', 'vcpkg_installed', 'node_modules', 'dist']);
const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const key = (p: string): string => normalize(p).toLowerCase();
const inside = (p: string, root: string): boolean => key(p) === key(root) || key(p).startsWith(key(root) + '/');
const forbidden = (p: string): boolean => normalize(p).split('/').some(part => HARD_EXCLUDES.has(part.toLowerCase()) || part.toLowerCase().startsWith('.codegraph'));

/** Syms emits both a whole-file marker and an explicit generator location. */
function isUeGeneratedSource(source: string): boolean {
  const head = source.slice(0, 8192);
  const leading = head.split(/\r?\n/, 8).join('\n');
  return /^[ \t]*\/\/[ \t]*generated[ \t]*$/im.test(leading) &&
    /^[ \t]*\/\/~[ \t]*generated from code at [^\r\n]+:\d+[ \t]*$/im.test(head);
}

interface Plugin { root: string; name: string; modules: string[] }
export interface UePluginScope {
  roots: string[];
  plugins: Array<{ root: string; depth: number; manual: boolean }>;
  unresolved: Array<{ file: string; line: number; include: string; candidates: string[] }>;
  depth: number;
  fingerprint: string;
  layoutFingerprint: string;
  sourceHashes: ReadonlyMap<string, string>;
  configSignature: string;
  incomplete: string[];
  /** Normalized plugin roots explicitly excluded by the current policy. */
  explicitlyExcluded: ReadonlySet<string>;
  observationOptions: { knownPlugins?: readonly string[]; discoverNew?: boolean };
  allows(relative: string): boolean;
}

/** All scope-affecting configuration participates in the persisted generation. */
export function ueScopeConfigSignature(root: string, config: UeEngineConfig): string {
  const local = loadIndexingConfig(root);
  if (JSON.stringify(local.ueEngine) !== JSON.stringify(config)) throw new ConfigError('UE scope configuration changed during observation.');
  let publicConfig: string | null = null;
  try {
    publicConfig = fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8');
    JSON.parse(publicConfig);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`Cannot read valid codegraph.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return JSON.stringify({ ueEngine: config, include: local.include, exclude: local.exclude, publicConfig });
}

/** Never follow a linked ancestor when a scope root starts below it. */
export function assertUnlinkedUePath(root: string, relative: string): void {
  let current = root;
  for (const segment of normalize(relative).split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new ConfigError(`UE scope contains a link that cannot be fully observed: ${relative}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
  }
}

/** Refuse partial directory observations: absence must not be inferred from EACCES. */
function entries(root: string, relative: string): fs.Dirent[] {
  assertUnlinkedUePath(root, relative);
  try { return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigError(`Cannot inspect UE source scope ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function* visitFiles(root: string, relative: string, excluded: (relative: string) => boolean): Generator<string | undefined> {
  if (forbidden(relative) || excluded(relative + '/')) return;
  // Yield for directories as well as files, including large empty trees.
  yield undefined;
  for (const item of entries(root, relative)) {
    const file = normalize(relative ? `${relative}/${item.name}` : item.name);
    if (forbidden(file) || excluded(file + (item.isDirectory() ? '/' : ''))) continue;
    // An omitted junction can hide reachability. Abort before mutations rather
    // than treating an unobserved subtree as proof that a plugin disappeared.
    if (item.isSymbolicLink()) throw new ConfigError(`UE scope contains a link that cannot be fully observed: ${file}`);
    if (item.isDirectory()) yield* visitFiles(root, file, excluded);
    else if (item.isFile()) yield file;
  }
}

function platformRoots(root: string, name: 'Source' | 'Plugins'): string[] {
  const platforms = entries(root, 'Engine/Platforms');
  const link = platforms.find(entry => entry.isSymbolicLink());
  if (link) throw new ConfigError(`UE platform scope contains a link that cannot be fully observed: Engine/Platforms/${link.name}`);
  return platforms.filter(e => e.isDirectory()).map(e => `Engine/Platforms/${e.name}/${name}`);
}

/**
 * Cheap change detector for an already verified generation. It observes names
 * and file identity/change times, but does not read source bodies. A mismatch
 * requires the full content-based scope observation; it never authorizes a
 * scope deletion by itself. Directory reads are bounded and yield to the loop.
 */
export async function probeUeScopeInputs(root: string, config: UeEngineConfig, pluginRoots: readonly string[], externalIgnoreRules: string,
  nestedIgnoreRules: (directory: string) => string): Promise<string> {
  const signature = ueScopeConfigSignature(root, config);
  clearProjectConfigCache();
  const patterns = [...loadExcludePatterns(root), ...loadIndexingConfig(root).exclude];
  const matcher = patterns.length ? ignore().add(patterns) : null;
  const excluded = (relative: string): boolean => forbidden(relative) || (matcher?.ignores(relative) ?? false);
  const sources = ['Engine/Source/Runtime', 'Engine/Source/Editor', 'Engine/Source/Developer', 'Engine/Source/Programs',
    'Engine/Programs', ...platformRoots(root, 'Source'), ...config.extraRoots, ...pluginRoots];
  const sourceRoots = new Set(sources.map(key));
  const isSelectedSource = (relative: string): boolean => {
    let parent = key(relative);
    for (;;) {
      if (sourceRoots.has(parent)) return true;
      const separator = parent.lastIndexOf('/');
      if (separator < 0) return false;
      parent = parent.slice(0, separator);
    }
  };
  const catalogRoots = ['Engine/Plugins', ...platformRoots(root, 'Plugins')];
  const directories = [...new Set([...sources, ...catalogRoots])];
  const queued = new Set<string>();
  const observations = new Map<string, string>();
  const addStat = async (relative: string, optional = false): Promise<void> => {
    try {
      const stat = await fs.promises.lstat(path.join(root, relative), { bigint: true });
      if (stat.isSymbolicLink()) throw new ConfigError(`UE scope contains a link that cannot be fully observed: ${relative}`);
      observations.set(relative, `${stat.mode}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (optional && (code === 'ENOENT' || code === 'ENOTDIR')) { observations.set(relative, 'missing'); return; }
      throw new ConfigError(`Cannot observe UE scope ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Ignore rules in ancestor directories affect the same source paths.
  const ancestors = new Set<string>(['.gitignore']);
  const ancestorDirectories = new Set<string>();
  for (const source of directories) {
    const parts = normalize(source).split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      ancestorDirectories.add(ancestor);
      ancestors.add(`${ancestor}/.gitignore`);
    }
  }
  // Check ancestors before reading any child through a possible junction.
  for (const directory of ancestorDirectories) await addStat(directory, true);
  for (const file of ancestors) await addStat(file, true);
  // A source root can start below an embedded Engine/.git boundary; that
  // boundary will not appear as a child of any traversed root directory.
  for (const directory of ancestorDirectories) {
    try {
      const git = await fs.promises.lstat(path.join(root, directory, '.git'));
      if (git.isSymbolicLink()) throw new ConfigError(`UE Git boundary is a link: ${directory}/.git`);
      observations.set(`${directory}/.git:rules`, nestedIgnoreRules(directory));
      await new Promise<void>(resolve => setImmediate(resolve));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  while (directories.length) {
    const batch = directories.splice(0, 24).filter(directory => {
      if (queued.has(key(directory)) || excluded(directory + '/')) return false;
      queued.add(key(directory));
      return true;
    });
    const lists = await Promise.all(batch.map(async directory => {
      try {
        await addStat(directory, !queued.has(`${key(directory)}:child`));
        const items = await fs.promises.readdir(path.join(root, directory), { withFileTypes: true });
        return items.map(item => ({ item, relative: `${directory}/${item.name}` }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Top-level optional UE roots need not exist; a disappearing observed
        // subtree must never be mistaken for an authoritative deletion.
        if ((code === 'ENOENT' || code === 'ENOTDIR') && !queued.has(`${key(directory)}:child`)) {
          observations.set(directory, 'missing'); return [];
        }
        throw new ConfigError(`Cannot inspect UE scope ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    const files: string[] = [];
    for (const entry of lists.flat()) {
      const { item, relative } = entry;
      if (item.name === '.git') {
        observations.set(`${relative}:rules`, nestedIgnoreRules(path.dirname(relative)));
        await new Promise<void>(resolve => setImmediate(resolve));
        continue;
      }
      if (excluded(relative + (item.isDirectory() ? '/' : ''))) continue;
      if (item.isSymbolicLink()) throw new ConfigError(`UE scope contains a link that cannot be fully observed: ${relative}`);
      if (item.isDirectory()) {
        queued.add(`${key(relative)}:child`);
        directories.push(relative);
      } else if (item.isFile()) {
        const selectedSource = isSelectedSource(relative);
        if (item.name === '.gitignore' || /\.uplugin$/i.test(item.name) ||
            (selectedSource ? CPP_FILE.test(relative) : CPP_HEADER.test(relative))) files.push(relative);
      }
    }
    for (let at = 0; at < files.length; at += 64) await Promise.all(files.slice(at, at + 64).map(file => addStat(file)));
  }
  return createHash('sha256').update(JSON.stringify({ signature, externalIgnoreRules, observations: [...observations.entries()].sort() })).digest('hex');
}

function* discoverPluginSteps(root: string): Generator<void, Plugin[]> {
  const found: Plugin[] = [];
  const visit = function* (relative: string): Generator<void> {
    yield;
    if (forbidden(relative)) return;
    const children = entries(root, relative);
    const link = children.find(entry => entry.isSymbolicLink());
    if (link) throw new ConfigError(`UE plugin scope contains a link that cannot be fully observed: ${relative}/${link.name}`);
    const manifests = children.filter(e => e.isFile() && /\.uplugin$/i.test(e.name));
    if (manifests.length) {
      if (manifests.length !== 1) throw new ConfigError(`Ambiguous UE plugin manifests in ${relative}`);
      const source = `${relative}/Source`;
      const modules = entries(root, source).filter(e => e.isDirectory()).map(e => e.name);
      found.push({ root: normalize(relative), name: manifests[0]!.name.slice(0, -'.uplugin'.length), modules });
      return;
    }
    for (const entry of children) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLowerCase() !== 'source') yield* visit(`${relative}/${entry.name}`);
  };
  for (const directory of ['Engine/Plugins', ...platformRoots(root, 'Plugins')]) yield* visit(directory);
  const seen = new Set<string>();
  for (const plugin of found) {
    const id = key(plugin.root);
    if (seen.has(id)) throw new ConfigError(`UE plugin paths differ only in case: ${plugin.root}`);
    seen.add(id);
  }
  return found;
}

function resolvePluginId(value: string, plugins: readonly Plugin[], field: string): Plugin | undefined {
  const matches = plugins.filter(plugin => value.includes('/') ? key(plugin.root) === key(value) : key(plugin.name) === key(value));
  if (matches.length > 1) throw new ConfigError(`Ambiguous UE plugin ${field}: ${value}`);
  if (!matches.length && field === 'plugins') throw new ConfigError(`UE plugin not found: ${value}`);
  return matches[0];
}

export interface UeObservedSource {
  readable: boolean;
  acceptable: boolean;
  bytes: number;
  hash: string;
  stamp: string;
  includes?: Array<{ spec: string; line: number }>;
}

/** Bounded cache of observations. Source identity is checked before every reuse. */
export class UeScopeObservationCache {
  private readonly entries = new Map<string, UeObservedSource>();
  private readonly changed = new Set<string>();
  private bytes = 0;
  private identity = '';
  private readonly budget: number;

  constructor(budget = 64 * 1024 * 1024) {
    this.budget = Number.isFinite(budget) ? Math.max(0, budget) : 64 * 1024 * 1024;
  }

  bind(root: string, config: string): void {
    const identity = JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root, config]);
    if (identity !== this.identity) { this.clear(); this.identity = identity; }
  }
  get(file: string): UeObservedSource | undefined { return this.entries.get(file); }
  delete(file: string): void {
    const prior = this.entries.get(file);
    if (prior) { this.bytes -= prior.bytes; this.entries.delete(file); }
  }
  set(file: string, observation: UeObservedSource): void {
    this.seed(file, observation);
    if (this.entries.has(file)) this.changed.add(file);
  }
  seed(file: string, observation: UeObservedSource): void {
    this.delete(file);
    if (this.bytes + observation.bytes <= this.budget) {
      this.entries.set(file, observation);
      this.bytes += observation.bytes;
    }
  }
  invalidateChanged(): void {
    for (const file of this.changed) this.delete(file);
  }
  *changes(): Iterable<[string, UeObservedSource]> {
    for (const file of this.changed) {
      const observation = this.entries.get(file);
      if (observation) yield [file, observation];
    }
  }
  clear(): void { this.entries.clear(); this.changed.clear(); this.bytes = 0; this.identity = ''; }
}

function sourceStamp(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source is no longer an unlinked regular file');
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export interface UeScopeBuildOptions {
  knownPlugins?: readonly string[];
  discoverNew?: boolean;
  admit?: (file: string) => boolean;
  /** In-memory observation budget; zero disables reuse for verification/tests. */
  observationCacheBytes?: number;
  observationCache?: UeScopeObservationCache;
  onObserved?: (count: number) => void;
  signal?: AbortSignal;
}

/** Compute one deterministic scope as resumable file and directory steps. */
function* buildUeEngineScopeSteps(
  root: string,
  config: UeEngineConfig,
  depth: number,
  options: UeScopeBuildOptions,
): Generator<void, UePluginScope> {
  // Respect explicit project exclusions during discovery as well as extraction.
  // Refresh the public config cache so restored mtimes cannot hide a rule edit.
  clearProjectConfigCache();
  const configSignature = ueScopeConfigSignature(root, config);
  const rootReal = fs.realpathSync(root);
  const overrides = loadExtensionOverrides(root);
  const exclusionPatterns = [...loadExcludePatterns(root), ...loadIndexingConfig(root).exclude];
  const exclusions = exclusionPatterns.length ? ignore().add(exclusionPatterns) : null;
  const excludedPath = (relative: string): boolean => exclusions?.ignores(relative) ?? false;
  const walk = function* (relative: string): Generator<string | undefined> {
    for (const file of visitFiles(root, relative, excludedPath)) {
      yield file && (!options.admit || options.admit(file)) ? file : undefined;
    }
  };
  const plugins = yield* discoverPluginSteps(root);
  const excluded = new Set(config.excludePlugins.map(value => resolvePluginId(value, plugins, 'excludePlugins')).filter((p): p is Plugin => !!p).map(p => key(p.root)));
  // Exact paths remain authoritative even if the corresponding manifest has
  // already disappeared; names need an unambiguous discovered manifest.
  for (const value of config.excludePlugins) if (value.includes('/')) excluded.add(key(value));
  // A regular ignore rule that excludes the plugin directory itself excludes
  // the whole subtree; a rule for just one child is not enough to remove it.
  for (const plugin of plugins) if (excludedPath(`${plugin.root}/`)) excluded.add(key(plugin.root));
  for (const previous of options.knownPlugins ?? []) if (excludedPath(`${previous}/`)) excluded.add(key(previous));
  const seeds = config.plugins.map(value => resolvePluginId(value, plugins, 'plugins')!).filter(plugin => !excluded.has(key(plugin.root)));
  const known = options.knownPlugins ? new Set(options.knownPlugins.map(key)) : undefined;
  const coreRoots = ['Engine/Source/Runtime', 'Engine/Source/Editor', 'Engine/Source/Developer', 'Engine/Source/Programs', 'Engine/Programs', ...platformRoots(root, 'Source'), ...config.extraRoots];
  const sourceObservations = new Map<string, string>();
  const incomplete = new Set<string>();
  const readSource = (file: string): { value: string | null; hash: string; stamp: string } => {
    try {
      const absolute = path.join(root, file);
      const stamp = sourceStamp(absolute);
      const observed = readBoundedSourceSync(absolute);
      if (sourceStamp(absolute) !== stamp) throw new Error('Source changed while it was read');
      const value = observed.bytes === null ? null : observed.bytes.toString('utf8');
      const hash = createHash('sha256').update(value === null ? oversizeStamp(observed.stats.size) : value).digest('hex');
      sourceObservations.set(file, hash);
      if (value === null) incomplete.add(file);
      return { value, hash, stamp };
    } catch (error) {
      throw new ConfigError(`Cannot read UE scope source ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const acceptableContent = (file: string, source: string | null): boolean => {
    if (source === null) return true; // retained as an explicitly incomplete observation
    const language = detectLanguage(file, source, overrides, root);
    return (language === 'c' || language === 'cpp') && !detectGeneratedFile(file, source) &&
      !isUeGeneratedSource(source) && !isUeTestOnlyFile(source);
  };
  const catalog = new Map<string, Array<{ file: string; plugin?: Plugin }>>();
  const seenHeaders = new Set<string>();
  const addHeader = (file: string, plugin?: Plugin): void => {
    if (!CPP_HEADER.test(file) || UE_GENERATED.test(file) || isGeneratedFile(file)) return;
    if (seenHeaders.has(key(file))) return;
    seenHeaders.add(key(file));
    const parts = normalize(file).split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = key(parts.slice(i).join('/'));
      const values = catalog.get(suffix) ?? [];
      values.push({ file, plugin }); catalog.set(suffix, values);
    }
  };
  for (const directory of coreRoots) for (const file of walk(directory)) {
    if (file) addHeader(file);
    yield;
  }
  for (const plugin of plugins) if (!excluded.has(key(plugin.root))) for (const file of walk(plugin.root)) {
    if (file) addHeader(file, plugin);
    yield;
  }

  const selected = new Map<string, { plugin: Plugin; depth: number; manual: boolean }>();
  for (const plugin of seeds) selected.set(key(plugin.root), { plugin, depth: 0, manual: true });
  const unresolved: UePluginScope['unresolved'] = [];
  const forEachInclude = (source: string, callback: (spec: string, line: number) => void): void => {
    if (!source.includes('include')) return;
    const testLines = ueTestOnlyLines(source);
    const code = stripCommentsForRegex(maskCppRawStrings(source).source, 'cpp');
    const lines = code.split(/\n/);
    const lexicalCode = blankStringContents(code);
    const lexical = lexicalCode.split(/\n/);
    const starts = ueDirectiveStarts(source, lexicalCode);
    for (let at = 0; at < lines.length; at++) {
      if (testLines.has(at + 1) || !starts.has(at + 1) || !/^\s*#\s*include\b/.test(lexical[at] ?? '')) continue;
      const match = lines[at]!.match(/^\s*#\s*include\s*["<]([^">]+)[">]/);
      if (match) callback(match[1]!, at + 1);
    }
  };
  // Discovery and selected-file reporting revisit the same sources. Retain
  // only their admission verdict and include sites during this observation;
  // do not retain source bodies or reuse this cache for later admission.
  const observedSources = options.observationCache ?? new UeScopeObservationCache(options.observationCacheBytes);
  observedSources.bind(rootReal, configSignature);
  const observe = (file: string, includeSites: boolean) => {
    const existing = observedSources.get(file);
    if (existing) {
      try {
        if (sourceStamp(path.join(root, file)) === existing.stamp && (!includeSites || existing.includes !== undefined)) {
          sourceObservations.set(file, existing.hash);
          if (!existing.readable) incomplete.add(file);
          return existing;
        }
      } catch (error) {
        throw new ConfigError(`Cannot recheck UE scope source ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      observedSources.delete(file);
    }
    const { value: source, hash, stamp } = readSource(file);
    const acceptable = acceptableContent(file, source);
    const includes: Array<{ spec: string; line: number }> = [];
    if (includeSites && source !== null && acceptable) {
      forEachInclude(source, (spec, line) => includes.push({ spec, line }));
    }
    const bytes = 128 + file.length * 2 + includes.reduce((sum, site) => sum + 80 + site.spec.length * 2, 0);
    const observation = { readable: source !== null, acceptable, bytes, hash, stamp, ...(includeSites ? { includes } : {}) };
    observedSources.set(file, observation);
    return observation;
  };
  let frontier = [...coreRoots, ...seeds.map(p => p.root)];
  const targetDepth = Math.min(Math.max(0, depth), config.maxDepth);
  for (let layer = 1; layer <= targetDepth && frontier.length; layer++) {
    const next = new Map<string, Plugin>();
    const inspectFrontierFile = (file: string): void => {
      if (!CPP_FILE.test(file) || UE_GENERATED.test(file)) return;
      const observation = observe(file, true);
      if (!observation.readable || !observation.acceptable) return;
      for (const include of observation.includes ?? []) {
        const spec = normalize(include.spec);
        // A bare basename or path traversal is not strong enough to choose a plugin.
        if (!spec.includes('/') || spec.split('/').some(part => part === '.' || part === '..')) continue;
        const hits = catalog.get(key(spec)) ?? [];
        const candidates = [...new Set(hits.map(hit => hit.plugin?.root ?? ''))];
        if (hits.length !== 1 || candidates.length !== 1 || !hits[0]!.plugin) {
          continue;
        }
        const plugin = hits[0]!.plugin!;
        const first = spec.split('/')[0]!.toLowerCase();
        if (first !== plugin.name.toLowerCase() && !plugin.modules.some(name => name.toLowerCase() === first)) continue;
        const targetSource = observe(hits[0]!.file, false);
        if (!targetSource.readable || !targetSource.acceptable) continue;
        if (!selected.has(key(plugin.root)) && (options.discoverNew !== false || !known || known.has(key(plugin.root)))) next.set(key(plugin.root), plugin);
      }
    };
    for (const directory of frontier) for (const file of walk(directory)) {
      if (file) inspectFrontierFile(file);
      yield;
    }
    frontier = [];
    for (const [id, plugin] of next) {
      selected.set(id, { plugin, depth: layer, manual: false });
      // A plugin newly found in this observation cannot expand again in the
      // same update. Explicit seeds and plugins from the prior generation can.
      if (!known || known.has(id)) frontier.push(plugin.root);
    }
  }
  const roots = [...new Set([...coreRoots, ...[...selected.values()].map(value => value.plugin.root)])];
  const seenReferences = new Set<string>();
  const sourceAdmission = new Map<string, 'admitted' | 'excluded' | 'oversized'>();
  // Include the newest layer in the snapshot and retain unselected plugin
  // header candidates without parsing any of those plugins' implementations.
  const inspectSelectedFile = (file: string): void => {
    if (!CPP_FILE.test(file) || UE_GENERATED.test(file)) return;
    const observation = observe(file, true);
    sourceAdmission.set(file, !observation.acceptable ? 'excluded' : observation.readable ? 'admitted' : 'oversized');
    if (!observation.readable || !observation.acceptable) return;
    for (const { spec, line } of observation.includes ?? []) {
      const hits = catalog.get(key(spec)) ?? [];
      if (!hits.some(hit => hit.plugin && !selected.has(key(hit.plugin.root)))) continue;
      const reference = `${key(file)}\0${line}\0${key(spec)}`;
      if (seenReferences.has(reference)) continue;
      seenReferences.add(reference);
      const matches = [...new Set(hits.map(hit => hit.file))].sort();
      const candidates = matches.slice(0, 32);
      if (matches.length > 32) candidates.push(`… ${matches.length - 32} more candidates; narrow the source scope`);
      unresolved.push({ file, line, include: spec, candidates });
    }
  };
  for (const directory of roots) for (const file of walk(directory)) {
    if (file) inspectSelectedFile(file);
    yield;
  }
  const pluginLayout = [...selected.values()].map(value => [value.plugin.root, value.depth]).sort();
  const headerCatalog = [...catalog.entries()].map(([name, hits]) => [name, hits.map(hit => hit.file).sort()]).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify({
    configSignature, exclusionPatterns, depth: targetDepth, plugins: pluginLayout, catalog: headerCatalog,
    sources: [...sourceObservations.entries()].sort(),
  })).digest('hex');
  const layoutFingerprint = createHash('sha256').update(JSON.stringify({
    configSignature, exclusionPatterns, plugins: pluginLayout, catalog: headerCatalog,
    sources: [...sourceAdmission.entries()].sort(),
  })).digest('hex');
  if (!options.observationCache) observedSources.clear();
  const testCache = new Map<string, boolean>();
  return {
    roots, depth: targetDepth, unresolved, fingerprint, layoutFingerprint, sourceHashes: sourceObservations, configSignature, incomplete: [...incomplete].sort(), explicitlyExcluded: excluded,
    observationOptions: { knownPlugins: options.knownPlugins, discoverNew: options.discoverNew },
    plugins: [...selected.values()].map(value => ({ root: value.plugin.root, depth: value.depth, manual: value.manual })),
    allows(relative: string): boolean {
      const rel = normalize(relative);
      if (!rel || forbidden(rel)) return false;
      const isDirectory = /\/$/.test(relative);
      if (isDirectory) {
        const admitted = roots.some(directory => inside(directory, rel) || inside(rel, directory));
        if (admitted) assertUnlinkedUePath(root, rel);
        return admitted;
      }
      if (!CPP_FILE.test(rel) || UE_GENERATED.test(rel) || !roots.some(directory => inside(rel, directory))) return false;
      // Git and explicit includes can surface paths the directory walker never
      // traverses. Resolve those paths here as well, before any file read.
      try {
        const real = fs.realpathSync(path.join(root, rel));
        if (key(real) !== key(path.resolve(rootReal, rel))) return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw new ConfigError(`Cannot inspect UE source path ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
      let testOnly = testCache.get(rel);
      if (testOnly === undefined) {
        try { testOnly = !observe(rel, false).acceptable; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw new ConfigError(`Cannot read UE source ${rel}: ${error instanceof Error ? error.message : String(error)}`);
        }
        testCache.set(rel, testOnly);
      }
      return !testOnly;
    },
  };
}

/** Synchronous compatibility for callers that explicitly need a sync scan. */
export function buildUeEngineScope(root: string, config: UeEngineConfig, depth = 1, options: UeScopeBuildOptions = {}): UePluginScope {
  const steps = buildUeEngineScopeSteps(root, config, depth, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Yield while observing large trees so query/CLI heartbeats remain responsive. */
export async function buildUeEngineScopeAsync(root: string, config: UeEngineConfig, depth = 1, options: UeScopeBuildOptions = {}): Promise<UePluginScope> {
  const steps = buildUeEngineScopeSteps(root, config, depth, options);
  let started = Date.now(), count = 0;
  options.signal?.throwIfAborted();
  options.onObserved?.(0);
  for (;;) {
    const step = steps.next();
    if (step.done) { options.onObserved?.(count); return step.value; }
    if (++count % 32 === 0 && Date.now() - started >= 15) {
      options.onObserved?.(count);
      await new Promise<void>(resolve => setImmediate(resolve));
      options.signal?.throwIfAborted();
      started = Date.now();
    }
  }
}
