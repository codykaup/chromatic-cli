/**
 * Completeness check: does a node_modules-inclusive graph close PR #3's #6/#7 (preview dep in
 * node_modules) WITHOUT missing CJS-internal dependency changes? Uses esbuild metafile with
 * bundle:true (follows into node_modules, bundles CJS natively) + transform-aware hashing
 * (source stripped, node_modules raw). "No missed capture" is the bar: every real content change
 * to a reachable module must bust its dependent stories.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { build } from 'esbuild';
import xxhashInit from 'xxhash-wasm';
import { transform } from 'esbuild';

import { REPO_ROOT, candidateSourceFiles, isStoryFile, toRepoPath } from './lib/common.mts';

const { create64 } = await xxhashInit();
const PREVIEW = '.storybook/preview.ts';
const xx = (s: string) => create64().update(s).digest().toString(16);
const isNodeModule = (p: string) => p.includes('node_modules/');

async function stripHash(repoPath: string, code: string) {
  const ext = path.extname(repoPath);
  if (!['.ts', '.tsx', '.jsx', '.mts', '.cts'].includes(ext)) return xx(code);
  try {
    const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'ts';
    return xx((await transform(code, { loader, format: 'esm', legalComments: 'none' })).code);
  } catch { return xx(code); }
}
// transform-aware: node_modules raw (builder passes through), source stripped (builder transforms)
const fileHash = (repoPath: string, code: string) =>
  isNodeModule(repoPath) ? xx(code) : stripHash(repoPath, code);

async function buildGraph() {
  const seeds = [
    ...candidateSourceFiles().filter((f) => isStoryFile(toRepoPath(f))),
    path.join(REPO_ROOT, PREVIEW),
  ];
  const t0 = performance.now();
  const r = await build({
    entryPoints: seeds,
    bundle: true, metafile: true, write: false, outdir: 'scan-out',
    logLevel: 'silent', platform: 'node', format: 'esm', // NO packages:external → follow node_modules
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.html': 'empty' },
  });
  const buildMs = Math.round(performance.now() - t0);
  const forward = new Map<string, Set<string>>();
  const contentOf = new Map<string, string>();
  const underRepo = (abs: string) => abs.startsWith(REPO_ROOT + path.sep);
  for (const [file, info] of Object.entries(r.metafile.inputs)) {
    const importerAbs = path.join(REPO_ROOT, file);
    if (!underRepo(importerAbs)) continue;
    const importer = toRepoPath(importerAbs);
    if (!forward.has(importer)) forward.set(importer, new Set());
    try { contentOf.set(importer, fs.readFileSync(importerAbs, 'utf8')); } catch {}
    for (const imp of (info as any).imports) {
      const abs = path.join(REPO_ROOT, imp.path);
      if (underRepo(abs)) forward.get(importer)!.add(toRepoPath(abs));
    }
  }
  return { forward, contentOf, buildMs };
}

function reach(start: string, forward: Map<string, Set<string>>) {
  const seen = new Set([start]); const q = [start];
  for (const c of q) for (const n of forward.get(c) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}
const digest = (names: Iterable<string>, h: Map<string, string>) =>
  createHash('sha256').update([...names].map((n) => h.get(n) ?? '').sort().join('\n')).digest('hex').slice(0, 16);
function storyHashes(forward: Map<string, Set<string>>, stories: Set<string>, h: Map<string, string>) {
  const shared = forward.has(PREVIEW) ? reach(PREVIEW, forward) : new Set<string>();
  const out: Record<string, string> = {};
  for (const s of stories) { const d = reach(s, forward); for (const m of shared) d.add(m); out[s] = digest(d, h); }
  return out;
}
const diff = (base: Record<string, string>, cur: Record<string, string>) =>
  Object.keys(cur).filter((s) => s in base && cur[s] !== base[s]).length;

const { forward, contentOf, buildMs } = await buildGraph();
const stories = new Set([...forward.keys()].filter(isStoryFile));
const nmFiles = [...contentOf.keys()].filter(isNodeModule);
const baseHash = new Map<string, string>();
for (const [f, code] of contentOf) baseHash.set(f, await fileHash(f, code));
const base = storyHashes(forward, stories, baseHash);

const withEdit = async (file: string, edited: string) => {
  const h = new Map(baseHash); h.set(file, await fileHash(file, edited));
  return diff(base, storyHashes(forward, stories, h));
};

const AUTH_STORY = 'node-src/ui/tasks/auth.stories.ts';
const AUTH_DEP = 'node-src/ui/tasks/auth.ts';
const ansiEntry = nmFiles.find((f) => /node_modules\/ansi-html\//.test(f));
// a CJS-internal file reached ONLY via require() (es-module-lexer would miss this)
const cjsInternal = nmFiles.find((f) => /node_modules\/chalk\/source\/.+\.js$/.test(f) && !/index\.js$/.test(f))
  ?? nmFiles.find((f) => /node_modules\/ansi-styles\//.test(f));

const results: Record<string, any> = {
  _meta: {
    buildMs, stories: stories.size, totalReached: contentOf.size,
    nodeModulesReached: nmFiles.length,
    ansiHtmlInGraph: Boolean(ansiEntry),
    cjsInternalProbe: cjsInternal ?? null,
  },
  '3_story_comment_only': await withEdit(AUTH_STORY, '// c\n' + contentOf.get(AUTH_STORY)!),
  '4_used_dep_code': await withEdit(AUTH_DEP, contentOf.get(AUTH_DEP)! + '\nexport const __p=1;\n'),
  '5_preview_config': await withEdit(PREVIEW, contentOf.get(PREVIEW)! + '\nexport const __p=1;\n'),
  '6_preview_dep_substantive': ansiEntry ? await withEdit(ansiEntry, contentOf.get(ansiEntry)! + '\nvar __p=1;\n') : 'ansi-html not reached',
  '7_preview_dep_comment': ansiEntry ? await withEdit(ansiEntry, '/* c */\n' + contentOf.get(ansiEntry)!) : 'ansi-html not reached',
  '8_cjs_internal_dep': cjsInternal ? await withEdit(cjsInternal, contentOf.get(cjsInternal)! + '\nvar __p=1;\n') : 'no CJS-internal file reached',
};

fs.writeFileSync(path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results/scenarios-complete.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
