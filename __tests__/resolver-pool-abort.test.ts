import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ResolverPool } from '../src/resolution/resolver-pool';

describe('resolver pool cancellation', () => {
  it('rejects pending synthesis before a clean worker exit and shuts down once', async () => {
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: (message: unknown) => void;
      terminate: () => Promise<number>;
    };
    worker.postMessage = vi.fn(() => queueMicrotask(() => worker.emit('exit', 0)));
    worker.terminate = vi.fn(async () => 0);
    let rejectWaiter!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectWaiter = reject; });
    const pool = Object.create(ResolverPool.prototype) as ResolverPool;
    Object.assign(pool, {
      workers: [{ worker, started: Promise.resolve(), ready: Promise.resolve(), rejectReady: () => undefined, busy: 1 }],
      waiters: new Map(), synthWaiters: new Map([[1, { resolve: () => undefined, reject: rejectWaiter }]]),
      recycleWaiters: new Map(), failed: null, destroyPromise: null,
    });
    const rejected = expect(pending).rejects.toThrow('cancel synthesis');
    const cancelled = pool.abort(new Error('cancel synthesis'));
    const closedAgain = pool.destroy();
    await Promise.all([rejected, cancelled, closedAgain]);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('settles waiters and terminates a worker that never acknowledges close', async () => {
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: (message: unknown) => void;
      terminate: () => Promise<number>;
    };
    worker.postMessage = vi.fn();
    worker.terminate = vi.fn(async () => 0);
    let rejectWaiter!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectWaiter = reject; });
    const pool = Object.create(ResolverPool.prototype) as ResolverPool;
    Object.assign(pool, {
      workers: [{ worker, started: Promise.resolve(), ready: Promise.resolve(), rejectReady: () => undefined, busy: 1 }],
      waiters: new Map(), synthWaiters: new Map([[1, { resolve: () => undefined, reject: rejectWaiter }]]),
      recycleWaiters: new Map(), failed: null, destroyPromise: null,
    });
    const rejected = expect(pending).rejects.toThrow('worker stalled');
    const closed = pool.destroy(10);
    const cancelled = pool.abort(new Error('worker stalled'));
    await Promise.all([rejected, closed, cancelled]);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('unblocks synthesis waiting for a worker that exits before becoming ready', async () => {
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: (message: unknown) => void;
      terminate: () => Promise<number>;
    };
    worker.postMessage = vi.fn(() => queueMicrotask(() => worker.emit('exit', 0)));
    worker.terminate = vi.fn(async () => 0);
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
    const pool = Object.create(ResolverPool.prototype) as ResolverPool;
    Object.assign(pool, {
      workers: [{ worker, started: Promise.resolve(), ready, rejectReady, busy: 0 }],
      waiters: new Map(), synthWaiters: new Map(), recycleWaiters: new Map(), failed: null, destroyPromise: null,
    });
    const pending = pool.runSynthPass('unrealDelegates');
    const settled = pending.then(() => true, () => true);
    try {
      await pool.abort(new Error('startup cancelled'));
      const completed = await Promise.race([settled, new Promise<false>(resolve => setTimeout(() => resolve(false), 3000))]);
      expect(completed).toBe(true);
      await expect(pending).rejects.toThrow('startup cancelled');
    } finally {
      rejectReady(new Error('fixture cleanup'));
      await settled;
    }
  }, 10_000);
});
