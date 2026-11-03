import { describe, expect, it } from 'vitest';
import { ueConditionsAtLine } from '../src/extraction/ue-conditions';

describe('UE source conditions', () => {
  it('reports nested branches without assuming a platform or build configuration', () => {
    const source = [
      '#if PLATFORM_WINDOWS',
      '#ifdef WITH_RENDERING',
      'void WindowsRenderer();',
      '#else',
      'void WindowsNoRenderer();',
      '#endif',
      '#elif PLATFORM_LINUX',
      'void Linux();',
      '#else',
      'void Other();',
      '#endif',
      'void Common();',
    ].join('\n');
    expect(ueConditionsAtLine(source, 3)).toEqual(['PLATFORM_WINDOWS', 'defined(WITH_RENDERING)']);
    expect(ueConditionsAtLine(source, 5)).toEqual(['PLATFORM_WINDOWS', '!(defined(WITH_RENDERING))']);
    expect(ueConditionsAtLine(source, 8)).toEqual(['!(PLATFORM_WINDOWS) && (PLATFORM_LINUX)']);
    expect(ueConditionsAtLine(source, 10)).toEqual(['!(PLATFORM_WINDOWS || PLATFORM_LINUX)']);
    expect(ueConditionsAtLine(source, 12)).toEqual([]);
  });

  it('does not treat apparent directives in raw strings or comments as conditions', () => {
    const source = ['const char* text = R"x(', '#if PLATFORM_WINDOWS', ')x";', '// #if PLATFORM_LINUX', 'void Common();'].join('\n');
    expect(ueConditionsAtLine(source, 5)).toEqual([]);
  });
});
