// EXPERIMENTAL — hybrid B+C diff for hash-based TurboSnap (research/analysis tool).
//
// Combines the two builder-emitted signals:
//   - B (module-level): per-module `contentHash` in `preview-stats.json` — roll each story up to a
//     hash over its reachable modules + the shared (preview) section.
//   - C (chunk-level):  per-chunk content hash + per-story chunk sets in `chunk-graph.json`.
//
// A story re-captures iff BOTH signals flag it (intersection); added/removed stories come from B
// (the authoritative per-story set). The two over-capture in opposite directions — B on barrels and
// tree-shaken dead code, C on story add/remove (loader churn) and shared vendor chunks — so the
// intersection lets each veto the other's over-capture. It stays safe (no new under-capture): a
// real in-graph rendering change flags B (conservative over reachable module content) and moves the
// bundled output so it also flags C, so AND only drops a story when one side proves the change is
// not a real dependency / produced no output change.
//
// See docs/hash-based-turbosnap.md (and strategy B/C docs) for the measured comparison.
//
// Usage:
//   node bin-src/hashStoriesHybrid.mjs \
//     <baseline preview-stats.json> <current preview-stats.json> \
//     <baseline chunk-graph.json>   <current chunk-graph.json>

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Per-story rolled-up hash from the strategy-B module graph + per-module contentHash. */
function moduleStoryHashes(statsPath) {
  const mods = JSON.parse(readFileSync(statsPath, 'utf8')).modules ?? [];
  const hashOf = new Map(mods.map((m) => [m.name ?? m.id, m.contentHash]));
  const forward = new Map(); // importer -> [imports], inverted from `reasons`
  for (const m of mods) {
    for (const r of m.reasons ?? []) {
      if (!forward.has(r.moduleName)) forward.set(r.moduleName, []);
      forward.get(r.moduleName).push(m.name ?? m.id);
    }
  }
  const reach = (start) => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const c = q.shift();
      for (const n of forward.get(c) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    return seen;
  };
  const digest = (names) =>
    createHash('sha256')
      .update([...names].sort().map((n) => `${n}:${hashOf.get(n) ?? ''}`).join('\n'))
      .digest('hex')
      .slice(0, 16);
  const preview = mods.map((m) => m.name ?? m.id).find((n) => /\.storybook\/preview\./.test(n));
  const shared = preview ? reach(preview) : new Set();
  const stories = mods.map((m) => m.name ?? m.id).filter((n) => /\.stories\.[tj]sx?$/.test(n));
  const out = {};
  for (const s of stories) {
    const deps = reach(s);
    for (const x of shared) deps.add(x);
    out[s] = digest(deps);
  }
  return out;
}

/** Stories whose chunk set changed (content hash or membership) per the strategy-C chunk graph. */
function chunkChangedStories(beforePath, afterPath) {
  const a = JSON.parse(readFileSync(beforePath, 'utf8'));
  const b = JSON.parse(readFileSync(afterPath, 'utf8'));
  const changed = new Set();
  for (const s of Object.keys(b.stories)) {
    if (!(s in a.stories)) continue; // added stories handled by B
    const setA = a.stories[s].chunks;
    const setB = b.stories[s].chunks;
    const keysB = new Set(setB);
    const sameSet = setA.length === setB.length && setA.every((k) => keysB.has(k));
    const hashChanged = setB.some((k) => a.chunks[k]?.hash !== b.chunks[k]?.hash);
    if (!sameSet || hashChanged) changed.add(s);
  }
  return changed;
}

export function hybridDiff(beforeMod, afterMod, beforeChunk, afterChunk) {
  const mBefore = moduleStoryHashes(beforeMod);
  const mAfter = moduleStoryHashes(afterMod);
  const cChanged = chunkChangedStories(beforeChunk, afterChunk);
  const stories = new Set([...Object.keys(mBefore), ...Object.keys(mAfter)]);

  const out = { total: stories.size, B: 0, C: 0, hybrid: 0, added: 0, removed: 0, hybridChanged: [] };
  for (const s of stories) {
    if (!(s in mBefore)) { out.added++; continue; }
    if (!(s in mAfter)) { out.removed++; continue; }
    const b = mBefore[s] !== mAfter[s];
    const c = cChanged.has(s);
    if (b) out.B++;
    if (c) out.C++;
    if (b && c) { out.hybrid++; out.hybridChanged.push(s); }
  }
  out.hybridChanged.sort();
  return out;
}

const [, , bm, am, bc, ac] = process.argv;
if (bm && am && bc && ac) {
  console.log(JSON.stringify(hybridDiff(bm, am, bc, ac), null, 2));
} else {
  console.error(
    'usage: node bin-src/hashStoriesHybrid.mjs <baseline stats> <current stats> <baseline chunks> <current chunks>'
  );
  process.exit(1);
}
