/**
 * Reference: madge (off-the-shelf, wraps dependency-tree/precinct). Does its own crawl + resolution.
 * Scoped mode seeds from story files; whole mode scans the source roots. Represents "just use an
 * existing dependency-graph tool".
 */
import path from 'node:path';
import madge from 'madge';

import { REPO_ROOT, ReverseGraph, toRepoPath } from '../lib/common.mts';

export const name = 'madge (dependency-tree/precinct)';
export const notes = ['off-the-shelf', 'own resolver (enhanced-resolve based)', 'JSX/TSX via precinct'];

export async function run(seeds: string[] | null): Promise<{ graph: ReverseGraph; extra: string[] }> {
  const entry = seeds ?? ['node-src', 'isChromatic.js'];
  const res = await madge(entry, {
    baseDir: REPO_ROOT,
    fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs'],
    tsConfig: path.join(REPO_ROOT, 'tsconfig.json'),
  });
  const forward = res.obj();
  const graph = new ReverseGraph();
  let edges = 0;
  for (const [importer, deps] of Object.entries(forward)) {
    const importerRepo = toRepoPath(path.join(REPO_ROOT, importer));
    for (const dep of deps as string[]) {
      graph.addEdge(importerRepo, toRepoPath(path.join(REPO_ROOT, dep)));
      edges++;
    }
  }
  const skipped = res.warnings?.()?.skipped?.length ?? 0;
  return { graph, extra: [`${edges} edges`, `${skipped} skipped (madge warnings)`] };
}
