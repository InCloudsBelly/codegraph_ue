import { loadIndexingConfig } from '../indexing-config';
import { loadExtensionOverrides } from '../project-config';
import type { Language } from '../types';

/** Add UE's C++ header spelling without changing another project's defaults. */
export function loadUeAwareExtensionOverrides(rootDir: string): Record<string, Language> {
  const configured = loadExtensionOverrides(rootDir);
  return loadIndexingConfig(rootDir).ueEngine ? { '.hh': 'cpp', ...configured } : configured;
}
