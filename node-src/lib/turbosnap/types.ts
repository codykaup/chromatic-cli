import type { Stats, TurboSnap } from '../../types';
import type { Logger } from '../log';

/** A baseline commit together with the files that changed relative to it. */
export interface PackageMetadataChange {
  changedFiles: string[];
  commit: string;
}

/** Inputs for {@link findChangedDependencies}. */
export interface FindChangedDependenciesInput {
  log: Logger;
  packageMetadataChanges?: PackageMetadataChange[];
  untraced?: string[];
  manifestConcurrency: number;
  packageConcurrency: number;
}

/** Inputs for {@link getDependentStoryFiles}. */
export interface GetDependentStoryFilesInput {
  log: Logger;
  rootPath?: string;
  baseDir?: string;
  configDir?: string;
  staticDir?: string[];
  storybookBuildDir?: string;
  storybookConfigDir?: string;
  storybookBaseDir?: string;
  untraced?: string[];
  traceChanged?: boolean | string;
}

/** Result of {@link getDependentStoryFiles}. `affectedModules` is `undefined` when TurboSnap bailed. */
export interface GetDependentStoryFilesResult {
  turboSnap: TurboSnap;
  untracedFiles: string[];
  affectedModules?: Record<string, string[]>;
}

/** Inputs for the {@link traceChangedFiles} orchestrator. */
export interface TraceChangedFilesInput
  extends FindChangedDependenciesInput, GetDependentStoryFilesInput {
  changedFiles?: string[];
  unavailable?: boolean;
  statsPath?: string;
  storybookVersion?: string;
  interactive?: boolean;
  /**
   * Validates that the Storybook base directory is configured correctly for the given stats.
   * Injected by the caller so this module stays decoupled from the (ctx-bound) implementation.
   */
  validateStorybookBaseDir?: (stats: Stats) => Promise<void> | void;
}

/**
 * Result of the {@link traceChangedFiles} orchestrator. The caller applies the returned data to its
 * own context rather than the module mutating a shared object.
 *
 * - `skipped`: TurboSnap is unavailable or there are no changed files; nothing was traced.
 * - `bailed`: tracing ran but bailed out of TurboSnap (see `turboSnap.bailReason`).
 * - `traced`: tracing succeeded and produced `affectedModules`.
 */
export type TraceChangedFilesResult =
  | { outcome: 'skipped' }
  | {
      outcome: 'bailed';
      turboSnap: TurboSnap;
      untracedFiles?: string[];
      changedDependencyNames?: string[];
    }
  | {
      outcome: 'traced';
      turboSnap: TurboSnap;
      untracedFiles: string[];
      changedDependencyNames?: string[];
      affectedModules: Record<string, string[]>;
    };
