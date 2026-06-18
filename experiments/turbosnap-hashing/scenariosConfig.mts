/**
 * Trace the dependency closures of .storybook/main.* and .storybook/preview.* (config-context files,
 * detached from the preview bundle) with the unified require-aware parser. Any change inside these
 * closures should bail → recapture everything. Measures closure size + cost, in-repo vs node_modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { REPO_ROOT } from './lib/common.mts';
import { SOURCE_EXTS } from './lib/config.mts';
import * as unified from './approaches/oxcStripRequire.mts';

const { parse, resolve } = await unified.prepare();

function findConfig(base: string) {
  for (const ext of ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'])
    if (fs.existsSync(path.join(REPO_ROOT, `.storybook/${base}.${ext}`)))
      return path.join(REPO_ROOT, `.storybook/${base}.${ext}`);
  return null;
}

async function closure(entryAbs: string, includeNodeModules: boolean, cap = 40000) {
  const t0 = performance.now();
  const inRepo = (abs: string) =>
    abs.startsWith(REPO_ROOT + path.sep) && SOURCE_EXTS.includes(path.extname(abs)) &&
    (includeNodeModules || !abs.includes(`${path.sep}node_modules${path.sep}`));
  const visited = new Set<string>();
  const queue = [entryAbs];
  while (queue.length && visited.size < cap) {
    const abs = queue.pop()!;
    if (visited.has(abs)) continue;
    visited.add(abs);
    let code: string; try { code = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    let specs: string[]; try { specs = await parse(abs, code); } catch { specs = []; }
    for (const spec of specs) {
      let t: string | null = null; try { t = await resolve(spec, abs); } catch {}
      if (t && inRepo(t) && !visited.has(t)) queue.push(t);
    }
  }
  const files = [...visited].map((f) => path.relative(REPO_ROOT, f));
  return {
    ms: Math.round(performance.now() - t0),
    total: files.length,
    inRepo: files.filter((f) => !f.includes('node_modules')).length,
    nodeModules: files.filter((f) => f.includes('node_modules')).length,
    capped: visited.size >= cap,
    sampleLocal: files.filter((f) => !f.includes('node_modules')).slice(0, 8),
  };
}

const out: any = {};
for (const base of ['main', 'preview']) {
  const entry = findConfig(base);
  if (!entry) { out[base] = 'not found'; continue; }
  out[base] = {
    entry: path.relative(REPO_ROOT, entry),
    localOnly: await closure(entry, false),
    withNodeModules: await closure(entry, true),
  };
}
console.log(JSON.stringify(out, null, 2));
