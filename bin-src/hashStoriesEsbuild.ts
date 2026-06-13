import { existsSync, readdirSync, readFileSync } from 'fs';
import meow from 'meow';
import path from 'path';
import xxHashWasm from 'xxhash-wasm';

import { getRepositoryRoot } from '../node-src/git/git';
import { getFileHashes } from '../node-src/lib/getFileHashes';
import { createLogger } from '../node-src/lib/log';
import { posix } from '../node-src/lib/posix';
import { normalizePath } from '../node-src/lib/turbosnap/getDependentStoryFiles';
import { readStatsFile } from '../node-src/tasks/readStatsFile';
import { Stats } from '../node-src/types';

/**
 * EXPERIMENTAL — hash-based TurboSnap using esbuild as the dependency source, node_modules INCLUDED.
 *
 * This is a third variant to compare against:
 *   - `hash-stories`        : graph from the builder's preview-stats.json; node_modules collapsed to
 *                             `package [version]` read from each package's package.json on disk.
 *   - `trace-fidelity`      : compares an own-trace (esbuild/oxc) against the stats, source files only.
 *   - `hash-stories-esbuild` (this): own-trace via esbuild WITH node_modules bundled in, and every
 *                             node_modules file hashed like any other source file — no version
 *                             sniffing. A dependency change (version bump, patch-package edit, a
 *                             changed transitive resolution) shows up naturally as a changed file
 *                             hash, so every story importing it (directly or transitively) re-hashes.
 *
 * For each story esbuild bundles it (metafile, node_modules bundled, Node builtins external) and we
 * hash the full set of input files — first-party AND node_modules — then reduce to one per-story
 * hash. The shared section is the esbuild trace of the preview config plus the .storybook config dir
 * hashed from disk, so this also closes the Vite preview-deps gap that the stats-based variant has.
 *
 * The story list is taken from the builder stats purely to enumerate the same stories the other
 * scripts use (a production version would use Storybook's story index). esbuild is dynamically
 * imported as a research-only dependency.
 *
 * Command:
 *   chromatic hash-stories-esbuild [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir]
 *                                  [-m|--mode expanded] [--baseline <json>] [--limit N] [--json]
 */

const { STORYBOOK_BASE_DIR, STORYBOOK_CONFIG_DIR, WEBPACK_STATS_FILE } = process.env;

const baseName = (name: string) => (name ?? '').replace(/\s+\+\s+\d+\s+modules?$/, '');
const isNodeModule = (name: string) => /(?:^|\/)node_modules\//.test(name);
const isStoryFile = (name: string) => /\.stories\.\w+$|\.mdx$/.test(baseName(name));
const isStoriesListModule = (name: string) =>
  /(^|\/)storybook-stories\.[cm]?js$/.test(name) ||
  /(^|\/)generated-stories-entry\.[cm]?js$/.test(name);

const storiesEntryFileNames = [
  '.storybook/generated-stories-entry.js',
  './generated-stories-entry.js',
  './generated-stories-entry.cjs',
  './storybook-stories.js',
  '/virtual:/@storybook/builder-vite/vite-app.js',
  'virtual:@storybook/builder-vite/vite-app.js',
  './storybook-config-entry.js',
];

// Node builtins kept external so bundling node_modules under platform:browser doesn't fail to
// resolve them (os/path are instead aliased to browser shims, mirroring a typical Storybook config).
const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
  'node:*',
];

/**
 * Enumerate story files from the builder stats (so we hash the same set the other scripts do).
 *
 * @param stats The parsed builder stats.
 * @param normalize Normalizes a module path to a repo-root-relative POSIX path.
 *
 * @returns The repo-root-relative story file paths.
 */
function aliasResolver(stats: Stats, normalize: (p: string) => string) {
  const aliasTo = new Map<string, string>();
  for (const module_ of stats.modules) {
    const full = normalize(module_.name);
    aliasTo.set(full, full);
    aliasTo.set(baseName(full), full);
    for (const inner of module_.modules ?? []) aliasTo.set(normalize(inner.name), full);
  }
  return (name: string) => aliasTo.get(name) ?? aliasTo.get(baseName(name)) ?? name;
}

function detectStoryFiles(stats: Stats, normalize: (p: string) => string): string[] {
  const storybookEntries = new Set(storiesEntryFileNames.map((file) => normalize(file)));
  const resolve = aliasResolver(stats, normalize);

  const childrenByName = new Map<string, Set<string>>();
  const globBoundaries = new Set<string>();
  for (const module_ of stats.modules) {
    const full = normalize(module_.name);
    const reasons = (module_.reasons ?? [])
      .filter((reason) => reason.moduleName)
      .map((reason) => resolve(normalize(reason.moduleName)))
      .filter((reasonName) => reasonName && reasonName !== full);
    for (const parent of reasons) {
      if (!childrenByName.has(parent)) childrenByName.set(parent, new Set());
      childrenByName.get(parent)?.add(full);
    }
    const fromEntry = reasons.some(
      (reason) => storybookEntries.has(baseName(reason)) || isStoriesListModule(reason)
    );
    if (/\s+(sync|lazy)\s+/.test(full) && fromEntry) globBoundaries.add(full);
    if (isStoriesListModule(full)) globBoundaries.add(full);
  }

  return [...new Set([...globBoundaries].flatMap((glob) => [...(childrenByName.get(glob) ?? [])]))]
    .filter((name) => isStoryFile(name) && !globBoundaries.has(name) && !isNodeModule(name))
    .map((name) => baseName(name));
}

/**
 * Bundle each entry with esbuild (node_modules included, Node builtins external) and return the full
 * set of input files per entry, as repo-root-relative POSIX paths.
 *
 * @param rootPath The repository root.
 * @param entries Repo-root-relative entry files (stories and preview config).
 *
 * @returns A map of entry -> set of input files, and the set of entries that failed to bundle.
 */
async function esbuildInputs(rootPath: string, entries: string[]) {
  const esbuild = await import('esbuild'); // research-only dependency, kept out of the shipped CLI
  const tsconfig = path.join(rootPath, 'tsconfig.json');
  const assets = [
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.html',
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.woff',
    '.woff2',
  ];
  const options = {
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'silent' as const,
    platform: 'browser' as const,
    format: 'esm' as const,
    absWorkingDir: rootPath,
    tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
    alias: { os: 'os-browserify/browser', path: 'path-browserify' },
    external: NODE_BUILTINS,
    loader: Object.fromEntries(assets.map((extension) => [extension, 'empty' as const])),
  };

  const inputsByEntry = new Map<string, Set<string>>();
  const failed = new Set<string>();
  for (const entry of entries) {
    try {
      const result = await esbuild.build({ ...options, entryPoints: [path.join(rootPath, entry)] });
      inputsByEntry.set(
        entry,
        new Set(Object.keys(result.metafile?.inputs ?? {}).map((p) => posix(p)))
      );
    } catch {
      failed.add(entry);
    }
  }
  return { inputsByEntry, failed };
}

/**
 * Recursively list every file in the Storybook config dir, as repo-root-relative POSIX paths.
 *
 * @param rootPath The repository root.
 * @param configDirectory The Storybook config dir, relative to the repository root.
 *
 * @returns The list of repo-root-relative config file paths.
 */
function listConfigDirectoryFiles(rootPath: string, configDirectory: string): string[] {
  const absolute = path.join(rootPath, configDirectory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix(path.relative(rootPath, path.join(entry.parentPath, entry.name))));
}

interface StoryResult {
  story: string;
  hash: string;
  files: string[];
}

/**
 * The main entrypoint for `chromatic hash-stories-esbuild`.
 *
 * @param argv A list of arguments passed.
 */
// eslint-disable-next-line complexity
export async function main(argv: string[]) {
  const { flags } = meow(
    `
    Usage
      $ chromatic hash-stories-esbuild [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir] [-m|--mode expanded] [--baseline <json>] [--limit N] [--json]

    Options
      --stats-file, -s <filepath>           Path to preview-stats.json (used only to enumerate stories). (default: 'storybook-static/preview-stats.json')
      --storybook-base-dir, -b <dirname>    Relative path from repository root to Storybook project root.
      --storybook-config-dir, -c <dirname>  Storybook config dir. (default: '.storybook')
      --mode, -m <mode>                     Set to 'expanded' to print every file in each story's hash document.
      --baseline <filepath>                 Path to a previous --json output to diff against.
      --limit <n>                           Only hash the first N stories (faster iteration).
      --json                                Print machine-readable JSON.
    `,
    {
      argv,
      description: 'Hash-based TurboSnap using esbuild with node_modules bundled in',
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
        mode: { type: 'string', alias: 'm' },
        baseline: { type: 'string' },
        limit: { type: 'number' },
        json: { type: 'boolean', default: false },
      },
    }
  );

  const log = createLogger({}, { logPrefix: '', logLevel: flags.json ? 'error' : 'info' });
  const rootPath = await getRepositoryRoot({ log });
  if (!rootPath) throw new Error('Failed to determine repository root');

  const baseDirectory = flags.storybookBaseDir === '.' ? '' : flags.storybookBaseDir;
  const normalize = (p: string) => normalizePath(p, rootPath, baseDirectory);
  const xxhash = await xxHashWasm();
  const hashString = (input: string) => xxhash.h64(input).toString(16).padStart(16, '0');

  const stats = await readStatsFile(flags.statsFile);
  let storyFiles = detectStoryFiles(stats, normalize).filter((f) =>
    existsSync(path.join(rootPath, f))
  );
  if (flags.limit) storyFiles = storyFiles.slice(0, flags.limit);

  // Preview config entries are traced by esbuild too, so the shared section captures preview's full
  // dependency graph (including node_modules) — not just the config dir on disk.
  const previewFiles = ['preview.ts', 'preview.tsx', 'preview.js', 'preview.cjs', 'preview.mjs']
    .map((file) => posix(path.join(flags.storybookConfigDir, file)))
    .filter((file) => existsSync(path.join(rootPath, file)));

  const { inputsByEntry, failed } = await esbuildInputs(rootPath, [...storyFiles, ...previewFiles]);

  // Shared section: preview deps (from esbuild) + every file in the config dir (hashed from disk).
  const sharedFiles = new Set<string>(listConfigDirectoryFiles(rootPath, flags.storybookConfigDir));
  for (const preview of previewFiles) {
    for (const file of inputsByEntry.get(preview) ?? []) sharedFiles.add(file);
  }

  // Hash every unique file we touched, in one batched pass.
  const allFiles = new Set<string>(sharedFiles);
  for (const story of storyFiles) {
    for (const file of inputsByEntry.get(story) ?? []) allFiles.add(file);
  }
  const existing = [...allFiles].filter((file) => existsSync(path.join(rootPath, file)));
  const fileHashes = await getFileHashes(existing, rootPath, 20);
  const token = (file: string) => `${file} [${fileHashes[file] ?? 'missing'}]`;

  const sharedLines = [...sharedFiles].map((file) => token(file)).sort();

  const results: StoryResult[] = storyFiles
    .filter((story) => !failed.has(story))
    .map((story) => {
      const files = [...(inputsByEntry.get(story) ?? [])].sort();
      const document = [
        ...files.map((file) => token(file)).sort(),
        '--- shared ---',
        ...sharedLines,
      ].join('\n');
      return { story, hash: hashString(document), files };
    })
    .sort((a, b) => a.story.localeCompare(b.story));

  const storyHashes = Object.fromEntries(results.map((r) => [r.story, r.hash]));
  const diff = flags.baseline ? diffBaseline(flags.baseline, storyHashes) : undefined;

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        { storyHashes, sharedFileCount: sharedFiles.size, failed: [...failed], diff },
        undefined,
        2
      ) + '\n'
    );
    return;
  }

  report({ log, results, sharedFiles, failed, mode: flags.mode, diff });
}

interface BaselineDiff {
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Diff current per-story hashes against a previous --json output.
 *
 * @param baselinePath Path to a previous --json output.
 * @param current The current story -> hash map.
 *
 * @returns The changed, added, removed, and unchanged story sets.
 */
function diffBaseline(baselinePath: string, current: Record<string, string>): BaselineDiff {
  const baseline: Record<string, string> =
    JSON.parse(readFileSync(baselinePath, 'utf8')).storyHashes ?? {};
  const common = Object.keys(current).filter((story) => story in baseline);
  const changed = common.filter((story) => current[story] !== baseline[story]);
  return {
    changed: changed.sort(),
    added: Object.keys(current)
      .filter((story) => !(story in baseline))
      .sort(),
    removed: Object.keys(baseline)
      .filter((story) => !(story in current))
      .sort(),
    unchanged: common.length - changed.length,
  };
}

interface ReportArguments {
  log: ReturnType<typeof createLogger>;
  results: StoryResult[];
  sharedFiles: Set<string>;
  failed: Set<string>;
  mode?: string;
  diff?: BaselineDiff;
}

function report({ log, results, sharedFiles, failed, mode, diff }: ReportArguments) {
  log.info(`Hashed ${results.length} stories with esbuild (node_modules included).\n`);
  for (const { story, hash, files } of results) {
    const nodeModules = files.filter((f) => isNodeModule(f)).length;
    log.info(`  ${story} [${hash}] — ${files.length} files (${nodeModules} node_modules)`);
    if (mode === 'expanded') for (const file of files) log.info(`      ${file}`);
  }

  const sharedNodeModules = [...sharedFiles].filter((f) => isNodeModule(f)).length;
  log.info(
    `\nShared section: ${sharedFiles.size} files (${sharedNodeModules} node_modules), appended to every story.`
  );
  if (failed.size > 0) {
    log.info(`\n${failed.size} stories failed to bundle:`);
    for (const story of [...failed].sort()) log.info(`  ! ${story}`);
  }
  if (diff) {
    const needCapture = diff.changed.length + diff.added.length;
    log.info(
      `\nBaseline diff: ${needCapture} need re-capture ` +
        `(${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed, ${diff.unchanged} unchanged).`
    );
    for (const story of diff.changed) log.info(`  ~ ${story}`);
  }
}
