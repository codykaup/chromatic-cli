#!/usr/bin/env node
// cost-profile.mjs — where inside buildManifest the time actually goes.
//
// cost-phases.mjs attributes time to phases; this attributes it to functions. It samples the V8 CPU
// profiler around N `buildManifest` runs and aggregates self time by function name. Because it runs the
// TypeScript source through Vite (see cost-lib.mjs) rather than the minified bundle, the names in the
// output are the real ones.
//
// Usage:
//   node cost-profile.mjs --project <dir> --stats <preview-stats.json>
//                         [--git-root <dir>] [--config-dir .storybook] [--static-dir a,b]
//                         [--runs 5] [--top 25]
//
// Read the output as clusters, not single rows: path work (`resolve`, `normalizeString`, `relative`,
// `posix`, `resolveStatsPath`, `normalizeStatsPath`), roll-up work (`rollUpFileHashes`,
// `rollUpEntryHashes`, `collectTransitiveDependencies`) and I/O (`open`, `read`, `close`,
// `createUnsafeBuffer`, `wasm-*`).

import { Session } from 'inspector/promises';
import path from 'path';

import { loadSource, parseFlags, readStatsFile } from './cost-lib.mjs';

const flags = parseFlags(process.argv.slice(2));
if (!flags.project || !flags.stats) {
  console.error('usage: node cost-profile.mjs --project <dir> --stats <preview-stats.json> [...]');
  process.exit(1);
}

const projectRoot = path.resolve(flags.project);
const roots = { projectRoot, gitRoot: path.resolve(flags['git-root'] ?? projectRoot) };
const outOfGraph = {
  configDir: flags['config-dir'] ?? '.storybook',
  staticDirs: flags['static-dir'] ? String(flags['static-dir']).split(',') : [],
};
const runs = Number(flags.runs ?? 5);
const top = Number(flags.top ?? 25);

const source = await loadSource();

try {
  const stats = await readStatsFile(path.resolve(String(flags.stats)));
  // One warm run first, so JIT compilation of the manifest code isn't attributed to the algorithm.
  await source.buildManifest(stats, roots, outOfGraph);

  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 100 });
  await session.post('Profiler.start');
  for (let index = 0; index < runs; index += 1) {
    await source.buildManifest(stats, roots, outOfGraph);
  }
  const { profile } = await session.post('Profiler.stop');
  session.disconnect();

  const selfHits = new Map();
  for (const node of profile.nodes) {
    const name = node.callFrame.functionName || '(anonymous)';
    const where = node.callFrame.url.replace(/^.*chromatic-cli\//, '').replace(/^node:/, 'node:');
    const key = `${name}  ${where}`;
    selfHits.set(key, (selfHits.get(key) ?? 0) + (node.hitCount ?? 0));
  }

  const totalHits = [...selfHits.values()].reduce((a, b) => a + b, 0);
  console.log(`\nproject: ${projectRoot}`);
  console.log(`total samples ${totalHits} over ${runs} buildManifest runs\n`);
  for (const [name, hits] of [...selfHits].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(
      `${((hits / totalHits) * 100).toFixed(1).padStart(6)}%  ${String(hits).padStart(6)}  ${name}`
    );
  }
  console.log();
} finally {
  await source.close();
}
