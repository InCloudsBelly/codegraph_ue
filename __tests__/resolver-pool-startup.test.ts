import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  attempts: 0,
  failConstructAt: 0,
  failOpenAt: 0,
  workers: [] as Array<{ messages: Array<{ type: string }>; emit: (event: string, ...args: unknown[]) => boolean }>,
}));

vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      readonly index: number;
      readonly messages: Array<{ type: string }> = [];
      constructor() {
        super();
        this.index = ++control.attempts;
        if (this.index === control.failConstructAt) throw new Error('injected worker construction failure');
        control.workers.push(this);
      }
      postMessage(message: { type: string }): void {
        this.messages.push(message);
        if (message.type === 'open' && this.index === control.failOpenAt) throw new Error('injected worker open failure');
        if (message.type === 'close') queueMicrotask(() => this.emit('exit', 0));
      }
      async terminate(): Promise<number> { this.emit('exit', 0); return 0; }
    },
  };
});

import { ResolverPool } from '../src/resolution/resolver-pool';
const TestPool = ResolverPool as unknown as new (script: string, db: string, root: string, size: number) => ResolverPool;

describe('resolver pool startup failures', () => {
  beforeEach(() => {
    control.attempts = 0;
    control.failConstructAt = 0;
    control.failOpenAt = 0;
    control.workers.length = 0;
  });

  it.each(['constructor', 'open'] as const)('retains and closes already-created workers when %s fails', async failure => {
    if (failure === 'constructor') control.failConstructAt = 2;
    else control.failOpenAt = 1;
    const pool = new TestPool('unused-worker.js', 'unused.db', '.', 2);
    await expect(pool.ready()).rejects.toThrow('injected worker');
    await pool.destroy(20);
    expect(control.workers).toHaveLength(1);
    expect(control.workers[0]!.messages.map(message => message.type)).toEqual(['open', 'close']);
  });

  it.each(['unexpected exit', 'close'] as const)('rejects a pending task on worker %s', async cause => {
    const pool = new TestPool('unused-worker.js', 'unused.db', '.', 1);
    const worker = control.workers[0]!;
    worker.emit('message', { type: 'ready' });
    await pool.ready();
    const pending = pool.runSynthPass('unrealDelegates');
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (cause === 'unexpected exit') worker.emit('exit', 0);
      else await pool.destroy(20);
      const result = await Promise.race([outcome, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 250))]);
      expect(result).toBe('rejected');
    } finally {
      await pool.abort(new Error('fixture cleanup'));
      await outcome;
    }
  });
});
