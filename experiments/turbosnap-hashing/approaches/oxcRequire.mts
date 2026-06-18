/**
 * oxc-parser covering ESM `import` + dynamic `import()` + CJS `require()` (AST walk), with
 * oxc-resolver. Require-aware (CJS-capable), but purely syntactic — no usage-based type elision, so
 * it inherits the TS over-capture on type-only-used value imports.
 */
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';

import { type ParseFn, type ResolveFn } from '../lib/common.mts';
import { collectRequires } from '../lib/astRequire.mts';
import { CONDITIONS, SOURCE_EXTS, TSCONFIG } from '../lib/config.mts';

export const name = 'oxc + require() (import+require+dyn)';
export const notes = ['require-aware → CommonJS supported', 'syntactic (no usage-based type elision)'];

export function parseImports(absPath: string, code: string): string[] {
  const r = parseSync(absPath, code);
  const out: string[] = [];
  for (const i of r.module.staticImports) {
    if (i.entries.length > 0 && i.entries.every((e) => e.isType)) continue; // drop `import type`
    out.push(i.moduleRequest.value);
  }
  for (const i of r.module.dynamicImports) {
    const lit = code.slice(i.moduleRequest.start, i.moduleRequest.end).replace(/^['"`]|['"`]$/g, '');
    if (lit && !lit.includes('${')) out.push(lit);
  }
  collectRequires(r.program, out);
  return out;
}

export async function prepare(): Promise<{ parse: ParseFn; resolve: ResolveFn }> {
  const resolver = new ResolverFactory({
    extensions: SOURCE_EXTS,
    conditionNames: CONDITIONS.length ? [...CONDITIONS, 'import', 'require', 'default'] : undefined,
    tsconfig: { configFile: TSCONFIG, references: 'auto' },
  });
  const resolve: ResolveFn = (spec, importerAbs) => resolver.sync(path.dirname(importerAbs), spec).path ?? null;
  return { parse: parseImports, resolve };
}
