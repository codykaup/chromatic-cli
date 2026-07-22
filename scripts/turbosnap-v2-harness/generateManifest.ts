/* eslint-disable no-console */
/**
 * Local-only entrypoint that runs TurboSnap v2's manifest generation against a
 * `preview-stats.json` and writes a `turbosnap-manifest.json`, WITHOUT talking to the Index.
 *
 * This reuses the real CLI code path (`traceChangedFiles` in
 * `node-src/lib/turbosnap/v2/index.ts`), which we've locally modified to skip the
 * `uploadBuildHashes` GraphQL mutation so we can inspect hash output offline.
 *
 * Usage:
 *   node generateManifest.cjs --stats <preview-stats.json> --project-root <dir> --out <dir>
 */
import { mkdirSync } from 'fs';
import path from 'path';

import { traceChangedFiles } from '../../node-src/lib/turbosnap/v2';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const statsPath = args.stats && path.resolve(args.stats);
  const projectRoot = args['project-root'] && path.resolve(args['project-root']);
  const outputDirectory = args.out && path.resolve(args.out);

  if (!statsPath || !projectRoot || !outputDirectory) {
    console.error(
      'Usage: generateManifest --stats <preview-stats.json> --project-root <dir> --out <dir>'
    );
    process.exit(1);
    return;
  }

  mkdirSync(outputDirectory, { recursive: true });

  await traceChangedFiles({
    statsPath,
    manifestOutputDirectory: outputDirectory,
    projectRoot,
  });

  console.log(`Wrote ${path.join(outputDirectory, 'turbosnap-manifest.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
