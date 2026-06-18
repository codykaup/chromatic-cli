/** Approach A: oxc-parser (imports) + oxc-resolver (resolution). Rust toolchain, TS/JSX-native. */
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';

import { type ParseFn, type ResolveFn } from '../lib/common.mts';
import { CONDITIONS, SOURCE_EXTS, TSCONFIG } from '../lib/config.mts';

export const name = 'oxc-parser + oxc-resolver';
export const notes = ['Rust parser+resolver', 'TS/JSX native', 'native binding (prebuilt per-platform)', 'drops type-only imports (isType) to match runtime graph'];

export function oxcImports(absPath: string, code: string): string[] {
  const r = parseSync(absPath, code);
  const out: string[] = [];
  for (const i of r.module.staticImports) {
    // Skip type-only imports (`import type ...`): erased at runtime, not real module edges.
    // Side-effect imports (`import './x.css'`) have no entries — keep them.
    if (i.entries.length > 0 && i.entries.every((e) => e.isType)) continue;
    out.push(i.moduleRequest.value);
  }
  for (const i of r.module.dynamicImports) {
    const lit = code.slice(i.moduleRequest.start, i.moduleRequest.end).replace(/^['"`]|['"`]$/g, '');
    if (lit && !lit.includes('${')) out.push(lit);
  }
  return out;
}

export async function prepare(): Promise<{ parse: ParseFn; resolve: ResolveFn }> {
  const resolver = new ResolverFactory({
    extensions: SOURCE_EXTS,
    conditionNames: CONDITIONS.length ? [...CONDITIONS, 'import', 'require', 'default'] : undefined,
    tsconfig: { configFile: TSCONFIG, references: 'auto' },
  });
  const resolve: ResolveFn = (spec, importerAbs) => resolver.sync(path.dirname(importerAbs), spec).path ?? null;
  return { parse: oxcImports, resolve };
}
