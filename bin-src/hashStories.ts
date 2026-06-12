/* eslint-disable max-lines -- research/prototype script: trace + hashing + reporting + diff in one file */
import { existsSync, readdirSync, readFileSync } from 'fs';
import meow from 'meow';
import path from 'path';
import xxHashWasm from 'xxhash-wasm';

import { getRepositoryRoot } from '../node-src/git/git';
import { getFileHashes } from '../node-src/lib/getFileHashes';
import { createLogger } from '../node-src/lib/log';
import { posix } from '../node-src/lib/posix';
import { normalizePath } from '../node-src/lib/turbosnap/getDependentStoryFiles';
import { matchesFile } from '../node-src/lib/utilities';
import { readStatsFile } from '../node-src/tasks/readStatsFile';

/**
 * EXPERIMENTAL — prototype for hash-based TurboSnap.
 *
 * Rather than tracing *changed git files* forward to affected story files (what the production
 * `getDependentStoryFiles` does), this script does the opposite: for every CSF (story) file in a
 * Storybook build, it walks the dependency graph *downwards* to collect every source file the story
 * transitively depends on, hashes each of those files, and boils the whole tree down to a single
 * hash for the story.
 *
 * The idea: two builds can be compared purely by these per-story hashes. Any story whose hash
 * changed between baseline and head needs to be re-captured — no git diffing required. Because every
 * story's document also includes the shared "global" section (preview config, main config, and all
 * external modules), changing a shared dependency busts the hash of every story that depends on it.
 *
 * This is a research tool to validate the algorithm against real `preview-stats.json` files before
 * we commit to replacing the production implementation. It intentionally lives alongside `trace.ts`
 * and reuses the same normalization logic.
 *
 * KNOWN LIMITATION — preview dependencies under Vite:
 *   Webpack's `preview-stats.json` is the real compiler graph, so the preview config and everything
 *   it imports are present and get folded into the shared section. Vite's stats are synthesized by a
 *   Rollup plugin that filters out the virtual modules the preview config is wired through, so
 *   `.storybook/preview.*` and its *external* dependencies (files imported by preview that live
 *   outside the config dir, e.g. a shared theme in `src/`) are absent from the graph entirely.
 *   To stay correct we take the same conservative stance the production tracer takes today — where a
 *   change anywhere in the config dir bails the whole build — by hashing the entire `.storybook`
 *   config dir from disk into the shared section (see `listConfigDirectoryFiles`). That busts every
 *   story hash on any in-config change. It does NOT yet catch preview's *external* deps under Vite
 *   (a pre-existing blind spot in TurboSnap too). Closing that needs a fuller graph — either a
 *   Chromatic-owned Vite plugin reading Rollup's full module info, or resolving preview's imports
 *   ourselves (e.g. an esbuild/Vite metafile rooted at the preview entry).
 *
 * Command:
 *   chromatic hash-stories [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir]
 *                          [-u|--untraced] [-m|--mode] [--baseline] [--json]
 *
 * Usage example:
 *   npx chromatic hash-stories -s ./storybook-static/preview-stats.json
 *   npx chromatic hash-stories -s ./preview-stats.json --mode expanded   # show the dependency tree
 *   npx chromatic hash-stories -s ./preview-stats.json --json            # machine-readable output
 *   npx chromatic hash-stories -s ./head.json --baseline ./base.json     # diff against a prior run
 */

const { STORYBOOK_BASE_DIR, STORYBOOK_CONFIG_DIR, WEBPACK_STATS_FILE } = process.env;

type FilePath = string;

/** A node in a story's dependency tree, used for both display and hashing. */
interface TreeNode {
  /** The label we hash / display, e.g. `src/Button.tsx` or `node_modules/react`. */
  name: string;
  kind: 'source' | 'package' | 'external';
  /** For `package` nodes, the resolved package name (used to look up its version). */
  pkg?: string;
  children: TreeNode[];
}

// Mirror the entry files getDependentStoryFiles recognizes, so we can identify the CSF glob modules.
const storiesEntryFileNames = [
  '.storybook/generated-stories-entry.js',
  './generated-stories-entry.js',
  './generated-stories-entry.cjs',
  './storybook-stories.js',
  '/virtual:/@storybook/builder-vite/vite-app.js',
  'virtual:@storybook/builder-vite/vite-app.js',
  './node_modules/.cache/storybook/default/dev-server/storybook-stories.js',
  './node_modules/.cache/storybook-rsbuild-builder/storybook-stories.js',
  './node_modules/.cache/storybook/storybook-rsbuild-builder/storybook-config-entry.js',
  './node_modules/.cache/storybook-rsbuild-builder/storybook-config-entry.js',
  './storybook-config-entry.js',
];

// Strip webpack's ` + N modules` suffix from a (concatenated) module name.
const baseName = (name: string) => (name ?? '').replace(/\s+\+\s+\d+\s+modules?$/, '');

// Return the path to the package directory a node_modules file resolves from — everything up to and
// including the package name, anchored at the LAST `node_modules/` segment. This makes nested
// (non-hoisted) installs resolve to their own version rather than a hoisted top-level one, e.g.
// `node_modules/react-dom/node_modules/scheduler` rather than `node_modules/scheduler`.
const getPackageRoot = (modulePath: string) => {
  const marker = 'node_modules/';
  const index = modulePath.lastIndexOf(marker);
  if (index === -1) return undefined;
  const after = modulePath.slice(index + marker.length);
  const parts = after.split('/');
  const pkg = after.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return `${modulePath.slice(0, index)}${marker}${pkg}`;
};

const isExternal = (name: string) => name.startsWith('external ');

// Whether a module path looks like a CSF story file (matches Storybook's default story glob).
const isStoryFile = (name: string) => /\.stories\.\w+$|\.mdx$/.test(baseName(name));

// Whether a module enumerates story files: webpack's `storybook-stories.js` /
// `generated-stories-entry.js`, or the Vite virtual equivalent. Story files are direct children of
// one of these (webpack additionally inserts a `require.context` glob module in between).
const isStoriesListModule = (name: string) =>
  /(^|\/)storybook-stories\.[cm]?js$/.test(name) ||
  /(^|\/)generated-stories-entry\.[cm]?js$/.test(name);

/**
 * The main entrypoint for `chromatic hash-stories`.
 *
 * @param argv A list of arguments passed.
 */
// eslint-disable-next-line complexity, max-statements
export async function main(argv: string[]) {
  const { flags } = meow(
    `
    Usage
      $ chromatic hash-stories [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir] [-u|--untraced] [-m|--mode] [--json]

    Options
      --stats-file, -s <filepath>           Path to preview-stats.json. Alternatively, set WEBPACK_STATS_FILE. (default: 'storybook-static/preview-stats.json')
      --storybook-base-dir, -b <dirname>    Relative path from repository root to Storybook project root.
      --storybook-config-dir, -c <dirname>  Directory where Storybook configuration lives. (default: '.storybook')
      --untraced, -u <filepath>             Disregard these files and their dependencies. Globs supported via picomatch. Repeatable.
      --mode, -m <mode>                     Set to 'expanded' to print the full dependency tree for each story.
      --baseline <filepath>                 Path to a previous --json output to diff against; reports the stories that would need re-capture.
      --json                                Print machine-readable JSON instead of a human report.
    `,
    {
      argv,
      description: 'Experimental hash-based TurboSnap prototype',
      flags: {
        statsFile: {
          type: 'string',
          alias: 's',
          default: WEBPACK_STATS_FILE || 'storybook-static/preview-stats.json',
        },
        storybookBaseDir: { type: 'string', alias: 'b', default: STORYBOOK_BASE_DIR || '.' },
        storybookConfigDir: {
          type: 'string',
          alias: 'c',
          default: STORYBOOK_CONFIG_DIR || '.storybook',
        },
        untraced: { type: 'string', alias: 'u', isMultiple: true },
        mode: { type: 'string', alias: 'm' },
        baseline: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    }
  );

  const log = createLogger({}, { logPrefix: '', logLevel: flags.json ? 'error' : 'info' });
  const rootPath = await getRepositoryRoot({ log });
  if (!rootPath) throw new Error('Failed to determine repository root');

  const baseDirectory = flags.storybookBaseDir === '.' ? '' : flags.storybookBaseDir;
  const stats = await readStatsFile(flags.statsFile);

  const xxhash = await xxHashWasm();

  // Convert a webpack module path into a repo-root-relative POSIX path, matching getDependentStoryFiles.
  const normalize = (posixPath: FilePath) => {
    const URL_PARAM_REGEX = /(\?.*)/g;
    const CSF_REGEX = /\s+(sync|lazy)\s+/g;
    const newPath = normalizePath(posixPath, rootPath, baseDirectory);
    return URL_PARAM_REGEX.test(newPath) && !CSF_REGEX.test(newPath)
      ? newPath.replaceAll(URL_PARAM_REGEX, '')
      : newPath;
  };

  const storybookDirectory = normalize(posix(flags.storybookConfigDir));
  const storiesEntryFiles = new Set(storiesEntryFileNames.map((file) => normalize(file)));
  const isStorybookFile = (name: string) =>
    name && name.startsWith(`${storybookDirectory}/`) && !storiesEntryFiles.has(name);

  // Honour --untraced just like the production tracer does.
  const untraced = flags.untraced ?? [];
  const isUntraced = (name: string) => {
    const filepath = baseName(name);
    return untraced.some((glob) => matchesFile(glob, filepath));
  };

  // Build a canonical alias map so edges connect even when one side carries the ` + N modules`
  // suffix or refers to an inner module of a concatenated bundle.
  const canonicalByAlias = new Map<string, string>();
  for (const module_ of stats.modules) {
    const full = normalize(module_.name);
    canonicalByAlias.set(full, full);
    canonicalByAlias.set(baseName(full), full);
    for (const inner of module_.modules ?? []) {
      canonicalByAlias.set(normalize(inner.name), full);
    }
  }
  const resolve = (name: string) =>
    canonicalByAlias.get(name) ?? canonicalByAlias.get(baseName(name)) ?? name;

  // Forward edges: childrenByName[A] = the set of modules A imports.
  const childrenByName = new Map<string, Set<string>>();
  // Modules that enumerate stories and act as traversal boundaries: webpack `require.context` globs
  // and the webpack/Vite stories-list modules. Story files are their direct children.
  const globBoundaries = new Set<string>();
  const externals = new Set<string>();

  for (const module_ of stats.modules) {
    const full = normalize(module_.name);
    if (isExternal(full)) externals.add(full);

    const reasons = (module_.reasons ?? [])
      .filter((reason) => reason.moduleName)
      .map((reason) => resolve(normalize(reason.moduleName)))
      .filter((reasonName) => reasonName && reasonName !== full);

    for (const parent of reasons) {
      if (!childrenByName.has(parent)) childrenByName.set(parent, new Set());
      childrenByName.get(parent)?.add(full);
    }

    // The webpack `require.context` glob (identified by the ` sync `/` lazy ` marker and a reason
    // pointing at a stories entry) inserts itself between the stories-list module and the stories.
    const isContextModule = /\s+(sync|lazy)\s+/.test(full);
    const fromStoriesEntry = reasons.some(
      (reason) => storiesEntryFiles.has(baseName(reason)) || isStoriesListModule(reason)
    );
    if (!isStorybookFile(full) && isContextModule && fromStoriesEntry) globBoundaries.add(full);

    // The stories-list module itself (webpack `storybook-stories.js`, or the Vite virtual module
    // which imports the story files directly).
    if (isStoriesListModule(full)) globBoundaries.add(full);
  }

  // Story files are the children of a glob boundary that look like CSF/MDX files. (For webpack the
  // stories-list module's only child is the context glob, which isn't a story file and is filtered
  // out here; the actual stories hang off the context glob.)
  const storyFiles = [
    ...new Set([...globBoundaries].flatMap((glob) => [...(childrenByName.get(glob) ?? [])])),
  ].filter(
    (name) =>
      isStoryFile(name) &&
      !globBoundaries.has(name) &&
      !isExternal(name) &&
      !getPackageRoot(name) &&
      !isStorybookFile(name)
  );

  if (storyFiles.length === 0) {
    log.error('Did not find any CSF story files in the stats file. Is this a preview-stats.json?');
    throw new Error('No CSF globs found');
  }

  // Walk the dependency graph downwards from `start`, collecting a tree. node_modules files collapse
  // to a single leaf keyed by their resolved (possibly nested) location — we compare package
  // versions, not file contents. Externals collapse to their name, source files recurse, and
  // untraced files are pruned.
  function trace(start: string) {
    const visited = new Set<string>();
    const sources = new Set<string>();
    // Keyed by package root path (e.g. `node_modules/react-dom/node_modules/scheduler`), so nested
    // installs of the same package are tracked—and versioned—separately.
    const packages = new Set<string>();

    function walk(name: string): TreeNode | undefined {
      if (isUntraced(name)) return undefined;

      if (isExternal(name)) {
        externals.add(name);
        return { name, kind: 'external', children: [] };
      }

      const packageRoot = getPackageRoot(baseName(name));
      if (packageRoot) {
        packages.add(packageRoot);
        return { name: packageRoot, kind: 'package', pkg: packageRoot, children: [] };
      }

      // Use the bare file path (without webpack's ` + N modules` suffix) for hashing and display,
      // but keep the full canonical `name` for graph traversal so edges still connect.
      const file = baseName(name);
      sources.add(file);
      const node: TreeNode = { name: file, kind: 'source', children: [] };
      if (visited.has(name)) return node; // already expanded elsewhere; list but don't recurse
      visited.add(name);

      const children = [...(childrenByName.get(name) ?? [])]
        .filter((child) => !globBoundaries.has(child))
        .sort();
      for (const child of children) {
        const childNode = walk(child);
        if (childNode) node.children.push(childNode);
      }
      return node;
    }

    const tree = walk(start);
    return { tree, sources, packages };
  }

  // --- Global / shared section: preview config + deps, the .storybook config dir, and externals ---
  // A change to any of these should bust every story's hash.
  const sharedSources = new Set<string>();
  const sharedPackages = new Set<string>();

  // When the builder includes the preview config in the stats (webpack does; Vite does not), trace
  // its dependency tree so changes to preview deps propagate too.
  const previewFiles = [...canonicalByAlias.values()].filter((name) =>
    /(^|\/)preview\.(t|j)sx?$/.test(baseName(name))
  );
  for (const previewFile of new Set(previewFiles)) {
    const { sources, packages } = trace(previewFile);
    for (const s of sources) sharedSources.add(s);
    for (const p of packages) sharedPackages.add(p);
  }

  // Hash every file in the .storybook config dir straight from disk. This is builder-agnostic and
  // covers main.* and preview.* (plus any local config/theme files) even when — as with Vite — the
  // preview config and its deps are absent from the stats file. NOTE: this still misses preview
  // dependencies that live *outside* the config dir under Vite; see the script docs.
  for (const file of listConfigDirectoryFiles(rootPath, flags.storybookConfigDir)) {
    sharedSources.add(file);
  }

  // --- Per-story dependency trees ---
  const storyTrees = storyFiles
    .map((storyFile) => ({ storyFile, ...trace(storyFile) }))
    .sort((a, b) => a.storyFile.localeCompare(b.storyFile));

  // --- Hash every source file we touched (one batched pass), and resolve package versions ---
  const allSources = new Set<string>(sharedSources);
  const allPackages = new Set<string>(sharedPackages);
  for (const { sources, packages } of storyTrees) {
    for (const s of sources) allSources.add(s);
    for (const p of packages) allPackages.add(p);
  }

  const existingSources = [...allSources].filter((file) => existsSync(path.join(rootPath, file)));
  const missingSources = [...allSources].filter((file) => !existsSync(path.join(rootPath, file)));
  const fileHashes = await getFileHashes(existingSources, rootPath, 10);
  const hashFor = (file: string) => fileHashes[file] ?? 'missing';

  const packageVersions = new Map<string, string>();
  for (const pkg of allPackages) {
    packageVersions.set(pkg, getPackageVersion(rootPath, pkg));
  }

  // Stable token for each tree entry, used both for the document and the final story hash. Package
  // entries are keyed by their resolved root path and labelled with the installed version.
  const tokenFor = (name: string, kind: TreeNode['kind'], pkg?: string) => {
    if (kind === 'external') return `${name} [external]`;
    if (kind === 'package') return `${pkg} [${packageVersions.get(pkg ?? '') ?? '?'}]`;
    return `${name} [${hashFor(name)}]`;
  };

  // The shared section lines, computed once and appended to every story's document.
  const sharedLines = [
    ...[...sharedSources].map((file) => tokenFor(file, 'source')),
    ...[...sharedPackages].map((pkg) => tokenFor(pkg, 'package', pkg)),
    ...[...externals].map((name) => tokenFor(name, 'external')),
  ]
    .sort()
    .filter((line, index, all) => all.indexOf(line) === index);

  const hashString = (input: string) => xxhash.h64(input).toString(16).padStart(16, '0');

  const results = storyTrees.map(({ storyFile, sources, packages }) => {
    const storyLines = [
      ...[...sources].map((file) => tokenFor(file, 'source')),
      ...[...packages].map((pkg) => tokenFor(pkg, 'package', pkg)),
    ]
      .sort()
      .filter((line, index, all) => all.indexOf(line) === index);

    // The "document": a canonical, order-independent representation of everything the story depends
    // on, plus the shared section. Hash it down to a single value for the story.
    const document = [...storyLines, '--- shared ---', ...sharedLines].join('\n');
    const hash = hashString(document);
    return { storyFile, hash, storyLines, document };
  });

  const storyHashes = Object.fromEntries(results.map((r) => [r.storyFile, r.hash]));

  // When a baseline (a prior --json run) is supplied, diff against it: any story whose hash differs
  // — or that is new — would need re-capture. This is the crux of the hash-based approach.
  const diff = flags.baseline ? diffBaseline(flags.baseline, storyHashes) : undefined;

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        { storyHashes, sharedSection: sharedLines, missingSources, diff },
        undefined,
        2
      ) + '\n'
    );
    return;
  }

  report({
    log,
    results,
    storyTrees,
    sharedLines,
    missingSources,
    mode: flags.mode,
    tokenFor,
    diff,
  });
}

interface BaselineDiff {
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Compare current per-story hashes against a baseline (a previous --json output) and report which
 * stories would need re-capture.
 *
 * @param baselinePath Path to a previous --json output file.
 * @param current The current map of story file -> hash.
 *
 * @returns The set of changed, added, removed, and unchanged stories.
 */
function diffBaseline(baselinePath: string, current: Record<string, string>): BaselineDiff {
  const baseline: Record<string, string> =
    JSON.parse(readFileSync(baselinePath, 'utf8')).storyHashes ?? {};
  const common = Object.keys(current).filter((story) => story in baseline);
  const changed = common.filter((story) => current[story] !== baseline[story]);
  const added = Object.keys(current).filter((story) => !(story in baseline));
  const removed = Object.keys(baseline).filter((story) => !(story in current));
  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    unchanged: common.length - changed.length,
  };
}

/**
 * Recursively list every file in the Storybook config dir, as repo-root-relative POSIX paths. Used
 * to fold the whole .storybook config (main, preview, themes, etc.) into the shared section.
 *
 * @param rootPath The repository root.
 * @param configDirectory The Storybook config dir, relative to the repository root.
 *
 * @returns A list of repo-root-relative POSIX file paths.
 */
function listConfigDirectoryFiles(rootPath: string, configDirectory: string): string[] {
  const absoluteConfigDirectory = path.join(rootPath, configDirectory);
  if (!existsSync(absoluteConfigDirectory)) return [];
  return readdirSync(absoluteConfigDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix(path.relative(rootPath, path.join(entry.parentPath, entry.name))));
}

/**
 * Read the exact installed version from a package's package.json at its resolved (possibly nested)
 * location on disk, falling back to 'unknown'. Reading the actually-installed version — rather than
 * the manifest range or a lockfile — means we detect any dependency bump that changes what's really
 * on disk, regardless of whether package.json itself changed.
 *
 * @param rootPath The repository root.
 * @param packageRoot The repo-root-relative path to the package directory (e.g.
 * `node_modules/react-dom/node_modules/scheduler`).
 *
 * @returns The installed version string, or 'unknown'.
 */
function getPackageVersion(rootPath: string, packageRoot: string) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(rootPath, packageRoot, 'package.json'), 'utf8')
    );
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Pretty-print the dependency tree for a story (only used in --mode expanded).
 *
 * @param node The tree node to print.
 * @param tokenFor Formats a node into its `path [hash|version]` token.
 * @param depth The current indentation depth.
 *
 * @returns The rendered, indented tree as a string.
 */
function printTree(
  node: TreeNode,
  tokenFor: (name: string, kind: TreeNode['kind'], pkg?: string) => string,
  depth = 0
): string {
  const indent = '  '.repeat(depth);
  const line = `${indent}- ${tokenFor(node.name, node.kind, node.pkg)}`;
  return [line, ...node.children.map((child) => printTree(child, tokenFor, depth + 1))].join('\n');
}

interface ReportArguments {
  log: ReturnType<typeof createLogger>;
  results: { storyFile: string; hash: string }[];
  storyTrees: { storyFile: string; tree?: TreeNode }[];
  sharedLines: string[];
  missingSources: string[];
  mode?: string;
  tokenFor: (name: string, kind: TreeNode['kind'], pkg?: string) => string;
  diff?: BaselineDiff;
}

function report({
  log,
  results,
  storyTrees,
  sharedLines,
  missingSources,
  mode,
  tokenFor,
  diff,
}: ReportArguments) {
  log.info(`Hashed ${results.length} story files:\n`);

  if (mode === 'expanded') {
    const treesByStory = new Map(storyTrees.map((t) => [t.storyFile, t.tree]));
    for (const { storyFile, hash } of results) {
      const tree = treesByStory.get(storyFile);
      log.info(`${storyFile} [${hash}]`);
      if (tree) for (const child of tree.children) log.info(printTree(child, tokenFor, 1));
      log.info('');
    }
  } else {
    for (const { storyFile, hash } of results) {
      log.info(`  ${storyFile} [${hash}]`);
    }
  }

  log.info(`\nShared section (appended to every story, ${sharedLines.length} entries):`);
  for (const line of sharedLines) log.info(`  ${line}`);

  if (missingSources.length > 0) {
    log.info(`\n${missingSources.length} referenced source files were not found on disk:`);
    for (const file of missingSources) log.info(`  ${file}`);
  }

  if (diff) reportDiff(log, diff);
}

/**
 * Print the baseline diff: how many stories would need re-capture and which ones.
 *
 * @param log The logger.
 * @param diff The computed baseline diff.
 */
function reportDiff(log: ReturnType<typeof createLogger>, diff: BaselineDiff) {
  const needCapture = diff.changed.length + diff.added.length;
  log.info(
    `\nBaseline diff: ${needCapture} stories need re-capture ` +
      `(${diff.changed.length} changed, ${diff.added.length} added, ` +
      `${diff.removed.length} removed, ${diff.unchanged} unchanged).`
  );
  for (const story of diff.changed) log.info(`  ~ ${story}`);
  for (const story of diff.added) log.info(`  + ${story}`);
  for (const story of diff.removed) log.info(`  - ${story}`);
}
