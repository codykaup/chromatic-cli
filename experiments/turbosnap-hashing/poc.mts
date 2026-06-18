/**
 * PoC: hash-based TurboSnap (CLI-side hashing, backend-baseline manifest, no lockfile/no git blobs).
 *
 * Three signals, all from files that exist NOW on disk; diffed against a baseline MANIFEST (what the
 * backend persists per build), never against git blobs:
 *   1. PREVIEW bail  — require-aware import closure of preview.* (incl. node_modules) + preview-head + staticDirs.
 *   2. MAIN bail     — main.* + resolved framework + core.builder entries.
 *   3. PER-STORY     — from preview-stats.json reasons: each story's reachable file set → one content-only hash.
 * Bail signals (1,2) changed ⇒ recapture everything. Else per-story hash diff ⇒ recapture changed/added.
 *
 * Migration: the manifest is always computed (to upload). If no/incompatible baseline manifest exists,
 * fall back to the legacy algorithm for THIS run while still uploading the manifest for next time.
 *
 * Run: tsx poc.mts            (prints the manifest summary + a decision table over simulated edits)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ResolverFactory } from 'oxc-resolver';
import xxhashInit from 'xxhash-wasm';

import { REPO_ROOT } from './lib/common.mts';
import { SOURCE_EXTS } from './lib/config.mts';
import * as unified from './approaches/oxcStripRequire.mts';

const MANIFEST_VERSION = 'poc-1'; // bump to force capture-all on incompatible baselines
const { create64 } = await xxhashInit();
const xx = (s: string | Buffer) => create64().update(s).digest().toString(16);
const rel = (abs: string) => path.relative(REPO_ROOT, abs);
const abs = (repoPath: string) => path.join(REPO_ROOT, repoPath);
const CONFIG_DIR = path.join(REPO_ROOT, '.storybook');
const STATS = path.join(REPO_ROOT, 'storybook-static/preview-stats.json');

const { parse, resolve } = await unified.prepare();
const resolver = new ResolverFactory({ extensions: SOURCE_EXTS, conditionNames: ['storybook', 'import', 'require', 'node', 'default'] });
const tryResolve = (spec: string, fromDir: string) => { try { return resolver.sync(fromDir, spec).path ?? null; } catch { return null; } };
const isStoryFile = (n: string) => /\.stories\.[cm]?[jt]sx?$/.test(n) || /\.mdx$/.test(n);
const findConfig = (base: string) => ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'].map((e) => path.join(CONFIG_DIR, `${base}.${e}`)).find(fs.existsSync) ?? null;

// ---------- file hashing (raw bytes, the files that exist now), cached ----------
function makeHasher() {
  const cache = new Map<string, string>();
  return (repoPath: string) => {
    if (cache.has(repoPath)) return cache.get(repoPath)!;
    let h = 'MISSING';
    try { h = xx(fs.readFileSync(abs(repoPath))); } catch {}
    cache.set(repoPath, h);
    return h;
  };
}
// content-only digest (paths NOT hashed → path-independent across machines)
const digest = (repoPaths: Iterable<string>, hashOf: (p: string) => string) =>
  createHash('sha256').update([...repoPaths].map(hashOf).sort().join('\n')).digest('hex').slice(0, 16);

// ---------- require-aware closure (local + node_modules), for preview/main ----------
const inRepoSrc = (a: string) => a.startsWith(REPO_ROOT + path.sep) && SOURCE_EXTS.includes(path.extname(a));
async function closure(seedsAbs: string[]) {
  const seen = new Set<string>();
  const q = seedsAbs.filter(Boolean);
  while (q.length) {
    const a = q.pop()!;
    if (seen.has(a)) continue;
    seen.add(a);
    let code = ''; try { code = fs.readFileSync(a, 'utf8'); } catch { continue; }
    let specs: string[] = []; try { specs = await parse(a, code); } catch {}
    for (const s of specs) { const t = await resolve(s, a); if (t && inRepoSrc(t) && !seen.has(t)) q.push(t); }
  }
  return [...seen].map(rel);
}

// ---------- per-story reachable file sets, from preview-stats reasons ----------
function perStoryReach(): Map<string, Set<string>> {
  const stats = JSON.parse(fs.readFileSync(STATS, 'utf8'));
  const fwd = new Map<string, Set<string>>();
  for (const m of stats.modules ?? [])
    for (const r of m.reasons ?? []) { if (!r.moduleName) continue; (fwd.get(r.moduleName) ?? fwd.set(r.moduleName, new Set()).get(r.moduleName)!).add(m.name); }
  const toRepo = (name: string) => name.replace(/^\.\//, '').replace(/\s+\+\s+\d+\s+modules?$/, '').replace(/\?.*$/, '');
  const isReal = (name: string) => !name.startsWith('/virtual') && !name.includes('\0') && fs.existsSync(abs(toRepo(name)));
  const stories = (stats.modules ?? []).map((m: any) => m.name).filter(isStoryFile);
  const reach = new Map<string, Set<string>>();
  for (const story of stories) {
    const seen = new Set([story]); const queue = [story];
    for (const cur of queue) for (const next of fwd.get(cur) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    reach.set(toRepo(story), new Set([...seen].filter(isReal).map(toRepo)));
  }
  return reach;
}

// ---------- gather out-of-graph render inputs + config-referenced packages ----------
async function configSets() {
  const mainAbs = findConfig('main'); const previewAbs = findConfig('preview');
  let cfg: any = {};
  try { cfg = (await import(mainAbs!)).default ?? {}; } catch {}
  const norm = (x: any) => (typeof x === 'string' ? x : x?.name ?? null);
  const framework = norm(cfg.framework); const builder = norm(cfg.core?.builder);
  const staticDirs: string[] = (cfg.staticDirs ?? []).map((d: any) => (typeof d === 'string' ? d : d.from));

  // PREVIEW bail set: preview.* closure (local+node_modules) + preview-head + staticDir files
  const previewClosure = previewAbs ? await closure([previewAbs]) : [];
  const headFiles = fs.readdirSync(CONFIG_DIR).filter((f) => /-head\.html$/.test(f)).map((f) => rel(path.join(CONFIG_DIR, f)));
  const staticFiles: string[] = [];
  for (const d of staticDirs) {
    const dir = path.resolve(CONFIG_DIR, d);
    if (fs.existsSync(dir)) for (const f of walk(dir)) staticFiles.push(rel(f));
  }
  const previewSet = new Set([...previewClosure, ...headFiles, ...staticFiles]);

  // MAIN bail set: main.* + framework + builder resolved entries (NOT addon classification)
  const mainSet = new Set<string>(mainAbs ? [rel(mainAbs)] : []);
  for (const pkg of [framework, builder].filter(Boolean)) { const e = tryResolve(pkg, CONFIG_DIR); if (e) mainSet.add(rel(e)); }

  return { previewSet, mainSet, meta: { framework, builder, staticDirs, headFiles, previewClosureSize: previewClosure.length } };
}
function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

// ---------- build manifest ----------
interface Manifest { version: string; previewBail: string; mainBail: string; storyHashes: Record<string, string>; }
async function buildManifest(override: (p: string) => string | undefined = () => undefined): Promise<Manifest> {
  const baseHash = makeHasher();
  const hashOf = (p: string) => override(p) ?? baseHash(p);
  const reach = perStoryReach();
  const { previewSet, mainSet } = await configSets();
  const storyHashes: Record<string, string> = {};
  for (const [story, files] of reach) storyHashes[story] = digest(files, hashOf);
  return { version: MANIFEST_VERSION, previewBail: digest(previewSet, hashOf), mainBail: digest(mainSet, hashOf), storyHashes };
}

// ---------- decide (the production decision, incl. fallback) ----------
function decide(baseline: Manifest | null, current: Manifest) {
  if (!baseline) return { mode: 'FALLBACK (legacy algorithm) — no baseline manifest; manifest uploaded for next build', recapture: 'all' as const };
  if (baseline.version !== current.version) return { mode: `FALLBACK — baseline manifest version ${baseline.version} ≠ ${current.version}`, recapture: 'all' as const };
  if (baseline.previewBail !== current.previewBail) return { mode: 'BAIL: preview graph changed', recapture: 'all' as const };
  if (baseline.mainBail !== current.mainBail) return { mode: 'BAIL: main/config changed', recapture: 'all' as const };
  const stories = new Set([...Object.keys(baseline.storyHashes), ...Object.keys(current.storyHashes)]);
  const changed: string[] = [], added: string[] = [], removed: string[] = [];
  for (const s of stories) {
    const b = baseline.storyHashes[s], c = current.storyHashes[s];
    if (b === undefined) added.push(s); else if (c === undefined) removed.push(s); else if (b !== c) changed.push(s);
  }
  return { mode: 'TurboSnap', recapture: { changed: changed.length, added: added.length, removed: removed.length } };
}

// ====================== demo ======================
const base = await buildManifest();
fs.writeFileSync(path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results/poc-manifest.json'), JSON.stringify(base, null, 2));
const cfgMeta = (await configSets()).meta;
console.log('Manifest:', { version: base.version, stories: Object.keys(base.storyHashes).length, previewBail: base.previewBail, mainBail: base.mainBail });
console.log('config:', cfgMeta, '\n');

// simulate edits by overriding the hash of specific repo paths (a content change)
const edit = (...paths: string[]) => (p: string) => (paths.includes(p) ? 'CHANGED-' + p : undefined);
const scenarios: [string, (p: string) => string | undefined, Manifest | null][] = [
  ['no edit (determinism)', () => undefined, base],
  ['edit a component (ui/tasks/auth.ts)', edit('node-src/ui/tasks/auth.ts'), base],
  ['edit a per-story node_modules dep (strip-ansi) — no lockfile', edit('node_modules/strip-ansi/index.js'), base],
  ['edit a shared preview dep (chalk, used by preview too)', edit('node_modules/chalk/source/util.js'), base],
  ['edit preview.ts', edit('.storybook/preview.ts'), base],
  ['edit preview-only dep (ansi-html)', edit('node_modules/ansi-html/index.js'), base],
  ['edit preview-head.html', edit('.storybook/preview-head.html'), base],
  ['edit main.ts', edit('.storybook/main.ts'), base],
  ['edit a static asset', edit(...[...(await configSets()).previewSet].filter((p) => p.startsWith('static/')).slice(0, 1)), base],
  ['FIRST BUILD (no baseline manifest)', () => undefined, null],
];

console.log('Decision table:');
for (const [name, ov, baseline] of scenarios) {
  const cur = await buildManifest(ov);
  const d = decide(baseline, cur);
  const r = typeof d.recapture === 'string' ? d.recapture.toUpperCase() : `changed=${d.recapture.changed} added=${d.recapture.added} removed=${d.recapture.removed}`;
  console.log(`  • ${name.padEnd(48)} → ${d.mode.padEnd(42)} | recapture: ${r}`);
}
