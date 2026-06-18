/**
 * Reproduce PR #3's 11-scenario end-to-end matrix, but with builder-INDEPENDENT inputs:
 *   - the forward dependency graph comes from each of our static approaches (not builder stats)
 *   - per-file content hashes come from our own hashing (raw bytes OR esbuild-stripped)
 * then roll each story up exactly like PR #3's `computeStoryHashes` (content-only digest of the
 * story's forward closure + the shared `.storybook/preview.*` section) and diff base vs edited.
 *
 * Output: results/scenarios.json — counts per (approach, hashMode, scenario).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import xxhashInit from 'xxhash-wasm';
import { build as esbuild, transform } from 'esbuild';

import { REPO_ROOT, candidateSourceFiles, isStoryFile, toRepoPath } from './lib/common.mts';
import { SOURCE_EXTS } from './lib/config.mts';

const { create64 } = await xxhashInit();
const PREVIEW = '.storybook/preview.ts';

type HashMode = 'raw' | 'stripped';
const fileHash = async (repoPath: string, code: string, mode: HashMode): Promise<string> => {
  if (mode === 'raw') return create64().update(code).digest().toString(16);
  const ext = path.extname(repoPath);
  if (!['.ts', '.tsx', '.jsx', '.mts', '.cts'].includes(ext))
    return create64().update(code).digest().toString(16); // .js/.mjs: nothing to strip
  try {
    const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'ts';
    const out = await transform(code, { loader, format: 'esm', legalComments: 'none' });
    return create64().update(out.code).digest().toString(16);
  } catch {
    return create64().update(code).digest().toString(16);
  }
};

// ---- forward graph from a static approach (importer -> set of intra-repo imports) ----
const isRepoSource = (abs: string) =>
  abs.startsWith(REPO_ROOT + path.sep) &&
  !abs.includes(`${path.sep}node_modules${path.sep}`) &&
  SOURCE_EXTS.includes(path.extname(abs));

async function buildForward(approach: string) {
  const seeds = [
    ...candidateSourceFiles().filter((f) => isStoryFile(toRepoPath(f))),
    path.join(REPO_ROOT, PREVIEW),
  ];
  const forward = new Map<string, Set<string>>();
  const contentOf = new Map<string, string>();

  if (approach === 'esbuildmeta') {
    // One uniform scan pass: esbuild resolves ESM+CJS+TS, elides types, emits the graph.
    // packages:'external' stops at the node_modules boundary to match the other source-only runs.
    const r = await esbuild({
      entryPoints: seeds,
      bundle: true, metafile: true, write: false, outdir: 'scan-out',
      logLevel: 'silent', platform: 'node', format: 'esm', packages: 'external',
      loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.html': 'empty' },
    }).catch((e) => { throw new Error('esbuild scan failed: ' + (e.message?.split('\n')[0] ?? e)); });
    for (const [file, info] of Object.entries(r.metafile.inputs)) {
      const importer = toRepoPath(path.join(REPO_ROOT, file));
      if (!forward.has(importer)) forward.set(importer, new Set());
      for (const imp of (info as any).imports) {
        const abs = path.join(REPO_ROOT, imp.path);
        if (isRepoSource(abs)) forward.get(importer)!.add(toRepoPath(abs));
      }
    }
    for (const f of forward.keys()) { try { contentOf.set(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')); } catch {} }
    return { forward, contentOf };
  }

  if (approach === 'madge') {
    const madge = (await import('madge')).default;
    const res = await madge(['node-src', 'isChromatic.js', PREVIEW], {
      baseDir: REPO_ROOT,
      fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs'],
      tsConfig: path.join(REPO_ROOT, 'tsconfig.json'),
    });
    for (const [imp, deps] of Object.entries(res.obj())) {
      forward.set(imp, new Set(deps as string[]));
    }
    for (const f of forward.keys()) {
      try { contentOf.set(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')); } catch {}
    }
    return { forward, contentOf };
  }

  const mod = await import(`./approaches/${approach}.mts`);
  const { parse, resolve, dispose } = await mod.prepare();
  const visited = new Set<string>();
  const queue = [...seeds];
  try {
    while (queue.length) {
      const abs = queue.pop()!;
      if (visited.has(abs)) continue;
      visited.add(abs);
      let code: string;
      try { code = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const importer = toRepoPath(abs);
      contentOf.set(importer, code);
      if (!forward.has(importer)) forward.set(importer, new Set());
      let specs: string[];
      try { specs = await parse(abs, code); } catch { specs = []; }
      for (const spec of specs) {
        if (!spec) continue;
        let target: string | null = null;
        try { target = await resolve(spec, abs); } catch { target = null; }
        if (!target || !isRepoSource(target)) continue;
        forward.get(importer)!.add(toRepoPath(target));
        if (!visited.has(target)) queue.push(target);
      }
    }
  } finally {
    await dispose?.();
  }
  return { forward, contentOf };
}

// ---- PR #3 rollup, content-only ----
function reach(start: string, forward: Map<string, Set<string>>): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  for (const cur of queue) for (const next of forward.get(cur) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}
function digest(names: Iterable<string>, hashOf: Map<string, string>): string {
  const doc = [...names].map((n) => hashOf.get(n) ?? '').sort().join('\n');
  return createHash('sha256').update(doc).digest('hex').slice(0, 16);
}
function computeStoryHashes(forward: Map<string, Set<string>>, stories: Set<string>, hashOf: Map<string, string>) {
  const shared = forward.has(PREVIEW) ? reach(PREVIEW, forward) : new Set<string>();
  const out: Record<string, string> = {};
  for (const s of stories) {
    const deps = reach(s, forward);
    for (const m of shared) deps.add(m);
    out[s] = digest(deps, hashOf);
  }
  return out;
}
function diff(base: Record<string, string>, cur: Record<string, string>) {
  const common = Object.keys(cur).filter((s) => s in base);
  const changed = common.filter((s) => cur[s] !== base[s]);
  const added = Object.keys(cur).filter((s) => !(s in base));
  const removed = Object.keys(base).filter((s) => !(s in cur));
  return { changed: changed.length, added: added.length, removed: removed.length };
}

// ---- scenarios ----
const SUBSTANTIVE = '\nexport const __probe_added_symbol = 42;\n';
const COMMENT = '// probe: a comment-only edit\n';

interface ScenarioResult { changed: number; added: number; removed: number; note?: string }

async function runScenarios(approach: string, mode: HashMode) {
  const t0 = performance.now();
  const { forward, contentOf } = await buildForward(approach);
  const buildMs = Math.round(performance.now() - t0);
  const stories = new Set([...forward.keys()].filter(isStoryFile));

  // base content hashes
  const baseHash = new Map<string, string>();
  for (const [f, code] of contentOf) baseHash.set(f, await fileHash(f, code, mode));
  const baseStoryHashes = computeStoryHashes(forward, stories, baseHash);

  const AUTH_STORY = 'node-src/ui/tasks/auth.stories.ts';
  const AUTH_DEP = 'node-src/ui/tasks/auth.ts';
  const LINK_STORY = 'node-src/ui/components/link.stories.ts';
  const TASK = 'node-src/ui/components/task.ts';

  // helper: clone base hashes, override one file with edited content
  const withEdit = async (file: string, edited: string) => {
    const h = new Map(baseHash);
    h.set(file, await fileHash(file, edited, mode));
    return computeStoryHashes(forward, stories, h);
  };

  const results: Record<string, ScenarioResult> = {};
  const D = (cur: Record<string, string>) => diff(baseStoryHashes, cur);

  // 1 determinism
  results['1_rebuild_no_edit'] = D(computeStoryHashes(forward, stories, new Map(baseHash)));
  // 2 story substantive
  results['2_story_substantive'] = D(await withEdit(AUTH_STORY, contentOf.get(AUTH_STORY)! + SUBSTANTIVE));
  // 3 story comment-only
  results['3_story_comment_only'] = D(await withEdit(AUTH_STORY, COMMENT + contentOf.get(AUTH_STORY)!));
  // 4 used dependency code change
  results['4_used_dep_code'] = D(await withEdit(AUTH_DEP, contentOf.get(AUTH_DEP)! + SUBSTANTIVE));
  // 5 preview config
  results['5_preview_config'] = D(await withEdit(PREVIEW, contentOf.get(PREVIEW)! + SUBSTANTIVE));
  // 6 & 7 preview dependency (node_module ansi-html) — outside the source universe
  results['6_preview_dep_substantive'] = { ...D(baseStoryHashes), note: 'node_modules dep — not in source graph' };
  results['7_preview_dep_comment'] = { ...D(baseStoryHashes), note: 'node_modules dep — not in source graph' };
  // 8 add a story (imports an existing component)
  {
    const f2 = new Map(forward);
    const extra = 'node-src/ui/components/extra.stories.ts';
    f2.set(extra, new Set([TASK]));
    const s2 = new Set([...stories, extra]);
    const h2 = new Map(baseHash); h2.set(extra, await fileHash(extra, 'export const Extra = () => task();', mode));
    results['8_add_story'] = diff(baseStoryHashes, computeStoryHashes(f2, s2, h2));
  }
  // 9 remove a story
  {
    const s2 = new Set(stories); s2.delete(LINK_STORY);
    results['9_remove_story'] = diff(baseStoryHashes, computeStoryHashes(forward, s2, baseHash));
  }
  // 10 out-of-graph file (README) — not a node in the graph
  results['10_readme_out_of_graph'] = D(computeStoryHashes(forward, stories, new Map(baseHash)));
  // 11 dependency path relocated, content identical
  {
    const RELOC = 'node-src/ui/components/task.__relocated__.ts';
    const f2 = new Map<string, Set<string>>();
    for (const [imp, deps] of forward) {
      const ni = imp === TASK ? RELOC : imp;
      const nd = new Set([...deps].map((d) => (d === TASK ? RELOC : d)));
      f2.set(ni, nd);
    }
    const h2 = new Map(baseHash); h2.set(RELOC, baseHash.get(TASK)!); // same content hash, new path
    h2.delete(TASK);
    results['11_paths_relocated_same_content'] = diff(baseStoryHashes, computeStoryHashes(f2, stories, h2));
  }

  return { storyCount: stories.size, buildMs, results };
}

const APPROACHES = ['oxc', 'eslexer', 'oxcRequire', 'oxcStripRequire', 'esbuildmeta', 'typescript', 'vite', 'madge'];
const out: any = { generatedAt: new Date().toISOString(), runs: {} };
for (const approach of APPROACHES) {
  for (const mode of ['raw', 'stripped'] as HashMode[]) {
    process.stderr.write(`scenarios: ${approach}/${mode}...\n`);
    try {
      out.runs[`${approach}_${mode}`] = await runScenarios(approach, mode);
    } catch (e: any) {
      out.runs[`${approach}_${mode}`] = { error: e.message?.split('\n')[0] };
    }
  }
}
fs.writeFileSync(path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results/scenarios.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
