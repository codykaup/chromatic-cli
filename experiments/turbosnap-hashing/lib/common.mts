/**
 * Shared utilities for the TurboSnap source-graph benchmark.
 *
 * Vocabulary:
 *  - "repo path": a POSIX path relative to the git repo root, e.g. `node-src/ui/components/icons.tsx`.
 *    This is the canonical key we compare everything on (matches `git diff --name-only` output).
 *  - "story file": a repo path matching the Storybook `stories` glob.
 *  - reverse graph: repo path -> set of repo paths that import it (its "importers"/"reasons").
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  SOURCE_EXTS,
  SOURCE_EXCLUDE_RE,
  SOURCE_INCLUDE_RE,
  STATS_PATH,
  STORY_BASE_DIR,
  STORY_RE,
} from './config.mts';

export { REPO_ROOT, SOURCE_EXTS } from './config.mts';

export const isStoryFile = (repoPath: string) => STORY_RE.test(repoPath);

/** All git-tracked files, as repo-relative POSIX paths. */
export function gitTrackedFiles(): string[] {
  return execSync('git ls-files', { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString()
    .split('\n')
    .filter(Boolean);
}

export const toRepoPath = (absOrRel: string) =>
  path.posix.relative(REPO_ROOT, path.resolve(REPO_ROOT, absOrRel));

/**
 * Invert a forward graph (file -> imports) into a reverse graph (file -> importers),
 * then expose a trace that walks importers transitively to find affected story files.
 */
export class ReverseGraph {
  reverse = new Map<string, Set<string>>();

  addEdge(importer: string, imported: string) {
    if (!this.reverse.has(imported)) this.reverse.set(imported, new Set());
    this.reverse.get(imported)!.add(importer);
  }

  /** All story files transitively reachable upward from `changed`. */
  affectedStories(changed: string): Set<string> {
    const result = new Set<string>();
    const seen = new Set<string>([changed]);
    const stack = [changed];
    if (isStoryFile(changed)) result.add(changed);
    while (stack.length) {
      const node = stack.pop()!;
      for (const importer of this.reverse.get(node) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (isStoryFile(importer)) result.add(importer);
        stack.push(importer);
      }
    }
    return result;
  }

  get nodeCount() {
    const nodes = new Set<string>(this.reverse.keys());
    for (const importers of this.reverse.values()) for (const i of importers) nodes.add(i);
    return nodes.size;
  }

  get edgeCount() {
    let n = 0;
    for (const importers of this.reverse.values()) n += importers.size;
    return n;
  }

  /** Keep only edges where BOTH endpoints are in `universe` (e.g. the builder's module set). */
  restrictTo(universe: Set<string>): ReverseGraph {
    const g = new ReverseGraph();
    for (const [imported, importers] of this.reverse) {
      if (!universe.has(imported)) continue;
      for (const importer of importers) if (universe.has(importer)) g.addEdge(importer, imported);
    }
    return g;
  }
}

/** Repo paths of every user module the builder actually bundled into the preview (from stats). */
export function statsUniverse(): Set<string> {
  const stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) as { modules: { name: string }[] };
  const set = new Set<string>();
  for (const m of stats.modules) {
    if (!m.name || m.name.includes('node_modules') || m.name.startsWith('/virtual')) continue;
    const rel = m.name.replace(/^\.\//, '').replace(/\s+\+\s+\d+\s+modules?$/, '').replace(/\?.*$/, '');
    set.add(STORY_BASE_DIR ? path.posix.join(STORY_BASE_DIR, rel) : rel);
  }
  return set;
}

export interface FidelityResult {
  approach: string;
  buildMs: number;
  peakRssMb: number;
  graphNodes: number;
  graphEdges: number;
  /** scenarios where prototype's affected-story set exactly equals ground truth */
  exactMatch: number;
  totalScenarios: number;
  /** micro-averaged over all (scenario, story) pairs that GT marks affected */
  recall: number; // 1 - falseNegativeRate ; <1 means MISSED stories (dangerous)
  precision: number; // <1 means EXTRA stories (wasteful but safe)
  falseNegativeScenarios: string[]; // changed files where we missed ≥1 story GT caught
  notes: string[];
}

/** Compare a prototype's per-scenario affected-story sets against ground truth. */
export function scoreFidelity(
  approach: string,
  groundTruth: Record<string, string[]>,
  predict: (changed: string) => Set<string>,
  meta: { buildMs: number; peakRssMb: number; graphNodes: number; graphEdges: number; notes?: string[] }
): FidelityResult {
  const scenarios = Object.keys(groundTruth);
  let exactMatch = 0;
  let tp = 0;
  let fn = 0;
  let fp = 0;
  const falseNegativeScenarios: string[] = [];
  for (const changed of scenarios) {
    const gt = new Set(groundTruth[changed]);
    const pred = predict(changed);
    let localFn = 0;
    for (const s of gt) (pred.has(s) ? tp++ : (fn++, localFn++));
    for (const s of pred) if (!gt.has(s)) fp++;
    const exact = gt.size === pred.size && [...gt].every((s) => pred.has(s));
    if (exact) exactMatch++;
    if (localFn > 0) falseNegativeScenarios.push(changed);
  }
  return {
    approach,
    buildMs: meta.buildMs,
    peakRssMb: meta.peakRssMb,
    graphNodes: meta.graphNodes,
    graphEdges: meta.graphEdges,
    exactMatch,
    totalScenarios: scenarios.length,
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    falseNegativeScenarios: falseNegativeScenarios.slice(0, 25),
    notes: meta.notes ?? [],
  };
}

/** All candidate source files in the graph universe (what the Storybook can reach). */
export function candidateSourceFiles(): string[] {
  return gitTrackedFiles()
    .filter((f) => SOURCE_INCLUDE_RE.test(f) && !SOURCE_EXCLUDE_RE.test(f))
    .filter((f) => SOURCE_EXTS.includes(path.extname(f)))
    .map((f) => path.join(REPO_ROOT, f));
}

/**
 * Generic graph builder: given a per-file import extractor and a resolver, build the reverse graph
 * over repo files. `parse` returns raw import specifiers; `resolve` maps (specifier, importerAbs) to
 * an absolute path or null (external/unresolved). Edges are only kept when the target is a repo file.
 */
export async function buildGraph(
  files: string[],
  parse: (absPath: string, code: string) => string[] | Promise<string[]>,
  resolve: (specifier: string, importerAbs: string) => string | null | Promise<string | null>
): Promise<{ graph: ReverseGraph; unresolved: number; resolved: number }> {
  const fs = await import('node:fs');
  const graph = new ReverseGraph();
  const repoFileSet = new Set(files.map(toRepoPath));
  let unresolved = 0;
  let resolved = 0;
  for (const abs of files) {
    let code: string;
    try {
      code = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const importerRepo = toRepoPath(abs);
    let specifiers: string[];
    try {
      specifiers = await parse(abs, code);
    } catch {
      specifiers = [];
    }
    for (const spec of specifiers) {
      if (!spec) continue;
      let target: string | null = null;
      try {
        target = await resolve(spec, abs);
      } catch {
        target = null;
      }
      if (!target) {
        if (spec.startsWith('.')) unresolved++; // a relative import we failed to resolve = real miss
        continue;
      }
      const targetRepo = toRepoPath(target);
      if (!repoFileSet.has(targetRepo)) continue; // external / node_modules / out of universe
      resolved++;
      graph.addEdge(importerRepo, targetRepo);
    }
  }
  return { graph, unresolved, resolved };
}

export type ParseFn = (absPath: string, code: string) => string[] | Promise<string[]>;
export type ResolveFn = (specifier: string, importerAbs: string) => string | null | Promise<string | null>;

const isRepoSource = (abs: string) =>
  abs.startsWith(REPO_ROOT + path.sep) &&
  !abs.includes(`${path.sep}node_modules${path.sep}`) &&
  SOURCE_EXTS.includes(path.extname(abs));

/**
 * Preview-scoped graph: crawl FORWARD from story entry files, following only intra-repo source
 * imports, and record reverse edges. This reproduces the builder's preview module set (minus
 * tree-shaking) WITHOUT a builder — story entry points come from Storybook's `stories` glob, not
 * the stats file. A changed file not reached from any story affects nothing (correct).
 */
export async function crawlGraph(
  seedsAbs: string[],
  parse: ParseFn,
  resolve: ResolveFn
): Promise<{ graph: ReverseGraph; resolved: number; unresolved: number; reached: number }> {
  const fs = await import('node:fs');
  const graph = new ReverseGraph();
  const visited = new Set<string>();
  const queue = [...seedsAbs];
  let resolved = 0;
  let unresolved = 0;
  while (queue.length) {
    const abs = queue.pop()!;
    if (visited.has(abs)) continue;
    visited.add(abs);
    let code: string;
    try {
      code = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const importerRepo = toRepoPath(abs);
    let specifiers: string[];
    try {
      specifiers = await parse(abs, code);
    } catch {
      specifiers = [];
    }
    for (const spec of specifiers) {
      if (!spec) continue;
      let target: string | null = null;
      try {
        target = await resolve(spec, abs);
      } catch {
        target = null;
      }
      if (!target) {
        if (spec.startsWith('.')) unresolved++;
        continue;
      }
      if (!isRepoSource(target)) continue; // external / node_modules / non-source
      resolved++;
      graph.addEdge(importerRepo, toRepoPath(target));
      if (!visited.has(target)) queue.push(target);
    }
  }
  return { graph, resolved, unresolved, reached: visited.size };
}

/** Measure wall time + peak RSS delta of an async fn. */
export async function measure<T>(fn: () => Promise<T> | T): Promise<{ result: T; ms: number; peakRssMb: number }> {
  if (global.gc) global.gc();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const timer = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, 5);
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  clearInterval(timer);
  const r = process.memoryUsage().rss;
  if (r > peak) peak = r;
  return { result, ms, peakRssMb: (peak - rss0) / 1024 / 1024 };
}
