import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import meow from 'meow';

import { createLogger } from '../node-src/lib/log';
import { readStatsFile } from '../node-src/tasks/readStatsFile';
import { Module, Stats } from '../node-src/types';

/**
 * Hash-based TurboSnap — module-hash strategy.
 *
 * Instead of git-diffing changed files forward to affected stories (what the production
 * `getDependentStoryFiles` does), this reduces every story to a single content hash and diffs those
 * hashes between two builds. Any story whose hash changed needs to be re-captured — no git history,
 * no lockfile parsing, no baseline checkout.
 *
 * The hash material comes entirely from the builder. `@storybook/builder-vite` emits a complete
 * module graph in `preview-stats.json` where every module carries a normalized, post-transform
 * `contentHash`. The CLI's whole job is then a graph rollup:
 *
 *   storyHash(S) = H( sorted contentHashes of the modules reachable from S + the shared
 *                     preview section )
 *
 * Only the modules' content hashes are hashed — not their paths. The module graph (and the story's
 * own path) is used to decide *which* modules a story reaches and *which* story changed, but the
 * path is never an input to the hash that decides *whether* it changed. So a path that shifts
 * without a content change (e.g. a global Yarn PnP cache at a different absolute location across
 * machines) doesn't spuriously re-capture.
 *
 * The shared section is everything reachable from `.storybook/preview.*` (preview config and the
 * files it imports). Because it is folded into every story, changing a shared dependency busts every
 * dependent story — matching how preview changes are global today, but precisely and by content.
 *
 * Scope: this is the module-hash signal only. It does not include the chunk-level (tree-shake)
 * signal. Residual out-of-graph inputs — `.storybook/main.*` (never in the preview bundle), static
 * dirs, and `preview-head.html` — are not modules in the graph, so they are not covered here; the
 * existing TurboSnap handling for those still applies.
 *
 * Command:
 *   chromatic hash-stories [-s|--stats-file] [--baseline <file>] [--json]
 *
 * Usage:
 *   storybook build --stats-json                              # emits storybook-static/preview-stats.json
 *   chromatic hash-stories -s storybook-static/preview-stats.json --json > base.json
 *   # ...make a change, rebuild...
 *   chromatic hash-stories -s storybook-static/preview-stats.json --baseline base.json
 */

const { WEBPACK_STATS_FILE } = process.env;

/**
 * Whether a module name matches Storybook's default story glob (CSF or MDX).
 *
 * @param name The module name.
 *
 * @returns True if the module is a story file.
 */
const isStoryFile = (name: string) => /\.stories\.[cm]?[jt]sx?$/.test(name) || /\.mdx$/.test(name);

/**
 * Whether a module name is the `.storybook/preview.*` config — the root of the shared section.
 *
 * @param name The module name.
 *
 * @returns True if the module is the preview config.
 */
const isPreviewFile = (name: string) => /(^|\/)\.storybook\/preview\.[cm]?[jt]sx?$/.test(name);

/**
 * The stable identifier for a module: its `name`, falling back to its `id`.
 *
 * @param module A module entry from the stats file.
 *
 * @returns The module's name.
 */
const moduleName = (module: Module): string => String(module.name ?? module.id);

/**
 * Build the forward dependency graph (importer → its imports) by inverting each module's `reasons`
 * (which list a module's importers).
 *
 * @param modules The modules from the builder stats file.
 *
 * @returns A map from a module name to the set of module names it imports.
 */
function buildForwardGraph(modules: Module[]): Map<string, Set<string>> {
  const forward = new Map<string, Set<string>>();
  for (const module of modules) {
    const name = moduleName(module);
    for (const reason of module.reasons ?? []) {
      if (!reason.moduleName) {
        continue;
      }
      const imports = forward.get(reason.moduleName) ?? new Set<string>();
      imports.add(name);
      forward.set(reason.moduleName, imports);
    }
  }
  return forward;
}

/**
 * Collect every module reachable from `start` (inclusive) by following forward edges.
 *
 * @param start The module to start from.
 * @param forward The forward dependency graph from {@link buildForwardGraph}.
 *
 * @returns The set of reachable module names, including `start`.
 */
function reach(start: string, forward: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  // for-of over a growing array gives a BFS: items pushed during iteration are visited later.
  for (const current of queue) {
    for (const next of forward.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * A canonical, order-independent digest of a set of modules' *content* hashes.
 *
 * Only the content hashes are hashed — deliberately not the module paths. A story re-captures when
 * the content of its reachable modules changes (or a module is added/removed), but not when a
 * module's path merely shifts on disk with identical content (e.g. a global Yarn PnP cache
 * resolving to a different absolute location across machines). That keeps the per-story hash
 * deterministic across machines/CI; the path stays the diff key and an attribution aid, never an
 * input to the hash that decides whether a story changed. Content hashes are sorted
 * (order-independent) and duplicates kept (a multiset), so two distinct modules with identical
 * content both count.
 *
 * @param names The module names whose content hashes to include.
 * @param hashOf A map from module name to its content hash.
 *
 * @returns A short, stable hex digest.
 */
function digest(names: Iterable<string>, hashOf: Map<string, string | undefined>): string {
  const document = [...names]
    .map((name) => hashOf.get(name) ?? '')
    .sort()
    .join('\n');
  return createHash('sha256').update(document).digest('hex').slice(0, 16);
}

export interface StoryHashes {
  /** Per-story rolled-up hash, keyed by story file name. */
  storyHashes: Record<string, string>;
  /** The shared (preview) section: the modules folded into every story, and their combined hash. */
  sharedSection: { modules: string[]; hash: string };
}

/**
 * Roll every story up to a single hash from the builder-emitted module graph and per-module content
 * hashes (the module-hash strategy).
 *
 * @param stats The builder stats file (`preview-stats.json`) with per-module `contentHash`.
 *
 * @returns The per-story hashes and the shared (preview) section.
 */
export function computeStoryHashes(stats: Stats): StoryHashes {
  const modules = stats.modules ?? [];
  const hashOf = new Map(modules.map((module) => [moduleName(module), module.contentHash]));
  const forward = buildForwardGraph(modules);
  const names = modules.map((module) => moduleName(module));

  const previewRoot = names.find((name) => isPreviewFile(name));
  const sharedModules = previewRoot ? reach(previewRoot, forward) : new Set<string>();

  const storyHashes: Record<string, string> = {};
  for (const story of names.filter((name) => isStoryFile(name))) {
    const dependencies = reach(story, forward);
    for (const shared of sharedModules) {
      dependencies.add(shared);
    }
    storyHashes[story] = digest(dependencies, hashOf);
  }

  return {
    storyHashes,
    sharedSection: {
      modules: [...sharedModules].sort(),
      hash: digest(sharedModules, hashOf),
    },
  };
}

export interface BaselineDiff {
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Diff current per-story hashes against a baseline (a previous `--json` output). Any story whose
 * hash changed — or that is new — needs re-capture.
 *
 * @param baselinePath Path to a previous `--json` output file.
 * @param current The current map of story file → hash.
 *
 * @returns The changed, added, removed, and unchanged stories.
 */
export function diffBaseline(baselinePath: string, current: Record<string, string>): BaselineDiff {
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
 * The main entrypoint for `chromatic hash-stories`.
 *
 * @param argv A list of arguments passed.
 */
export async function main(argv: string[]) {
  const { flags } = meow(
    `
    Usage
      $ chromatic hash-stories [-s|--stats-file] [--baseline <file>] [--json]

    Reduce every story to a single content hash from the builder's module graph + per-module
    content hashes, and (with --baseline) report which stories need re-capture.

    Options
      --stats-file, -s <filepath>  Path to preview-stats.json. Alternatively set WEBPACK_STATS_FILE. (default: 'storybook-static/preview-stats.json')
      --baseline <filepath>        Path to a previous --json output to diff against.
      --json                       Print machine-readable JSON instead of a human report.
    `,
    {
      argv,
      description: 'Hash-based TurboSnap — module-hash strategy',
      flags: {
        statsFile: {
          type: 'string',
          alias: 's',
          default: WEBPACK_STATS_FILE || 'storybook-static/preview-stats.json',
        },
        baseline: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    }
  );

  const log = createLogger({}, { logPrefix: '', logLevel: flags.json ? 'error' : 'info' });
  const stats = await readStatsFile(flags.statsFile);
  const { storyHashes, sharedSection } = computeStoryHashes(stats);

  const storyFiles = Object.keys(storyHashes);
  if (storyFiles.length === 0) {
    log.error('No CSF story files found in the stats file. Is this a preview-stats.json?');
    throw new Error('No stories found');
  }

  if (sharedSection.modules.length === 0) {
    log.warn(
      'No `.storybook/preview.*` module found in the graph — the shared section is empty. ' +
        'Is the builder emitting the complete graph (preview-gap fix)?'
    );
  }

  const diff = flags.baseline ? diffBaseline(flags.baseline, storyHashes) : undefined;

  if (flags.json) {
    process.stdout.write(JSON.stringify({ storyHashes, sharedSection, diff }, undefined, 2) + '\n');
    return;
  }

  report(log, { storyHashes, sharedSection }, diff);
}

/**
 * Print a human-readable report of the per-story hashes, the shared section, and (if present) the
 * baseline diff.
 *
 * @param log The logger.
 * @param hashes The computed per-story hashes and shared section.
 * @param hashes.storyHashes The per-story rolled-up hashes.
 * @param hashes.sharedSection The shared (preview) section.
 * @param diff The baseline diff, when a baseline was supplied.
 */
function report(
  log: ReturnType<typeof createLogger>,
  { storyHashes, sharedSection }: StoryHashes,
  diff: BaselineDiff | undefined
) {
  const storyFiles = Object.keys(storyHashes).sort();
  log.info(`Hashed ${storyFiles.length} story files:\n`);
  for (const story of storyFiles) {
    log.info(`  ${story} [${storyHashes[story]}]`);
  }

  log.info(
    `\nShared section (preview config + deps, folded into every story): ` +
      `${sharedSection.modules.length} modules [${sharedSection.hash}]`
  );

  if (diff) {
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
}
