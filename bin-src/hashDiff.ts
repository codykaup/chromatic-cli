import { readFile } from 'fs/promises';
import meow from 'meow';

import { createLogger } from '../node-src/lib/log';
import { diffManifests, HashManifest } from '../node-src/lib/turbosnap/hashManifest';

/**
 * TurboSnap 2.0 (Hash Based TS) — PoC command: `chromatic hash-diff`.
 *
 * Compares a baseline hash manifest against the current build's manifest and prints exactly which
 * stories must be recaptured. This proves the core hypothesis of the pitch: given two manifests,
 * change detection is a pure hash comparison — no git, no lockfiles, no baseline checkout.
 *
 * Command:
 *   chromatic hash-diff <baseline.json> <current.json> [--json]
 *
 * Usage example:
 *   npx chromatic hash-diff ./baseline-hashes.json ./chromatic-hashes.json
 *
 * Exit code is 0 when nothing needs recapture, 1 when there are changes (handy for CI).
 */

/**
 * The main entrypoint for `chromatic hash-diff`.
 *
 * @param argv A list of arguments passed.
 *
 * @returns The computed diff, or undefined on error.
 */
export async function main(argv: string[]) {
  const { flags, input } = meow(
    `
    Usage
      $ chromatic hash-diff <baseline.json> <current.json> [--json]

    Arguments
      <baseline.json>   Hash manifest from a previous build.
      <current.json>    Hash manifest from the current build.

    Options
      --json            Print the raw diff as JSON instead of a human-readable summary.
    `,
    {
      argv,
      description: 'Diff two TurboSnap 2.0 hash manifests to find stories needing recapture',
      flags: {
        json: {
          type: 'boolean',
          default: false,
        },
      },
    }
  );

  const log = createLogger({}, { logPrefix: '', logLevel: 'info' });

  const [baselinePath, currentPath] = input;
  if (!baselinePath || !currentPath) {
    log.error('Usage: chromatic hash-diff <baseline.json> <current.json>');
    process.exitCode = 1;
    return undefined;
  }

  try {
    const [baseline, current] = (await Promise.all([
      readFile(baselinePath, 'utf8').then((c) => JSON.parse(c)),
      readFile(currentPath, 'utf8').then((c) => JSON.parse(c)),
    ])) as [HashManifest, HashManifest];

    const diff = diffManifests(baseline, current);

    if (flags.json) {
      console.log(JSON.stringify(diff, undefined, 2));
    } else {
      printSummary(log, diff);
    }

    process.exitCode = diff.recapture.length > 0 ? 1 : 0;
    return diff;
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return undefined;
  }
}

function printSummary(
  log: ReturnType<typeof createLogger>,
  diff: ReturnType<typeof diffManifests>
) {
  if (diff.incompatible) {
    log.warn('Manifests are incompatible (schema/algorithm mismatch) — recapturing everything.');
  }

  if (diff.globalChanged) {
    log.warn('Global (Storybook config) section changed — every story will be recaptured.');
  }

  log.info('');
  log.info(`TurboSnap 2.0 hash diff:`);
  log.info(`  Changed stories: ${diff.changed.length}`);
  log.info(`  Added stories:   ${diff.added.length}`);
  log.info(`  Removed stories: ${diff.removed.length}`);
  log.info(`  → Recapture:     ${diff.recapture.length}`);
  log.info('');

  for (const { storyFile, changedFiles } of diff.changed) {
    log.info(`  ✎ ${storyFile}`);
    for (const { file, from, to } of changedFiles) {
      let label: string;
      if (from === undefined) label = 'added';
      else if (to === undefined) label = 'removed';
      else label = `${from} → ${to}`;
      log.info(`      ∟ ${file} (${label})`);
    }
  }
  for (const storyFile of diff.added) log.info(`  + ${storyFile} (new)`);
  for (const storyFile of diff.removed) log.info(`  - ${storyFile} (removed)`);

  if (diff.recapture.length === 0) {
    log.info('  Nothing to recapture — all story hashes match the baseline. ✨');
  }
}
