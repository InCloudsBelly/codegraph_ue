import { existsSync } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { terminateOnceStarted, workerStarted } from '../worker-teardown';

export interface PendingChangeCounts {
  added: number;
  modified: number;
  removed: number;
}

/** `getChangedFiles()` may fall back to a huge filesystem scan (#1959). */
const MEASURE_TIMEOUT_MS = 8_000;
let liveMeasurements = 0;
const active = new Map<string, Promise<PendingChangeCounts | null>>();
export interface CppIncludeFreshness { observed: boolean; complete: boolean; changed: boolean; reason?: string }
const includeActive = new Map<string, Promise<CppIncludeFreshness | null>>();
export function measureCppIncludeEnvironment(root: string, timeoutMs = MEASURE_TIMEOUT_MS): Promise<CppIncludeFreshness | null> {
  const key = path.resolve(root);
  const existing = includeActive.get(key);
  if (existing) return existing;
  if (liveMeasurements >= 2) return Promise.resolve(null);
  const pending = runMeasurement<CppIncludeFreshness>(key, timeoutMs, 'cpp-includes', value => {
    if (!value || typeof value !== 'object' || !['observed', 'complete', 'changed'].every(k => typeof (value as Record<string, unknown>)[k] === 'boolean')) return null;
    return value as CppIncludeFreshness;
  }).finally(() => includeActive.delete(key));
  includeActive.set(key, pending); return pending;
}
/** Every measurement worker not yet terminated, with its load — for {@link endFreshnessMeasurements}. */
const live = new Map<Worker, Promise<void>>();

export function measurePendingChanges(root: string, timeoutMs = MEASURE_TIMEOUT_MS): Promise<PendingChangeCounts | null> {
  const key = path.resolve(root);
  const existing = active.get(key);
  if (existing) return existing;
  // Status probes for many projects must not exhaust the shared daemon.
  if (liveMeasurements >= 2) return Promise.resolve(null);

  const pending = runMeasurement<PendingChangeCounts>(key, timeoutMs, 'changes', value => {
    if (!value || typeof value !== 'object') return null;
    const counts = value as PendingChangeCounts;
    return ['added', 'modified', 'removed'].every(k => Number.isSafeInteger(counts[k as keyof PendingChangeCounts]) && counts[k as keyof PendingChangeCounts] >= 0) ? counts : null;
  }).finally(() => active.delete(key));
  active.set(key, pending);
  return pending;
}

/**
 * Terminate every measurement still running, each once it has loaded its
 * modules (worker-teardown.ts) — for a server that is about to exit, since
 * exiting tears the workers down the same way terminating them does.
 */
export async function endFreshnessMeasurements(): Promise<void> {
  await Promise.all([...live].map(([worker, loaded]) => terminateOnceStarted(worker, loaded)));
}

function runMeasurement<T>(root: string, timeoutMs: number, mode: 'changes' | 'cpp-includes', validate: (value: unknown) => T | null): Promise<T | null> {
  // The compiled sibling is beside us in production; Vitest loads src/ but
  // builds dist/ before the tests, so use that copy for the worker there.
  const sibling = path.join(__dirname, 'index-freshness-worker.js');
  const workerFile = existsSync(sibling)
    ? sibling
    : path.resolve(__dirname, '../../dist/mcp/index-freshness-worker.js');
  if (!existsSync(workerFile)) return Promise.resolve(null);

  let worker: Worker;
  try {
    worker = new Worker(workerFile, { workerData: { root, mode } });
  } catch {
    return Promise.resolve(null);
  }

  // Its first message is 'loaded', posted once its modules are in. Terminating
  // it before then can crash the whole process on Windows (worker-teardown.ts).
  const loaded = workerStarted(worker);
  live.set(worker, loaded);
  liveMeasurements++;
  return new Promise(resolve => {
    let settled = false;
    const finish = (counts: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A worker inside a synchronous Git call may take time to terminate, and
      // one still loading its modules must not be terminated yet. Return
      // unknown on deadline, but keep its concurrency slot until it is gone.
      void terminateOnceStarted(worker, loaded).finally(() => {
        live.delete(worker);
        liveMeasurements--;
      });
      resolve(counts);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.on('message', (msg: { type?: string; counts?: unknown }) => {
      if (msg?.type !== 'counts') return;
      finish(validate(msg.counts));
    });
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}
