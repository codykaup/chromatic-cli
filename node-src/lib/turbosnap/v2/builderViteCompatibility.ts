import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import semver from 'semver';

import { Stats } from '../../../types';

const BUILDER_VITE_PACKAGE = '@storybook/builder-vite';

// The CJS proxy importer-edge fix is parked in the Storybook fork for this map. Until it lands in a
// released builder-vite, v2 must not trust Vite stats for production tracing.
const FIRST_BUILDER_VITE_VERSION_WITH_CJS_EDGE_FIX = '10.6.0-alpha.4';

/**
 * Returns why TurboSnap v2 should fall back for a Vite stats file, or undefined when the stats are
 * not Vite or are produced by a known-fixed builder-vite.
 *
 * @param stats The preview stats file.
 * @param projectRoot The absolute Storybook project root to resolve packages from.
 *
 * @returns The compatibility fallback reason, if any.
 */
export function getBuilderViteFallbackReason(
  stats: Stats,
  projectRoot: string
): string | undefined {
  // TODO: rename this function because it doesn't state its purpose
  if (!isBuilderViteStats(stats)) return undefined;

  const version = resolvePackageVersion(projectRoot, BUILDER_VITE_PACKAGE);
  if (!version) {
    return `could not resolve ${BUILDER_VITE_PACKAGE} from ${projectRoot}`;
  }

  if (!semver.valid(version)) {
    return `${BUILDER_VITE_PACKAGE}@${version} is not a valid semver version`;
  }

  if (semver.lt(version, FIRST_BUILDER_VITE_VERSION_WITH_CJS_EDGE_FIX)) {
    // TODO: update this return reason
    return `${BUILDER_VITE_PACKAGE}@${version} is known to drop Vite CJS importer edges`;
  }

  return undefined;
}

function isBuilderViteStats(stats: Stats) {
  return stats.modules.some((module) =>
    [
      module.name,
      module.nameForCondition,
      ...(module.reasons ?? []).map((reason) => reason.moduleName),
    ].some((name) => name?.includes(`${BUILDER_VITE_PACKAGE}/`))
  );
}

function resolvePackageVersion(projectRoot: string, packageName: string): string | undefined {
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));

  let packageJsonPath;
  try {
    packageJsonPath = requireFromProject.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }

  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return version;
}
