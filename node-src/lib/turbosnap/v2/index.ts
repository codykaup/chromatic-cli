import GraphQLClient from '../../../io/graphqlClient';
import { readStatsFile } from '../../../tasks/readStatsFile';
import { TraceChangedFilesResult } from '../types';
import { determineChangedFiles } from './api';
import { getBuilderViteFallbackReason } from './builderViteCompatibility';
import { buildManifest, writeManifest } from './manifest';

interface TraceChangedFilesInput {
  graphqlClient: GraphQLClient;
  buildId: string;
  statsPath: string;
  manifestOutputDirectory: string;
  projectRoot: string;
  gitRoot: string;
  configDir: string;
  staticDirs: string[];
}

/**
 * The result of running TurboSnap v2. In addition to the shared trace statuses, v2 can return
 * 'fallback' to tell the caller it can't be trusted to trace this build and v1 should run instead.
 */
export type TraceChangedFilesV2Result =
  | TraceChangedFilesResult
  | { status: 'fallback'; reason?: string };

/**
 * Determines which story files are affected by the changed source file hashes, bailing out of
 * TurboSnap when necessary.
 *
 * @param input The input to run TurboSnap 2.0.
 * @param input.statsPath The path to the stats file.
 * @param input.manifestOutputDirectory The directory to write the manifest file to.
 * @param input.projectRoot The absolute Storybook project root used to read source files off disk.
 * @param input.gitRoot The absolute git repository root used to anchor manifest keys; see
 * {@link StatsPathRoots} for why the two roots differ.
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
  // TODO: rename this. We want it to be as generic as possible.
  const fallbackReason = getBuilderViteFallbackReason(stats, input.projectRoot);
  if (fallbackReason) {
    return { status: 'fallback', reason: fallbackReason };
  }

  const manifest = await buildManifest(
    stats,
    { projectRoot: input.projectRoot, gitRoot: input.gitRoot },
    { configDir: input.configDir, staticDirs: input.staticDirs }
  );
  await determineChangedFiles(input.graphqlClient, input.buildId, manifest);
  writeManifest(manifest, input.manifestOutputDirectory);

  // Until we want to lean on the v2 output, we always fallback to v1.
  return { status: 'fallback' };
}
