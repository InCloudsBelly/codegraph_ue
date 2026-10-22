import { describe, expect, it } from 'vitest';
import { getNodeVersionBlock } from '../src/bin/node-version-check';

describe('UE fork Node runtime compatibility', () => {
  it.each(['20.0.0', '22.18.0', '24.16.0', '26.0.0', '27.0.0'])(
    'allows %s without the unsafe override',
    (version) => expect(getNodeVersionBlock(version)).toBeNull(),
  );

  it.each(['25.0.0', '25.9.0'])(
    'continues to block the affected Node %s runtime',
    (version) => expect(getNodeVersionBlock(version)).toBe('node25-wasm-oom'),
  );

  it('preserves the supported runtime floor', () => {
    expect(getNodeVersionBlock('18.20.0')).toBe('too-old');
  });
});
