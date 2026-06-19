import * as turbosnap from '@cli/turbosnap';

import { checkStorybookBaseDirectory } from '../../lib/checkStorybookBaseDirectory';
import { transitionTo } from '../../lib/tasks';
import { rewriteErrorMessage } from '../../lib/utilities';
import { Context, Task } from '../../types';
import { bailed, traced, tracing } from '../../ui/tasks/prepare';

// These are the special characters that need to be escaped in the filename
// because they are used as special characters in picomatch
const SPECIAL_CHARS_REGEXP = /([$()*+?[\]^])/g;

/**
 * Builds the TurboSnap trace inputs from the CLI context. TurboSnap itself stays decoupled from the
 * context; the context-bound base directory check is injected as a callback.
 *
 * @param ctx - The CLI context containing git info and TurboSnap configuration
 *
 * @returns The inputs for `turbosnap.traceChangedFiles`.
 */
function buildTraceInput(ctx: Context): turbosnap.TraceChangedFilesInput {
  return {
    log: ctx.log,
    unavailable: !ctx.turboSnap || ctx.turboSnap.unavailable,
    changedFiles: ctx.git.changedFiles,
    packageMetadataChanges: ctx.git.packageMetadataChanges,
    statsPath: ctx.fileInfo?.statsPath,
    storybookVersion: ctx.storybook?.version,
    interactive: ctx.options.interactive,
    untraced: ctx.options.untraced,
    manifestConcurrency: ctx.env.CHROMATIC_TURBOSNAP_MANIFEST_CONCURRENCY,
    packageConcurrency: ctx.env.CHROMATIC_TURBOSNAP_PACKAGE_CONCURRENCY,
    rootPath: ctx.git.rootPath,
    baseDir: ctx.storybook?.baseDir,
    configDir: ctx.storybook?.configDir,
    staticDir: ctx.storybook?.staticDir,
    storybookBuildDir: ctx.options.storybookBuildDir,
    storybookConfigDir: ctx.options.storybookConfigDir,
    storybookBaseDir: ctx.options.storybookBaseDir,
    traceChanged: ctx.options.traceChanged,
    validateStorybookBaseDir: (stats) => checkStorybookBaseDirectory(ctx, stats),
  };
}

/**
 * Traces which story files are affected by recent changes using TurboSnap.
 * Analyzes changed files to determine which stories need to be tested.
 *
 * @param ctx - The CLI context containing git info and TurboSnap configuration
 * @param task - The current Listr task for UI updates
 *
 * @throws {Error} if stats file is missing or tracing fails
 */
// eslint-disable-next-line complexity
export async function traceChangedFiles(ctx: Context, task: Task) {
  const input = buildTraceInput(ctx);
  if (!turbosnap.shouldTrace(input)) return;

  transitionTo(tracing)(ctx, task);

  let result: turbosnap.TraceChangedFilesResult;
  try {
    result = await turbosnap.traceChangedFiles(input);
  } catch (err) {
    // Record the bail reason carried by a missing stats file so it's reported downstream.
    if (err instanceof turbosnap.MissingStatsFileError) {
      ctx.turboSnap = { ...ctx.turboSnap, bailReason: err.bailReason };
    }
    if (!ctx.options.interactive) {
      ctx.log.info('Failed to retrieve dependent story files', {
        statsPath: ctx.fileInfo?.statsPath,
        changedFiles: ctx.git.changedFiles,
        err,
      });
    }
    throw rewriteErrorMessage(err, `Could not retrieve dependent story files.\n${err.message}`);
  }

  if (result.outcome === 'skipped') return;

  ctx.turboSnap = { ...ctx.turboSnap, ...result.turboSnap };
  if (result.untracedFiles) ctx.untracedFiles = result.untracedFiles;
  if (result.changedDependencyNames) {
    ctx.git.changedDependencyNames = result.changedDependencyNames;
  }

  if (result.outcome === 'bailed') {
    transitionTo(bailed)(ctx, task);
    return;
  }

  // Escape special characters in the filename so it does not conflict with picomatch
  ctx.onlyStoryFiles = Object.keys(result.affectedModules).map((key) =>
    key.replaceAll(SPECIAL_CHARS_REGEXP, String.raw`\$1`)
  );

  if (!ctx.options.interactive) {
    if (!ctx.options.traceChanged) {
      ctx.log.info(
        `Found affected story files:\n${Object.entries(result.affectedModules)
          .flatMap(([id, files]) => files.map((f) => `  ${f} [${id}]`))
          .join('\n')}`
      );
    }
    if (ctx.untracedFiles && ctx.untracedFiles.length > 0) {
      ctx.log.info(
        `Encountered ${ctx.untracedFiles.length} untraced files:\n${ctx.untracedFiles
          .map((f) => `  ${f}`)
          .join('\n')}`
      );
    }
  }
  transitionTo(traced)(ctx, task);
}
