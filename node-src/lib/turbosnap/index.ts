import path from 'path';
import semver from 'semver';

import { Context } from '../../types';
import missingStatsFile from '../../ui/messages/errors/missingStatsFile';
import { TraceChangedFilesResult } from './types';
import { traceChangedFiles as traceChangedFilesV1 } from './v1';
import { traceChangedFiles as traceChangedFilesV2 } from './v2';

/**
 * Runs both TurboSnap algorithms for monitoring while keeping V1 authoritative.
 *
 * @param ctx The context set when executing the CLI.
 *
 * @returns Both ordinary algorithm results when V2 produced one.
 */
// TODO: Refactor this function
// eslint-disable-next-line complexity
export async function compareChangedFiles(
  ctx: Context
): Promise<{ v1: TraceChangedFilesResult; v2?: TraceChangedFilesResult }> {
  if (!ctx.turboSnap) {
    const skipped = { status: 'skipped' as const };
    return { v1: skipped, v2: skipped };
  }
  if (ctx.turboSnap.unavailable) {
    const unavailable = { status: 'skipped' as const, turboSnap: ctx.turboSnap };
    return { v1: unavailable, v2: unavailable };
  }
  if (!ctx.git.changedFiles) {
    const shared = ctx.turboSnap.bailReason
      ? ({ status: 'bailed', turboSnap: ctx.turboSnap } as const)
      : ({ status: 'skipped' } as const);
    return { v1: shared, v2: shared };
  }
  if (!ctx.fileInfo?.statsPath) {
    // If we don't know the SB version, we should assume we don't support `--stats-json`
    const nonLegacyStatsSupported =
      ctx.storybook?.version &&
      semver.gte(semver.coerce(ctx.storybook.version) || '0.0.0', '8.0.0');

    throw new Error(missingStatsFile({ legacy: !nonLegacyStatsSupported }));
  }

  // `ctx.build` is the baseline build and is only assigned when the Index returned one, so it can be
  // missing here even though `git.changedFiles` is a (possibly empty) array that passes the guard
  // above. v2's mutation targets that build, so without it v2 has nothing to trace against.
  if (!ctx.build) {
    ctx.log.info('TurboSnap v2 has no baseline build to trace against; running TurboSnap v1');
    return {
      v1: await traceChangedFilesV1(ctx),
      v2: {
        status: 'bailed',
        turboSnap: {
          bailReason: { internalError: true, bailSubreason: 'missingBaselineBuild' },
        },
      },
    };
  }

  let v2: TraceChangedFilesResult | undefined;
  // Anchor at the Storybook base directory when we know it. Without a base directory (e.g. a
  // non-monorepo where Storybook lives at `<repo>/.storybook`), fall back to the repo root, and
  // only to the current working directory when even the repo root is unknown.
  const projectRoot = ctx.git.rootPath
    ? path.resolve(ctx.git.rootPath, ctx.storybook?.baseDir ?? '.')
    : process.cwd();
  const result = await traceChangedFilesV2({
    graphqlClient: ctx.client,
    // The current mutation writes to the build. Keep targeting the baseline until the settled
    // return-only Index contract lands; its consumption ticket will switch this to announcedBuild.
    buildId: ctx.build.id,
    statsPath: ctx.fileInfo.statsPath,
    manifestOutputDirectory: path.join(ctx.sourceDir, '.chromatic'),
    projectRoot,
    // The config and static directories are project-relative, matching how v1 reads them. An
    // explicit --storybook-config-dir wins over the discovered one, as it does in v1.
    configDir: ctx.options?.storybookConfigDir ?? ctx.storybook?.configDir ?? '.storybook',
    staticDirs: ctx.storybook?.staticDir ?? [],
  });

  if (result.status === 'bailed') {
    ctx.log.info('TurboSnap v2 bailed; running TurboSnap v1');
  } else if (result.status === 'fallback') {
    ctx.log.info('TurboSnap v2 could not produce a result; running TurboSnap v1');
  } else {
    v2 = result;
  }
  if (result.status === 'bailed') v2 = result;

  const v1 = await traceChangedFilesV1(ctx);
  return { v1, ...(v2 && { v2 }) };
}

/** Returns the V1 result that remains authoritative while V2 runs in monitoring mode. */
export async function traceChangedFiles(ctx: Context): Promise<TraceChangedFilesResult> {
  const { v1 } = await compareChangedFiles(ctx);
  return v1.status === 'skipped' ? { status: 'skipped' } : v1;
}
