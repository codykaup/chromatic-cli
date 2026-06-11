import path from 'path';

import {
  ChangedPackageFilesBailReason,
  ChangedStorybookFilesBailReason,
  InvalidChangedFilesBailReason,
} from '../../types';
import {
  AncestorMissingError,
  BaselineCheckoutFailedError,
  BaselineDirtyError,
  GitCommandError,
  LockFileParseFailedError,
  LockFileSizeExceededError,
  NetworkError,
  ReplacementFailedError,
} from './errors';
import { SUPPORTED_LOCK_FILES } from './findChangedDependencies';

/**
 * Detect which supported lockfile kind a given path corresponds to.
 *
 * @param filePath The filesystem path to inspect.
 *
 * @returns The matching lockfile filename, or `undefined` if none match.
 */
export function detectLockfileKind(filePath: string): string | undefined {
  const basename = path.basename(filePath);
  return SUPPORTED_LOCK_FILES.find((lockfile) => basename === lockfile);
}

/**
 * Map an unknown thrown error into a partial `TurboSnapBailReason` patch.
 *
 * @param err The thrown value to classify.
 *
 * @returns A partial patch object to merge into the bail reason.
 */
export function classifyChangedPackageFilesDetail(
  err: unknown
): Partial<ChangedPackageFilesBailReason> {
  if (err instanceof LockFileSizeExceededError) {
    const lockfileKind = detectLockfileKind(err.lockfilePath);
    return {
      bailSubreason: 'lockfileSizeExceeded',
      ...(lockfileKind && { lockfileKind }),
      lockfileSizeBytes: err.lockfileSizeBytes,
    };
  }
  if (err instanceof LockFileParseFailedError) {
    const lockfileKind = detectLockfileKind(err.lockfilePath);
    return {
      bailSubreason: 'lockfileParseFailed',
      ...(lockfileKind && { lockfileKind }),
    };
  }
  if (err instanceof BaselineCheckoutFailedError) {
    return { bailSubreason: 'baselineCheckoutFailed' };
  }
  return {};
}

/**
 * Map an unknown thrown error to its `invalidChangedFiles` bail subreason, if recognized.
 *
 * @param err The thrown value to classify.
 *
 * @returns The matching subreason, or an empty object for an unclassified error.
 */
export function classifyInvalidChangedFilesDetail(
  err: unknown
): Partial<InvalidChangedFilesBailReason> {
  if (err instanceof AncestorMissingError) return { bailSubreason: 'ancestorMissing' };
  if (err instanceof BaselineDirtyError) return { bailSubreason: 'baselineDirty' };
  if (err instanceof NetworkError) return { bailSubreason: 'networkError' };
  if (err instanceof ReplacementFailedError) return { bailSubreason: 'replacementFailed' };
  if (err instanceof GitCommandError) return { bailSubreason: 'gitCommandFailed' };
  return {};
}

/**
 * Classify a `changedStorybookFiles` bail as a direct config edit or a config dependency change.
 * It's `configFileChanged` when one of the matched config files is itself a changed file (the user
 * edited config), otherwise `configDependencyChanged` (a changed non-config file traced up to a
 * config file). The changed file may be bundled into the same chunk as the config file, so this
 * checks config-file membership in the changed set rather than how the bail was reached.
 *
 * @param storybookFiles The files backing the bailing module (from `files(moduleName)`).
 * @param changedFiles The set of changed (git-relative) file paths.
 * @param isStorybookFile Predicate identifying files inside the Storybook config dir.
 *
 * @returns A partial patch object to merge into the bail reason.
 */
export function classifyChangedStorybookFilesDetail(
  storybookFiles: string[],
  changedFiles: Set<string>,
  isStorybookFile: (name: string) => unknown
): Partial<ChangedStorybookFilesBailReason> {
  const configFileChanged = storybookFiles.some(
    (file) => isStorybookFile(file) && changedFiles.has(file)
  );
  return {
    bailSubreason: configFileChanged ? 'configFileChanged' : 'configDependencyChanged',
  };
}
