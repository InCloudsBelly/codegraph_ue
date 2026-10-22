import { cppMacroInvocations } from './cpp-macro-methods';

export const UNREAL_ANNOTATIONS: ReadonlySet<string> = new Set(['UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION']);
export function unrealMacroNames(source: string): Set<string> {
  const names = new Set(UNREAL_ANNOTATIONS);
  for (const m of source.matchAll(/\bDECLARE_(?:[A-Z_]*DELEGATE\w*|EVENT\w*)\b/g)) names.add(m[0]);
  return names;
}
export function mayHaveUnrealReflection(source: string): boolean {
  return /\b(?:UCLASS|USTRUCT|UENUM|UPROPERTY|UFUNCTION|DECLARE_[A-Z_]*DELEGATE\w*|DECLARE_EVENT\w*)\s*\(/.test(source);
}
/** Confirm code tokens so examples in comments/raw strings and #defines don't change header language. */
export function hasUnrealCppDeclaration(source: string): boolean {
  return mayHaveUnrealReflection(source) && cppMacroInvocations(source, unrealMacroNames(source)).length > 0;
}
