/**
 * Per-approach benchmark runner (one approach per process for isolated timing/memory).
 * Usage: tsx bench.mts <oxc|eslexer|typescript|vite|madge> <whole|scoped>
 * Prints one JSON FidelityResult line prefixed with @@RESULT@@.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  ReverseGraph,
  buildGraph,
  candidateSourceFiles,
  crawlGraph,
  isStoryFile,
  measure,
  scoreFidelity,
  statsUniverse,
  toRepoPath,
} from './lib/common.mts';

const key = process.argv[2];
// whole = scan entire source tree; scoped = crawl from stories; ceiling = scoped restricted to the
// builder's actual module set (isolates parse/resolve fidelity from the module-universe problem).
const mode = (process.argv[3] ?? 'scoped') as 'whole' | 'scoped' | 'ceiling';

const gt = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results/groundtruth.json'), 'utf8')
) as { affected: Record<string, string[]> };

const allFiles = candidateSourceFiles();
const storySeeds = allFiles.filter((f) => isStoryFile(toRepoPath(f)));

async function buildGraphFor(): Promise<{ graph: ReverseGraph; name: string; notes: string[] }> {
  const restrict = (g: ReverseGraph) => (mode === 'ceiling' ? g.restrictTo(statsUniverse()) : g);
  if (key === 'madge') {
    const m = await import('./approaches/madge.mts');
    const { graph, extra } = await m.run(mode === 'whole' ? null : storySeeds);
    return { graph: restrict(graph), name: m.name, notes: [...m.notes, ...extra] };
  }
  const mods: Record<string, () => Promise<any>> = {
    oxc: () => import('./approaches/oxc.mts'),
    eslexer: () => import('./approaches/eslexer.mts'),
    typescript: () => import('./approaches/typescript.mts'),
    vite: () => import('./approaches/vite.mts'),
  };
  if (!mods[key]) {
    console.error(`unknown approach: ${key}`);
    process.exit(1);
  }
  const mod = await mods[key]();
  const { parse, resolve, dispose } = await mod.prepare();
  try {
    const r =
      mode === 'whole'
        ? await buildGraph(allFiles, parse, resolve)
        : await crawlGraph(storySeeds, parse, resolve);
    const extra =
      'reached' in r
        ? [`reached ${r.reached} files`, `${r.resolved} edges`, `${r.unresolved} unresolved rel`]
        : [`${r.resolved} edges`, `${r.unresolved} unresolved rel`];
    return { graph: restrict(r.graph), name: mod.name, notes: [...mod.notes, ...extra] };
  } finally {
    await dispose?.();
  }
}

const { result, ms, peakRssMb } = await measure(buildGraphFor);
const score = scoreFidelity(result.name, gt.affected, (changed) => result.graph.affectedStories(changed), {
  buildMs: ms,
  peakRssMb,
  graphNodes: result.graph.nodeCount,
  graphEdges: result.graph.edgeCount,
  notes: result.notes,
});

console.log('@@RESULT@@' + JSON.stringify({ ...score, mode, fileCount: mode === 'whole' ? allFiles.length : storySeeds.length }));
