/**
 * Ground truth = the REAL TurboSnap algorithm (`getDependentStoryFiles`) run against the
 * builder-emitted preview-stats.json. We run it once per candidate changed file and record the
 * set of affected story files, so prototypes can be scored against it.
 */
import path from 'node:path';
import fs from 'node:fs';

import { getDependentStoryFiles } from '../../../node-src/lib/turbosnap/getDependentStoryFiles';
import { readStatsFile } from '../../../node-src/tasks/readStatsFile';
import { REPO_ROOT, gitTrackedFiles, isStoryFile } from './common.mts';

const STATS_PATH = path.join(REPO_ROOT, 'storybook-static/preview-stats.json');

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  queue() {},
  setLevel() {},
} as any;

function makeCtx() {
  return {
    log: silentLog,
    options: { storybookConfigDir: '.storybook', untraced: [], traceChanged: false },
    git: { rootPath: REPO_ROOT },
    storybook: { baseDir: '', configDir: '.storybook', staticDir: ['static'] },
    turboSnap: {},
  } as any;
}

export interface GroundTruth {
  /** repo paths that are nodes in the builder graph and exist as real source files */
  scenarioFiles: string[];
  /** every story file the builder knows about */
  storyFiles: string[];
  /** changed file -> sorted affected story files */
  affected: Record<string, string[]>;
  /** files that triggered a bail (storybook config / static dir) instead of a trace */
  bailFiles: string[];
}

export async function buildGroundTruth(): Promise<GroundTruth> {
  const stats = await readStatsFile(STATS_PATH);
  const tracked = new Set(gitTrackedFiles());

  // Candidate changed files: stats user-modules normalized to repo paths that exist on disk.
  const scenarioSet = new Set<string>();
  for (const m of stats.modules) {
    if (!m.name || m.name.includes('node_modules') || m.name.startsWith('/virtual')) continue;
    const repoPath = m.name.replace(/^\.\//, '').replace(/\s+\+\s+\d+\s+modules?$/, '').replace(/\?.*$/, '');
    if (tracked.has(repoPath) && /^node-src\//.test(repoPath)) scenarioSet.add(repoPath);
  }
  const scenarioFiles = [...scenarioSet].sort();

  const affected: Record<string, string[]> = {};
  const storyFiles = new Set<string>();
  const bailFiles: string[] = [];

  for (const changed of scenarioFiles) {
    const ctx = makeCtx();
    const result = await getDependentStoryFiles(ctx, stats, STATS_PATH, [changed]);
    if (!result) {
      bailFiles.push(changed);
      affected[changed] = []; // handled separately; excluded from graph-fidelity core metric
      continue;
    }
    const stories = new Set<string>();
    for (const files of Object.values(result)) {
      for (const f of files as string[]) {
        const repoPath = f.replace(/\s+\+\s+\d+\s+modules?$/, '');
        if (isStoryFile(repoPath)) {
          stories.add(repoPath);
          storyFiles.add(repoPath);
        }
      }
    }
    affected[changed] = [...stories].sort();
  }

  return {
    scenarioFiles,
    storyFiles: [...storyFiles].sort(),
    affected,
    bailFiles,
  };
}

// Allow running standalone to dump + sanity-check.
if (import.meta.url === `file://${process.argv[1]}`) {
  const gt = await buildGroundTruth();
  const outDir = path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'groundtruth.json'), JSON.stringify(gt, null, 2));
  const withStories = gt.scenarioFiles.filter((f) => gt.affected[f]?.length).length;
  console.log(`scenarioFiles: ${gt.scenarioFiles.length}`);
  console.log(`storyFiles:    ${gt.storyFiles.length}`);
  console.log(`bailFiles:     ${gt.bailFiles.length}`);
  console.log(`files affecting >=1 story: ${withStories}`);
  // Show a couple of high-fanout examples
  const ranked = gt.scenarioFiles
    .map((f) => [f, gt.affected[f].length] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log('top fan-out files:');
  for (const [f, n] of ranked) console.log(`  ${n}\t${f}`);
}
