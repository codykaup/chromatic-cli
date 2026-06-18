/**
 * Config-bail signal (CLI-computed, Storybook-config-aware).
 *
 * Two global "change → recapture everything" sets, independent of the per-story graph:
 *   - PREVIEW bail: the import closure (require-aware, into node_modules incl. CJS) of preview.* PLUS
 *     each addon's `./preview` entry and any `main.previewAnnotations`. A change to any file here
 *     affects how every story renders → bail.
 *   - MAIN/config bail: main.* itself PLUS the resolved framework / core.builder / addon packages it
 *     references as config strings (not imports). A change here changes the build → bail. (In
 *     production, pair with the lockfile/dependency-change signal for transitive version bumps.)
 *
 * Hashing is raw + CLI-side (reproducible, debuggable): the bail set is a sorted list of
 * {path: hash}; the combined hash is what you diff between builds.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ResolverFactory } from 'oxc-resolver';
import xxhashInit from 'xxhash-wasm';

import { REPO_ROOT } from './lib/common.mts';
import { SOURCE_EXTS } from './lib/config.mts';
import * as unified from './approaches/oxcStripRequire.mts';

const { create64 } = await xxhashInit();
const xx = (s: string) => create64().update(s).digest().toString(16);
const rel = (abs: string) => path.relative(REPO_ROOT, abs);
const CONFIG_DIR = path.join(REPO_ROOT, '.storybook');

const { parse, resolve } = await unified.prepare();
const resolver = new ResolverFactory({
  extensions: SOURCE_EXTS,
  conditionNames: ['storybook', 'module', 'import', 'require', 'node', 'default'],
});
const tryResolve = (spec: string, fromDir: string) => {
  try { return resolver.sync(fromDir, spec).path ?? null; } catch { return null; }
};

function findConfig(base: string) {
  for (const ext of ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'])
    if (fs.existsSync(path.join(CONFIG_DIR, `${base}.${ext}`))) return path.join(CONFIG_DIR, `${base}.${ext}`);
  return null;
}

/** Load main config (evaluate — what Storybook does); fall back to regex string extraction. */
async function loadMainConfig(mainAbs: string) {
  try {
    const mod = await import(mainAbs);
    const cfg = mod.default ?? mod.config ?? mod;
    if (cfg && (cfg.addons || cfg.framework)) return cfg;
  } catch { /* fall through to regex */ }
  const code = fs.readFileSync(mainAbs, 'utf8');
  const addons = [...code.matchAll(/['"]([@\w./-]+)['"]/g)].map((m) => m[1])
    .filter((s) => /addon|builder|vite|webpack|storybook/.test(s));
  const framework = code.match(/name:\s*['"]([^'"]+)['"]/)?.[1];
  return { addons, framework, _viaRegex: true };
}

const norm = (x: any): string | null => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.name ?? null : null);

/** Require-aware forward closure (into node_modules incl. CJS), seeded from multiple entries. */
async function closure(seeds: string[]) {
  const inRepo = (abs: string) => abs.startsWith(REPO_ROOT + path.sep) && SOURCE_EXTS.includes(path.extname(abs));
  const seen = new Set<string>();
  const q = seeds.filter(Boolean);
  while (q.length) {
    const a = q.pop()!;
    if (seen.has(a)) continue;
    seen.add(a);
    let code = ''; try { code = fs.readFileSync(a, 'utf8'); } catch { continue; }
    let specs: string[] = []; try { specs = await parse(a, code); } catch {}
    for (const s of specs) { const t = await resolve(s, a); if (t && inRepo(t) && !seen.has(t)) q.push(t); }
  }
  return [...seen];
}

const hashSet = (files: string[]) => {
  const entries = files.map((f) => [rel(f), (() => { try { return xx(fs.readFileSync(f, 'utf8')); } catch { return 'MISSING'; } })()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return { files: entries.map(([p]) => p), combined: createHash('sha256').update(entries.map(([p, h]) => `${p}:${h}`).join('\n')).digest('hex').slice(0, 16) };
};

// ---- gather config ----
const mainAbs = findConfig('main');
const previewAbs = findConfig('preview');
const cfg: any = mainAbs ? await loadMainConfig(mainAbs) : {};

const framework = norm(cfg.framework);
const builder = norm(cfg.core?.builder) ?? norm(cfg.framework && cfg.framework.options?.builder);
const addons = (cfg.addons ?? []).map(norm).filter(Boolean) as string[];
const previewAnnotations = (cfg.previewAnnotations ?? cfg.previewEntries ?? []).map(norm).filter(Boolean) as string[];

// PREVIEW bail seeds: preview.* + addon `./preview` entries + previewAnnotations
const previewSeeds: string[] = [];
if (previewAbs) previewSeeds.push(previewAbs);
for (const ann of previewAnnotations) {
  const a = path.isAbsolute(ann) ? ann : tryResolve(ann.startsWith('.') ? ann : ann, CONFIG_DIR) ?? tryResolve(ann, REPO_ROOT);
  if (a) previewSeeds.push(a);
}
const addonPreviewEntries: Record<string, string | null> = {};
for (const addon of addons) {
  // Storybook addons expose a preview entry via `<addon>/preview` (export map) or preview.js
  const p = tryResolve(`${addon}/preview`, CONFIG_DIR) ?? tryResolve(`${addon}/dist/preview`, CONFIG_DIR);
  addonPreviewEntries[addon] = p ? rel(p) : null;
  if (p) previewSeeds.push(p);
}
const previewClosure = await closure(previewSeeds);

// MAIN/config bail set: main.* + resolved entry of framework/builder/addons (config-referenced packages)
const mainFiles = [mainAbs].filter(Boolean) as string[];
const referencedPackages: Record<string, string | null> = {};
for (const pkg of [framework, builder, ...addons].filter(Boolean) as string[]) {
  const entry = tryResolve(pkg, CONFIG_DIR) ?? tryResolve(`${pkg}/package.json`, CONFIG_DIR);
  referencedPackages[pkg] = entry ? rel(entry) : null;
}
const mainBailFiles = [...mainFiles, ...Object.values(referencedPackages).filter(Boolean).map((p) => path.join(REPO_ROOT, p as string))];

const out = {
  loadedVia: cfg._viaRegex ? 'regex-fallback' : 'evaluated',
  framework, builder, addons, previewAnnotations,
  previewBail: {
    seeds: previewSeeds.map(rel),
    addonPreviewEntries,
    closureSize: previewClosure.length,
    nodeModules: previewClosure.filter((f) => f.includes('node_modules')).length,
    ...hashSet(previewClosure),
  },
  mainBail: {
    configFiles: mainFiles.map(rel),
    referencedPackages,
    ...hashSet(mainBailFiles),
    note: 'entry-only for node_modules packages; pair with lockfile version-diff for transitive changes',
  },
};
fs.writeFileSync(path.join(REPO_ROOT, 'experiments/turbosnap-hashing/results/config-bail.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
