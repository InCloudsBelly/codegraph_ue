import { describe, expect, it } from 'vitest';
import { isUeTestOnlyFile, ueTestOnlyLines } from '../src/extraction/ue-test-scope';

describe('UE confirmed test branches', () => {
  it('excludes only the test side of positive and negative guards', () => {
    const source = [
      'void Before();',
      '#if WITH_DEV_AUTOMATION_TESTS',
      'void TestOnly();',
      '#else',
      'void ProductionElse();',
      '#endif',
      '#if !WITH_AUTOMATION_TESTS',
      'void ProductionIf();',
      '#else',
      'void TestElse();',
      '#endif',
    ].join('\n');
    expect([...ueTestOnlyLines(source)]).toEqual([3, 10]);
    expect(isUeTestOnlyFile(source)).toBe(false);
  });

  it('retains mixed platform conditions and code in comments or raw strings', () => {
    const source = [
      'const char* text = R"data(',
      '#if WITH_DEV_AUTOMATION_TESTS',
      'not a directive',
      '#endif',
      ')data";',
      '#if WITH_DEV_AUTOMATION_TESTS || PLATFORM_WINDOWS',
      'void MayBeProduction();',
      '#endif',
      '#if WITH_DEV_AUTOMATION_TESTS && PLATFORM_WINDOWS',
      'void TestOnWindows();',
      '#endif',
    ].join('\n');
    expect([...ueTestOnlyLines(source)]).toEqual([10]);
  });

  it('recognizes a file containing only guarded tests without hiding real Tests directories', () => {
    expect(isUeTestOnlyFile('#if WITH_DEV_AUTOMATION_TESTS\nvoid TestOnly() {}\n#endif\n')).toBe(true);
    expect(isUeTestOnlyFile('#include "Core.h"\n#if WITH_DEV_AUTOMATION_TESTS\nvoid TestOnly() {}\n#endif\n')).toBe(false);
    expect(isUeTestOnlyFile('class UEnvQueryTest_Distance {};\n')).toBe(false);
  });

  it('does not treat a defined-but-zero UE test macro as absent', () => {
    const source = '#ifdef WITH_DEV_AUTOMATION_TESTS\nvoid Production();\n#endif\n';
    expect([...ueTestOnlyLines(source)]).toEqual([]);
    expect(isUeTestOnlyFile(source)).toBe(false);
    expect([...ueTestOnlyLines('#if defined(WITH_DEV_AUTOMATION_TESTS)\nvoid AlsoProduction();\n#endif\n')]).toEqual([]);
  });

  it('excludes confirmed test branches with CRLF while retaining production lines', () => {
    const mixed = [
      'void ProductionBefore();',
      '#if WITH_DEV_AUTOMATION_TESTS',
      'void AutomationOnly();',
      '#else',
      'void ProductionElse();',
      '#endif',
    ].join('\r\n');
    expect([...ueTestOnlyLines(mixed)]).toEqual([3]);
    expect(isUeTestOnlyFile(mixed)).toBe(false);
    expect(isUeTestOnlyFile('#if WITH_DEV_AUTOMATION_TESTS\r\nvoid TestOnly() {}\r\n#endif\r\n')).toBe(true);
  });
});
