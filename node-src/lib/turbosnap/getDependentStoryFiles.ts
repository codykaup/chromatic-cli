import path from 'path';

import { Module, Reason, Stats, TurboSnap } from '../../types';
import noCSFGlobs from '../../ui/messages/errors/noCSFGlobs';
import tracedAffectedFiles from '../../ui/messages/info/tracedAffectedFiles';
import bailFile from '../../ui/messages/warnings/bailFile';
import { posix } from '../posix';
import { isPackageManifestFile, matchesFile } from '../utilities';
import { SUPPORTED_LOCK_FILES } from './findChangedDependencies';
import { GetDependentStoryFilesInput, GetDependentStoryFilesResult } from './types';

type FilePath = string;
type NormalizedName = string;
type TraceToCheck = (string | number | string[])[];

// Ignore these while tracing dependencies
const INTERNALS = [/\/webpack\/runtime\//, /^\(webpack\)/];

const isPackageLockFile = (name: string) =>
  SUPPORTED_LOCK_FILES.some((lockfile) => name.endsWith(lockfile));
const isUserModule = (module_: Module | Reason) =>
  (module_ as Module).id !== undefined &&
  (module_ as Module).id !== null &&
  !INTERNALS.some((re) => re.test((module_ as Module).name || (module_ as Reason).moduleName));

// For any path in node_modules, return the package name, including scope prefix if any.
const getPackageName = (modulePath: string) => {
  const [, scopedName] = modulePath.match(/\/node_modules\/(@[\w-]+\/[\w-]+)\//) || [];
  if (scopedName) return scopedName;
  const [, unscopedName] = modulePath.match(/\/node_modules\/([\w-]+)\//) || [];
  return unscopedName;
};

/**
 * Converts a module path found in the webpack stats to be relative to the (git) root path. Module
 * paths can be relative (`./module.js`) or absolute (`/path/to/project/module.js`). The webpack
 * stats may have been generated in a subdirectory, so we prepend the baseDir if necessary. The
 * result is a relative POSIX path compatible with `git diff --name-only`. Virtual paths (e.g. Vite)
 * are returned as-is.
 *
 * @param posixPath The POSIX path to the file.
 * @param rootPath The project root path.
 * @param baseDirectory The base directory to the file.
 *
 * @returns A normalized path to the file.
 */
export function normalizePath(posixPath: string, rootPath: string, baseDirectory = '') {
  if (!posixPath || posixPath.startsWith('/virtual:')) return posixPath;

  return path.posix.isAbsolute(posixPath)
    ? path.posix.relative(rootPath, posixPath)
    : path.posix.join(baseDirectory, posixPath);
}

/**
 * This traverses the webpack module stats to retrieve a set of CSF files that somehow trace back to
 * the changed git files. The result is a map of Module ID => file path. In the end we'll only send
 * the Module IDs to Chromatic, the file paths are only for logging purposes.
 *
 * @param input The data and configuration TurboSnap needs to trace dependent story files.
 * @param stats The stats file information from the project's builder (Webpack, for example).
 * @param statsPath The path to the stats file generated from the project's builder (Webpack, for
 * example).
 * @param changedFiles A list of changed files.
 * @param changedDependencies A list of changed dependencies.
 *
 * @returns The resulting TurboSnap state, untraced files, and any affected story files (omitted
 * when TurboSnap bailed).
 */
// TODO: refactor this function
// eslint-disable-next-line complexity, max-statements
export async function getDependentStoryFiles(
  input: GetDependentStoryFilesInput,
  stats: Stats,
  statsPath: string,
  changedFiles: string[],
  changedDependencies: string[] = []
): Promise<GetDependentStoryFilesResult> {
  const { log, rootPath } = input;
  if (!rootPath) {
    throw new Error('Failed to determine repository root');
  }

  const {
    baseDir: baseDirectory = '',
    configDir: configDirectory = '.storybook',
    staticDir: staticDirectory = [],
  } = input;
  const {
    storybookBuildDir,
    // eslint-disable-next-line unicorn/prevent-abbreviations
    storybookConfigDir = configDirectory,
    storybookBaseDir,
    untraced = [],
    traceChanged,
  } = input;

  // Convert a "webpack path" (relative to storybookBaseDir) to a "git path" (relative to repository root)
  // e.g. `./src/file.js` => `path/to/storybook/src/file.js`
  const normalize = (posixPath: FilePath): NormalizedName => {
    const CSF_REGEX = /\s+(sync|lazy)\s+/g;
    const URL_PARAM_REGEX = /(\?.*)/g;
    const newPath = normalizePath(posixPath, rootPath, baseDirectory);
    // Trim query params such as `?ngResource` which are sometimes present
    return URL_PARAM_REGEX.test(newPath) && !CSF_REGEX.test(newPath)
      ? newPath.replaceAll(URL_PARAM_REGEX, '')
      : newPath;
  };

  const storybookDirectory = normalize(posix(storybookConfigDir));
  const staticDirectories = staticDirectory.map((directory: string) => normalize(posix(directory)));

  log.debug('BASE Directory:', baseDirectory);
  log.debug('Storybook CONFIG Directory:', storybookDirectory);

  // NOTE: this only works with `main:stories` -- if stories are imported from files in `.storybook/preview.js`
  // we'll need a different approach to figure out CSF files (maybe the user should pass a glob?).
  const storiesEntryFiles = [
    // v6 store (SB <= 6.3)
    `${storybookConfigDir}/generated-stories-entry.js`,
    // v6 store (SB 6.4 or SB <= 6.3 with root as config dir)
    `./generated-stories-entry.js`,
    // v6 store with .cjs extension (SB 6.5)
    `./generated-stories-entry.cjs`,
    // v7 store (SB >= 6.4)
    `./storybook-stories.js`,
    // vite builder
    `/virtual:/@storybook/builder-vite/vite-app.js`,
    `virtual:@storybook/builder-vite/vite-app.js`,
    // rspack builder
    `./node_modules/.cache/storybook/default/dev-server/storybook-stories.js`,
    './node_modules/.cache/storybook-rsbuild-builder/storybook-stories.js',
    `./node_modules/.cache/storybook/storybook-rsbuild-builder/storybook-config-entry.js`,
    `./node_modules/.cache/storybook-rsbuild-builder/storybook-config-entry.js`,
    `./storybook-config-entry.js`,
  ].map((file) => normalize(file));

  const modulesByName = new Map<NormalizedName, Module>();
  const nodeModules = new Map<string, NormalizedName[]>();
  const namesById = new Map<Module['id'], NormalizedName>();
  const reasonsById = new Map<Module['id'], NormalizedName[]>();
  const csfGlobsByName = new Set<NormalizedName>();

  const isStorybookFile = (name: string) =>
    name && name.startsWith(`${storybookDirectory}/`) && !storiesEntryFiles.includes(name);

  stats.modules
    .filter((module_) => isUserModule(module_))
    // TODO: refactor this function
    // eslint-disable-next-line complexity
    .map((module_) => {
      const normalizedName = normalize(module_.name);
      modulesByName.set(normalizedName, module_);
      namesById.set(module_.id, normalizedName);

      const packageName = getPackageName(module_.name);
      if (packageName) {
        // Track all modules from any node_modules directory by their package name, so we can mark
        // all those files "changed" if a dependency (version) changes, while still being able to
        // "untrace" certain files (or globs) in those packages.
        if (!nodeModules.has(packageName)) nodeModules.set(packageName, []);
        nodeModules.get(packageName)?.push(normalizedName);
      }

      if (module_.modules) {
        for (const m of module_.modules) {
          modulesByName.set(normalize(m.name), module_);
        }
      }

      const normalizedReasons = module_.reasons
        ?.map((reason) => normalize(reason.moduleName))
        .filter((reasonName) => reasonName && reasonName !== normalizedName);
      if (normalizedReasons) {
        reasonsById.set(module_.id, normalizedReasons);
      }

      if (
        !isStorybookFile(normalizedName) &&
        reasonsById
          .get(module_.id)
          ?.some((reason) => storiesEntryFiles.some((prefix) => reason.startsWith(prefix))) // match module names that include a "+ N modules"
      ) {
        csfGlobsByName.add(normalizedName);
      }
    });

  if (csfGlobsByName.size === 0) {
    // Check for misconfigured Storybook configDir. Only applicable to v6 store because v7 store
    // does not use configDir in the entry file path so there's no fix to recommend there.
    const storiesEntryRegExp = /^(.+\/)?generated-stories-entry\.js$/;
    const foundEntry = stats.modules.find(
      (module_) =>
        storiesEntryRegExp.test(module_.name) &&
        !storiesEntryFiles.includes(normalize(module_.name))
    );
    const entryFile = foundEntry && normalize(foundEntry.name);
    log.error(
      noCSFGlobs({
        statsPath,
        storybookDir: storybookDirectory,
        storybookBuildDir,
        entryFile,
      })
    );
    throw new Error('Did not find any CSF globs in preview-stats.json');
  }

  const isCsfGlob = (name: NormalizedName) => csfGlobsByName.has(name);
  const isStaticFile = (name: string) =>
    staticDirectories.some((directory) => name && name.startsWith(`${directory}/`));

  const untracedFiles: string[] = [];

  function untrace(filepath: string) {
    filepath = filepath.replace(/\s\+\s\d+\smodules?$/, ''); // strip ' + N modules' from the string before matching against `untraced`
    if (untraced.some((glob) => matchesFile(glob, filepath))) {
      untracedFiles.push(filepath);
      return false;
    }
    return true;
  }

  function files(moduleName: string) {
    const module_ = modulesByName.get(moduleName);
    if (!module_) return [moduleName];
    // Normalize module names, if there are any
    return module_.modules?.length
      ? module_.modules.map((m) => normalize(m.name))
      : [normalize(module_.name)];
  }

  const tracedFiles = [
    // Convert dependency names into their corresponding files which occur in the stats file.
    ...changedDependencies.flatMap((packageName) => nodeModules.get(packageName) || []),
    ...changedFiles,
  ].filter((file) => untrace(file));
  const tracedPaths = new Set<string>();
  const affectedModuleIds = new Set<string | number>();
  const checkedIds = {};
  const toCheck: TraceToCheck[] = [];

  const turboSnap: TurboSnap = {
    rootPath,
    baseDir: baseDirectory,
    storybookDir: storybookDirectory,
    staticDirs: staticDirectories,
    globs: [...csfGlobsByName],
    modules: [...modulesByName.keys()],
    tracedFiles,
    tracedPaths,
    affectedModuleIds,
    bailReason: undefined,
  };

  const changedPackageLockFiles = tracedFiles.filter((file) => isPackageLockFile(file));

  if (nodeModules.size === 0 && changedDependencies.length > 0) {
    // If we didn't find any node_modules in the stats file, it's probably incomplete and we can't
    // trace changed dependencies, so we bail just in case.
    turboSnap.bailReason = {
      changedPackageFiles: [
        ...(changedFiles?.filter((file) => isPackageManifestFile(file)) || []),
        ...changedPackageLockFiles,
      ],
      bailSubreason: 'nodeModulesMissingInStats',
    };
  }

  function shouldBail(moduleName: string) {
    // Check staticDirs before the Storybook config dir so static assets
    // nested under `.storybook/` (e.g. an MSW-generated mockServiceWorker.js
    // inside a configured staticDir) aren't mis-categorized as config changes.
    if (isStaticFile(moduleName)) {
      turboSnap.bailReason = { changedStaticFiles: files(moduleName) };
      return true;
    }

    if (isStorybookFile(moduleName)) {
      turboSnap.bailReason = { changedStorybookFiles: files(moduleName) };
      return true;
    }
    return false;
  }

  // TODO: refactor this function
  // eslint-disable-next-line complexity
  function traceName(name: string, tracePath: string[] = []) {
    if (turboSnap.bailReason || isCsfGlob(name)) return;
    if (shouldBail(name)) return;
    const { id } = modulesByName.get(name) || {};
    // eslint-disable-next-line unicorn/no-null
    const normalizedName = namesById.get(id || null);
    if (!normalizedName) return;
    if (shouldBail(normalizedName)) return;

    if (!id || !reasonsById.get(id) || checkedIds[id]) return;
    // Queue this id for tracing
    toCheck.push([id, [...tracePath, id.toString()]]);

    if (reasonsById.get(id)?.some((reason) => isCsfGlob(reason))) {
      affectedModuleIds.add(id);
      tracedPaths.add([...tracePath, id].map((pid) => namesById.get(pid)).join('\n'));
    }
  }

  if (traceChanged) {
    log.debug('Traced files...');
    log.debug(tracedFiles);
  }

  // First, check the files that have changed according to git
  tracedFiles.map((posixPath) => traceName(posixPath));
  // If more were found during that process, check them too.
  while (toCheck.length > 0) {
    const [id, tracePath] = toCheck.pop() as TraceToCheck;

    if (Array.isArray(id)) {
      log.debug('Trace ID is an unexpected value, skipping');
      continue;
    }
    if (!Array.isArray(tracePath)) {
      log.debug('Trace path is an unexpected value, skipping');
      continue;
    }

    checkedIds[id] = true;
    reasonsById
      .get(id)
      ?.filter((file) => untrace(file))
      .map((reason) => traceName(reason, tracePath));
  }
  const affectedModules = Object.fromEntries(
    // The id will be compared against the result of the stories' `.parameters.filename` values (stories retrieved from getStoriesJsonData())
    [...affectedModuleIds].map((id) => [String(id), files(namesById.get(id) || '')])
  );

  if (traceChanged) {
    log.debug('Affected modules...');
    log.debug(affectedModules);
  }

  if (traceChanged) {
    log.info(
      tracedAffectedFiles(
        {
          log,
          options: { storybookBaseDir, storybookConfigDir, traceChanged },
          turboSnap,
          untracedFiles,
        },
        {
          changedFiles,
          affectedModules,
          modulesByName: Object.fromEntries(modulesByName),
          normalize,
        }
      )
    );
    log.info('');
  }

  if (turboSnap.bailReason) {
    log.warn(bailFile({ turboSnap }));
    return { turboSnap, untracedFiles };
  }

  return { turboSnap, untracedFiles, affectedModules };
}
