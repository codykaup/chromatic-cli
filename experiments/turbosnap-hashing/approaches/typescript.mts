/**
 * Approach D: TypeScript compiler API. `ts.preProcessFile` for imports + `ts.resolveModuleName`
 * (with a resolution cache) using the project tsconfig — the machinery tsc and TS-aware tools use.
 */
import path from 'node:path';
import ts from 'typescript';

import { REPO_ROOT, type ParseFn, type ResolveFn } from '../lib/common.mts';
import { TSCONFIG } from '../lib/config.mts';

export const name = 'typescript (preProcessFile + resolveModuleName)';
export const notes = ['highest-fidelity TS resolution', 'pure JS dependency (no native binding)', 'resolves type-only imports too'];

export async function prepare(): Promise<{ parse: ParseFn; resolve: ResolveFn }> {
  const configFile = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT);
  const options = parsed.options;
  const host = ts.createCompilerHost(options);
  const cache = ts.createModuleResolutionCache(REPO_ROOT, (x) => x, options);
  const parse: ParseFn = (_abs, code) => ts.preProcessFile(code, true, true).importedFiles.map((f) => f.fileName);
  const resolve: ResolveFn = (spec, importerAbs) =>
    ts.resolveModuleName(spec, importerAbs, options, host, cache).resolvedModule?.resolvedFileName ?? null;
  return { parse, resolve };
}
