// Shared plumbing for the manifest cost harness (cost-phases.mjs, cost-scale.mjs).
//
// The phase timings load the TurboSnap v2 modules straight from TypeScript source through a Vite SSR
// server, because `dist/bin.cjs` is bundled and minified so its internals aren't addressable. The
// algorithm is the same one `dist` ships; `cost-e2e.sh` measures the real compiled binary end to end
// so the two totals can be compared. Always run `yarn build` before `cost-e2e.sh`.

import { createReadStream } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { createServer } from 'vite';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Loads the TurboSnap v2 source modules needed by the cost harness.
 *
 * @returns The loaded modules and a `close` function to shut the Vite server down.
 */
export async function loadSource() {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    resolve: { alias: { '@cli': path.join(REPO_ROOT, 'node-src/lib') } },
  });

  const load = (file) => server.ssrLoadModule(file);
  const [manifest, outOfGraphFiles, getFileHashes, paths] = await Promise.all([
    load('/node-src/lib/turbosnap/v2/manifest.ts'),
    load('/node-src/lib/turbosnap/v2/outOfGraphFiles.ts'),
    load('/node-src/lib/getFileHashes.ts'),
    load('/node-src/lib/turbosnap/v2/paths.ts'),
  ]);

  return {
    buildManifest: manifest.buildManifest,
    hashOutOfGraphFiles: outOfGraphFiles.hashOutOfGraphFiles,
    getFileHashes: getFileHashes.getFileHashes,
    readStatsFile,
    paths,
    close: () => server.close(),
  };
}

/**
 * The same streaming JSON parse `node-src/tasks/readStatsFile.ts` performs. Loaded through
 * `createRequire` rather than the Vite server because json-ext is CJS and Vite's SSR interop can't
 * expose `parseChunked` as a named binding either externalized or inlined.
 *
 * @param filePath The stats file to read.
 *
 * @returns The parsed stats.
 */
export async function readStatsFile(filePath) {
  const { parseChunked } = createRequire(import.meta.url)('@discoveryjs/json-ext');
  return parseChunked(createReadStream(filePath));
}

/**
 * Times an async function while sampling resident set size, so a phase's peak memory is attributed to
 * that phase rather than to the process as a whole.
 *
 * @param fn The function to run.
 * @param sampleIntervalMs How often to sample RSS.
 *
 * @returns The function's result, its wall-clock duration in ms, the RSS at entry and the peak RSS seen
 * in bytes. The absolute figures include this harness's own Vite server, so `peakRss - startRss` is the
 * number to read; `cost-e2e.sh` gives the absolute peak for the production binary.
 */
export async function measure(fn, sampleIntervalMs = 5) {
  const startRss = process.memoryUsage.rss();
  let peakRss = startRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, sampleIntervalMs);

  const start = performance.now();
  try {
    const result = await fn();
    return { result, ms: performance.now() - start, startRss, peakRss };
  } finally {
    clearInterval(sampler);
  }
}

/**
 * Summary statistics over repeated samples. Variance matters more than the mean here: the operation is
 * I/O bound, so a single sample says as much about page-cache state as about the algorithm.
 *
 * @param values The samples.
 *
 * @returns min, median, max, mean and the spread as a percentage of the median.
 */
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    n: sorted.length,
    min: sorted[0],
    median,
    max: sorted.at(-1),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    spreadPct: median === 0 ? 0 : ((sorted.at(-1) - sorted[0]) / median) * 100,
  };
}

/**
 * Formats a byte count for the report tables.
 *
 * @param bytes The byte count.
 *
 * @returns A human-readable size.
 */
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

/**
 * Minimal `--flag value` parser, so the harness has no dependencies of its own.
 *
 * @param argv The arguments to parse.
 *
 * @returns The flags as a plain object.
 */
export function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}
