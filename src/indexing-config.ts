import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from './directory';
import { ConfigError } from './errors';
import { normalizePath } from './utils';

export const INDEXING_CONFIG_FILE = 'indexing.json';

/** Opt-in policy for one UE engine source index, never a global language default. */
export interface UeEngineConfig {
  plugins: string[];
  excludePlugins: string[];
  extraRoots: string[];
  maxDepth: number;
}

export interface IndexingConfig {
  path: string;
  loaded: boolean;
  include: string[];
  exclude: string[];
  includeRoots: string[];
  ueEngine?: UeEngineConfig;
}

export interface IndexingConfigStatus {
  path: string;
  loaded: boolean;
  include: string[];
  exclude: string[];
  error: string | null;
  ueEngine?: UeEngineConfig;
}

export function getIndexingConfigPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), INDEXING_CONFIG_FILE);
}

function fail(configPath: string, message: string): never {
  throw new ConfigError(`${configPath}: ${message}`, { file: configPath });
}

function normalizePattern(configPath: string, field: 'include' | 'exclude', pattern: string): string {
  if (pattern.trim() === '') fail(configPath, `${field} pattern must not be empty`);
  if (pattern.includes('\\')) fail(configPath, `${field} pattern "${pattern}" must use POSIX "/" separators`);
  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || pattern.startsWith('/')) {
    fail(configPath, `${field} pattern "${pattern}" must be project-relative`);
  }
  if (pattern.startsWith('!')) fail(configPath, `${field} pattern "${pattern}" must not use gitignore negation`);
  if (/[{}()[\]?]/.test(pattern)) fail(configPath, `${field} pattern "${pattern}" uses unsupported glob syntax`);
  const normalized = normalizePath(pattern);
  if (normalized.split('/').includes('..')) fail(configPath, `${field} pattern "${pattern}" must not contain ".."`);
  if (field === 'include' && pattern.includes('*') && normalized.split('/').findIndex(s => s.includes('*')) <= 0) {
    fail(configPath, `include pattern "${pattern}" must start with a concrete directory before any wildcard`);
  }
  return normalized;
}

function validatePatternArray(configPath: string, raw: Record<string, unknown>, field: 'include' | 'exclude'): string[] {
  const value = raw[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(configPath, `${field} must be an array of strings`);
  return value.map((entry, idx) => {
    if (typeof entry !== 'string') fail(configPath, `${field}[${idx}] must be a string`);
    return normalizePattern(configPath, field, entry);
  });
}

function includeRootFor(pattern: string): string {
  const segments = pattern.split('/');
  const firstGlobSegment = segments.findIndex(s => s.includes('*'));
  return firstGlobSegment >= 0 ? segments.slice(0, firstGlobSegment).join('/') : pattern.replace(/\/+$/, '');
}

function concreteRelativePath(configPath: string, field: string, value: unknown, index: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(configPath, `${field}[${index}] must be a non-empty path or name`);
  if (value.includes('\\') || path.isAbsolute(value) || path.win32.isAbsolute(value) || /[\0*?{}()[\]!]/.test(value)) {
    fail(configPath, `${field}[${index}] must be a concrete project-relative POSIX path or name`);
  }
  const normalized = normalizePath(value).replace(/\/+$/, '');
  if (!normalized || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    fail(configPath, `${field}[${index}] must not contain empty, "." or ".." path segments`);
  }
  return normalized;
}

function ueEngineConfig(configPath: string, raw: unknown): UeEngineConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(configPath, 'ueEngine must be an object');
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['plugins', 'excludePlugins', 'extraRoots', 'maxDepth']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(configPath, `Unknown ueEngine key "${key}"`);
  const list = (field: 'plugins' | 'excludePlugins' | 'extraRoots'): string[] => {
    const entries = value[field];
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) fail(configPath, `ueEngine.${field} must be an array`);
    return [...new Set(entries.map((entry, index) => concreteRelativePath(configPath, `ueEngine.${field}`, entry, index)))];
  };
  const plugins = list('plugins');
  const excludePlugins = list('excludePlugins');
  const extraRoots = list('extraRoots');
  for (const root of extraRoots) {
    if (!/^(?:Engine|Samples|Templates)\/[^/]+/i.test(root)) fail(configPath, 'ueEngine.extraRoots must name a concrete path inside Engine/, Samples/, or Templates/');
    if (/^Engine\/Plugins(?:\/|$)/i.test(root) || /^Engine\/Platforms(?:\/[^/]+)?(?:\/Plugins(?:\/|$)|$)/i.test(root)) {
      fail(configPath, 'ueEngine.extraRoots must not bypass plugin selection; use ueEngine.plugins instead');
    }
  }
  const maxDepth = value.maxDepth === undefined ? 3 : value.maxDepth;
  if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
    fail(configPath, 'ueEngine.maxDepth must be an integer from 0 to 16');
  }
  return { plugins, excludePlugins, extraRoots, maxDepth };
}

/** Local scope is deliberately strict: a typo must not silently index a different tree. */
export function loadIndexingConfig(projectRoot: string): IndexingConfig {
  const configPath = getIndexingConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { path: configPath, loaded: false, include: [], exclude: [], includeRoots: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(configPath, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(configPath, 'top-level value must be an object');
  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'include' && key !== 'exclude' && key !== 'ueEngine') fail(configPath, `Unknown indexing config key "${key}"; expected include, exclude or ueEngine`);
  }
  const include = validatePatternArray(configPath, raw, 'include');
  const exclude = validatePatternArray(configPath, raw, 'exclude');
  const ueEngine = ueEngineConfig(configPath, raw.ueEngine);
  return { path: configPath, loaded: true, include, exclude, includeRoots: [...new Set(include.map(includeRootFor).filter(Boolean))], ...(ueEngine ? { ueEngine } : {}) };
}

export function getIndexingConfigStatus(projectRoot: string): IndexingConfigStatus {
  try {
    const config = loadIndexingConfig(projectRoot);
    return { path: config.path, loaded: config.loaded, include: config.include, exclude: config.exclude, error: null, ...(config.ueEngine ? { ueEngine: config.ueEngine } : {}) };
  } catch (error) {
    return { path: getIndexingConfigPath(projectRoot), loaded: false, include: [], exclude: [], error: error instanceof Error ? error.message : String(error) };
  }
}
