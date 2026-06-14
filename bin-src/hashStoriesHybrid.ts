import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import meow from 'meow';

/**
 * EXPERIMENTAL — end-to-end hybrid (B ∩ C) TurboSnap diff.
 *
 * Combines the two builder-emitted signals from a Storybook build:
 *   - B (module-level): per-module `contentHash` in `preview-stats.json`. Each story is rolled up
 *     to one hash over its reachable modules + the shared (preview) section.
 *   - C (chunk-level):  per-chunk content hash + per-story chunk sets in `chunk-graph.json`.
 *
 * A story re-captures iff BOTH signals flag it (intersection); added/removed come from B. The two
 * over-capture in opposite directions (B: barrels / dead code / untransformed-node_module comments;
 * C: story add/remove loader churn), so intersecting lets each veto the other's over-capture while
 * staying safe — a real in-graph rendering change flags B (conservative) and moves the bundled
 * output so it flags C too.
 *
 * "Backend storage" here is just local files: build once, save the artifacts as a baseline, build
 * again, and diff the current artifacts against the saved baseline.
 *
 * See docs/hash-based-turbosnap.md for the design and measured comparison.
 */

interface StatsModule {
  id?: string | number;
  name?: string;
  reasons?: { moduleName: string }[];
  contentHash?: string;
}
interface PreviewStats {
  modules: StatsModule[];
}
interface ChunkGraph {
  stories: Record<string, { chunks: string[] }>;
  chunks: Record<string, { hash: string }>;
}

/** The set of stories needing re-capture, plus the over-captures each signal would have made alone. */
export interface HybridResult {
  total: number;
  changed: string[];
  added: string[];
  removed: string[];
  bOnly: string[];
  cOnly: string[];
}

/**
 * Read and parse a JSON artifact, with a friendly error if it's missing.
 *
 * @param filepath Path to the JSON file.
 * @param label Human label used in the not-found error.
 *
 * @returns The parsed JSON.
 */
function readJson<T>(filepath: string, label: string): T {
  if (!existsSync(filepath)) {
    throw new Error(`${label} not found: ${filepath}`);
  }
  return JSON.parse(readFileSync(filepath, 'utf8')) as T;
}

/**
 * Normalized module identifier — prefer `name`, fall back to `id`.
 *
 * @param module A module entry from the stats file.
 *
 * @returns The module's stable name.
 */
function moduleName(module: StatsModule): string {
  return String(module.name ?? module.id);
}

/**
 * Per-story rolled-up hash from the module graph (B).
 *
 * @param stats The build's `preview-stats.json` (module graph + per-module `contentHash`).
 *
 * @returns A map of story file → hash over its reachable modules + the shared (preview) section.
 */
export function moduleStoryHashes(stats: PreviewStats): Record<string, string> {
  const mods = stats.modules ?? [];
  const hashOf = new Map(mods.map((module) => [moduleName(module), module.contentHash]));
  const forward = new Map<string, string[]>(); // importer -> [imports], inverted from `reasons`
  for (const module of mods) {
    for (const reason of module.reasons ?? []) {
      const list = forward.get(reason.moduleName) ?? [];
      list.push(moduleName(module));
      forward.set(reason.moduleName, list);
    }
  }
  const reach = (start: string) => {
    const seen = new Set([start]);
    const queue = [start];
    // Array for-of visits items appended during iteration, giving a BFS over the graph.
    for (const current of queue) {
      for (const next of forward.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const digest = (names: Set<string>) =>
    createHash('sha256')
      .update(
        [...names]
          .sort()
          .map((n) => `${n}:${hashOf.get(n) ?? ''}`)
          .join('\n')
      )
      .digest('hex')
      .slice(0, 16);

  const allNames = mods.map((module) => moduleName(module));
  const preview = allNames.find((n) => /\.storybook\/preview\./.test(n));
  const shared = preview ? reach(preview) : new Set<string>();
  const stories = allNames.filter((n) => /\.stories\.[cm]?[jt]sx?$/.test(n));
  const out: Record<string, string> = {};
  for (const story of stories) {
    const deps = reach(story);
    for (const s of shared) {
      deps.add(s);
    }
    out[story] = digest(deps);
  }
  return out;
}

/**
 * Stories whose chunk set changed (content hash or membership) between two chunk graphs (C).
 *
 * @param before The baseline build's `chunk-graph.json`.
 * @param after The current build's `chunk-graph.json`.
 *
 * @returns The set of story files whose chunk set changed.
 */
export function chunkChangedStories(before: ChunkGraph, after: ChunkGraph): Set<string> {
  const changed = new Set<string>();
  for (const story of Object.keys(after.stories)) {
    if (!(story in before.stories)) {
      continue; // added stories handled by B
    }
    const setA = before.stories[story].chunks;
    const setB = after.stories[story].chunks;
    const keysB = new Set(setB);
    const sameSet = setA.length === setB.length && setA.every((k) => keysB.has(k));
    const hashChanged = setB.some((k) => before.chunks[k]?.hash !== after.chunks[k]?.hash);
    if (!sameSet || hashChanged) {
      changed.add(story);
    }
  }
  return changed;
}

/**
 * Intersect the module (B) and chunk (C) signals into the hybrid re-capture set.
 *
 * @param baselineStats Baseline `preview-stats.json`.
 * @param currentStats Current `preview-stats.json`.
 * @param baselineChunks Baseline `chunk-graph.json`.
 * @param currentChunks Current `chunk-graph.json`.
 *
 * @returns The hybrid result: changed/added/removed plus each signal's vetoed over-capture.
 */
export function hybridDiff(
  baselineStats: PreviewStats,
  currentStats: PreviewStats,
  baselineChunks: ChunkGraph,
  currentChunks: ChunkGraph
): HybridResult {
  const mBefore = moduleStoryHashes(baselineStats);
  const mAfter = moduleStoryHashes(currentStats);
  const cChanged = chunkChangedStories(baselineChunks, currentChunks);
  const stories = new Set([...Object.keys(mBefore), ...Object.keys(mAfter)]);

  const result: HybridResult = {
    total: stories.size,
    changed: [],
    added: [],
    removed: [],
    bOnly: [],
    cOnly: [],
  };
  for (const story of stories) {
    if (!(story in mBefore)) {
      result.added.push(story);
      continue;
    }
    if (!(story in mAfter)) {
      result.removed.push(story);
      continue;
    }
    const bChanged = mBefore[story] !== mAfter[story];
    const cChangedHere = cChanged.has(story);
    if (bChanged && cChangedHere) {
      result.changed.push(story);
    } else if (bChanged) {
      result.bOnly.push(story);
    } else if (cChangedHere) {
      result.cOnly.push(story);
    }
  }
  for (const key of ['changed', 'added', 'removed', 'bOnly', 'cOnly'] as const) {
    result[key].sort();
  }
  return result;
}

/**
 * CLI entrypoint for `chromatic hash-stories-hybrid`.
 *
 * @param argv CLI arguments after the subcommand name.
 */
export async function main(argv: string[]) {
  const { flags } = meow(
    `
    Usage
      $ chromatic hash-stories-hybrid --baseline-stats <path> --baseline-chunks <path> [-s|--stats-file] [--chunk-graph] [--json]

    Diff a build's hash signals against a saved baseline build's artifacts (B ∩ C hybrid).
    Build with \`storybook build --stats-json\` and \`STORYBOOK_CHUNK_GRAPH=1\` to emit both files.

    Options
      --stats-file, -s <path>     Current preview-stats.json. (default: 'storybook-static/preview-stats.json')
      --chunk-graph <path>        Current chunk-graph.json. (default: 'storybook-static/chunk-graph.json')
      --baseline-stats <path>     Baseline build's preview-stats.json. (required)
      --baseline-chunks <path>    Baseline build's chunk-graph.json. (required)
      --json                      Print machine-readable JSON instead of a human report.
    `,
    {
      argv,
      description: 'Experimental hybrid (module ∩ chunk) hash-based TurboSnap diff',
      flags: {
        statsFile: { type: 'string', alias: 's', default: 'storybook-static/preview-stats.json' },
        chunkGraph: { type: 'string', default: 'storybook-static/chunk-graph.json' },
        baselineStats: { type: 'string' },
        baselineChunks: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    }
  );

  if (!flags.baselineStats || !flags.baselineChunks) {
    console.error('Error: --baseline-stats and --baseline-chunks are required.');
    process.exitCode = 1;
    return;
  }

  const result = hybridDiff(
    readJson<PreviewStats>(flags.baselineStats, 'baseline stats'),
    readJson<PreviewStats>(flags.statsFile, 'current stats'),
    readJson<ChunkGraph>(flags.baselineChunks, 'baseline chunk graph'),
    readJson<ChunkGraph>(flags.chunkGraph, 'current chunk graph')
  );

  if (flags.json) {
    console.log(JSON.stringify(result, undefined, 2));
    return;
  }

  const unchanged =
    result.total - result.changed.length - result.added.length - result.removed.length;
  const lines = [
    `Hybrid (B ∩ C): ${result.changed.length} changed, ${result.added.length} added, ` +
      `${result.removed.length} removed, ${unchanged} unchanged (of ${result.total} stories).`,
    ...result.changed.map((s) => `  ~ ${s}`),
    ...result.added.map((s) => `  + ${s}`),
    ...result.removed.map((s) => `  - ${s}`),
  ];
  if (result.bOnly.length > 0 || result.cOnly.length > 0) {
    lines.push(
      `\nVetoed over-capture (one signal only, not re-captured): ` +
        `${result.bOnly.length} module-only (B; barrels / dead code / node_module comments), ` +
        `${result.cOnly.length} chunk-only (C; add/remove loader churn).`
    );
  }

  console.log(lines.join('\n'));
}
