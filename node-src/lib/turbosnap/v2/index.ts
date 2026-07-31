import * as Sentry from '@sentry/node';

import GraphQLClient from '../../../io/graphqlClient';
import { readStatsFile } from '../../../tasks/readStatsFile';
import { TraceChangedFilesResult } from '../types';
import { captureBailException } from '../v1/captureBailException';
import { isNetworkError } from '../v1/errors';
import { determineChangedFiles } from './api';
import { getUntrustedBuilderStatsReason } from './builderViteCompatibility';
import { buildManifest, writeManifest } from './manifest';

interface TraceChangedFilesInput {
  graphqlClient: GraphQLClient;
  buildId: string;
  statsPath: string;
  manifestOutputDirectory: string;
  projectRoot: string;
  configDir: string;
  staticDirs: string[];
}

/**
 * The result of running TurboSnap v2. In addition to the shared trace statuses, v2 can return
 * 'fallback' to tell the caller it can't be trusted to trace this build and v1 should run instead.
 */
export type TraceChangedFilesV2Result = TraceChangedFilesResult | { status: 'fallback' };

function writeDiagnosticManifest(
  manifest: Parameters<typeof writeManifest>[0],
  outputDirectory: string
) {
  try {
    writeManifest(manifest, outputDirectory);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { turbo_snap_v2_diagnostic: 'writeManifest' },
    });
  }
}

/**
 * Determines which story files are affected by the changed source file hashes, bailing out of
 * TurboSnap when necessary.
 *
 * @param input The input to run TurboSnap 2.0.
 * @param input.statsPath The path to the stats file.
 * @param input.manifestOutputDirectory The directory to write the manifest file to.
 * @param input.projectRoot The absolute Storybook project root used to read source files off disk
 * and to anchor manifest keys.
 * @param input.configDir The project-relative Storybook config directory, hashed off disk because it
 * is never a bundler input.
 * @param input.staticDirs The project-relative static directories, hashed off disk for the same reason.
 *
 * @returns The TurboSnap result.
 */
export async function traceChangedFiles(
  input: TraceChangedFilesInput
): Promise<TraceChangedFilesV2Result> {
  const stats = await readStatsFile(input.statsPath);
  let builderStatsReason;
  try {
    builderStatsReason = getUntrustedBuilderStatsReason(stats, input.projectRoot);
  } catch (error) {
    const bailSubreason = 'builderCompatibilityCheckFailed';
    return {
      status: 'bailed',
      turboSnap: {
        bailReason: {
          internalError: true,
          bailSubreason,
          sentryEventId: captureBailException(error, {
            bailSubreason,
            bailPath: 'getUntrustedBuilderStatsReason',
          }),
        },
      },
    };
  }
  if (builderStatsReason) {
    return {
      status: 'bailed',
      turboSnap: {
        bailReason: {
          untrustedBuilderStats: true,
          bailSubreason: builderStatsReason.subreason,
          builderName: builderStatsReason.builderName,
          ...(builderStatsReason.builderVersion && {
            builderVersion: builderStatsReason.builderVersion,
          }),
        },
      },
    };
  }

  let manifest;
  try {
    manifest = await buildManifest(stats, input.projectRoot, {
      configDir: input.configDir,
      staticDirs: input.staticDirs,
    });
  } catch (error) {
    const bailSubreason = 'manifestBuildFailed';
    return {
      status: 'bailed',
      turboSnap: {
        bailReason: {
          internalError: true,
          bailSubreason,
          sentryEventId: captureBailException(error, {
            bailSubreason,
            bailPath: 'buildManifest',
          }),
        },
      },
    };
  }

  // A graph we found no stories in can only ever recapture everything through `<storybookGlobals>`,
  // which is wider than v1. Write the manifest anyway so the degenerate graph is still debuggable.
  if (manifest.storyFileHashes.size === 0) {
    writeDiagnosticManifest(manifest, input.manifestOutputDirectory);
    return {
      status: 'bailed',
      turboSnap: {
        bailReason: {
          noStoryFiles: true,
        },
      },
    };
  }

  try {
    await determineChangedFiles(input.graphqlClient, input.buildId, manifest);
  } catch (error) {
    writeDiagnosticManifest(manifest, input.manifestOutputDirectory);
    return {
      status: 'bailed',
      turboSnap: {
        bailReason: {
          indexUnavailable: true,
          ...(isNetworkError(error) && { bailSubreason: 'networkError' as const }),
        },
      },
    };
  }
  writeDiagnosticManifest(manifest, input.manifestOutputDirectory);

  // Until we want to lean on the v2 output, we always fallback to v1.
  return { status: 'fallback' };
}
