/**
 * The unified per-file parser for mixed TS+CJS: esbuild type-strip (drops type-only imports the same
 * way the builder does) → oxc parse of the stripped output for `import` + dynamic `import()` + CJS
 * `require()` (AST walk), with oxc-resolver. Covers ESM + CJS AND keeps the type elision that avoids
 * the TS over-capture — without branching on module system.
 */
import path from 'node:path';
import { transform } from 'esbuild';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';

import { type ParseFn, type ResolveFn } from '../lib/common.mts';
import { collectRequires } from '../lib/astRequire.mts';
import { CONDITIONS, SOURCE_EXTS, TSCONFIG } from '../lib/config.mts';

export const name = 'esbuild-strip + oxc(import+require)';
export const notes = ['unified ESM+CJS', 'type elision via esbuild strip', 'require-aware via AST'];

export async function prepare(): Promise<{ parse: ParseFn; resolve: ResolveFn }> {
  const resolver = new ResolverFactory({
    extensions: SOURCE_EXTS,
    conditionNames: CONDITIONS.length ? [...CONDITIONS, 'import', 'require', 'default'] : undefined,
    tsconfig: { configFile: TSCONFIG, references: 'auto' },
  });
  const parse: ParseFn = async (absPath, code) => {
    const ext = path.extname(absPath);
    const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : ext === '.ts' || ext === '.mts' || ext === '.cts' ? 'ts' : 'js';
    let js = code;
    try { js = (await transform(code, { loader, format: 'esm' })).code; } catch { /* keep raw */ }
    const r = parseSync(absPath, js);
    const out: string[] = [];
    for (const i of r.module.staticImports) out.push(i.moduleRequest.value);
    for (const i of r.module.dynamicImports) {
      const lit = js.slice(i.moduleRequest.start, i.moduleRequest.end).replace(/^['"`]|['"`]$/g, '');
      if (lit && !lit.includes('${')) out.push(lit);
    }
    collectRequires(r.program, out);
    return out;
  };
  const resolve: ResolveFn = (spec, importerAbs) => resolver.sync(path.dirname(importerAbs), spec).path ?? null;
  return { parse, resolve };
}
