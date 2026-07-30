#!/usr/bin/env node
// cost-phases.mjs — what building the TurboSnap v2 manifest costs, broken down by phase.
//
// Usage:
//   node cost-phases.mjs --project <storybook project root> --stats <preview-stats.json>
//                        [--git-root <dir>] [--config-dir .storybook] [--static-dir a,b]
//                        [--runs 5] [--concurrency-sweep] [--json <out.json>]
//
// Reports, per phase: wall clock over N runs (min / median / max / spread) and the peak RSS observed
// while that phase ran. Also reports the size of the workload — file counts and total bytes — so the
// numbers can be re-derived on other hardware.
//
// Phases are timed by calling the same units `buildManifest` calls, in the same order, against the same
// inputs. `buildManifest` is then timed as a whole, and the assembly/roll-up cost is what is left over
// after the measured phases are subtracted. See the note in cost-lib.mjs about source vs. dist.
// That subtraction needs enough samples to be meaningful — use `--runs 10` or more, or the derived rows
// can come out negative because one phase's median caught an outlier.
//
// Every run after the first is warm-page-cache. `purge` needs root, so cold-cache numbers came from a
// detach/reattach of a disk image instead; see manifest-cost.md.

import { existsSync, statSync } from 'fs';
import path from 'path';
import { writeFileSync } from 'fs';

import { formatBytes, loadSource, measure, parseFlags, stats } from './cost-lib.mjs';

const flags = parseFlags(process.argv.slice(2));
if (!flags.project || !flags.stats) {
  console.error('usage: node cost-phases.mjs --project <dir> --stats <preview-stats.json> [...]');
  process.exit(1);
}

const projectRoot = path.resolve(flags.project);
const roots = { projectRoot, gitRoot: path.resolve(flags['git-root'] ?? projectRoot) };
const configDir = flags['config-dir'] ?? '.storybook';
const staticDirs = flags['static-dir'] ? String(flags['static-dir']).split(',') : [];
const runs = Number(flags.runs ?? 5);
const statsPath = path.resolve(flags.stats);

const source = await loadSource();

try {
  const report = await run();
  print(report);
  if (flags.json) writeFileSync(String(flags.json), JSON.stringify(report, undefined, 2));
} finally {
  await source.close();
}

/**
 * Runs every phase `runs` times and collects the timings.
 *
 * @returns The report object.
 */
async function run() {
  const statsRead = [];
  const graphDiscovery = [];
  const graphHash = [];
  const configHash = [];
  const outOfGraph = [];
  const total = [];
  const peaks = {};

  let workload;
  let manifestShape;

  for (let index = 0; index < runs; index += 1) {
    const read = await measure(() => source.readStatsFile(statsPath));
    statsRead.push(read.ms);
    record(peaks, 'statsRead', read);
    const statsFile = read.result;

    const discovery = await measure(() => Promise.resolve(discoverGraphFiles(statsFile)));
    graphDiscovery.push(discovery.ms);
    record(peaks, 'graphDiscovery', discovery);
    const absolutePaths = discovery.result;

    const hashed = await measure(() => source.getFileHashes(absolutePaths, '', 10));
    graphHash.push(hashed.ms);
    record(peaks, 'graphHash', hashed);

    const config = await measure(() =>
      source.hashOutOfGraphFiles({ configDir, staticDirs: [] }, roots)
    );
    configHash.push(config.ms);
    record(peaks, 'configHash', config);

    const both = await measure(() => source.hashOutOfGraphFiles({ configDir, staticDirs }, roots));
    outOfGraph.push(both.ms);
    record(peaks, 'outOfGraph', both);

    const built = await measure(() =>
      source.buildManifest(statsFile, roots, { configDir, staticDirs })
    );
    total.push(built.ms);
    record(peaks, 'buildManifest', built);

    if (index === 0) {
      workload = describeWorkload(absolutePaths, both.result);
      const manifest = built.result;
      manifestShape = {
        files: manifest.files.size,
        storyFiles: manifest.storyFileHashes.size,
        storybookFiles: manifest.storybookFiles.size,
        attribution: {
          storyReachable: manifest.attribution.storyReachable.size,
          previewSubtree: manifest.attribution.previewSubtree.size,
          storybookGlobals: manifest.attribution.storybookGlobals.size,
        },
      };
    }
  }

  const phases = {
    statsRead: stats(statsRead),
    graphDiscovery: stats(graphDiscovery),
    graphHash: stats(graphHash),
    configHash: stats(configHash),
    outOfGraph: stats(outOfGraph),
    buildManifest: stats(total),
  };
  // The static-dir phase is not separately callable, so take it as the difference between hashing the
  // config dir alone and hashing both sections.
  phases.staticHashDerived = { median: phases.outOfGraph.median - phases.configHash.median };
  phases.assemblyDerived = {
    median:
      phases.buildManifest.median -
      phases.graphDiscovery.median -
      phases.graphHash.median -
      phases.outOfGraph.median,
  };

  const concurrency = flags['concurrency-sweep']
    ? await sweepConcurrency(discoverGraphFiles(await source.readStatsFile(statsPath)))
    : undefined;

  return {
    input: { projectRoot, gitRoot: roots.gitRoot, statsPath, configDir, staticDirs, runs },
    node: process.version,
    workload,
    manifestShape,
    phases,
    rssGrowth: peaks,
    concurrency,
  };
}

/**
 * Keeps the largest RSS growth seen for a phase across runs. Growth rather than absolute RSS, because
 * this harness carries a Vite server the production binary does not.
 *
 * @param peaks The accumulator, mutated in place.
 * @param name The phase name.
 * @param measurement The measurement returned by {@link measure}.
 */
function record(peaks, name, measurement) {
  peaks[name] = Math.max(peaks[name] ?? 0, measurement.peakRss - measurement.startRss);
}

/**
 * Replicates `hashFiles`' path collection: every module name and importer name in the stats file that
 * resolves to a file that exists on disk. This is the set the graph-hashing phase reads.
 *
 * @param statsFile The parsed stats file.
 *
 * @returns The absolute paths that will be hashed.
 */
function discoverGraphFiles(statsFile) {
  const rawPaths = new Set();
  for (const module of statsFile.modules) {
    const names = module.modules?.length
      ? module.modules.map((m) => m.nameForCondition ?? m.name)
      : [module.nameForCondition ?? module.name];
    for (const name of names.filter(Boolean)) rawPaths.add(name);
    for (const reason of module.reasons ?? []) {
      if (reason.moduleName) rawPaths.add(reason.moduleName);
    }
  }

  const absolutePaths = new Set();
  for (const rawPath of rawPaths) {
    if (rawPath.includes('virtual:')) continue;
    const absolutePath = source.paths.resolveStatsPath(rawPath, projectRoot);
    if (existsSync(absolutePath)) absolutePaths.add(absolutePath);
  }
  return [...absolutePaths];
}

/**
 * Sizes the workload so the timings can be normalised per file and per byte.
 *
 * @param graphPaths The absolute graph file paths.
 * @param outOfGraphFiles The out-of-graph hash result.
 *
 * @returns Counts and byte totals per section.
 */
function describeWorkload(graphPaths, outOfGraphFiles) {
  const size = (paths) => {
    let bytes = 0;
    let largest = 0;
    for (const filePath of paths) {
      try {
        const { size: fileSize } = statSync(filePath);
        bytes += fileSize;
        largest = Math.max(largest, fileSize);
      } catch {
        // A file that vanished between discovery and sizing contributes nothing.
      }
    }
    return { count: paths.length, bytes, largest };
  };

  const configPaths = [...outOfGraphFiles.storybookConfigFiles.keys()].map((p) =>
    path.resolve(roots.gitRoot, p)
  );
  const staticPaths = [...outOfGraphFiles.staticFiles.keys()].map((p) =>
    path.resolve(roots.gitRoot, p)
  );

  return {
    graph: size(graphPaths),
    config: size(configPaths),
    static: size(staticPaths),
    nodeModulesInGraph: graphPaths.filter((p) => p.includes(`${path.sep}node_modules${path.sep}`))
      .length,
    statsFileBytes: statSync(statsPath).size,
  };
}

/**
 * Times `getFileHashes` at several concurrency levels over the real graph, to show where the shipped
 * value of 10 sits on the curve. For the *memory* side of the same question use cost-scale.mjs, which
 * runs each level in a fresh process — RSS is a high-water mark, so in-process levels contaminate
 * each other.
 *
 * @param absolutePaths The files to hash.
 *
 * @returns Time and peak RSS per concurrency level.
 */
async function sweepConcurrency(absolutePaths) {
  const results = [];
  for (const concurrency of [1, 5, 10, 25, 50, 100, 250, 1000]) {
    // Two passes: the first warms the cache for this level, the second is the sample.
    await source.getFileHashes(absolutePaths, '', concurrency);
    const run = await measure(() => source.getFileHashes(absolutePaths, '', concurrency));
    results.push({
      concurrency,
      ms: run.ms,
      rssGrowth: run.peakRss - run.startRss,
      bufferBytes: concurrency * 64 * 1024,
    });
  }
  return results;
}

/**
 * Prints the report as fixed-width tables.
 *
 * @param report The report object.
 */
function print(report) {
  const ms = (value) => `${value.toFixed(1)}`;
  console.log(`\nproject:  ${report.input.projectRoot}`);
  console.log(
    `stats:    ${report.input.statsPath} (${formatBytes(report.workload.statsFileBytes)})`
  );
  console.log(
    `config:   ${report.input.configDir}   static: ${report.input.staticDirs.join(',') || '(none)'}`
  );
  console.log(`node:     ${report.node}   runs: ${report.input.runs}`);

  const w = report.workload;
  console.log(`\nworkload`);
  console.log(
    `  graph files   ${w.graph.count} (${formatBytes(w.graph.bytes)}, largest ${formatBytes(w.graph.largest)}, ${w.nodeModulesInGraph} in node_modules)`
  );
  console.log(`  config files  ${w.config.count} (${formatBytes(w.config.bytes)})`);
  console.log(
    `  static files  ${w.static.count} (${formatBytes(w.static.bytes)}, largest ${formatBytes(w.static.largest)})`
  );
  console.log(
    `  manifest      ${report.manifestShape.files} files, ${report.manifestShape.storyFiles} stories, ${report.manifestShape.storybookFiles} storybookFiles entries`
  );

  console.log(`\nphase                     min     median   max      spread   RSS growth`);
  for (const [name, phase] of Object.entries(report.phases)) {
    if (phase.min === undefined) {
      console.log(`  ${name.padEnd(22)}         ${ms(phase.median).padStart(8)}   (derived)`);
      continue;
    }
    const growth = report.rssGrowth[name];
    const peak = growth === undefined ? '' : `+${formatBytes(growth)}`;
    console.log(
      `  ${name.padEnd(22)}${ms(phase.min).padStart(7)}${ms(phase.median).padStart(9)}${ms(phase.max).padStart(9)}${`${phase.spreadPct.toFixed(0)}%`.padStart(9)}   ${peak}`
    );
  }

  if (report.concurrency) {
    console.log(`\nconcurrency sweep over ${w.graph.count} graph files`);
    console.log(`  limit    ms   RSS growth   concurrency x 64KiB`);
    for (const row of report.concurrency) {
      console.log(
        `  ${String(row.concurrency).padStart(5)}${ms(row.ms).padStart(8)}   +${formatBytes(row.rssGrowth).padStart(9)}   ${formatBytes(row.bufferBytes)}`
      );
    }
  }
  console.log();
}
