/**
 * Approach A2: es-module-lexer + oxc-resolver. The lexer is JS-only, so TS/JSX must be type-stripped
 * first (esbuild transform) — exactly what Vite does internally. Measures the "ultra-fast lexer"
 * path while exposing its hidden dependency on a transform step.
 */
import path from 'node:path';
import { init, parse } from 'es-module-lexer';
import { transform } from 'esbuild';
import { ResolverFactory } from 'oxc-resolver';

import { REPO_ROOT, SOURCE_EXTS, type ParseFn, type ResolveFn } from '../lib/common.mts';

export const name = 'es-module-lexer (+esbuild strip) + oxc-resolver';
export const notes = ['lexer is JS-only → needs esbuild type-strip first', 'misses type-only imports after strip (correct for runtime)'];

export async function prepare(): Promise<{ parse: ParseFn; resolve: ResolveFn }> {
  await init;
  const resolver = new ResolverFactory({
    extensions: SOURCE_EXTS,
    tsconfig: { configFile: path.join(REPO_ROOT, 'tsconfig.json'), references: 'auto' },
  });
  const parse_: ParseFn = async (absPath, code) => {
    const ext = path.extname(absPath);
    let js = code;
    if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') {
      const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'ts';
      js = (await transform(code, { loader, format: 'esm' })).code;
    }
    const [imports] = parse(js);
    return imports.map((i) => i.n).filter((n): n is string => Boolean(n) && !n!.includes('${'));
  };
  const resolve: ResolveFn = (spec, importerAbs) => resolver.sync(path.dirname(importerAbs), spec).path ?? null;
  return { parse: parse_, resolve };
}
