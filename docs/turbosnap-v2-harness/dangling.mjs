#!/usr/bin/env node
// dangling.mjs <stats.json> <project-root> [manifest.json] [--strip <out-stats.json>]
// Lists every `reasons` entry whose named parent is not itself a module in the stats. `ensureFile`
// (manifest.ts) creates a graph node for such a parent, so it becomes a *parentless root*: a file in
// the graph that nothing imports.
//
// Pass a manifest to see where each invented root landed. Pass `--strip <out>` to also write a copy
// of the stats with every dangling reason deleted — regenerate a manifest from that with
// `gen.sh <pkg> <out.json> <stripped-stats.json>` and diff it against the real one to measure what
// dropping them would cost, without touching the fixture or rebuilding Storybook.
//
// Two classes come out of this, and only one has any consequence:
//   - the parent is a real file on disk → it is hashed, and lands in `<storybookGlobals>` (it cannot
//     reach a story or preview subtree, because by definition nothing imports it). This is the
//     unpatched-builder-vite CJS-proxy edge loss; a patched builder produces none.
//   - the parent has no file on disk (a webpack loader-request name, an external) → `hash: ''`, and
//     `pruneSyntheticFiles` drops it, so it never reaches the written manifest at all.
//
// Normalization comes from the CLI's own `paths.ts` through the Vite SSR server in cost-lib.mjs,
// NOT from a copy. This matters: `normalizeStatsPath` strips the ` + N modules` concatenation
// suffix, so comparing raw stats names instead counts every webpack concatenated-module root as
// parentless. That artifact once produced a false "webpack invents 7 parentless roots, including two
// story files and preview.ts" — the real count on webpack is 0. See README → Measurement traps.
import { existsSync, readFileSync, writeFileSync } from 'fs';

import { loadSource, readStatsFile } from './cost-lib.mjs';

const ATTRIBUTION_SETS = ['storyReachable', 'previewSubtree', 'storybookGlobals'];

const positional = [];
let stripTo;
for (const argument of process.argv.slice(2)) {
  if (stripTo === true) stripTo = argument;
  else if (argument === '--strip') stripTo = true;
  else positional.push(argument);
}
const [statsFile, projectRoot, manifestFile] = positional;

if (!statsFile || !projectRoot || stripTo === true) {
  console.error(
    'usage: node dangling.mjs <stats.json> <project-root> [manifest.json] [--strip <out-stats.json>]'
  );
  process.exit(2);
}

const source = await loadSource();
const { normalizeStatsPath, resolveStatsPath } = source.paths;

const stats = await readStatsFile(statsFile);

/**
 * The real files a stats module represents, root first — the same reading `moduleFileNames` performs
 * in manifest.ts. This is the one piece of that module's logic reimplemented here, because it is not
 * exported; keep it in step with manifest.ts.
 *
 * @param module The stats module to read file names from.
 *
 * @returns The module's raw file names, with unusable ones dropped.
 */
function moduleFileNames(module) {
  const names = module.modules?.length
    ? module.modules.map((m) => m.nameForCondition ?? m.name)
    : [module.nameForCondition ?? module.name];
  return names.filter(Boolean);
}

const normalize = (name) => normalizeStatsPath(name, projectRoot);

// Every canonical path the stats declares as a module, including concatenated members.
const moduleNames = new Set();
for (const module of stats.modules) {
  for (const name of moduleFileNames(module)) moduleNames.add(normalize(name));
}

// Reason parents that are never a module themselves, and the children they claim to import.
const dangling = new Map();
let danglingEntries = 0;
for (const module of stats.modules) {
  const [sourceFilePath] = moduleFileNames(module).map(normalize);
  if (!sourceFilePath) continue;
  for (const reason of module.reasons ?? []) {
    if (!reason.moduleName) continue;
    const parent = normalize(reason.moduleName);
    if (moduleNames.has(parent)) continue;
    danglingEntries++;
    if (!dangling.has(parent)) dangling.set(parent, new Set());
    dangling.get(parent).add(sourceFilePath);
  }
}

const manifest = manifestFile ? JSON.parse(readFileSync(manifestFile, 'utf8')) : undefined;

/**
 * Where an invented root ended up in the manifest.
 *
 * @param filePath The canonical path of the invented root.
 *
 * @returns A human-readable list of the homes it landed in.
 */
function homesOf(filePath) {
  if (!manifest) return 'unknown (no manifest given)';
  const homes = ATTRIBUTION_SETS.filter((set) => manifest.attribution[set].includes(filePath));
  if (manifest.storyFiles[filePath] !== undefined) homes.unshift('storyFiles KEY');
  if (homes.length === 0) return 'ABSENT from manifest (pruned)';
  return homes.join(' + ');
}

const onDisk = [...dangling.keys()].filter((p) => existsSync(resolveStatsPath(p, projectRoot)));

console.log(`stats:   ${statsFile}`);
console.log(`modules: ${stats.modules.length}`);
console.log(
  `dangling reason parents: ${dangling.size} (${danglingEntries} entries) — ` +
    `${onDisk.length} real file(s), ${dangling.size - onDisk.length} with no file on disk`
);

for (const [parent, children] of [...dangling].sort()) {
  const real = existsSync(resolveStatsPath(parent, projectRoot));
  console.log(`\n${parent}`);
  console.log(`  real file: ${real}`);
  console.log(`  attribution: ${homesOf(parent)}`);
  console.log(`  invented edges to: ${[...children].sort().join(', ')}`);
}

if (stripTo) {
  for (const module of stats.modules) {
    if (!module.reasons) continue;
    module.reasons = module.reasons.filter(
      (reason) => !reason.moduleName || moduleNames.has(normalize(reason.moduleName))
    );
  }
  writeFileSync(stripTo, JSON.stringify(stats));
  console.log(`\nwrote stats without ${danglingEntries} dangling reason entries to ${stripTo}`);
}

await source.close();
