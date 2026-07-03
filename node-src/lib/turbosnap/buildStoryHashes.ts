import path from 'path';

import { Module, Stats } from '../../types';
import { posix } from '../posix';
import { matchesFile } from '../utilities';

/**
 * =============================================================================
 * TurboSnap 2.0 (Hash Based TS) — Proof of Concept, CLI side.
 * =============================================================================
 *
 * This module is the counterpart to {@link getDependentStoryFiles} (TurboSnap 1.0). Where TS 1.0
 * starts from a `git diff` and traces *forward* to the story files that depend on the changed
 * files, the hash-based approach never looks at git at all. Instead, for every story file we walk
 * the builder's dependency graph *downward* to collect the complete set of source files that story
 * depends on. Later, {@link buildHashManifest} hashes each of those files and folds them into a
 * single per-story hash. Two builds can then be compared purely by diffing hashes — no git diff, no
 * lockfile parsing, no baseline checkout required.
 *
 * This file is deliberately independent of the TS 1.0 tracer so the PoC can be reasoned about (and
 * removed) in isolation, but it reuses the same graph-shape assumptions and the same
 * `normalizePath` helper so paths line up with what TS 1.0 (and `git diff`) produce.
 */

// Ignore these while tracing dependencies (mirrors getDependentStoryFiles).
const INTERNALS = [/\/webpack\/runtime\//, /^\(webpack\)/];

const CSF_REGEX = /\s+(sync|lazy)\s+/g;
const URL_PARAM_REGEX = /(\?.*)/g;

const isUserModule = (module_: Module) =>
  module_.id !== undefined && module_.id !== null && !INTERNALS.some((re) => re.test(module_.name));

/**
 * Convert a builder module path to a repo-root-relative POSIX path (matching `git diff
 * --name-only`). Relative paths are joined onto the Storybook base directory; absolute paths are
 * made relative to the repo root; virtual paths are returned as-is. This mirrors `normalizePath` in
 * {@link getDependentStoryFiles} — kept inline so this PoC module stays independent of the TS 1.0
 * tracer (and its transitive imports).
 *
 * @param posixPath The POSIX path to the file.
 * @param rootPath The project root path.
 * @param baseDirectory The base directory to the file.
 *
 * @returns A normalized path to the file.
 */
function normalizePath(posixPath: string, rootPath: string, baseDirectory = '') {
  if (!posixPath || posixPath.startsWith('/virtual:')) return posixPath;

  return path.posix.isAbsolute(posixPath)
    ? path.posix.relative(rootPath, posixPath)
    : path.posix.join(baseDirectory, posixPath);
}

/**
 * A file that we resolved out of a module but could not (or should not) hash from disk. We still
 * record it in the manifest — with a synthetic hash derived from the module name — so that the
 * story hash changes if the *set* of such dependencies changes, and so debugging output isn't
 * silently missing dependencies.
 */
export interface UnhashableDependency {
  path: string;
  reason: 'external' | 'virtual';
}

export interface StoryDependencies {
  /** Story file path, relative to the repo root (matches `git diff --name-only`). */
  storyFile: string;
  /**
   * Real on-disk source files whose contents this story's hash covers — the story file itself plus
   * everything it transitively imports (excluding the shared global section). Sorted + deduped.
   */
  files: string[];
  /** Modules that have no hashable on-disk file (externals, virtual modules). */
  unhashable: UnhashableDependency[];
}

export interface BuildStoryHashesResult {
  /** Per-story dependency file lists. */
  stories: StoryDependencies[];
  /**
   * Files that are shared by *every* story and therefore folded into every story's hash: the
   * Storybook config directory (`.storybook/main.js`, `preview.js`, ...) and anything they import.
   * A change here bails the entire Storybook, matching TS 1.0's `changedStorybookFiles` behavior.
   */
  globalFiles: string[];
  globalUnhashable: UnhashableDependency[];
  /** The CSF "glob" container modules (the builder-generated story index entrypoints). */
  csfGlobs: string[];
  /** Every real file referenced (union of all story files, their deps, and the global set). */
  allFiles: string[];
}

export interface BuildStoryHashesOptions {
  rootPath: string;
  baseDir?: string;
  storybookConfigDir?: string;
  staticDir?: string[];
  /** Globs to disregard (and their dependencies), same semantics as the `--untraced` flag. */
  untraced?: string[];
}

/**
 * A module name coming out of the builder stats may be an ordinary file, an "external" reference
 * (e.g. `external "__STORYBOOK_MODULE_PREVIEW_API__"`), or a virtual module (e.g. Vite's
 * `/virtual:/...`). Classify it so we know whether it can be hashed from disk.
 *
 * @param name The (normalized) module name from the builder stats.
 *
 * @returns Whether the module is a real file, an external, or a virtual/bundle pseudo-module.
 */
function classifyModuleName(name: string): 'file' | 'external' | 'virtual' {
  if (!name) return 'virtual';
  if (name.startsWith('external ')) return 'external';
  if (name.includes('virtual:') || name.startsWith('/virtual:')) return 'virtual';
  // Webpack container/namespace pseudo-modules contain ' lazy ' / ' sync ' markers or are
  // multi-module bundles ("foo.js + N modules"). We can't hash those directly; we expand them via
  // their `modules` list instead (see expandFiles) and drop the container itself.
  if (CSF_REGEX.test(name) || / \+ \d+ modules?$/.test(name)) return 'virtual';
  return 'file';
}

/**
 * Trace the builder's module graph to produce, for each story file, the complete set of files it
 * depends on — plus the global (Storybook config) set shared by all stories.
 *
 * @param stats The parsed `preview-stats.json` from the builder (Webpack / Vite / Rspack).
 * @param options Repo root and Storybook layout information.
 *
 * @returns Per-story dependency file lists, the global file set, and bookkeeping.
 */
// eslint-disable-next-line complexity, max-statements
export function buildStoryHashes(
  stats: Stats,
  options: BuildStoryHashesOptions
): BuildStoryHashesResult {
  const {
    rootPath,
    baseDir: baseDirectory = '',
    storybookConfigDir: storybookConfigDirectory = '.storybook',
    staticDir: staticDirectory = [],
    untraced = [],
  } = options;

  // Convert a "builder path" to a repo-root-relative POSIX path, trimming URL params such as
  // `?ngResource`. Identical to the normalize() closure in getDependentStoryFiles. Real stats can
  // contain modules/reasons with null names, so coerce those to an empty string.
  const normalize = (posixPath: string | null | undefined): string => {
    if (!posixPath) return '';
    const newPath = normalizePath(posixPath, rootPath, baseDirectory);
    return URL_PARAM_REGEX.test(newPath) && !CSF_REGEX.test(newPath)
      ? newPath.replaceAll(URL_PARAM_REGEX, '')
      : newPath;
  };

  const storybookDirectory = normalize(posix(storybookConfigDirectory));
  const staticDirectories = staticDirectory.map((directory) => normalize(posix(directory)));

  // These are the builder-generated entrypoints that import the CSF glob(s). Copied from
  // getDependentStoryFiles so we detect story globs the same way across builders.
  const storiesEntryFiles = [
    `${storybookConfigDirectory}/generated-stories-entry.js`,
    `./generated-stories-entry.js`,
    `./generated-stories-entry.cjs`,
    `./storybook-stories.js`,
    `/virtual:/@storybook/builder-vite/vite-app.js`,
    `virtual:@storybook/builder-vite/vite-app.js`,
    `./node_modules/.cache/storybook/default/dev-server/storybook-stories.js`,
    './node_modules/.cache/storybook-rsbuild-builder/storybook-stories.js',
    `./node_modules/.cache/storybook/storybook-rsbuild-builder/storybook-config-entry.js`,
    `./node_modules/.cache/storybook-rsbuild-builder/storybook-config-entry.js`,
    `./storybook-config-entry.js`,
  ].map((file) => normalize(file));

  const isStorybookFile = (name: string) =>
    !!name && name.startsWith(`${storybookDirectory}/`) && !storiesEntryFiles.includes(name);
  const isStaticFile = (name: string) =>
    staticDirectories.some((directory) => name && name.startsWith(`${directory}/`));

  const untrace = (filepath: string) => {
    const stripped = filepath.replace(/\s\+\s\d+\smodules?$/, '');
    return !untraced.some((glob) => matchesFile(glob, stripped));
  };

  // ---------------------------------------------------------------------------
  // Index the graph.
  //   modulesByName: normalized name -> module (for expanding bundles to real files)
  //   childrenByName: normalized name -> normalized names it *imports* (forward edges)
  //
  // The stats only record "reasons" (who imports me = incoming edges). We invert them to get
  // outgoing edges so we can walk *downward* from a story to its dependencies.
  // ---------------------------------------------------------------------------
  const modulesByName = new Map<string, Module>();
  const childrenByName = new Map<string, Set<string>>();
  const csfGlobs = new Set<string>();

  const addChild = (parent: string, child: string) => {
    if (!parent || !child || parent === child) return;
    const children = childrenByName.get(parent) ?? new Set<string>();
    children.add(child);
    childrenByName.set(parent, children);
  };

  for (const module_ of stats.modules) {
    if (!isUserModule(module_)) continue;
    const normalizedName = normalize(module_.name);
    modulesByName.set(normalizedName, module_);

    // A bundle ("a.js + N modules") advertises its constituent files in `modules`; map each back to
    // the bundle so that edges pointing at either resolve to the same place.
    if (module_.modules) {
      for (const m of module_.modules) modulesByName.set(normalize(m.name), module_);
    }

    for (const reason of module_.reasons ?? []) {
      const importer = normalize(reason.moduleName);
      // reason = "importer imports this module", i.e. edge importer -> normalizedName.
      addChild(importer, normalizedName);
    }

    // Same CSF-glob detection as TS 1.0: a module directly imported by a stories entry file, that
    // isn't itself a config file, is the glob container whose children are the story files.
    const importedByEntry = module_.reasons?.some((reason) =>
      storiesEntryFiles.some((entry) => normalize(reason.moduleName).startsWith(entry))
    );
    if (normalizedName && importedByEntry && !isStorybookFile(normalizedName)) {
      csfGlobs.add(normalizedName);
    }
  }

  // Story files = the direct children of a CSF glob (button.stories.tsx, etc).
  const storyFileNames = new Set<string>();
  for (const glob of csfGlobs) {
    for (const child of childrenByName.get(glob) ?? []) {
      if (!csfGlobs.has(child) && !storiesEntryFiles.includes(child)) storyFileNames.add(child);
    }
  }

  // Expand a module name to the real, hashable, repo-relative file(s) it represents. Bundles expand
  // to their constituent `modules`; externals/virtuals are recorded separately as unhashable.
  const expandFiles = (
    name: string,
    files: Set<string>,
    unhashable: Map<string, UnhashableDependency>
  ) => {
    const module_ = modulesByName.get(name);
    const rawNames =
      module_?.modules?.length && module_.modules.length > 0
        ? module_.modules.map((m) => normalize(m.name))
        : [module_ ? normalize(module_.name) : name];

    for (const rawName of rawNames) {
      const kind = classifyModuleName(rawName);
      if (kind === 'file') files.add(rawName);
      else if (!unhashable.has(rawName)) unhashable.set(rawName, { path: rawName, reason: kind });
    }
  };

  // Walk downward from `roots`, collecting every reachable dependency's file(s). We stop at CSF
  // globs (so one story never pulls in every other story) and honor `--untraced`.
  const collectFrom = (roots: string[]) => {
    const files = new Set<string>();
    const unhashable = new Map<string, UnhashableDependency>();
    const seen = new Set<string>();
    const stack = [...roots];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current) || csfGlobs.has(current)) continue;
      seen.add(current);
      if (!untrace(current)) continue;

      expandFiles(current, files, unhashable);

      for (const child of childrenByName.get(current) ?? []) {
        if (!seen.has(child) && untrace(child)) stack.push(child);
      }
    }
    return { files, unhashable, seen };
  };

  // ---------------------------------------------------------------------------
  // Global / shared section: the Storybook config dir (main.js, preview.js and everything they
  // import). A change here recaptures every story, so we fold this into all story hashes.
  //
  // NOTE (edge case): with today's builder stats, `.storybook/main.js` and `preview.js` often do
  // *not* appear as their own graph nodes (see the pitch's open questions). We capture whatever
  // config-dir modules the stats *do* expose. Anything not represented in the graph is a known
  // blind spot for the PoC.
  // ---------------------------------------------------------------------------
  const globalRoots = [...modulesByName.keys()].filter(
    (name) => isStorybookFile(name) || isStaticFile(name)
  );
  const globalCollected = collectFrom(globalRoots);
  const globalFiles = [...globalCollected.files].sort();
  const globalUnhashable = [...globalCollected.unhashable.values()].sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  const globalFileSet = new Set(globalFiles);

  // ---------------------------------------------------------------------------
  // Per-story dependency sets.
  // ---------------------------------------------------------------------------
  const stories: StoryDependencies[] = [...storyFileNames]
    .map((storyModule): StoryDependencies => {
      const { files, unhashable } = collectFrom([storyModule]);
      // The collected files already include the story's own source file(s) (a webpack bundle like
      // `foo.stories.ts + 1 modules` expands to its constituents). Drop the global files, which are
      // hashed once in the shared section, and everything remaining — including the story file — is
      // what this story's hash covers.
      const storyFiles = [...files].filter((file) => !globalFileSet.has(file)).sort();
      return {
        // Use a clean path as the key: strip the webpack `+ N modules` bundle suffix.
        storyFile: storyModule.replace(/\s\+\s\d+\smodules?$/, ''),
        files: storyFiles,
        unhashable: [...unhashable.values()].sort((a, b) => a.path.localeCompare(b.path)),
      };
    })
    .sort((a, b) => a.storyFile.localeCompare(b.storyFile));

  const allFiles = [...new Set([...globalFiles, ...stories.flatMap((s) => s.files)])].sort();

  return {
    stories,
    globalFiles,
    globalUnhashable,
    csfGlobs: [...csfGlobs].sort(),
    allFiles,
  };
}
