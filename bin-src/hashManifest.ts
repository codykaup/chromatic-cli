import { outputFile } from 'fs-extra';
import meow from 'meow';

import { getRepositoryRoot } from '../node-src/git/git';
import { createLogger } from '../node-src/lib/log';
import { buildHashManifest } from '../node-src/lib/turbosnap/hashManifest';
import { readStatsFile } from '../node-src/tasks/readStatsFile';

/**
 * TurboSnap 2.0 (Hash Based TS) — PoC command: `chromatic hash-manifest`.
 *
 * Reads a builder `preview-stats.json`, traces the dependency graph for every story file, hashes
 * each dependency on disk, and writes a self-contained hash manifest to JSON. Comparing two of
 * these manifests (see `chromatic hash-diff`) tells you exactly which stories changed — without a
 * git diff, lockfile parsing, or a baseline checkout.
 *
 * Command:
 *   chromatic hash-manifest [-s|--stats-file] [-o|--output] [-b|--base-dir] [-c|--config-dir]
 *                           [-d|--static-dir] [-u|--untraced]
 *
 * Usage example:
 *   npx chromatic hash-manifest -s ./storybook-static/preview-stats.json -o ./hashes.json
 *
 * Generate a preview-stats.json with (Storybook >= 6.3):
 *   npx storybook build --webpack-stats-json
 */

const { STORYBOOK_BASE_DIR, STORYBOOK_CONFIG_DIR, WEBPACK_STATS_FILE } = process.env;

/**
 * The main entrypoint for `chromatic hash-manifest`.
 *
 * @param argv A list of arguments passed.
 *
 * @returns The path to the written manifest, or undefined on error.
 */
export async function main(argv: string[]) {
  const { flags } = meow(
    `
    Usage
      $ chromatic hash-manifest [-s|--stats-file] [-o|--output] [-b|--base-dir] [-c|--config-dir] [-d|--static-dir] [-u|--untraced]

    Options
      --stats-file, -s <filepath>           Path to preview-stats.json. Alternatively, set WEBPACK_STATS_FILE. (default: 'storybook-static/preview-stats.json')
      --output, -o <filepath>               Where to write the hash manifest JSON. (default: 'chromatic-hashes.json')
      --storybook-base-dir, -b <dirname>    Relative path from repository root to Storybook project root. Alternatively, set STORYBOOK_BASE_DIR. (default: '.')
      --storybook-config-dir, -c <dirname>  Directory where Storybook configuration is loaded from. Alternatively, set STORYBOOK_CONFIG_DIR. (default: '.storybook')
      --static-dir, -d <dirname>            Directory of static files treated as global dependencies. Can be specified multiple times.
      --untraced, -u <filepath>             Disregard these files and their dependencies. Globs supported via picomatch. Can be specified multiple times.
    `,
    {
      argv,
      description: 'Generate a hash manifest for TurboSnap 2.0 (Hash Based TS)',
      flags: {
        statsFile: {
          type: 'string',
          alias: 's',
          default: WEBPACK_STATS_FILE || 'storybook-static/preview-stats.json',
        },
        output: {
          type: 'string',
          alias: 'o',
          default: 'chromatic-hashes.json',
        },
        storybookBaseDir: {
          type: 'string',
          alias: 'b',
          default: STORYBOOK_BASE_DIR || '.',
        },
        storybookConfigDir: {
          type: 'string',
          alias: 'c',
          default: STORYBOOK_CONFIG_DIR || '.storybook',
        },
        staticDir: {
          type: 'string',
          alias: 'd',
          isMultiple: true,
        },
        untraced: {
          type: 'string',
          alias: 'u',
          isMultiple: true,
        },
      },
    }
  );

  const log = createLogger({}, { logPrefix: '', logLevel: 'info' });

  try {
    const rootPath = await getRepositoryRoot({ log });
    if (!rootPath) throw new Error('Failed to determine repository root');

    const stats = await readStatsFile(flags.statsFile);

    const manifest = await buildHashManifest(stats, {
      rootPath,
      baseDir: flags.storybookBaseDir,
      storybookConfigDir: flags.storybookConfigDir,
      staticDir: flags.staticDir,
      untraced: flags.untraced,
    });

    await outputFile(flags.output, JSON.stringify(manifest, undefined, 2));

    const { storyCount, fileCount, missingFileCount, unhashableCount } = manifest.summary;
    log.info(`Wrote ${flags.output}`);
    log.info(
      `Hashed ${storyCount} stories across ${fileCount} files ` +
        `(global section: ${Object.keys(manifest.global.files).length} files).`
    );
    if (missingFileCount > 0) {
      log.warn(
        `${missingFileCount} referenced file(s) were not found on disk and recorded as "<missing>". ` +
          `This is expected for e.g. Yarn PnP node_modules or generated files.`
      );
    }
    if (unhashableCount > 0) {
      log.info(
        `${unhashableCount} module(s) were external/virtual and recorded with a synthetic hash.`
      );
    }

    return flags.output;
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return undefined;
  }
}
