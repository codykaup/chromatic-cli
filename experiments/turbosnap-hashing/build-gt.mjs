import { build } from 'esbuild';
import path from 'node:path';
const stub = path.resolve('experiments/turbosnap-hashing/lib/findChangedDependencies.stub.ts');
await build({
  entryPoints: ['experiments/turbosnap-hashing/lib/groundtruth.mts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" },
  outfile: 'experiments/turbosnap-hashing/.gt-bundle.mjs',
  external: ['fsevents'],
  plugins: [{
    name: 'stub-fcd',
    setup(b) {
      b.onResolve({ filter: /findChangedDependencies(\.js)?$/ }, () => ({ path: stub }));
    },
  }],
  logLevel: 'error',
});
console.log('bundled OK');
