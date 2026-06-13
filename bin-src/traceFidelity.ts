/* eslint-disable max-lines -- research/prototype script: two own-tracers + stats trace + reporting */
import { existsSync, readFileSync } from 'fs';
import meow from 'meow';
import path from 'path';

import { getRepositoryRoot } from '../node-src/git/git';
import { createLogger } from '../node-src/lib/log';
import { posix } from '../node-src/lib/posix';
import { normalizePath } from '../node-src/lib/turbosnap/getDependentStoryFiles';
import { readStatsFile } from '../node-src/tasks/readStatsFile';
import { Stats } from '../node-src/types';

/**
 * EXPERIMENTAL — fidelity check for a builder-agnostic dependency tracer.
 *
 * The hash-based prototype (`hash-stories`) relies on the builder's `preview-stats.json`, which
 * differs between webpack (complete) and Vite (lossy). A more appealing design is to trace file
 * dependencies *ourselves*, outside the builder, so behavior is identical regardless of builder. The
 * open question is whether our own resolver is *faithful* — does it find the same dependencies the
 * builder actually bundled?
 *
 * This script answers that empirically. For every story file, it computes two dependency sets:
 *   1. STATS — the source files reachable from the story in the builder's stats graph (the ground
 *      truth of what the builder bundled).
 *   2. OWN — the source files reachable from the same story when we trace it ourselves with esbuild
 *      (bundle + metafile, node_modules externalized), standing in for an independent resolver.
 *
 * It then diffs the two per story and reports:
 *   - MISSED: files the builder bundled but our tracer didn't find. These are the dangerous ones —
 *     a miss means under-capture (a real visual change we'd skip).
 *   - EXTRA:  files our tracer found that the builder didn't. These cause over-capture (wasted
 *     snapshots) but are safe.
 *
 * The goal is to quantify how trustworthy an external tracer would be before we commit to replacing
 * the stats-based approach. Two own-tracers are provided via --resolver:
 *   - 'esbuild' (default): bundle + metafile. esbuild compiles TS and tree-shakes, so it elides
 *     type-only imports and dead code just like the real builder.
 *   - 'oxc': oxc-parser (import extraction) + oxc-resolver (resolution). A pure resolver/parser with
 *     no bundling. Requires `npm i oxc-parser oxc-resolver` (kept out of the shipped CLI).
 *
 * FINDINGS (this repo, vs freshly built Vite stats):
 *   - esbuild: 100% coverage, 0 missed, 0 EXTRA. Faithful.
 *   - oxc:     100% coverage, 0 missed, but ~9k EXTRA files (massive over-capture) concentrated in a
 *     long tail (median 0 extra/story, max ~217). Root causes a bare resolver can't handle:
 *       1. Type-only imports written WITHOUT the `type` keyword, e.g. `import { Context } from
 *          '../types'` where Context is an interface. esbuild does TS-aware elision and drops it; a
 *          syntactic tracer follows it into the type barrel and pulls in the whole app graph.
 *       2. Tree-shaking / dead-code elimination of unused exports (esp. via barrel files).
 *   Conclusion: an external tracer IS viable, but it needs bundler-grade TS elision + tree-shaking
 *   (esbuild gives this for free); resolution alone over-captures badly and defeats TurboSnap.
 *
 * Command:
 *   chromatic trace-fidelity [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir]
 *                            [--resolver esbuild|oxc] [--limit N] [--worst N] [--json]
 */

const { STORYBOOK_BASE_DIR, STORYBOOK_CONFIG_DIR, WEBPACK_STATS_FILE } = process.env;

const baseName = (name: string) => (name ?? '').replace(/\s+\+\s+\d+\s+modules?$/, '');
const isExternal = (name: string) => name.startsWith('external ');
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

/**
 * Build a resolver that maps any module alias (the ` + N modules` form, or an inner module of a
 * concatenated bundle) to its canonical module name, so graph edges connect.
 *
 * @param stats The parsed builder stats.
 * @param normalize Normalizes a module path to a repo-root-relative POSIX path.
 *
 * @returns A function resolving an alias to its canonical name.
 */
function buildAliasResolver(stats: Stats, normalize: (p: string) => string) {
  const canonicalByAlias = new Map<string, string>();
  for (const module_ of stats.modules) {
    const full = normalize(module_.name);
    canonicalByAlias.set(full, full);
    canonicalByAlias.set(baseName(full), full);
    for (const inner of module_.modules ?? []) canonicalByAlias.set(normalize(inner.name), full);
  }
  return (name: string) =>
    canonicalByAlias.get(name) ?? canonicalByAlias.get(baseName(name)) ?? name;
}

/**
 * Build the forward dependency graph and story/glob boundaries from the builder stats. Mirrors the
 * stats traversal in `hash-stories`.
 *
 * @param stats The parsed builder stats.
 * @param normalize Normalizes a webpack/vite module path to a repo-root-relative POSIX path.
 *
 * @returns The forward-edge map, the set of glob boundary modules, and the story file names.
 */
function buildStatsGraph(stats: Stats, normalize: (p: string) => string) {
  const storybookEntries = new Set(storiesEntryFileNames.map((file) => normalize(file)));
  const resolve = buildAliasResolver(stats, normalize);

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
    const fromStoriesEntry = reasons.some(
      (reason) => storybookEntries.has(baseName(reason)) || isStoriesListModule(reason)
    );
    if (/\s+(sync|lazy)\s+/.test(full) && fromStoriesEntry) globBoundaries.add(full);
    if (isStoriesListModule(full)) globBoundaries.add(full);
  }

  const storyFiles = [
    ...new Set([...globBoundaries].flatMap((glob) => [...(childrenByName.get(glob) ?? [])])),
  ].filter((name) => isStoryFile(name) && !globBoundaries.has(name) && !isNodeModule(name));

  return { childrenByName, globBoundaries, storyFiles };
}

/**
 * Build a map of story file -> set of reachable first-party source files (no node_modules, no
 * externals) from the builder's stats graph — the ground truth we compare an own-trace against.
 *
 * @param stats The parsed builder stats.
 * @param normalize Normalizes a webpack/vite module path to a repo-root-relative POSIX path.
 *
 * @returns A map of repo-root-relative story path to its set of reachable source files.
 */
function statsDependencies(stats: Stats, normalize: (p: string) => string) {
  const { childrenByName, globBoundaries, storyFiles } = buildStatsGraph(stats, normalize);
  const depsByStory = new Map<string, Set<string>>();
  for (const story of storyFiles) {
    const sources = new Set<string>();
    const visited = new Set<string>();
    const stack = [story];
    while (stack.length > 0) {
      const name = stack.pop() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      for (const child of childrenByName.get(name) ?? []) {
        if (globBoundaries.has(child) || isExternal(child) || isNodeModule(child)) continue;
        sources.add(baseName(child));
        stack.push(child);
      }
    }
    depsByStory.set(baseName(story), sources);
  }
  return depsByStory;
}

/**
 * Trace each story's first-party source dependencies independently of the builder, using esbuild
 * (bundle + metafile, node_modules externalized). Returns a map of story -> reachable source files,
 * plus the set of stories esbuild failed to resolve (a fidelity signal in itself).
 *
 * @param rootPath The repository root.
 * @param storyFiles Repo-root-relative story file paths to trace.
 *
 * @returns The own-traced dependency map and the set of stories that failed to resolve.
 */
async function ownDependenciesEsbuild(rootPath: string, storyFiles: string[]) {
  // Dynamic import: esbuild is a research-only dependency, kept out of the shipped CLI bundle.
  const esbuild = await import('esbuild');
  const tsconfig = path.join(rootPath, 'tsconfig.json');
  const assetLoaders = [
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

  const depsByStory = new Map<string, Set<string>>();
  const failed = new Set<string>();

  for (const story of storyFiles) {
    try {
      const result = await esbuild.build({
        entryPoints: [path.join(rootPath, story)],
        bundle: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
        platform: 'browser',
        format: 'esm',
        packages: 'external', // don't traverse node_modules; we only compare first-party sources
        absWorkingDir: rootPath,
        tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
        loader: Object.fromEntries(assetLoaders.map((extension) => [extension, 'empty'])),
      });
      const sources = new Set(
        Object.keys(result.metafile?.inputs ?? {})
          .map((input) => posix(input))
          .filter((input) => !isNodeModule(input) && input !== story)
      );
      depsByStory.set(story, sources);
    } catch {
      failed.add(story);
    }
  }
  return { depsByStory, failed };
}

const PARSEABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

interface OxcResolver {
  sync: (directory: string, specifier: string) => { path?: string };
}

/**
 * Extract every module specifier from a parsed source file: static imports, re-exports, and (literal)
 * dynamic imports. Dynamic imports carry only source offsets, so we slice and strip quotes, skipping
 * non-literal expressions.
 *
 * @param module_ The `module` record from oxc-parser.
 * @param code The source text (for slicing dynamic-import specifiers).
 *
 * @returns The list of import specifiers found.
 */
function importSpecifiers(module_: any, code: string): string[] {
  const fromRequest = (request: { value?: string; start: number; end: number } | undefined) => {
    if (!request) return undefined;
    if (request.value !== undefined) return request.value;
    const raw = code.slice(request.start, request.end).replaceAll(/^['"`]|['"`]$/g, '');
    return /[$`+\s]/.test(raw) ? undefined : raw; // skip non-literal dynamic imports
  };
  // Skip TypeScript type-only imports/re-exports: the bundler strips them, so following them would
  // drag the whole type graph in and massively over-capture. A static import is a runtime dependency
  // if it's a bare side-effect import (no bindings) or has at least one value (non-type) binding.
  const fromImport = (imp: any) =>
    imp.entries.length === 0 || imp.entries.some((entry: any) => !entry.isType)
      ? fromRequest(imp.moduleRequest)
      : undefined;
  const fromExport = (entry: any) => (entry.isType ? undefined : fromRequest(entry.moduleRequest));

  const specifiers = [
    ...module_.staticImports.map((imp: any) => fromImport(imp)),
    ...module_.staticExports.flatMap((exp: any) =>
      (exp.entries ?? []).map((entry: any) => fromExport(entry))
    ),
    ...module_.dynamicImports.map((dyn: any) => fromRequest(dyn.moduleRequest)),
  ];
  return specifiers.filter((specifier): specifier is string => !!specifier);
}

/**
 * Resolve every import in a single file to its first-party dependencies (node_modules excluded).
 *
 * @param parseSync The oxc-parser parse function.
 * @param resolver The oxc-resolver instance.
 * @param resolver.sync Resolves a specifier relative to a directory.
 * @param resolver.sync
 * @param rootPath The repository root.
 * @param absolute The absolute path of the file to read and parse.
 * @param story The repo-root-relative story path (excluded from its own deps).
 *
 * @returns Resolved first-party dependencies with their repo-relative path and whether to recurse.
 */
function fileDependencies(
  parseSync: (filename: string, code: string) => { module: any },
  resolver: OxcResolver,
  rootPath: string,
  absolute: string,
  story: string
) {
  const code = readFileSync(absolute, 'utf8');
  const parsed = parseSync(absolute, code);
  const dependencies: { relative: string; absolute: string; parseable: boolean }[] = [];
  for (const specifier of importSpecifiers(parsed.module, code)) {
    const resolved = resolver.sync(path.dirname(absolute), specifier).path;
    if (!resolved || isNodeModule(posix(resolved))) continue;
    const relative = posix(path.relative(rootPath, resolved));
    if (relative !== story) {
      dependencies.push({
        relative,
        absolute: resolved,
        parseable: PARSEABLE.has(path.extname(resolved)),
      });
    }
  }
  return dependencies;
}

/**
 * Trace each story's first-party source dependencies independently of the builder, using oxc-parser
 * (TS/JSX-aware import extraction) + oxc-resolver (resolution honoring tsconfig paths). This is an
 * own-written resolver — no bundler involved — so it's the closest stand-in for a production tracer.
 *
 * @param rootPath The repository root.
 * @param storyFiles Repo-root-relative story file paths to trace.
 *
 * @returns The own-traced dependency map and the set of stories that failed to trace.
 */
async function ownDependenciesOxc(rootPath: string, storyFiles: string[]) {
  // Dynamic imports: oxc-* are research-only dependencies, kept out of the shipped CLI bundle.
  const { parseSync } = await import('oxc-parser');
  const { ResolverFactory } = await import('oxc-resolver');

  const resolver = new ResolverFactory({
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    conditionNames: ['import', 'browser', 'default'],
    tsconfig: { configFile: path.join(rootPath, 'tsconfig.json'), references: 'auto' },
  });

  // DFS one story to its transitive first-party source files (node_modules excluded).
  const traceStory = (story: string) => {
    const sources = new Set<string>();
    const visited = new Set<string>();
    const stack = [path.join(rootPath, story)];
    while (stack.length > 0) {
      const absolute = stack.pop() as string;
      if (visited.has(absolute)) continue;
      visited.add(absolute);
      for (const dep of fileDependencies(parseSync, resolver, rootPath, absolute, story)) {
        sources.add(dep.relative);
        if (dep.parseable) stack.push(dep.absolute);
      }
    }
    return sources;
  };

  const depsByStory = new Map<string, Set<string>>();
  const failed = new Set<string>();
  for (const story of storyFiles) {
    try {
      depsByStory.set(story, traceStory(story));
    } catch {
      failed.add(story);
    }
  }
  return { depsByStory, failed };
}

interface StoryFidelity {
  story: string;
  missed: string[];
  extra: string[];
  statsCount: number;
}

/**
 * The main entrypoint for `chromatic trace-fidelity`.
 *
 * @param argv A list of arguments passed.
 */
// eslint-disable-next-line complexity
export async function main(argv: string[]) {
  const { flags } = meow(
    `
    Usage
      $ chromatic trace-fidelity [-s|--stats-file] [-b|--storybook-base-dir] [-c|--storybook-config-dir] [--resolver esbuild|oxc] [--limit N] [--worst N] [--json]

    Options
      --stats-file, -s <filepath>           Path to preview-stats.json. (default: 'storybook-static/preview-stats.json')
      --storybook-base-dir, -b <dirname>    Relative path from repository root to Storybook project root.
      --storybook-config-dir, -c <dirname>  Storybook config dir. (default: '.storybook')
      --resolver <name>                     Own-tracer to use: 'esbuild' (bundle+metafile) or 'oxc' (oxc-parser + oxc-resolver). (default: 'esbuild')
      --limit <n>                           Only check the first N stories (faster iteration).
      --worst <n>                           Show the N stories with the most missed dependencies. (default: 10)
      --json                                Print machine-readable JSON.
    `,
    {
      argv,
      description: 'Compare an own-traced dependency graph against the builder stats',
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
        resolver: { type: 'string', default: 'esbuild' },
        limit: { type: 'number' },
        worst: { type: 'number', default: 10 },
        json: { type: 'boolean', default: false },
      },
    }
  );

  const log = createLogger({}, { logPrefix: '', logLevel: flags.json ? 'error' : 'info' });
  const rootPath = await getRepositoryRoot({ log });
  if (!rootPath) throw new Error('Failed to determine repository root');

  const baseDirectory = flags.storybookBaseDir === '.' ? '' : flags.storybookBaseDir;
  const normalize = (p: string) => normalizePath(p, rootPath, baseDirectory);
  const stats = await readStatsFile(flags.statsFile);

  const statsDeps = statsDependencies(stats, normalize);
  let stories = [...statsDeps.keys()].filter((story) => existsSync(path.join(rootPath, story)));
  if (flags.limit) stories = stories.slice(0, flags.limit);

  const trace = flags.resolver === 'oxc' ? ownDependenciesOxc : ownDependenciesEsbuild;
  const { depsByStory: ownDeps, failed } = await trace(rootPath, stories);

  const fidelity: StoryFidelity[] = [];
  for (const story of stories) {
    if (failed.has(story)) continue;
    const stat = statsDeps.get(story) ?? new Set();
    const own = ownDeps.get(story) ?? new Set();
    const missed = [...stat].filter((file) => !own.has(file)).sort();
    const extra = [...own].filter((file) => !stat.has(file)).sort();
    fidelity.push({ story, missed, extra, statsCount: stat.size });
  }

  const storiesWithMisses = fidelity.filter((f) => f.missed.length > 0);
  const totalStatsDeps = fidelity.reduce((sum, f) => sum + f.statsCount, 0);
  const totalMissed = fidelity.reduce((sum, f) => sum + f.missed.length, 0);
  const allMissedFiles = new Set(fidelity.flatMap((f) => f.missed));
  const coverage = totalStatsDeps > 0 ? 1 - totalMissed / totalStatsDeps : 1;

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          summary: {
            resolver: flags.resolver,
            storiesChecked: fidelity.length,
            storiesFailed: [...failed],
            storiesWithMisses: storiesWithMisses.length,
            dependencyCoverage: Number(coverage.toFixed(4)),
            uniqueMissedFiles: [...allMissedFiles].sort(),
          },
          perStory: fidelity,
        },
        undefined,
        2
      ) + '\n'
    );
    return;
  }

  report({
    log,
    resolver: flags.resolver,
    fidelity,
    failed,
    storiesWithMisses,
    coverage,
    allMissedFiles,
    worst: flags.worst,
  });
}

interface ReportArguments {
  log: ReturnType<typeof createLogger>;
  resolver: string;
  fidelity: StoryFidelity[];
  failed: Set<string>;
  storiesWithMisses: StoryFidelity[];
  coverage: number;
  allMissedFiles: Set<string>;
  worst: number;
}

function report({
  log,
  resolver,
  fidelity,
  failed,
  storiesWithMisses,
  coverage,
  allMissedFiles,
  worst,
}: ReportArguments) {
  log.info(
    `Checked ${fidelity.length} stories against the builder stats (resolver: ${resolver}).\n`
  );
  log.info(
    `  Dependency coverage:  ${(coverage * 100).toFixed(1)}% of stats deps found by own-trace`
  );
  log.info(`  Stories with misses:  ${storiesWithMisses.length} / ${fidelity.length}`);
  log.info(`  Unique missed files:  ${allMissedFiles.size}`);
  log.info(`  Stories the resolver could not trace: ${failed.size}`);

  if (failed.size > 0) {
    log.info(`\nFailed to resolve (own-trace gap):`);
    for (const story of [...failed].sort()) log.info(`  ! ${story}`);
  }

  const ranked = [...storiesWithMisses].sort((a, b) => b.missed.length - a.missed.length);
  if (ranked.length > 0) {
    log.info(`\nTop ${Math.min(worst, ranked.length)} stories by missed dependencies:`);
    for (const { story, missed, statsCount } of ranked.slice(0, worst)) {
      log.info(`  ${story} — missed ${missed.length}/${statsCount}`);
      for (const file of missed.slice(0, 8)) log.info(`      - ${file}`);
      if (missed.length > 8) log.info(`      … and ${missed.length - 8} more`);
    }
  }

  if (allMissedFiles.size === 0 && failed.size === 0) {
    log.info(`\nPerfect fidelity: the own-trace found every dependency the builder bundled.`);
  }
}
