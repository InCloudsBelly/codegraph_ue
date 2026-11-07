import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';

/** Keep exact recovery identity and completed-graph compatibility separate. */
export async function ueRuntimeBuildIdentities(runtimeRoot = path.resolve(__dirname, '..'), dependencyRoot?: string):
Promise<{ exact: string; semantics: string }> {
  const packageRoot = path.resolve(runtimeRoot, '..');
  const entries: Array<{ name: string; file: string }> = [];
  const walk = async (base: string, relative: string, prefix: string, source: boolean): Promise<void> => {
    const children = await fs.readdir(path.join(base, relative), { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${child.name}` : child.name;
      if (child.isSymbolicLink()) throw new Error(`UE runtime identity cannot follow a link: ${prefix}/${rel}`);
      if (child.isDirectory()) {
        if (child.name !== 'viewer' && child.name !== 'test' && child.name !== 'tests') await walk(base, rel, prefix, source);
      } else if (child.isFile() && /\.(?:cjs|mjs|js|ts|wasm|node|sql|json)$/i.test(child.name) &&
                 !/^\.test-build-.*\.json$/i.test(child.name) && !/\.d\.ts$/i.test(child.name) &&
                 (source || !child.name.endsWith('.ts'))) {
        entries.push({ name: `${prefix}/${rel}`, file: path.join(base, rel) });
      }
    }
  };
  await walk(runtimeRoot, '', 'runtime', true);
  for (const file of ['package.json', 'package-lock.json']) entries.push({ name: file, file: path.join(packageRoot, file) });
  const dependencyBase = dependencyRoot ?? packageRoot;
  for (const name of ['web-tree-sitter', 'ignore', 'picomatch', 'jsonc-parser']) {
    const entry = require.resolve(name, { paths: [dependencyBase] });
    let dir = path.dirname(entry), found = false;
    for (;;) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
        if (manifest.name === name) { found = true; break; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!found) throw new Error(`Cannot identify UE runtime dependency: ${name}`);
    await walk(dir, '', `dependency/${name}`, false);
  }
  const runtime = `node=${process.version}\0platform=${process.platform}\0arch=${process.arch}\0`;
  const exact = createHash('sha256').update(runtime);
  const semantics = createHash('sha256').update(runtime).update('ue-index-semantics-v1\0');
  // Throughput-only worker counts and timeout limits do not change a
  // successfully completed graph and may vary with available system memory.
  const settings = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_CFNPTR', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_PATH',
    'CODEGRAPH_VALUE_REFS', 'CODEGRAPH_AMBIGUOUS_NAME_CEILING', 'CODEGRAPH_NO_REBIND'];
  for (const setting of settings) {
    const value = `${setting}=${process.env[setting] ?? '<unset>'}\0`;
    exact.update(value);
    semantics.update(value);
  }
  const presentation = /^runtime\/(?:bin\/(?:codegraph|ue-reconcile)|mcp\/(?:server-instructions|tools)|ui\/[^/]+)\.(?:js|ts)$/;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const content = await fs.readFile(entry.file);
    const label = `${entry.name}\0${content.length}\0`;
    exact.update(label).update(content);
    // These entrypoints and presentation modules consume the index or
    // delegate to the SDK. Keep them in the exact publication/recovery identity.
    if (!presentation.test(entry.name)) {
      semantics.update(label).update(content);
    }
  }
  const nativeCandidates: string[] = [];
  if (process.env.CODEGRAPH_KERNEL_PATH) {
    const specified = process.env.CODEGRAPH_KERNEL_PATH;
    // The loader tests the cwd path, then uses require relative to its own file.
    nativeCandidates.push(path.resolve(specified));
    try {
      const loaderRequire = createRequire(path.join(runtimeRoot, 'extraction', 'kernel', 'loader.js'));
      nativeCandidates.push(loaderRequire.resolve(specified));
    } catch { nativeCandidates.push(path.resolve(runtimeRoot, 'extraction', 'kernel', specified)); }
  }
  nativeCandidates.push(path.join(packageRoot, 'kernel', 'codegraph-kernel.node'));
  nativeCandidates.push(path.join(packageRoot, 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));
  for (const [index, file] of nativeCandidates.entries()) {
    try {
      const content = await fs.readFile(file);
      const label = `native/${index}\0${content.length}\0`;
      exact.update(label).update(content);
      semantics.update(label).update(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const missing = `native/${index}\0missing\0`;
      exact.update(missing);
      semantics.update(missing);
    }
  }
  return { exact: exact.digest('hex'), semantics: semantics.digest('hex') };
}

/** Bind an unfinished UE generation to the actual running extraction build. */
export async function ueRuntimeBuildIdentity(runtimeRoot?: string, dependencyRoot?: string): Promise<string> {
  return (await ueRuntimeBuildIdentities(runtimeRoot, dependencyRoot)).exact;
}
