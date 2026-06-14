# Hash-based TurboSnap — Strategy C: chunk-diff (builder-emitted chunk graph)

> Part of the [hash-based TurboSnap research](./hash-based-turbosnap.md). Read the main doc
> first for the goal, the hashing/diff core, the shared section, and the strategy decision.
> **This document only covers what's specific to strategy C.**

**Strategy C diffs the builder's *output chunks* instead of its source modules.** It's a
variant of [strategy B](./hash-based-turbosnap-strategy-b-builder-emit.md) — the builder
still emits the graph — but the **primitive is the post-bundle chunk**, not the module. The
builder emits per-chunk content hashes, the cross-chunk import graph, and the set of chunks
each story loads; TurboSnap re-captures a story when any chunk in its set changes hash.

The appeal: chunk hashes are **tree-shake-accurate by construction** (a chunk's bytes are
exactly what ships), and the chunk format is uniform across builders. The catch: chunk
identity and chunk hashes are noisy (hashed filenames, re-chunking), so the signal is only
usable with deliberate normalization — see the findings below.

```mermaid
flowchart TD
  B[builder generateBundle] --> CG[chunk-graph.json: per-chunk hash + import graph]
  CG --> CD{compare chunk hashes to baseline}
  CD -->|story's chunk changed| RE[re-capture story]
  CD -->|all chunks identical| SK[skip story]
  ENT[entry / preview-runtime chunk] -. folded into every story .-> CG
```

## Relationship to the chunk-diff proposal (Notion)

This strategy is **sourced from the internal proposal**, not an independent alternative to
it: *Exploration of TurboSnap optimization angles* → "Idea 2 — Chunk-diff replaces
source-file tracing"
([Notion](https://app.notion.com/p/chromatic-ui/Exploration-of-TurboSnap-optimization-angles-3606e8162034814a92f2d15319dd41a7)).
The artifact (`chunk-graph.json`), the diff algorithm, and the preview-runtime-as-shared
section are taken directly from that proposal. What this doc adds is a concrete
Storybook/Vite implementation plus the empirical findings from running it — including two
points the proposal left as open caveats.

**Findings tracked against the proposal:**

| Proposal (Idea 2) | What we found / changed when implementing it |
|---|---|
| Builder emits `chunk-graph.json` (`stories`→chunks, `chunks`→`{hash, imports}`); diff hashes + per-story closure | **Confirmed & implemented** as `pluginChunkStats` (Vite). Same shape, same diff. |
| Chunks keyed by stable ids with a separate `hash` (e.g. `s-button.abc.js`) | Real Vite filenames **embed** the content hash, so they aren't stable. We key each chunk by a **hash of its module-id set** so the diff isn't fooled by filename churn (distinguishes "same chunk, new content" from re-chunking). |
| Caveat #1: "chunk-hash stability (`moduleIds: deterministic`)" | **This is load-bearing, not a footnote.** Hashing the shipped chunk code as-is busts **all 115** stories on a *single-story* edit — the runtime `importFn` references hashed sibling filenames, so one leaf change cascades through the runtime chunk (which is folded into every story). Fix = **normalize hashed filename refs out before hashing**; the same edit then drops to a precise **3**. |
| "Tree-shake aware by construction" | **Confirmed empirically.** A change to an *unused/dead* dependency export → **0** stories (the export is tree-shaken out), vs. module-level's safe over-capture of 1. A *used/side-effecting* dependency change → caught (**1**). |
| Framed as **replacing** source-file tracing / `findChangedDependencies` | We position it as a **variant of Strategy B that can ship alongside** module-level hashing. Chunk attribution is **coarser** (a chunk bundles many modules), so B stays the precise, debuggable "why did this story re-capture?" layer; C adds tree-shake accuracy. |
| Caveat: topology change (vendor-split tweak) moves many hashes at once | Carried forward — the diff flags a **structural chunk-set change** separately rather than silently mis-attributing (see caveats below). |
| Caveats: CSS/asset chunks, dynamic-`import()` blind spot, per-builder coverage, silent migration, symbol-level as a later layer | Unchanged from the proposal; carried into the caveats section below. |

## How it relates to strategies A and B

| | A — own-trace | B — module-emit | **C — chunk-emit** |
|---|---|---|---|
| Primitive | source files (esbuild inputs) | transformed **modules** | output **chunks** |
| Graph source | we bundle | builder plugin | builder plugin |
| Tree-shaking | from esbuild | mild over-capture¹ | exact (by construction) |
| Main risk | silent fidelity drift | over-capture of unused exports | hash/identity noise (needs normalization) |

¹ Strategy B hashes a module's transformed code *before* tree-shaking, so a change to a
tree-shaken-away export of a used module still busts the story — safe over-capture.

C and B are not exclusive: the builder can emit **both** (the prototype does). Module hashes
give precise per-story attribution and graph debuggability; chunk hashes give tree-shake
accuracy. A backend could prefer chunk hashes and fall back to module rollups.

## The emitted artifact

`chunk-graph.json`, alongside `preview-stats.json`:

```json
{
  "stories": {
    "./src/Button.stories.tsx": { "chunks": ["<key>", "<key>", "..."] }
  },
  "chunks": {
    "<stable-key>": {
      "fileName": "assets/Button.stories-A1b2C3d4.js",
      "hash": "ab12cd34ef56...",
      "imports": ["<key>", "..."],
      "dynamicImports": ["<key>", "..."]
    }
  }
}
```

- **Stable chunk key.** Output filenames embed a content hash, so they churn on every change.
  Each chunk is keyed by a **stable identity** (the hash of its module-id set) with the
  content hash carried separately, so a build-to-build diff can tell *"same chunk, new
  content"* apart from *re-chunking*.
- **Per-story chunk set.** The transitive closure over a story chunk's static imports, plus
  the **entry / preview-runtime chunk** folded in (the chunk-diff equivalent of the shared
  section — a preview/global change moves the runtime chunk and busts every story).

### The diff

```typescript
const changed = (story) =>
  // structural change in the chunk set (re-chunk), or any chunk's content hash moved
  !sameSet(prev.stories[story], curr.stories[story]) ||
  curr.stories[story].chunks.some((k) => prev.chunks[k]?.hash !== curr.chunks[k].hash);
```

## Prototype

Implemented in the **Storybook** builder (not the CLI), since that's where the bundle lives:
`@storybook/builder-vite`'s `pluginChunkStats` (branch
`claude/vite-plugin-turbosnap-pozq5x`), emitting `chunk-graph.json` at Rollup's
`generateBundle`. **Opt-in** via `STORYBOOK_CHUNK_GRAPH=1` so normal builds are unaffected.
It is emitted *alongside* the strategy-B module graph (`preview-stats.json` + per-module
`contentHash`) so the two can be diffed head-to-head on the same build.

### Reference implementation (Vite)

The actual emitter. The two non-obvious parts — stable chunk keys (finding 1's companion)
and filename normalization in `hashChunk` (finding 1) — are what make the chunk hashes
usable; without them the signal is dominated by routing noise.

```ts
import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import slash from 'slash';
import type { Plugin } from 'vite';

const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/;

export function pluginChunkStats({ workingDir }: { workingDir: string }): Plugin {
  const normalize = (id: string) => `./${slash(relative(workingDir, id.split('?')[0]))}`;

  // Hash chunk content, normalized so the hash reflects *content* not *routing*:
  // drop the sourcemap ref and neutralize hashed sibling filenames (`name-A1b2C3d4.js`),
  // otherwise a leaf chunk's new hash cascades through the runtime chunk to every story.
  const hashChunk = (code: string) =>
    createHash('sha256')
      .update(code.replace(/\n?\/\/# sourceMappingURL=.*$/gm, '').replace(/-[\w-]{8}\.(js|css)/g, '-[hash].$1'))
      .digest('hex')
      .slice(0, 16);

  return {
    name: 'storybook:chunk-graph-stats',
    enforce: 'post',
    generateBundle(_options, bundle) {
      if (!process.env.STORYBOOK_CHUNK_GRAPH) return;

      // Output filenames embed a content hash and churn on every change. Key each chunk by a
      // stable identity (hash of its module-id set) so the diff can tell "same chunk, new
      // content" from re-chunking.
      const chunkKey = (moduleIds: string[]) =>
        createHash('sha256').update(moduleIds.slice().sort().join('\n')).digest('hex').slice(0, 16);

      const fileNameToKey = new Map<string, string>();
      for (const file of Object.values(bundle))
        if (file.type === 'chunk') fileNameToKey.set(file.fileName, chunkKey(Object.keys(file.modules)));

      const chunks: Record<string, { fileName: string; hash: string; imports: string[]; dynamicImports: string[] }> = {};
      const moduleToChunk = new Map<string, string>();
      const entryChunks: string[] = [];

      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        const key = fileNameToKey.get(file.fileName)!;
        chunks[key] = {
          fileName: file.fileName,
          hash: hashChunk(file.code),
          imports: file.imports.map((f) => fileNameToKey.get(f)!).filter(Boolean),
          dynamicImports: file.dynamicImports.map((f) => fileNameToKey.get(f)!).filter(Boolean),
        };
        if (file.isEntry) entryChunks.push(key);
        for (const moduleId of Object.keys(file.modules)) moduleToChunk.set(moduleId, key);
      }

      // Transitive closure over static chunk imports.
      const reachable = (starts: string[]) => {
        const seen = new Set<string>();
        const stack = [...starts];
        while (stack.length > 0) {
          const chunk = stack.pop()!;
          if (!chunk || seen.has(chunk)) continue;
          seen.add(chunk);
          stack.push(...(chunks[chunk]?.imports ?? []));
        }
        return seen;
      };

      // Preview-runtime / shared section: every story loads the entry chunk graph.
      const sharedChunks = reachable(entryChunks);

      const stories: Record<string, { chunks: string[] }> = {};
      for (const [moduleId, chunkName] of moduleToChunk) {
        const bare = moduleId.split('?')[0];
        if (!STORY_FILE.test(bare) || bare.includes('node_modules')) continue;
        const set = reachable([chunkName]);
        for (const shared of sharedChunks) set.add(shared);
        stories[normalize(moduleId)] = { chunks: [...set].sort() };
      }

      this.emitFile({ type: 'asset', fileName: 'chunk-graph.json', source: JSON.stringify({ stories, chunks }, null, 2) });
    },
  };
}
```

For webpack5 the equivalent taps `compilation.hooks.afterProcessAssets`, reading
`compilation.chunks` (each chunk's `contentHash`, its `chunk.getAllReferencedChunks()` for
the import graph, and `chunkGraph.getChunkModules(chunk)` for the module→chunk map). The
schema and diff are identical; only the chunk-enumeration API differs.

## Head-to-head vs. module-level (strategy B)

Measured on this repo's own Storybook (115 stories), building twice per edit with the
modified `@storybook/builder-vite` and diffing each signal against the baseline build:

| Edit | B — module-level | C — chunk-level |
|---|---|---|
| `auth.stories.ts` (substantive) | 3 | **3** |
| `auth.stories.ts` (comment-only) | 0 | 0 |
| dependency change — **unused / dead code** | 1 | **0** |
| dependency change — **used / side-effecting** | 1 | 1 |
| `.storybook/preview.ts` (substantive) | 115 | 115 |
| **edit an _unused_ barrel re-export sibling** | **1 (over-captures)** | **0 (correct)** |
| **add 1 story** | +1 added, 0 changed | +1 added, **115 changed** |
| **remove 1 story** | −1 removed, 0 changed | −1 removed, **114 changed** |
| `README.md` | 0 | 0 |

Both signals are reproducible (0 changes between two identical builds), and `chunk-graph.json`
is smaller than the module stats (≈88 KB vs ≈180 KB here). The two diverge in **opposite
directions**: C over-captures on story add/remove (loader churn, below), while B over-captures
on **barrel files** and tree-shaken dead code — C is correct on both because it hashes
tree-shaken output.

### Barrel files

A story that imports one symbol from a barrel (`import { Used } from './components'`) should
not re-capture when an *unused* sibling re-export (`Unused`) changes. Measured by editing only
the unused sibling:

- **C → not re-flagged (correct).** Tree-shaking drops the unused sibling from the bundled
  output, so it's not in the story's chunks.
- **B → re-flagged (over-captures).** B builds its graph from the *static* import graph
  (`getModuleInfo().importedIds`), so the barrel lists **both** re-exports and the unused
  sibling is reachable from the story; whole-module content hashing then rolls its change into
  the story's hash.

This is the mirror image of the add/remove finding: hashing bundled output makes C
tree-shake-accurate through barrels where B is blunt. The fix for B is **symbol-level barrel
resolution** — resolve which exported *symbols* the story actually pulls through the barrel and
depend only on those modules (the [Storybook change-detection](https://github.com/storybookjs/storybook)
`followBarrel` approach; "reform H" in the optimization-angles exploration). That's a real
extension to B, not something whole-module hashing gives for free. (C's correctness here is
bounded by chunk granularity: if the "unused" sibling is used by *another* story and
co-bundled into a shared chunk, C can still over-capture.)

### Adding or removing a story

Adding or removing a story is correctly reported as `added` / `removed` by both. The
difference is the **collateral**:

- **B touches nothing else** — existing stories don't import the new one, and no existing
  module's content changed, so every other per-story hash is byte-identical.
- **C re-flags the entire suite.** The entry chunk (folded into every story's set) carries the
  bundler's **loading machinery**, and adding/removing a story perturbs it for *all* stories.

**This is hard to fix — we tried and it didn't work.** The obvious mitigation — exclude the
`storybook-stories` importFn map from the shared hash — is **insufficient**. Diffing the actual
built chunks showed the real driver is **Vite's `__vite__mapDeps` preload array**: a flat list
of *every* async chunk filename, injected into the entry chunk, with consumer chunks
referencing **indices** into it. Adding one story inserts an entry and **re-indexes** the array,
so the change ripples across multiple shared chunks (e.g. the entry, the renderer, and shared
component chunks all moved hash in our test — not just the importFn module). It is **not** the
hashed-filename cascade (finding 1); normalization of filenames doesn't remove the added array
element or the shifted indices.

A robust fix would mean **neutralizing the bundler's loader/preload internals** out of the hash
(fragile and Vite-version-specific — whack-a-mole as Vite's codegen evolves) or **building the
signal with `build.modulePreload` disabled** (changes the real output, so not viable for the
production build Chromatic consumes). Neither is the clean, low-effort change first assumed.
**Takeaway:** this is a structural cost of hashing *output chunks* — module-level (B) doesn't
have it, because it hashes modules *before* the bundler injects its loading/preload glue. It is
the strongest argument for using B as the primary signal and treating C as a tree-shaking
refinement layer rather than a stand-alone primitive.

## Two findings that decide whether this is viable

### 1. Hashed filenames cascade — normalize before hashing (mandatory)

The first naive version hashed each chunk's shipped code as-is. A change to **one** story
busted **all 115**. Cause: the runtime chunk's `importFn` maps story IDs → hashed output
filenames; one story's new content → new filename → the runtime chunk's bytes change → and
the runtime chunk is folded into every story. A leaf edit cascades to the whole suite.

Fix: **normalize the chunk code before hashing** — strip the sourcemap reference and
neutralize hashed sibling-chunk filenames (`name-A1b2C3d4.js` → `name-[hash].js`). With that,
the same edit drops from 115 back to a precise **3**, matching module-level. This is the
non-negotiable version of the design's "chunk-hash stability" caveat: without it the signal
is unusable.

### 2. Tree-shaking is the real precision difference

Appending an **unused** export to a dependency a story imports:

- **chunk-level → 0.** The export is tree-shaken out of the bundle (confirmed: the marker
  never reaches `storybook-static/assets`), so the shipped chunk is byte-identical. Correct
  non-capture — dead code can't change a snapshot.
- **module-level → 1.** It hashes the module's transformed code *before* tree-shaking, so the
  dependent story busts. Safe over-capture.

When the dependency change is **not** dead (a side-effecting statement that survives
tree-shaking), chunk-level catches it precisely (→ 1). So chunk-diff strictly wins on
dead-code/unused-export edits; module-diff strictly wins on never-under-capturing.

## Caveats specific to strategy C

- **Hash normalization is load-bearing** (finding 1). Sourcemap refs and hashed sibling
  filenames must be stripped, or the runtime chunk cascades to everything.
- **Chunk identity must be stable** across builds (we key by module-set hash). Filename-based
  keys make every content change look like add/remove.
- **Topology / re-chunk changes.** If the chunking strategy itself changes (vendor-split
  tweak, a new manual chunk), many chunk sets shift at once and the diff conservatively busts
  the affected stories. The structural-set check above flags these rather than silently
  mis-attributing.
- **Bundler loading machinery leaks into the hash.** The entry chunk (folded into every story)
  carries Vite's `__vite__mapDeps` preload array and dep-index references; adding/removing a
  story re-indexes it and **re-flags the whole suite** (see *Adding or removing a story* above —
  excluding the importFn module was tried and is insufficient). This is the deepest C-specific
  problem: it can only be addressed by stripping bundler loader internals (fragile) or disabling
  `modulePreload` (changes output), and is the main reason C isn't a safe stand-alone primitive.
- **Builder coverage.** Each builder needs a `generateBundle`-time emitter conforming to the
  shared `chunk-graph.json` schema (the prototype covers Vite only).

## Effect on bail reasons

See the [main doc's bail-reason table](./hash-based-turbosnap.md#effect-on-turbosnap-bail-reasons)
for the full picture (C eliminates the same `changedPackageFiles` / `invalidChangedFiles`
bails as B). C's distinctive new bails:

- **`chunkTopologyChanged`** — a re-chunk (vendor-split tweak, a new manual chunk) moves many
  chunk hashes at once. Detect the structural chunk-set change (per the caveats above) and
  conservatively capture the affected stories rather than mis-attribute.
- **`chunkGraphExtractionFailed`** — the plugin fails to emit `chunk-graph.json`.
- Incomplete hash normalization is an over-capture cascade, **not** a bail — but if left
  unfixed it makes every build look like "everything changed."

## Open questions specific to strategy C

- Whether to ship C **instead of** or **alongside** B. Alongside keeps module-level precision
  and debuggability while gaining chunk-level tree-shake accuracy; the cost is two artifacts.
- Whether the normalized chunk hash should instead be built from per-module rendered code
  (`RenderedChunk.modules[id].code`, post-tree-shake) to sidestep filename normalization
  entirely — at the cost of re-deriving chunk boundaries.
- How the backend stores/compares chunk graphs, and how `--untraced` maps onto chunks.
