import { createHash } from 'crypto';

import { Context, Module, Stats } from '../../types';

/**
 * The Vite builder bridges Storybook's preview subgraph into the stats graph through this virtual
 * module (see the builder's `webpack-stats-plugin`). Everything reachable from it is preview/global
 * config — `.storybook/preview.*`, addon previews and their dependencies — so a content change
 * anywhere in that subgraph affects every story and we recapture all of them.
 */
const PROJECT_ANNOTATIONS_NAME = '/virtual:/@storybook/builder-vite/project-annotations.js';

interface GraphNode {
  id: Module['id'];
  name: string;
  contentHash?: string;
  /** Normalized names of the modules that import this one (i.e. its `reasons`). */
  importers: string[];
}

interface StoryGraph {
  byName: Map<string, GraphNode>;
  /** Forward edges: importer name -> set of imported names. */
  forward: Map<string, Set<string>>;
  /** Story files: modules imported (directly) by a CSF glob aggregator. */
  storyFiles: Set<string>;
  /** Modules reachable from the project-annotations module (preview/global config). */
  previewSubgraph: Set<string>;
}

export interface StoryHashComparison {
  /** Story files present in both builds whose rolled-up content hash changed. */
  changed: string[];
  /** Story files present only in the head build. */
  added: string[];
  /** Story files present only in the baseline build. */
  removed: string[];
  /** Whether any module in the preview subgraph changed (by content), implying a full recapture. */
  previewChanged: boolean;
  /** Preview-subgraph files whose content changed, for bail messaging. */
  changedPreviewFiles: string[];
}

export interface HashComparisonOptions {
  normalize: (posixPath: string) => string;
  /** Normalized stories-entry file names (the builder's entry modules). */
  storiesEntryFiles: string[];
  isStorybookFile: (name: string) => boolean;
}

/** Whether a stats object carries per-module content hashes (i.e. the builder supports them). */
export function hasContentHashes(stats: Stats): boolean {
  return stats.modules.some((module_) => typeof module_.contentHash === 'string');
}

/** Build the lookup structures the comparison needs from a builder stats object. */
function buildGraph(stats: Stats, options: HashComparisonOptions): StoryGraph {
  const { normalize, storiesEntryFiles, isStorybookFile } = options;
  const byName = new Map<string, GraphNode>();
  const forward = new Map<string, Set<string>>();

  for (const module_ of stats.modules) {
    if (module_.id === undefined || module_.id === null) {
      continue;
    }
    const name = normalize(module_.name);
    const importers = (module_.reasons ?? [])
      .map((reason) => normalize(reason.moduleName))
      .filter((reasonName) => reasonName && reasonName !== name);

    byName.set(name, { id: module_.id, name, contentHash: module_.contentHash, importers });

    for (const importer of importers) {
      if (!forward.has(importer)) {
        forward.set(importer, new Set());
      }
      forward.get(importer)?.add(name);
    }
  }

  // CSF glob aggregators are modules imported directly by a stories entry (e.g. the Vite builder's
  // `storybook-stories.js`); story files are the modules those aggregators import.
  const isEntry = (reasonName: string) =>
    storiesEntryFiles.some((entry) => reasonName.startsWith(entry));
  const csfGlobs = new Set<string>();
  for (const [name, node] of byName) {
    if (!isStorybookFile(name) && node.importers.some((importer) => isEntry(importer))) {
      csfGlobs.add(name);
    }
  }
  const storyFiles = new Set<string>();
  for (const [name, node] of byName) {
    if (node.importers.some((importer) => csfGlobs.has(importer))) {
      storyFiles.add(name);
    }
  }

  const previewSubgraph = forwardReachable(forward, normalize(PROJECT_ANNOTATIONS_NAME));

  return { byName, forward, storyFiles, previewSubgraph };
}

/** All names reachable by following forward edges from `start` (excluding `start` itself). */
function forwardReachable(forward: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of forward.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/**
 * Reduce a story file to a single hash over the sorted multiset of `contentHash`es of itself and
 * its reachable dependencies (excluding the preview subgraph). Keyed on content, not module names,
 * so dependencies that resolve to different absolute paths across machines (e.g. a global package
 * cache) but have identical content do not look changed.
 */
function rolledUpHash(graph: StoryGraph, storyFile: string): string {
  const reachable = forwardReachable(graph.forward, storyFile);
  const hashes = [storyFile, ...reachable]
    .filter((name) => !graph.previewSubgraph.has(name) || name === storyFile)
    .map((name) => graph.byName.get(name)?.contentHash)
    .filter((hash): hash is string => Boolean(hash))
    .sort();
  return createHash('sha256').update(hashes.join('\n')).digest('hex').slice(0, 16);
}

/** Sorted multiset of preview-subgraph content hashes — its signature for change detection. */
function previewSignature(graph: StoryGraph): string {
  return [...graph.previewSubgraph]
    .map((name) => graph.byName.get(name)?.contentHash)
    .filter((hash): hash is string => Boolean(hash))
    .sort()
    .join('\n');
}

/**
 * Compare two builds' stats by content hash and determine which story files changed, were added or
 * removed, and whether a preview/global change means everything must be recaptured.
 */
export function compareStoryHashes(
  baselineStats: Stats,
  headStats: Stats,
  options: HashComparisonOptions
): StoryHashComparison {
  const baseline = buildGraph(baselineStats, options);
  const head = buildGraph(headStats, options);

  const added = [...head.storyFiles].filter((name) => !baseline.storyFiles.has(name));
  const removed = [...baseline.storyFiles].filter((name) => !head.storyFiles.has(name));
  const common = [...head.storyFiles].filter((name) => baseline.storyFiles.has(name));

  const previewChanged = previewSignature(baseline) !== previewSignature(head);
  const changedPreviewFiles = previewChanged
    ? [...new Set([...baseline.previewSubgraph, ...head.previewSubgraph])].filter((name) => {
        const before = baseline.byName.get(name)?.contentHash;
        const after = head.byName.get(name)?.contentHash;
        return before !== after;
      })
    : [];

  const changed = previewChanged
    ? common
    : common.filter((name) => rolledUpHash(baseline, name) !== rolledUpHash(head, name));

  return { changed, added, removed, previewChanged, changedPreviewFiles };
}

/**
 * Hash-based equivalent of `getDependentStoryFiles`: given the baseline and head build stats (both
 * carrying `contentHash`es), return the affected story files keyed by module id, or `undefined`
 * (after recording a bail reason) when a preview/global change requires recapturing everything.
 */
export function getDependentStoryFilesByHash(
  ctx: Context,
  baselineStats: Stats,
  headStats: Stats,
  options: HashComparisonOptions
): Record<string, string[]> | undefined {
  const { changed, added, previewChanged, changedPreviewFiles } = compareStoryHashes(
    baselineStats,
    headStats,
    options
  );

  if (!ctx.turboSnap) {
    ctx.turboSnap = {};
  }

  if (previewChanged) {
    // A preview/global change affects every story; bail so the whole Storybook is recaptured.
    ctx.turboSnap.bailReason = { changedStorybookFiles: changedPreviewFiles };
    return undefined;
  }

  const head = buildGraph(headStats, options);
  const affectedModules: Record<string, string[]> = {};
  for (const name of [...changed, ...added]) {
    const node = head.byName.get(name);
    if (node && node.id !== undefined && node.id !== null) {
      affectedModules[String(node.id)] = [name];
    }
  }
  return affectedModules;
}
