/**
 * CJS support check. Builds the forward graph of a small all-CommonJS fixture (edges are all
 * `require()`) with each parser, and reports how many of the 4 real edges each recovers. Shows that
 * ESM-only parsers (es-module-lexer, oxc's module record) recover ~none, while require-aware parsers
 * (oxc + AST walk, TypeScript preProcessFile, madge/precinct) recover the full graph.
 */
import fs from 'node:fs';
import path from 'node:path';

import { init, parse as lexParse } from 'es-module-lexer';
import { transform } from 'esbuild';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';
import ts from 'typescript';
import madge from 'madge';

const DIR = path.join(import.meta.dirname, 'fixtures/cjs');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(DIR, f));
const resolver = new ResolverFactory({ extensions: ['.js', '.ts', '.json'] });
const resolve = (spec: string, importerAbs: string) => {
  try { return resolver.sync(path.dirname(importerAbs), spec).path ?? null; } catch { return null; }
};
const rel = (abs: string) => path.relative(DIR, abs);

await init;
type Parser = { name: string; parse: (abs: string, code: string) => Promise<string[]> | string[] };

const requireWalk = (node: any, out: string[]) => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee?.name === 'require') {
    const a = node.arguments?.[0];
    if (a && a.type === 'Literal' && typeof a.value === 'string') out.push(a.value);
  }
  for (const k of Object.keys(node)) {
    const v = (node as any)[k];
    if (Array.isArray(v)) v.forEach((c) => requireWalk(c, out));
    else if (v && typeof v === 'object') requireWalk(v, out);
  }
};

const parsers: Parser[] = [
  {
    name: 'es-module-lexer (+strip)',
    parse: async (_a, code) => {
      const js = (await transform(code, { loader: 'js', format: 'esm' })).code;
      try { return lexParse(js)[0].map((i) => i.n).filter(Boolean) as string[]; } catch { return []; }
    },
  },
  {
    name: 'oxc module record (import only)',
    parse: (a, code) => {
      const r = parseSync(a, code);
      return r.module.staticImports.map((i) => i.moduleRequest.value);
    },
  },
  {
    name: 'oxc + AST require() walk',
    parse: (a, code) => {
      const r = parseSync(a, code);
      const out = r.module.staticImports.map((i) => i.moduleRequest.value);
      requireWalk(r.program, out);
      return out;
    },
  },
  {
    name: 'typescript preProcessFile',
    parse: (_a, code) => ts.preProcessFile(code, true, true).importedFiles.map((f) => f.fileName),
  },
  {
    // The unified parser a mixed TS+CJS repo needs: esbuild-strip (type-only elision for TS) THEN
    // oxc import + AST require() walk (covers ESM import, dynamic import, and CJS require).
    name: 'esbuild-strip + oxc(import + require)',
    parse: async (a, code) => {
      const ext = path.extname(a);
      const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : ext === '.ts' || ext === '.mts' ? 'ts' : 'js';
      let js = code;
      try { js = (await transform(code, { loader, format: 'esm' })).code; } catch {}
      const r = parseSync(a, js);
      const out = r.module.staticImports.map((i) => i.moduleRequest.value);
      requireWalk(r.program, out);
      return out;
    },
  },
];

function edgesOf(specsByFile: Map<string, string[]>): Set<string> {
  const edges = new Set<string>();
  for (const abs of files) {
    for (const spec of specsByFile.get(abs) ?? []) {
      const t = resolve(spec, abs);
      if (t) edges.add(`${rel(abs)} -> ${rel(t)}`);
    }
  }
  return edges;
}

const EXPECTED = 4;
const results: Record<string, number> = {};
for (const p of parsers) {
  const specsByFile = new Map<string, string[]>();
  for (const abs of files) specsByFile.set(abs, await p.parse(abs, fs.readFileSync(abs, 'utf8')));
  results[p.name] = edgesOf(specsByFile).size;
}

// madge (uses precinct/detective-cjs under the hood)
const mres = await madge([path.join(DIR, 'button.stories.js')], { baseDir: DIR, fileExtensions: ['js'] });
let madgeEdges = 0;
for (const deps of Object.values(mres.obj())) madgeEdges += (deps as string[]).length;
results['madge (precinct/detective-cjs)'] = madgeEdges;

console.log(`CJS fixture — real require() edges: ${EXPECTED}\n`);
for (const [name, n] of Object.entries(results)) {
  console.log(`  ${n}/${EXPECTED}\t${(n / EXPECTED * 100).toFixed(0)}%\t${name}`);
}
fs.writeFileSync(
  path.join(import.meta.dirname, 'results/cjs-fixture.json'),
  JSON.stringify({ expectedEdges: EXPECTED, edgesRecovered: results }, null, 2)
);
