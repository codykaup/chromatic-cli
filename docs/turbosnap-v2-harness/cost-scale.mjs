#!/usr/bin/env node
// cost-scale.mjs — how the manifest's cost scales, and where it stops being linear.
//
// Real Storybooks only give two or three points on the curve, and they move both axes at once (more
// stories *and* more modules). This builds synthetic projects — real files on disk plus a real
// preview-stats.json — so one axis can be moved at a time, and runs the same `buildManifest` against
// them. It also probes the three cases that could degrade non-linearly: a very wide static directory, a
// single very large file, and a large number of byte-identical files (node_modules duplication).
//
// Usage:
//   node cost-scale.mjs [--stories 100,500,1000,2000,4000] [--modules 100,500,1000,2000]
//                       [--static 100,1000,10000,50000] [--huge-file-mib 512]
//                       [--skip-huge] [--json <out.json>]
//
// Synthetic graph shape: each story imports one hub module, and the hub imports every shared module.
// So a story's subtree is `modules + 2` files, which is how a real Storybook looks — every story
// reaches the same framework and renderer base.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';

import { formatBytes, loadSource, measure, parseFlags, stats } from './cost-lib.mjs';

const flags = parseFlags(process.argv.slice(2));

// Child mode: hash one directory at one concurrency and exit, so the parent can read this process's
// maximum resident set size from `/usr/bin/time -l`. Pass `--hash-child none` for the baseline, which
// measures what the harness itself costs before any file is hashed.
if (flags['hash-child']) {
  const child = await loadSource();
  const directory = String(flags['hash-child']);
  const paths =
    directory === 'none' ? [] : readdirSync(directory).map((name) => path.join(directory, name));
  const start = performance.now();
  await child.getFileHashes(paths, '', Number(flags.concurrency ?? 10));
  console.log(`hashMs=${(performance.now() - start).toFixed(1)}`);
  await child.close();
  process.exit(0);
}

const list = (name, fallback) =>
  String(flags[name] ?? fallback)
    .split(',')
    .map(Number);

const storyCounts = list('stories', '100,500,1000,2000,4000');
const moduleCounts = list('modules', '100,500,1000,2000');
const staticCounts = list('static', '100,1000,10000,50000');
const hugeFileMib = Number(flags['huge-file-mib'] ?? 512);

const source = await loadSource();
const workDirectory = mkdtempSync(path.join(tmpdir(), 'ts-v2-cost-'));

try {
  const report = {
    node: process.version,
    storiesSweep: await sweepStories(),
    modulesSweep: await sweepModules(),
    staticSweep: await sweepStaticDirectory(),
    identicalFiles: await probeIdenticalFiles(),
    hugeFile: flags['skip-huge'] ? undefined : await probeHugeFile(),
    concurrency: await sweepConcurrency(),
  };
  print(report);
  if (flags.json) writeFileSync(String(flags.json), JSON.stringify(report, undefined, 2));
} finally {
  await source.close();
  rmSync(workDirectory, { recursive: true, force: true });
}

/**
 * Times `buildManifest` against a synthetic project, three times, and returns the median.
 *
 * @param storyCount How many story files.
 * @param moduleCount How many shared modules every story reaches through the hub.
 *
 * @returns The timing row.
 */
async function timeSynthetic(storyCount, moduleCount) {
  const { projectRoot, statsFile } = writeSyntheticProject(storyCount, moduleCount);
  const roots = { projectRoot, gitRoot: projectRoot };
  const outOfGraph = { configDir: '.storybook', staticDirs: [] };

  const samples = [];
  let rssGrowth = 0;
  let manifestShape;
  for (let index = 0; index < 3; index += 1) {
    const built = await measure(() => source.buildManifest(statsFile, roots, outOfGraph));
    samples.push(built.ms);
    rssGrowth = Math.max(rssGrowth, built.peakRss - built.startRss);
    manifestShape = {
      files: built.result.files.size,
      storyFiles: built.result.storyFileHashes.size,
    };
  }

  return {
    stories: storyCount,
    modules: moduleCount,
    graphFiles: storyCount + moduleCount + 1,
    // Every story's subtree is the hub plus every shared module, so this is the number of node visits
    // and hash-string appends the story-hash loop performs.
    subtreeVisits: storyCount * (moduleCount + 2),
    ...stats(samples),
    rssGrowth,
    manifestShape,
  };
}

/**
 * Sweeps the story count with the module count fixed.
 *
 * @returns One row per story count.
 */
async function sweepStories() {
  const rows = [];
  for (const storyCount of storyCounts) rows.push(await timeSynthetic(storyCount, 500));
  return rows;
}

/**
 * Sweeps the shared-module count with the story count fixed.
 *
 * @returns One row per module count.
 */
async function sweepModules() {
  const rows = [];
  for (const moduleCount of moduleCounts) rows.push(await timeSynthetic(500, moduleCount));
  return rows;
}

/**
 * Measures the deliberately uncapped static-directory walk: how long listing and hashing N files under
 * a `staticDir` takes, and how much memory it costs.
 *
 * @returns One row per static file count.
 */
async function sweepStaticDirectory() {
  const rows = [];
  for (const count of staticCounts) {
    const projectRoot = path.join(workDirectory, `static-${count}`);
    const staticDirectory = path.join(projectRoot, 'static');
    mkdirSync(path.join(projectRoot, '.storybook'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.storybook/main.ts'), 'export default {};\n');
    // Fan out over subdirectories so the walk has real recursion rather than one enormous readdir.
    for (let index = 0; index < count; index += 1) {
      const directory = path.join(staticDirectory, String(Math.floor(index / 200)));
      if (index % 200 === 0) mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `asset-${index}.svg`), `<svg id="${index}"/>\n`);
    }

    const roots = { projectRoot, gitRoot: projectRoot };
    const input = { configDir: '.storybook', staticDirs: ['static'] };
    await source.hashOutOfGraphFiles(input, roots);
    const samples = [];
    let rssGrowth = 0;
    for (let index = 0; index < 3; index += 1) {
      const run = await measure(() => source.hashOutOfGraphFiles(input, roots));
      samples.push(run.ms);
      rssGrowth = Math.max(rssGrowth, run.peakRss - run.startRss);
    }
    rows.push({ count, ...stats(samples), rssGrowth });
    rmSync(projectRoot, { recursive: true, force: true });
  }
  return rows;
}

/**
 * The node_modules-duplication case: hashing many byte-identical files. Nothing dedupes by content, so
 * this checks the cost really is linear in file count and that identical hashes don't degrade the
 * roll-up's sort.
 *
 * @returns One row per file count.
 */
async function probeIdenticalFiles() {
  const rows = [];
  for (const count of [1000, 10_000, 50_000]) {
    const directory = path.join(workDirectory, `dupes-${count}`);
    mkdirSync(directory, { recursive: true });
    const paths = [];
    for (let index = 0; index < count; index += 1) {
      const filePath = path.join(directory, `copy-${index}.js`);
      writeFileSync(filePath, 'module.exports = 1;\n');
      paths.push(filePath);
    }
    await source.getFileHashes(paths, '', 10);
    const run = await measure(() => source.getFileHashes(paths, '', 10));
    rows.push({ count, ms: run.ms, rssGrowth: run.peakRss - run.startRss });
    rmSync(directory, { recursive: true, force: true });
  }
  return rows;
}

/**
 * The very-large-single-file case. `hashFile` reads in 64 KiB chunks and hashes incrementally, so this
 * should be linear in bytes with flat memory — the probe is here to prove it, since a single huge asset
 * under a `staticDir` is the realistic worst case for the uncapped walk.
 *
 * @returns The timing and memory for one large file.
 */
async function probeHugeFile() {
  const filePath = path.join(workDirectory, 'huge.bin');
  const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
  const handle = [];
  for (let written = 0; written < hugeFileMib; written += 8) handle.push(chunk);
  writeFileSync(filePath, Buffer.concat(handle));

  await source.getFileHashes([filePath], '', 10);
  const run = await measure(() => source.getFileHashes([filePath], '', 10));
  rmSync(filePath, { force: true });
  return {
    mib: hugeFileMib,
    ms: run.ms,
    rssGrowth: run.peakRss - run.startRss,
    mibPerSecond: hugeFileMib / (run.ms / 1000),
  };
}

/**
 * Whether peak memory is set by `concurrency` × the 64 KiB read buffer allocated inside the pLimit
 * callback. Hashes the same 20 000 files at each level.
 *
 * Each level runs in a **fresh child process** under `/usr/bin/time -l`. In-process sampling can't
 * answer this: RSS is a high-water mark, so a later level inherits whatever an earlier one already
 * grew the heap to and reports zero growth.
 *
 * @returns One row per concurrency level.
 */
async function sweepConcurrency() {
  const directory = path.join(workDirectory, 'concurrency');
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 20_000; index += 1) {
    writeFileSync(path.join(directory, `file-${index}.js`), `export const n = ${index};\n`);
  }

  const rows = [{ concurrency: 0, bufferBytes: 0, ...runHashChild('none', 10) }];
  for (const concurrency of [1, 5, 10, 25, 50, 100, 250, 1000]) {
    rows.push({
      concurrency,
      bufferBytes: concurrency * 64 * 1024,
      ...runHashChild(directory, concurrency),
    });
  }
  rmSync(directory, { recursive: true, force: true });
  return rows;
}

/**
 * Runs one `getFileHashes` pass over a directory in a child process, timed and RSS-measured from the
 * outside.
 *
 * @param directory The directory whose files to hash.
 * @param concurrency The pLimit concurrency to pass through.
 *
 * @returns The child's wall clock in ms and its maximum resident set size in bytes.
 */
function runHashChild(directory, concurrency) {
  const child = spawnSync(
    '/usr/bin/time',
    [
      '-l',
      process.execPath,
      import.meta.filename,
      '--hash-child',
      directory,
      '--concurrency',
      String(concurrency),
    ],
    { encoding: 'utf8' }
  );
  const timing = child.stderr;
  const ms = Number(/^\s*([\d.]+) real/m.exec(timing)?.[1] ?? 0) * 1000;
  const maxRss = Number(/(\d+)\s+maximum resident set size/.exec(timing)?.[1] ?? 0);
  const innerMs = Number(/^hashMs=([\d.]+)$/m.exec(child.stdout)?.[1] ?? 0);
  return { ms, innerMs, maxRss };
}

/**
 * Writes a synthetic Storybook project and its stats file to disk.
 *
 * @param storyCount How many story files.
 * @param moduleCount How many shared modules.
 *
 * @returns The project root and the parsed stats object.
 */
function writeSyntheticProject(storyCount, moduleCount) {
  const projectRoot = path.join(workDirectory, `graph-${storyCount}x${moduleCount}`);
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(path.join(projectRoot, '.storybook'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'src/base'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'src/stories'), { recursive: true });
  writeFileSync(path.join(projectRoot, '.storybook/main.ts'), 'export default {};\n');
  writeFileSync(path.join(projectRoot, '.storybook/preview.ts'), 'export const parameters = {};\n');
  writeFileSync(path.join(projectRoot, 'src/hub.ts'), 'export const hub = 1;\n');
  // resolveStorybookVersion refuses to build a manifest without a resolvable core package.
  mkdirSync(path.join(projectRoot, 'node_modules/storybook'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'node_modules/storybook/package.json'),
    JSON.stringify({ name: 'storybook', version: '10.3.5' })
  );

  const modules = [
    {
      name: 'virtual:@storybook/builder-vite/storybook-stories.js',
      reasons: [{ moduleName: './iframe.html' }],
    },
  ];

  const storyNames = [];
  for (let index = 0; index < storyCount; index += 1) {
    const name = `./src/stories/Story${index}.stories.tsx`;
    writeFileSync(
      path.join(projectRoot, `src/stories/Story${index}.stories.tsx`),
      `import { hub } from '../hub';\nexport default { title: 'S${index}' };\nexport const Basic = { hub };\n`
    );
    storyNames.push(name);
    modules.push({
      name,
      reasons: [{ moduleName: 'virtual:@storybook/builder-vite/storybook-stories.js' }],
    });
  }

  modules.push({ name: './src/hub.ts', reasons: storyNames.map((name) => ({ moduleName: name })) });

  for (let index = 0; index < moduleCount; index += 1) {
    writeFileSync(
      path.join(projectRoot, `src/base/mod${index}.ts`),
      `export const m = ${index};\n`
    );
    modules.push({
      name: `./src/base/mod${index}.ts`,
      reasons: [{ moduleName: './src/hub.ts' }],
    });
  }

  return { projectRoot, statsFile: { modules } };
}

/**
 * Prints the report as fixed-width tables.
 *
 * @param report The report object.
 */
function print(report) {
  const ms = (value) => value.toFixed(1).padStart(9);

  console.log(`\nnode ${report.node}\n`);
  const graphTable = (title, rows) => {
    console.log(`${title}`);
    console.log(
      `  stories  modules  graph files  subtree visits   median ms      max ms   RSS growth`
    );
    for (const row of rows) {
      console.log(
        `  ${String(row.stories).padStart(7)}${String(row.modules).padStart(9)}${String(row.graphFiles).padStart(13)}${String(row.subtreeVisits).padStart(16)}${ms(row.median)}${ms(row.max)}   +${formatBytes(row.rssGrowth)}`
      );
    }
    console.log();
  };
  graphTable('buildManifest, story count swept (500 shared modules)', report.storiesSweep);
  graphTable('buildManifest, shared-module count swept (500 stories)', report.modulesSweep);

  console.log(`staticDir walk + hash (uncapped by design)`);
  console.log(`  files    median ms      max ms   RSS growth   us/file`);
  for (const row of report.staticSweep) {
    console.log(
      `  ${String(row.count).padStart(7)}${ms(row.median)}${ms(row.max)}   +${formatBytes(row.rssGrowth).padStart(9)}   ${((row.median * 1000) / row.count).toFixed(1)}`
    );
  }

  console.log(`\nbyte-identical files (node_modules duplication)`);
  console.log(`  files          ms   RSS growth   us/file`);
  for (const row of report.identicalFiles) {
    console.log(
      `  ${String(row.count).padStart(7)}${ms(row.ms)}   +${formatBytes(row.rssGrowth).padStart(9)}   ${((row.ms * 1000) / row.count).toFixed(1)}`
    );
  }

  if (report.hugeFile) {
    const huge = report.hugeFile;
    console.log(
      `\nsingle ${huge.mib} MiB file: ${huge.ms.toFixed(0)} ms (${huge.mibPerSecond.toFixed(0)} MiB/s), RSS growth +${formatBytes(huge.rssGrowth)}`
    );
  }

  console.log(`\nconcurrency sweep over 20 000 small files (fresh child process per level;`);
  console.log(`limit 0 is the harness baseline with no files hashed)`);
  console.log(`  limit    hash ms   child max RSS   over baseline   concurrency x 64KiB`);
  const baselineRss = report.concurrency[0].maxRss;
  for (const row of report.concurrency) {
    console.log(
      `  ${String(row.concurrency).padStart(5)}${ms(row.innerMs)}   ${formatBytes(row.maxRss).padStart(13)}   ${`+${formatBytes(row.maxRss - baselineRss)}`.padStart(13)}   ${formatBytes(row.bufferBytes)}`
    );
  }
  console.log();
}
