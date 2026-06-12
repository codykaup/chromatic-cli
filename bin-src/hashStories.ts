import { existsSync, readFileSync } from 'fs';
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
 * Command:
 *   chromatic hash-stories [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir]
 *                          [-u|--untraced] [-m|--mode] [--json]
 *
 * Usage example:
 *   npx chromatic hash-stories -s ./storybook-static/preview-stats.json
 *   npx chromatic hash-stories -s ./preview-stats.json --mode expanded   # show the dependency tree
 *   npx chromatic hash-stories -s ./preview-stats.json --json            # machine-readable output
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

const NODE_MODULES_RE = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/;

/** Strip webpack's ` + N modules` suffix from a (concatenated) module name. */
const baseName = (name: string) => (name ?? '').replace(/\s+\+\s+\d+\s+modules?$/, '');

/** For any path inside node_modules, return the (optionally scoped) package name. */
const getPackageName = (modulePath: string) => modulePath.match(NODE_MODULES_RE)?.[1];

const isExternal = (name: string) => name.startsWith('external ');

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
  const csfGlobs = new Set<string>();
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

    // A CSF glob is the synthetic `require.context` module that pulls in all matched story files.
    // It's identifiable by webpack's ` sync `/` lazy ` marker AND by being imported from a stories
    // entry file. (The production tracer uses a broader test because it post-filters against the
    // real story index; here we need the precise set, or addon previews imported by the config
    // entry would be mistaken for stories.)
    const isContextModule = /\s+(sync|lazy)\s+/.test(full);
    if (
      !isStorybookFile(full) &&
      isContextModule &&
      reasons.some((reason) => storiesEntryFiles.has(baseName(reason)))
    ) {
      csfGlobs.add(full);
    }
  }

  // Story files are the source modules imported directly by a CSF glob.
  const storyFiles = [
    ...new Set([...csfGlobs].flatMap((glob) => [...(childrenByName.get(glob) ?? [])])),
  ].filter(
    (name) =>
      !csfGlobs.has(name) &&
      !isExternal(name) &&
      !getPackageName(name) &&
      !isStorybookFile(name) &&
      !storiesEntryFiles.has(baseName(name))
  );

  if (storyFiles.length === 0) {
    log.error('Did not find any CSF story files in the stats file. Is this a preview-stats.json?');
    throw new Error('No CSF globs found');
  }

  /**
   * Walk the dependency graph downwards from `start`, collecting a tree. node_modules files collapse
   * to a single `node_modules/<pkg>` leaf (we compare package versions, not their file contents),
   * externals collapse to their name, and source files recurse. Untraced files are pruned.
   *
   * @param start
   *
   * @returns
   */
  function trace(start: string) {
    const visited = new Set<string>();
    const sources = new Set<string>();
    const packages = new Set<string>();

    function walk(name: string): TreeNode | undefined {
      if (isUntraced(name)) return undefined;

      if (isExternal(name)) {
        externals.add(name);
        return { name, kind: 'external', children: [] };
      }

      const pkg = getPackageName(name);
      if (pkg) {
        packages.add(pkg);
        return { name: `node_modules/${pkg}`, kind: 'package', pkg, children: [] };
      }

      // Use the bare file path (without webpack's ` + N modules` suffix) for hashing and display,
      // but keep the full canonical `name` for graph traversal so edges still connect.
      const file = baseName(name);
      sources.add(file);
      const node: TreeNode = { name: file, kind: 'source', children: [] };
      if (visited.has(name)) return node; // already expanded elsewhere; list but don't recurse
      visited.add(name);

      const children = [...(childrenByName.get(name) ?? [])]
        .filter((child) => !csfGlobs.has(child))
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

  // --- Global / shared section: preview config + deps, main config, and all externals ---
  // A change to any of these should bust every story's hash.
  const previewFiles = [...canonicalByAlias.values()].filter((name) =>
    /(^|\/)preview\.(t|j)sx?$/.test(baseName(name))
  );
  const sharedSources = new Set<string>();
  const sharedPackages = new Set<string>();
  for (const previewFile of new Set(previewFiles)) {
    const { sources, packages } = trace(previewFile);
    for (const s of sources) sharedSources.add(s);
    for (const p of packages) sharedPackages.add(p);
  }

  // main.* is a node config file and isn't part of the preview bundle, so hash it straight from disk.
  const mainConfigFiles = ['main.ts', 'main.tsx', 'main.js', 'main.cjs', 'main.mjs']
    .map((file) => normalize(posix(path.join(flags.storybookConfigDir, file))))
    .filter((file) => existsSync(path.join(rootPath, file)));
  for (const file of mainConfigFiles) sharedSources.add(file);

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

  // Stable token for each tree entry, used both for the document and the final story hash.
  const tokenFor = (name: string, kind: TreeNode['kind'], pkg?: string) => {
    if (kind === 'external') return `${name} [external]`;
    if (kind === 'package') return `node_modules/${pkg} [${packageVersions.get(pkg ?? '') ?? '?'}]`;
    return `${name} [${hashFor(name)}]`;
  };

  // The shared section lines, computed once and appended to every story's document.
  const sharedLines = [
    ...[...sharedSources].map((file) => tokenFor(file, 'source')),
    ...[...sharedPackages].map((pkg) => tokenFor(`node_modules/${pkg}`, 'package', pkg)),
    ...[...externals].map((name) => tokenFor(name, 'external')),
  ]
    .sort()
    .filter((line, index, all) => all.indexOf(line) === index);

  const hashString = (input: string) => xxhash.h64(input).toString(16).padStart(16, '0');

  const results = storyTrees.map(({ storyFile, sources, packages }) => {
    const storyLines = [
      ...[...sources].map((file) => tokenFor(file, 'source')),
      ...[...packages].map((pkg) => tokenFor(`node_modules/${pkg}`, 'package', pkg)),
    ]
      .sort()
      .filter((line, index, all) => all.indexOf(line) === index);

    // The "document": a canonical, order-independent representation of everything the story depends
    // on, plus the shared section. Hash it down to a single value for the story.
    const document = [...storyLines, '--- shared ---', ...sharedLines].join('\n');
    const hash = hashString(document);
    return { storyFile, hash, storyLines, document };
  });

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          storyHashes: Object.fromEntries(results.map((r) => [r.storyFile, r.hash])),
          sharedSection: sharedLines,
          missingSources,
        },
        undefined,
        2
      ) + '\n'
    );
    return;
  }

  report({ log, results, storyTrees, sharedLines, missingSources, mode: flags.mode, tokenFor });
}

/**
 * Read a package's version from its installed package.json, falling back to 'unknown'.
 *
 * @param rootPath
 * @param pkg
 *
 * @returns
 */
function getPackageVersion(rootPath: string, pkg: string) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(rootPath, 'node_modules', pkg, 'package.json'), 'utf8')
    );
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Pretty-print the dependency tree for a story (only used in --mode expanded).
 *
 * @param node
 * @param tokenFor
 * @param depth
 *
 * @returns
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
}

function report({
  log,
  results,
  storyTrees,
  sharedLines,
  missingSources,
  mode,
  tokenFor,
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
}
