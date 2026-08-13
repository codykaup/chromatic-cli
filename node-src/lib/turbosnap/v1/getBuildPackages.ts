import path from 'path';

import { Context, Stats } from '../../../types';
import { posix } from '../../posix';
import { getPackageName, normalizePath } from './getDependentStoryFiles';

/**
 * A summary of which packages are actually part of the Storybook build, derived from the builder's
 * stats file. Used to determine which changed `package.json` files are relevant for tracing so we
 * can avoid diffing manifests that can't affect the build (e.g. unrelated packages in a monorepo).
 */
export interface BuildPackages {
  /**
   * Package names present in a `node_modules` directory within the build, including scope prefix if
   * any (e.g. `react`, `@storybook/react`).
   */
  packageNames: Set<string>;
  /**
   * Repo-root-relative POSIX paths of non-`node_modules` modules in the build. Used to detect
   * whether a workspace's source files are part of the build via directory containment.
   */
  sourceModulePaths: string[];
}

/**
 * Inspect the builder's stats file to determine which packages contribute to the Storybook build.
 * Returns `undefined` when the information can't be derived (e.g. missing repository root or an
 * empty stats file), in which case callers should skip relevance filtering to stay conservative.
 *
 * @param ctx The context set when executing the CLI.
 * @param stats The stats file information from the project's builder (Webpack, for example).
 *
 * @returns The set of packages/source paths in the build, or `undefined` if it can't be determined.
 */
export function getBuildPackages(ctx: Context, stats: Stats): BuildPackages | undefined {
  const { rootPath } = ctx.git || {};
  if (!rootPath) return undefined;

  const { baseDir: baseDirectory = '' } = ctx.storybook || {};

  const packageNames = new Set<string>();
  const sourceModulePaths: string[] = [];

  for (const module_ of stats.modules) {
    if (!module_.name) continue;
    const packageName = getPackageName(module_.name);
    if (packageName) {
      packageNames.add(packageName);
    } else {
      sourceModulePaths.push(normalizePath(posix(module_.name), rootPath, baseDirectory));
    }
  }

  // If the stats file yielded nothing usable, don't risk pruning relevant manifests.
  if (packageNames.size === 0 && sourceModulePaths.length === 0) return undefined;

  return { packageNames, sourceModulePaths };
}

/**
 * Determine whether a changed `package.json` is relevant to the Storybook build, and therefore
 * worth diffing for dependency changes. A manifest is considered relevant when any of the following
 * holds:
 *
 * 1. It's the repository root manifest, where hoisted/shared dependencies live.
 * 2. Its directory contains at least one source module that's part of the build (a workspace whose
 *    source is bundled).
 * 3. Its declared package `name` is bundled from `node_modules` (e.g. a symlinked workspace whose
 *    source appears under `node_modules` in the stats).
 *
 * @param manifestPath The repo-root-relative POSIX path to the `package.json` file.
 * @param manifestName The `name` field declared in the manifest, if known.
 * @param buildPackages The packages/source paths that make up the build.
 *
 * @returns `true` when the manifest could affect the build and should be diffed.
 */
export function isManifestRelevant(
  manifestPath: string,
  manifestName: string | undefined,
  buildPackages: BuildPackages
): boolean {
  const { packageNames, sourceModulePaths } = buildPackages;
  const directory = path.posix.dirname(manifestPath);

  // Root manifest: always relevant, since hoisted/shared dependencies are pinned here.
  if (directory === '.' || directory === '') return true;

  // A workspace whose source files are part of the build.
  const prefix = `${directory}/`;
  if (sourceModulePaths.some((modulePath) => modulePath.startsWith(prefix))) return true;

  // A workspace bundled from node_modules (e.g. resolved through a symlink).
  if (manifestName && packageNames.has(manifestName)) return true;

  return false;
}
