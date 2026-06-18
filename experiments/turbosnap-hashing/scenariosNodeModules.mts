/**
 * Can we close PR #3's #6/#7 gap by crawling INTO node_modules for the complete graph?
 *
 * Same rollup as scenarios.mts, but the crawl follows resolved imports into node_modules too (the
 * reachable closure — not all of node_modules). Hashing is TRANSFORM-AWARE to mirror the builder:
 *   - in-project source  → esbuild-stripped (builder transforms it; comments don't count)
 *   - node_modules files  → raw bytes        (builder passes them through; comments DO count)
 * Uses the recommended grapher (es-module-lexer). Reports cost vs source-only and the #6/#7 result.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import xxhashInit from 'xxhash-wasm';
import { transform } from 'esbuild';

import { REPO_ROOT, candidateSourceFiles, isStoryFile, toRepoPath } from './lib/common.mts';
import { SOURCE_EXTS } from './lib/config.mts';
import * as eslexer from './approaches/eslexer.mts';

const { create64 } = await xxhashInit();
const PREVIEW = '.storybook/preview.ts';
const isNodeModule = (repoPath: string) => repoPath.includes('node_modules/');
const xx = (s: string) => create64().update(s).digest().toString(16);

async function stripHash(repoPath: string, code: string): Promise<string> {
  const ext = path.extname(repoPath);
  if (!['.ts', '.tsx', '.jsx', '.mts', '.cts'].includes(ext)) return xx(code);
  try {
    const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'ts';
    return xx((await transform(code, { loader, format: 'esm', legalComments: 'none' })).code);
  } catch {
    return xx(code);
  }
}
// transform-aware: node_modules raw, source stripped
const fileHash = async (repoPath: string, code: string) =>
  isNodeModule(repoPath) ? xx(code) : stripHash(repoPath, code);

async function buildForward(includeNodeModules: boolean, cap = 60000) {
  const seeds = [
    ...candidateSourceFiles().filter((f) => isStoryFile(toRepoPath(f))),
    path.join(REPO_ROOT, PREVIEW),
  ];
  const underRepo = (abs: string) =>
    abs.startsWith(REPO_ROOT + path.sep) && SOURCE_EXTS.includes(path.extname(abs));
  const keep = (abs: string) =>
    underRepo(abs) && (includeNodeModules || !abs.includes(`${path.sep}node_modules${path.sep}`));

  const { parse, resolve } = await eslexer.prepare();
  const forward = new Map<string, Set<string>>();
  const contentOf = new Map<string, string>();
  const visited = new Set<string>();
  const queue = [...seeds];
  while (queue.length && visited.size < cap) {
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
      if (!target || !keep(target)) continue;
      forward.get(importer)!.add(toRepoPath(target));
      if (!visited.has(target)) queue.push(target);
    }
  }
  return { forward, contentOf, reached: visited.size, capped: visited.size >= cap };
}

function reach(start: string, forward: Map<string, Set<string>>) {
  const seen = new Set([start]); const q = [start];
  for (const c of q) for (const n of forward.get(c) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}
const digest = (names: Iterable<string>, hashOf: Map<string, string>) =>
  createHash('sha256').update([...names].map((n) => hashOf.get(n) ?? '').sort().join('\n')).digest('hex').slice(0, 16);
function storyHashes(forward: Map<string, Set<string>>, stories: Set<string>, hashOf: Map<string, string>) {
  const shared = forward.has(PREVIEW) ? reach(PREVIEW, forward) : new Set<string>();
  const out: Record<string, string> = {};
  for (const s of stories) { const d = reach(s, forward); for (const m of shared) d.add(m); out[s] = digest(d, hashOf); }
  return out;
}
const diff = (base: Record<string, string>, cur: Record<string, string>) => {
  const common = Object.keys(cur).filter((s) => s in base);
  return {
    changed: common.filter((s) => cur[s] !== base[s]).length,
    added: Object.keys(cur).filter((s) => !(s in base)).length,
    removed: Object.keys(base).filter((s) => !(s in cur)).length,
  };
};

async function run(includeNodeModules: boolean) {
  const t0 = performance.now();
  const { forward, contentOf, reached, capped } = await buildForward(includeNodeModules);
  const buildMs = performance.now() - t0;
  const stories = new Set([...forward.keys()].filter(isStoryFile));
  const baseHash = new Map<string, string>();
  for (const [f, code] of contentOf) baseHash.set(f, await fileHash(f, code));
  const base = storyHashes(forward, stories, baseHash);

  const withEdit = async (file: string, edited: string) => {
    const h = new Map(baseHash); h.set(file, await fileHash(file, edited));
    return diff(base, storyHashes(forward, stories, h));
  };

  const AUTH_STORY = 'node-src/ui/tasks/auth.stories.ts';
  const AUTH_DEP = 'node-src/ui/tasks/auth.ts';
  const ansi = [...contentOf.keys()].find((f) => /node_modules\/ansi-html\//.test(f));

  const results: Record<string, any> = {
    _meta: { includeNodeModules, reached, capped, buildMs: Math.round(buildMs), stories: stories.size, ansiHtmlInGraph: Boolean(ansi) },
    '3_story_comment_only': await withEdit(AUTH_STORY, '// c\n' + contentOf.get(AUTH_STORY)!),
    '4_used_dep_code': await withEdit(AUTH_DEP, contentOf.get(AUTH_DEP)! + '\nexport const __p=1;\n'),
  };
  if (ansi) {
    results['6_preview_dep_substantive'] = await withEdit(ansi, contentOf.get(ansi)! + '\nvar __p=1;\n');
    results['7_preview_dep_comment'] = await withEdit(ansi, '/* c */\n' + contentOf.get(ansi)!);
  } else {
    results['6_preview_dep_substantive'] = { note: 'ansi-html not reached' };
    results['7_preview_dep_comment'] = { note: 'ansi-html not reached' };
  }
  return results;
}

const out = { generatedAt: new Date().toISOString(), sourceOnly: await run(false), withNodeModules: await run(true) };
fs.writeFileSync(path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results/scenarios-nodemodules.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
