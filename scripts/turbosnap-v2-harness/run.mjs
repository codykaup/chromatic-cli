/* eslint-disable no-console */
/**
 * TurboSnap v2 hash-manifest test harness.
 *
 * For each Storybook project in the turbosnap-monorepo it:
 *   1. Builds the Storybook with `--stats-json` (produces `preview-stats.json`).
 *   2. Runs the TurboSnap v2 manifest algorithm on it (no Index call — local only).
 *   3. Saves the resulting `turbosnap-manifest.json` as a baseline.
 *   4. Applies a source change (story / component / shared lib), rebuilds, regenerates.
 *   5. Diffs the baseline manifest against the new one: which story hashes changed,
 *      and whether the top-level `storybookHash` changed.
 *
 * Each scenario declares which stories we *expect* to change, so the harness can mark
 * every result PASS/FAIL automatically.
 *
 * Usage:
 *   node run.mjs                # all projects, all scenarios
 *   node run.mjs --projects ui  # limit projects (comma separated)
 *
 * Output: results/<project>/<scenario>/{baseline,after}.json manifests plus a
 * machine-readable results/summary.json and a printed table.
 */
import { execFileSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, '../..');
const MONOREPO = '/home/user/turbosnap-monorepo';
const STORYBOOK_BIN = path.join(MONOREPO, 'node_modules/storybook/bin/index.cjs');
const GENERATOR = path.join(HERE, 'generateManifest.cjs');
const RESULTS = path.join(HERE, 'results');

const ALL_PROJECTS = [
  { name: 'ui', builder: 'vite (react-vite)' },
  { name: 'ui-webpack', builder: 'webpack5 (react-webpack5)' },
  { name: 'ui-rsbuild', builder: 'rsbuild (react-rsbuild)' },
];

/**
 * A scenario mutates one source file and declares the stories we expect to re-hash.
 * `file` is relative to the project package dir; `shared` scenarios edit the shared package
 * (relative to the monorepo root) and therefore affect every project.
 */
const SCENARIOS = [
  {
    id: 'noop-rebuild',
    title: 'Rebuild with no source change (determinism)',
    edit: null,
    expectedChangedStories: [],
    expectStorybookHashChange: false,
  },
  {
    id: 'edit-button-component',
    title: 'Edit Button.tsx (leaf component of Button story)',
    file: 'src/lib/Button/Button.tsx',
    transform: (s) => s.replace("backgroundColor: '#0070f3'", "backgroundColor: '#1111ff'"),
    expectedChangedStories: ['src/lib/Button/Button.stories.tsx'],
    expectStorybookHashChange: true,
  },
  {
    id: 'edit-badge-component',
    title: 'Edit Badge.tsx (shared by Badge + UserCard stories)',
    file: 'src/lib/Badge/Badge.tsx',
    transform: (s) => `${s}\n// harness: badge tweak\n`,
    expectedChangedStories: [
      'src/lib/Badge/Badge.stories.tsx',
      'src/lib/UserCard/UserCard.stories.tsx',
    ],
    expectStorybookHashChange: true,
  },
  {
    id: 'edit-button-story',
    title: 'Edit Button.stories.tsx (the story file itself)',
    file: 'src/lib/Button/Button.stories.tsx',
    transform: (s) =>
      s.replace("label: 'click me'", "label: 'click me now'"),
    expectedChangedStories: ['src/lib/Button/Button.stories.tsx'],
    expectStorybookHashChange: true,
  },
  {
    id: 'edit-shared-lib',
    title: 'Edit @myorg/shared (capitalize + formatDate used by Button & UserCard)',
    sharedFile: 'packages/shared/src/index.ts',
    transform: (s) =>
      s.replace(
        'return str.charAt(0).toUpperCase() + str.slice(1);',
        'return str.charAt(0).toUpperCase() + str.slice(1) + "";'
      ),
    // Button.tsx uses capitalize; UserCard.tsx uses formatDate + User type. Badge uses neither.
    expectedChangedStories: [
      'src/lib/Button/Button.stories.tsx',
      'src/lib/UserCard/UserCard.stories.tsx',
    ],
    expectStorybookHashChange: true,
  },
];

function log(...args) {
  console.log(...args);
}

function pkgDir(project) {
  return path.join(MONOREPO, 'packages', project);
}

function buildStorybook(project) {
  const dir = pkgDir(project);
  execFileSync('node', [STORYBOOK_BIN, 'build', '--stats-json'], {
    cwd: dir,
    stdio: 'pipe',
  });
  const stats = path.join(dir, 'storybook-static', 'preview-stats.json');
  if (!existsSync(stats)) throw new Error(`No preview-stats.json for ${project}`);
  return stats;
}

/**
 * Run the v2 manifest algorithm. Returns { ok, manifest, error }.
 * The algorithm can throw (a known bug on some builders); we capture that instead of aborting.
 */
function generateManifest(project, statsPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  try {
    execFileSync(
      'node',
      [
        GENERATOR,
        '--stats',
        statsPath,
        '--project-root',
        pkgDir(project),
        '--out',
        outDir,
      ],
      { cwd: CLI_ROOT, stdio: 'pipe' }
    );
  } catch (error) {
    return { ok: false, error: (error.stderr?.toString() || error.message).trim() };
  }
  const manifestPath = path.join(outDir, 'turbosnap-manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, error: 'no manifest written' };
  return { ok: true, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath };
}

/** Diff two manifests' story hashes + storybookHash. */
function diffManifests(before, after) {
  const beforeStories = before.storyFiles ?? {};
  const afterStories = after.storyFiles ?? {};
  const keys = new Set([...Object.keys(beforeStories), ...Object.keys(afterStories)]);
  const changed = [];
  const added = [];
  const removed = [];
  const unchanged = [];
  for (const key of [...keys].sort()) {
    const b = beforeStories[key];
    const a = afterStories[key];
    if (b === undefined) added.push(key);
    else if (a === undefined) removed.push(key);
    else if (a !== b) changed.push(key);
    else unchanged.push(key);
  }
  return {
    storybookHashChanged: before.storybookHash !== after.storybookHash,
    beforeStorybookHash: before.storybookHash,
    afterStorybookHash: after.storybookHash,
    changed,
    added,
    removed,
    unchanged,
    beforeStoryCount: Object.keys(beforeStories).length,
    afterStoryCount: Object.keys(afterStories).length,
  };
}

function readSource(scn, project) {
  const p = scn.sharedFile
    ? path.join(MONOREPO, scn.sharedFile)
    : path.join(pkgDir(project), scn.file);
  return { path: p, content: readFileSync(p, 'utf8') };
}

function setsEqual(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

async function main() {
  const argv = process.argv.slice(2);
  const projArg = argv.includes('--projects')
    ? argv[argv.indexOf('--projects') + 1].split(',')
    : null;
  const projects = projArg
    ? ALL_PROJECTS.filter((p) => projArg.includes(p.name))
    : ALL_PROJECTS;

  rmSync(RESULTS, { recursive: true, force: true });
  mkdirSync(RESULTS, { recursive: true });

  const summary = [];

  for (const project of projects) {
    log(`\n=== Project: ${project.name} (${project.builder}) ===`);

    // Baseline: clean build + manifest.
    log(`  [baseline] building storybook...`);
    let baselineStats;
    try {
      baselineStats = buildStorybook(project.name);
    } catch (error) {
      log(`  [baseline] BUILD FAILED: ${(error.stderr?.toString() || error.message).slice(0, 300)}`);
      summary.push({
        project: project.name,
        builder: project.builder,
        scenario: 'baseline-build',
        status: 'BUILD_FAILED',
      });
      continue;
    }
    const baselineDir = path.join(RESULTS, project.name, '_baseline');
    const baseline = generateManifest(project.name, baselineStats, baselineDir);
    if (!baseline.ok) {
      log(`  [baseline] GENERATION FAILED: ${baseline.error.split('\n')[0]}`);
      summary.push({
        project: project.name,
        builder: project.builder,
        scenario: 'baseline-generate',
        status: 'GENERATE_CRASHED',
        error: baseline.error.split('\n')[0],
      });
      continue;
    }
    log(
      `  [baseline] storybookHash=${baseline.manifest.storybookHash} stories=${
        Object.keys(baseline.manifest.storyFiles).length
      }`
    );

    for (const scn of SCENARIOS) {
      const scnDir = path.join(RESULTS, project.name, scn.id);
      mkdirSync(scnDir, { recursive: true });
      cpSync(baseline.manifestPath, path.join(scnDir, 'baseline.json'));

      // Apply edit (if any), with guaranteed restore.
      let saved = null;
      if (scn.edit !== null && (scn.file || scn.sharedFile)) {
        saved = readSource(scn, project.name);
        const next = scn.transform(saved.content);
        if (next === saved.content) {
          log(`  [${scn.id}] WARN: transform was a no-op (pattern not found)`);
        }
        writeFileSync(saved.path, next);
      }

      let result;
      try {
        const stats = buildStorybook(project.name);
        const afterDir = path.join(scnDir, '_after');
        const after = generateManifest(project.name, stats, afterDir);
        if (!after.ok) {
          result = { status: 'GENERATE_CRASHED', error: after.error.split('\n')[0] };
        } else {
          cpSync(after.manifestPath, path.join(scnDir, 'after.json'));
          const diff = diffManifests(baseline.manifest, after.manifest);
          const actualChanged = [...diff.changed, ...diff.added, ...diff.removed];
          const storiesMatch = setsEqual(actualChanged, scn.expectedChangedStories);
          const hashMatch = diff.storybookHashChanged === scn.expectStorybookHashChange;
          result = {
            status: storiesMatch && hashMatch ? 'PASS' : 'FAIL',
            diff,
            expectedChangedStories: scn.expectedChangedStories,
            expectStorybookHashChange: scn.expectStorybookHashChange,
            storiesMatch,
            hashMatch,
          };
        }
      } finally {
        if (saved) writeFileSync(saved.path, saved.content);
      }

      const line =
        result.status === 'PASS'
          ? `PASS`
          : result.status === 'FAIL'
          ? `FAIL (changed=[${result.diff.changed
              .concat(result.diff.added.map((a) => `+${a}`))
              .map((s) => s.replace('src/lib/', ''))
              .join(', ')}] expected=[${scn.expectedChangedStories
              .map((s) => s.replace('src/lib/', ''))
              .join(', ')}] sbHashChanged=${result.diff.storybookHashChanged})`
          : `${result.status}: ${result.error ?? ''}`;
      log(`  [${scn.id}] ${line}`);

      summary.push({
        project: project.name,
        builder: project.builder,
        scenario: scn.id,
        title: scn.title,
        ...result,
      });
    }
  }

  writeFileSync(path.join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`\nWrote ${path.join(RESULTS, 'summary.json')}`);

  // Compact table.
  log('\n=== SUMMARY ===');
  log('project        scenario                status');
  for (const r of summary) {
    log(
      `${r.project.padEnd(14)} ${String(r.scenario).padEnd(23)} ${r.status}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
