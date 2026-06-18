/**
 * The unified, no-branching option: esbuild's own `metafile`. esbuild natively understands ESM +
 * CJS + TS + JSX, resolves with the real resolver, elides TS types, and reports each edge's kind —
 * all in one uniform pass (write:false, so nothing is emitted). With bundle:true it also follows
 * into node_modules, so it covers CJS internals and the #6/#7 dependency boundary too.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.join(import.meta.dirname, 'fixtures');

async function graph(entry: string, root: string) {
  const r = await build({
    entryPoints: [entry],
    bundle: true, metafile: true, write: false,
    logLevel: 'silent', platform: 'neutral', format: 'esm',
  });
  const edges: string[] = [];
  for (const [file, info] of Object.entries(r.metafile.inputs))
    for (const imp of info.imports)
      edges.push(`${path.relative(root, file)} -[${imp.kind}]-> ${path.relative(root, imp.path)}`);
  return edges;
}

const cjs = await graph(path.join(FIX, 'cjs/button.stories.js'), path.join(FIX, 'cjs'));
const mixed = await graph(path.join(FIX, 'mixed/entry.ts'), path.join(FIX, 'mixed'));

const out = {
  cjsFixture: { expectedEdges: 4, edges: cjs, recovered: cjs.length },
  mixedFile: {
    edges: mixed,
    elidesTypeOnly: !mixed.some((e) => e.includes('types')),
    seesEsmImport: mixed.some((e) => e.includes('import-statement') && e.includes('esmDep')),
    seesCjsRequire: mixed.some((e) => e.includes('require-call') && e.includes('cjsDep')),
  },
};
fs.writeFileSync(path.join(import.meta.dirname, 'results/esbuild-meta.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
