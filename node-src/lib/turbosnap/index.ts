import semver from 'semver';

import { readStatsFile } from '../../tasks/readStatsFile';
import { ChangedPackageFilesBailReason, TurboSnap } from '../../types';
import missingStatsFile from '../../ui/messages/errors/missingStatsFile';
import bailFile from '../../ui/messages/warnings/bailFile';
import { captureBailException } from './captureBailException';
import { classifyChangedPackageFilesDetail } from './classifyBailDetail';
import { MissingStatsFileError } from './errors';
import { findChangedDependencies } from './findChangedDependencies';
import { findChangedPackageFiles } from './findChangedPackageFiles';
import { getDependentStoryFiles } from './getDependentStoryFiles';
import { TraceChangedFilesInput, TraceChangedFilesResult } from './types';

/**
 * Determine whether TurboSnap should attempt to trace changed files. Tracing is skipped when
 * TurboSnap is unavailable or there are no changed files to trace.
 *
 * @param input The (subset of) trace inputs that gate tracing.
 *
 * @returns True if tracing should run.
 */
export const shouldTrace = (
  input: Pick<TraceChangedFilesInput, 'unavailable' | 'changedFiles'>
): boolean => !input.unavailable && Boolean(input.changedFiles);

/**
 * Trace which story files are affected by the changed files using TurboSnap, without mutating any
 * shared context. The caller applies the returned result to its own context.
 *
 * @param input The data and configuration TurboSnap needs to trace dependent story files.
 *
 * @returns A discriminated result describing whether tracing was skipped, bailed, or succeeded.
 *
 * @throws {MissingStatsFileError} if no webpack stats file is available to trace.
 */
// eslint-disable-next-line complexity
export async function traceChangedFiles(
  input: TraceChangedFilesInput
): Promise<TraceChangedFilesResult> {
  if (!shouldTrace(input)) return { outcome: 'skipped' };

  const { log, statsPath, changedFiles = [], packageMetadataChanges } = input;

  if (!statsPath) {
    // If we don't know the SB version, we should assume we don't support `--stats-json`
    const nonLegacyStatsSupported =
      input.storybookVersion &&
      semver.gte(semver.coerce(input.storybookVersion) || '0.0.0', '8.0.0');

    throw new MissingStatsFileError(missingStatsFile({ legacy: !nonLegacyStatsSupported }));
  }

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  let changedDependencyNames: void | string[] = [];
  let resolvedDependencyNames: string[] | undefined;
  let pendingError: unknown;
  let pendingPatch: Partial<ChangedPackageFilesBailReason> | undefined;
  if (packageMetadataChanges?.length) {
    changedDependencyNames = await findChangedDependencies({
      log,
      packageMetadataChanges,
      untraced: input.untraced,
      manifestConcurrency: input.manifestConcurrency,
      packageConcurrency: input.packageConcurrency,
    }).catch((err) => {
      pendingError = err;
      pendingPatch = classifyChangedPackageFilesDetail(err);

      const { name, message, stack, code } = err;
      log.debug({ name, message, stack, code });
    });
    if (changedDependencyNames) {
      resolvedDependencyNames = changedDependencyNames;
      if (!input.interactive) {
        const list =
          changedDependencyNames.length > 0
            ? `:\n${changedDependencyNames.map((f) => `  ${f}`).join('\n')}`
            : '';
        log.info(`Found ${changedDependencyNames.length} changed dependencies${list}`);
      }
    } else {
      log.warn(`Could not retrieve dependency changes from lockfiles; checking package.json`);

      const changedPackageFiles = await findChangedPackageFiles(log, packageMetadataChanges);
      if (changedPackageFiles.length > 0) {
        // Capture original error from findChangedDependencies at the actual bail site. There could
        // be times when findChangedDependencies fails but our fallback works. In those cases, we
        // don't want to capture an error since we were able to recover and didn't bail.
        if (pendingPatch && pendingError) {
          pendingPatch.sentryEventId = captureBailException(pendingError, {
            bailSubreason: pendingPatch.bailSubreason,
            bailPath: 'findChangedDependencies',
          });
        }

        const turboSnap: TurboSnap = {
          bailReason: {
            changedPackageFiles,
            ...pendingPatch,
          },
        };
        log.warn(bailFile({ turboSnap }));
        return { outcome: 'bailed', turboSnap };
      }
    }
  }

  const stats = await readStatsFile(statsPath);

  await input.validateStorybookBaseDir?.(stats);

  const { turboSnap, untracedFiles, affectedModules } = await getDependentStoryFiles(
    input,
    stats,
    statsPath,
    changedFiles,
    changedDependencyNames || []
  );

  if (!affectedModules) {
    return {
      outcome: 'bailed',
      turboSnap,
      untracedFiles,
      changedDependencyNames: resolvedDependencyNames,
    };
  }

  return {
    outcome: 'traced',
    turboSnap,
    untracedFiles,
    affectedModules,
    changedDependencyNames: resolvedDependencyNames,
  };
}

export { MissingStatsFileError } from './errors';
export { findChangedDependencies } from './findChangedDependencies';
export { findChangedPackageFiles } from './findChangedPackageFiles';
export { getDependentStoryFiles } from './getDependentStoryFiles';
export * from './types';
