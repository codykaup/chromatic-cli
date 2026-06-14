# Hash-based TurboSnap — research findings

> Status: **research / prototype**. Branch: `claude/story-dependency-hashing-tnevak`.
> Nothing here is wired into the production build or the `publishBuild` mutation yet.

This is the **shared overview**: the goal, the hashing/diff core, the key learnings, and
the decision between the implementation options. Each option has its own document with the
details specific to it — read this first, then dive into whichever you're working on:

- **[Strategy A — own-trace (esbuild)](./hash-based-turbosnap-strategy-a-own-trace.md)** —
  builder-agnostic fallback; we trace the graph ourselves.
- **[Strategy B — emit the graph from the builder](./hash-based-turbosnap-strategy-b-builder-emit.md)**
  — *recommended* for the builders we own (Vite, webpack5).
- **[Strategy C — chunk-diff (builder-emitted chunk graph)](./hash-based-turbosnap-strategy-c-chunk-diff.md)**
  — a B-variant that diffs output *chunks* instead of modules; tree-shake-accurate, but needs
  careful hash normalization. Sourced from the internal "chunk-diff" proposal — that doc
  [tracks our findings against it](./hash-based-turbosnap-strategy-c-chunk-diff.md#relationship-to-the-chunk-diff-proposal-notion).

## Goal

Replace TurboSnap's git-diff-based change detection with a **content-hash** approach:

1. For every story (CSF) file, compute the tree of source files it depends on.
2. Hash each dependency and reduce the whole tree to a **single hash per story**.
3. Compare a build's per-story hashes to a previous build's. **Any story whose hash
   changed needs to be re-captured** — no git diffing, no ancestry detection.

A shared "global" section (preview config, Storybook config, externals) is folded into
every story's hash, so changing a shared dependency busts every dependent story.

```mermaid
flowchart LR
  A[Build Storybook] --> B[Per-story dependency graph]
  B --> C[Hash each dependency]
  C --> D[Reduce to one hash per story]
  D --> E{Compare to baseline build}
  E -->|hash differs| F[Re-capture story]
  E -->|hash matches| G[Skip story]
```

## TL;DR / recommendations

- **The hash approach works.** All prototypes produce stable per-story hashes that bust
  exactly when (and only when) a story's dependencies change — including dependencies
  shared with other stories, and including stories imported by other stories (CSF
  composition).
- **We need a complete, consistent dependency graph — today's stats aren't enough on their
  own.** The builder's `preview-stats.json` behaves differently across builders (webpack =
  complete, Vite = lossy and missing the preview's deps) and forces version-sniffing for
  node_modules. There are two ways to get a full, consistent graph: trace it ourselves with
  esbuild, or have the builder emit it. **The hashing/diff core is identical either way** —
  the only real decision is where the graph comes from.
- **Recommended production path:
  [emit the graph from the builders we own (strategy B)](./hash-based-turbosnap-strategy-b-builder-emit.md).**
  We maintain **2 of the 3 relevant builders** — Vite and webpack5 (Rspack is community-
  maintained). For those two, having the builder plugin emit a normalized graph **with
  per-module content hashes** gives the highest fidelity (resolution, TypeScript type-
  elision, and tree-shaking come from the real build for free) and a **loud** failure mode
  (a broken extractor fails in CI) rather than the *silent* fidelity drift of an own-trace.
- **Use the [esbuild own-trace (strategy A)](./hash-based-turbosnap-strategy-a-own-trace.md)
  as the validated fallback.** It's builder-agnostic, so it covers builders we don't own
  (e.g. Rspack) and any project whose builder hasn't been upgraded yet. It's also the
  prototype that already proved the hashing core is correct and consistent across builders.
- **Hash module/file contents; don't sniff versions.** Hashing the real dependency files
  (or builder-emitted per-module hashes) is more robust and less fragile than reading
  versions from `node_modules/**/package.json` — it catches version bumps, `patch-package`
  edits, and changed transitive resolutions alike.
- **A chunk-level variant ([strategy C](./hash-based-turbosnap-strategy-c-chunk-diff.md))
  is tree-shake-accurate and can ship alongside B.** Diffing the builder's output *chunks*
  (instead of modules) ignores dead-code/unused-export edits that module-level conservatively
  busts — but only once hashed filenames are normalized out, or a single-story edit cascades
  through the runtime chunk to the whole suite. A head-to-head found B and C agree on every
  tested edit except tree-shaken dead code.

## The hashing core, demonstrated (`hash-stories`)

The [`hash-stories`](../bin-src/hashStories.ts) prototype hashes on top of the existing builder `preview-stats.json`
(the same data the production tracer uses). It's the simplest of the three scripts and the
best illustration of the **shared mechanics both strategies build on** — per-story
hashing, the shared section, baseline diffing, and CSF composition.

```mermaid
flowchart TD
  S[preview-stats.json] --> N[normalize module paths]
  N --> G[forward dependency graph + story detection]
  G --> TR[walk deps per story, honoring untraced]
  TR --> SRC[source file -> xxhash of contents]
  TR --> PKG[node_modules -> package version from package.json]
  CFG[.storybook config dir + preview deps + externals] --> DOC
  SRC --> DOC[per-story document]
  PKG --> DOC
  DOC --> H[xxhash document = story hash]
```

**Output** (this repo's Vite build):

```
Hashed 115 story files:

  node-src/ui/components/icons.stories.ts [b6cd1d9ff46fc9da]
  node-src/ui/components/link.stories.ts [e41fdc1554cbacb2]
  node-src/ui/components/task.stories.ts [623608de44205d8b]
  node-src/ui/html/metadata.html.stories.ts [ef06e4a70b8da631]
```

The shared section (busts every story when changed):

```
Shared section (appended to every story, 3 entries):
  .storybook/main.ts [4cbe9e158562b0a7]
  .storybook/preview-head.html [a77ddb25a6085529]
  .storybook/preview.ts [e53e2cd5664d933e]
```

**Baseline diff** (`--baseline`) — the core decision. After editing `auth.stories.ts`:

```
Baseline diff: 3 stories need re-capture (3 changed, 0 added, 0 removed, 112 unchanged).
  ~ node-src/ui/tasks/auth.stories.ts
  ~ node-src/ui/workflows/uploadBuild.stories.ts
  ~ node-src/ui/workflows/uploadBuildE2E.stories.ts
```

Note the two workflow stories: they `import * as auth from '../tasks/auth.stories'`
(CSF composition), so a story file can be a dependency of other stories. The hash
approach handles this automatically because it traces real dependencies.

This prototype is conservative by construction: it inherits the builder stats' limitations
(on Vite, the preview's deps are missing) and collapses node_modules to a version string
rather than hashing them. Both options below exist to fix exactly those gaps.

## The prototype scripts

These live in `bin-src/` and are registered as CLI subcommands (except the hybrid, a standalone
analysis script). They are research tools, not shipped features (`esbuild`/`oxc-*` are
dynamically imported).

| Command / script | Graph source | Covered in |
|---|---|---|
| [`chromatic hash-stories`](../bin-src/hashStories.ts) | builder `preview-stats.json` | this doc (shared core demo) |
| [`chromatic hash-stories-esbuild`](../bin-src/hashStoriesEsbuild.ts) | esbuild (own bundle) | [Strategy A](./hash-based-turbosnap-strategy-a-own-trace.md) |
| [`chromatic trace-fidelity`](../bin-src/traceFidelity.ts) | esbuild / oxc vs. stats | [Strategy A](./hash-based-turbosnap-strategy-a-own-trace.md) |
| [`hashStoriesHybrid.mjs`](../bin-src/hashStoriesHybrid.mjs) | builder module graph ∩ chunk graph | [Hybrid](#hybrid-combine-b-and-c-intersection) |

## The options

All strategies share the hashing/diff core demonstrated above; they differ in **where the
graph comes from** and **what primitive is hashed**:

| | A — own-trace (esbuild) | B — module-emit | C — chunk-emit |
|---|---|---|---|
| **Graph source** | We bundle stories ourselves and read the inputs | Builder plugins emit a module graph | Builder plugins emit a chunk graph |
| **Primitive hashed** | source files | transformed modules | output chunks |
| **Fidelity** | Must replicate each project's build config | Comes from the real build for free | Comes from the real build for free |
| **Failure mode** | *Silent* drift (risk: under-capture) | *Loud* (extractor breaks in CI) | *Loud*, but hash needs normalization |
| **Best for** | Builders we don't own (e.g. Rspack) | Builders we own (Vite, webpack5) | Builders we own; max tree-shake accuracy |
| **Details** | [Strategy A doc](./hash-based-turbosnap-strategy-a-own-trace.md) | [Strategy B doc](./hash-based-turbosnap-strategy-b-builder-emit.md) | [Strategy C doc](./hash-based-turbosnap-strategy-c-chunk-diff.md) |

**We own 2 of the 3 relevant builders (Vite and webpack5; Rspack is community-maintained),
so a builder-emit path (B, optionally C) is the recommended production path for the builders
we own, with strategy A as the fallback for the rest.** B and C are not exclusive — the
builder can emit both (the prototype does), and a [head-to-head shows they over-capture in
opposite directions](./hash-based-turbosnap-strategy-c-chunk-diff.md#head-to-head-vs-module-level-strategy-b).
Intersecting them ([**B ∩ C hybrid**](#hybrid-combine-b-and-c-intersection)) is near-ideal in
every tested scenario. Whichever the graph comes from, the downstream steps are the same:

1. **Hash module/file contents** rather than sniffing versions.
2. **Drive story enumeration from Storybook's story index** rather than the stats.
3. **`publishBuild` payload:** send the list of `{ storyFile, hash }`. Open question —
   send the shared section as one shared hash + per-story hashes, or fold it into each
   story hash (current prototypes do the latter).

### Benefits and drawbacks by option

> We're willing to take the harder option if it pays off long-term. The dimensions that
> matter most here are **monorepo robustness** and **debuggability** — the two areas where
> today's git-diff + lockfile-parsing TurboSnap is most finicky and opaque.

| Option | Benefits | Drawbacks | Effort |
|---|---|---|---|
| **A — own-trace (esbuild)** | Builder-agnostic — covers builders we don't own (Rspack) and not-yet-upgraded projects;<br>no builder changes to adopt;<br>already-validated prototype | Must replicate each project's build config (aliases, plugins) → **silent** fidelity drift → **under-capture risk** (skips a real visual change);<br>a second bundler to keep faithful forever;<br>**weakest in monorepos** with varied/custom configs;<br>**hardest to debug** (failures are silent) | Medium to adopt, **high** ongoing fidelity upkeep |
| **B — module-emit** *(recommended baseline)* | Highest fidelity — resolution, TS type-elision, tree-shaking come from the real build for free;<br>**loud** failure (breaks in CI, never silent);<br>per-module content hashes catch version bumps + `patch-package`;<br>**most debuggable** — exact "story X re-captured because module Y changed" attribution;<br>**monorepo-robust** — no git-baseline fetch, no lockfile parsing | Per-builder plugin to maintain (Vite, webpack5);<br>mild **over-capture** of changed-but-unused exports of used modules;<br>larger stats artifact | **Medium** — Vite done, webpack5 to do |
| **C — chunk-emit** *(layer on B for max precision)* | **Tree-shake-accurate** by construction — ignores dead-code / unused-export edits B would bust;<br>smaller artifact;<br>uniform chunk format across builders;<br>same monorepo/loud-failure wins as B | Hash **normalization is load-bearing** (hashed filenames cascade through the runtime chunk to every story if not stripped);<br>chunk identity must be stabilized;<br>topology / re-chunk changes can over-bust a batch;<br>**coarser attribution** than B (a chunk bundles many modules) — harder to explain *why* | **Medium-high** — normalization + stable keys; prototype Vite-only |

**Why every hash option helps the monorepo + debugging pain.** All three replace
git-diffing, shallow-clone-sensitive baseline fetches, and per-ecosystem lockfile parsing
with a single content-hash compare against the previous build's stored hashes. That removes
the failure modes that make TurboSnap finicky in monorepos and opaque when it misbehaves.
**B and C go further on debuggability and safety:** failures are *loud* (a broken extractor
fails the build in CI instead of silently under-capturing), and B in particular gives a
direct, per-module answer to "why did this story re-capture?" — which is exactly what's hard
to get today. The recommendation for the builders we own is therefore **B as the baseline,
with C layered on where tree-shaking precision is worth the extra normalization work**;
reserve A for builders we don't own.

## Hybrid: combine B and C (intersection)

"B baseline + C layered" has a concrete form: emit **both** signals and re-capture a story only
when **both** flag it. B and C over-capture in *opposite* directions, so intersecting lets each
veto the other:

```
recapture(story) =
  story is added            (no baseline hash — from B's per-story set)
  OR ( B.changed(story)  AND  C.changed(story) )
```

- **B** (module-level): the story's rolled-up hash over its reachable *modules* + shared section.
- **C** (chunk-level): a chunk in the story's set changed content hash (or set membership).
- **Added / removed** come from B, which is authoritative and precise on the story set.

**Why the intersection is safe (no new under-capture).** AND only drops a story when *one* side
says "unchanged." If **B** says unchanged, no module the story reaches changed content (any real
change must be out-of-graph — static assets, `preview-head.html` — which both miss and the shared
section / static bail still covers). If **C** says unchanged, the story's bundled output is
byte-identical, so its snapshot can't change. The two only *disagree* in the over-capture cases
(barrel/dead-code: B over-flags, C correct; add/remove: C over-flags, B correct), and AND resolves
each to the correct, minimal answer.

**Measured across the full matrix** (this repo's 115-story Storybook;
[`bin-src/hashStoriesHybrid.mjs`](../bin-src/hashStoriesHybrid.mjs)):

| Edit | B | C | **B ∩ C (hybrid)** | Ideal |
|---|---|---|---|---|
| rebuild, no edit | 0 | 0 | **0** | 0 |
| `auth.stories.ts` (substantive) | 3 | 3 | **3** | 3 |
| `auth.stories.ts` (comment-only) | 0 | 0 | **0** | 0 |
| dependency — unused / dead code | 1 | 0 | **0** | 0 |
| dependency — used / side-effecting | 1 | 1 | **1** | 1 |
| `.storybook/preview.ts` | 115 | 115 | **115** | 115 (global) |
| add 1 story | +1 added | +1 added, **115 changed** | **+1 added, 0 changed** | +1 added |
| remove 1 story | −1 removed | −1 removed, **114 changed** | **−1 removed, 0 changed** | −1 removed |
| edit unused barrel sibling | **1** | 0 | **0** | 0 |
| `README.md` | 0 | 0 | **0** | 0 |

The hybrid lands on the **minimal correct set in every tested scenario** — B's precision on
add/remove, C's precision on barrels and dead code, and agreement everywhere they already agree.
It is the only one of the four (A/B/C/hybrid) with no measured over-capture outside the genuinely
global `preview.ts` case.

**Cost / caveats.** Emit and store *both* artifacts (module graph + chunk graph) and intersect on
the backend — more storage and two per-builder extractors to maintain. Residual over-capture
remains where C itself can't be precise (an "unused" barrel sibling that is *co-bundled* into a
shared chunk with a used one), and the out-of-graph surface (static/fonts/`preview-head.html`) is
still covered by the shared section, not the hashes. Net: the hybrid buys near-ideal precision at
the cost of running both pipelines.

## Effect on TurboSnap bail reasons

A "bail" is TurboSnap giving up on precision and re-capturing **everything**. Today's bail
reasons (from `TurboSnapBailReason` in `node-src/types.ts`) fall into three buckets:
git/baseline-diff failures, lockfile/dependency-tracing failures, and conservative blanket
bails on file categories the tracer can't reason about. The hash approach removes most of
them — but only under one **assumption**, which is itself an [open question](#open-questions-shared):

> The baseline build stores its per-story (and per-module/chunk) hashes, and the next build
> compares against *those* — not against a git diff between commits. This is what lets the
> git- and lockfile-derived bails go away. See
> [What the backend must store](#what-the-backend-must-store-the-contingency) for the
> concrete requirement.

Legend: ✅ **eliminated** (no longer possible or needed) · 🔄 **changed** (no longer a blanket
bail — becomes precise hash invalidation, which may still bust many stories but never blindly
"capture everything") · ⚠️ **retained** (still required).

| Current bail reason | A | B | C | Why |
|---|---|---|---|---|
| `noAncestorBuild` | ⚠️ | ⚠️ | ⚠️ | No baseline build ⇒ nothing to diff. Fundamental. |
| `rebuild` | ⚠️ | ⚠️ | ⚠️ | Same-commit rebuild policy; unrelated to tracing. |
| `missingStatsFile` | ✅ | ⚠️\* | ⚠️\* | A bundles stories itself (no builder stats needed). B needs the emitted module graph, C the `chunk-graph.json` (\*renamed to "missing graph artifact"). |
| `changedStorybookFiles` | 🔄 | 🔄 | 🔄 | `.storybook/preview.*` + addon preview entries are now **in the graph** (B/C via the preview-gap fix; A via the esbuild preview trace) ⇒ precise per-story invalidation, not a blanket bail. `main.*` / manager-side config (never in the preview bundle) stay folded into the shared section as a disk hash. |
| `changedStaticFiles` | ⚠️ | ⚠️ | ⚠️ | Static assets are copied, not bundled modules ⇒ not in any hash graph. Downgrade to a disk hash of `staticDirs` folded into the shared section, else keep as a bail. |
| `changedExternalFiles` | ⚠️ | ⚠️ | ⚠️ | User-declared `externals` globs are an out-of-graph escape hatch by definition. |
| `changedPackageFiles` | ✅ | ✅ | ✅ | No lockfile parsing / snyk / baseline-lockfile fetch — dependencies are hashed by content. |
| ↳ `baselineCheckoutFailed` | ✅ | ✅ | ✅ | No baseline-lockfile `git show`. |
| ↳ `lockfileParseFailed` | ✅ | ✅ | ✅ | No lockfile parsing. |
| ↳ `lockfileSizeExceeded` | ✅ | ✅ | ✅ | No lockfile read / 10 MB cap. |
| ↳ `nodeModulesMissingInStats` | ✅ | ✅ | ✅ | A bundles node_modules; B/C emit them in the graph — gone by construction. |
| `invalidChangedFiles` | ✅ | ✅ | ✅ | The diff is per-story hash vs. stored baseline hashes, not a git changed-file computation. |
| ↳ `ancestorMissing` | ✅ | ✅ | ✅ | No baseline-commit checkout for the trace ⇒ **shallow clones stop mattering**. |
| ↳ `baselineDirty` | ✅ | ✅ | ✅ | No baseline working-tree comparison. |
| ↳ `replacementFailed` | ✅ | ✅ | ✅ | No `getChangedFilesWithReplacement`. |
| ↳ `gitCommandFailed` | ✅ | ✅ | ✅ | No git diff in the trace path. |
| ↳ `networkError` | ⚠️ | ⚠️ | ⚠️ | Still need to fetch the baseline hash manifest from Chromatic — a transport error, not a precision bail. |

**Net:** every `changedPackageFiles` and `invalidChangedFiles` bail (the bulk of the
monorepo/shallow-clone pain) is **eliminated for all three options**; `changedStorybookFiles`
stops being a blanket bail; and only the genuinely out-of-graph categories
(`changedStaticFiles`, `changedExternalFiles`) plus the fundamental `noAncestorBuild` /
`rebuild` / `missingStatsFile` remain. The eliminations are nearly identical across A/B/C
because they share the diff core — the options differ mainly in the **new** bails they
introduce.

### New bail reasons to consider

**Shared (A/B/C):**

- **`baselineHashesMissing`** — an ancestor build exists but predates hash-TurboSnap (no
  stored hashes to diff against). A migration-window capture-all; scope it to a version check.
- **`hashSchemaMismatch`** — baseline hashes use an incompatible schema/version ⇒ can't
  compare. Version the hash payload so this is detectable rather than silently wrong.
- **Residual out-of-graph surface** — anything affecting rendering that isn't a module in the
  graph (static assets, `preview-head.html` global CSS, fonts, runtime-fetched data). This is
  *why* `changedStaticFiles` / `changedExternalFiles` and the `.storybook`-dir disk hash are
  retained; the new risk is **forgetting** one of these inputs and silently under-capturing.

**Strategy A (own-trace):**

- **`ownTraceFailed`** — esbuild can't bundle a story entry (alias/plugin/config replication
  gap). Plus the dangerous non-bail: *silent* fidelity drift ⇒ under-capture (see the
  [Strategy A doc](./hash-based-turbosnap-strategy-a-own-trace.md)).

**Strategy B (module-emit):**

- **`graphExtractionFailed`** — the builder plugin fails to emit the module graph or a module
  hash. A *loud*, CI-visible failure (the intended trade-off vs. A's silent drift).

**Strategy C (chunk-diff):**

- **`chunkTopologyChanged`** — a re-chunk (vendor-split tweak, new manual chunk) moves many
  chunk hashes at once ⇒ detect the structural chunk-set change and conservatively capture the
  affected stories rather than mis-attribute.
- **`chunkGraphExtractionFailed`** — the plugin fails to emit `chunk-graph.json`.
- Incomplete hash normalization is an over-capture cascade, not a bail (see the
  [Strategy C doc](./hash-based-turbosnap-strategy-c-chunk-diff.md#two-findings-that-decide-whether-this-is-viable)).

### What the backend must store (the contingency)

The bail eliminations above hold **only if the comparison is hash-vs-stored-baseline-hashes**.
If the diff still falls back to a git changed-file computation, the `invalidChangedFiles`
family (shallow clone, dirty baseline, git failures) comes back. So the requirement is: each
build **persists its own hash manifest**, and the next build fetches the baseline build's
manifest and diffs maps — no git, no lockfiles. (This is the same direction as the
"upload baseline manifests as build artifacts" idea.)

**Per build, store a small hash manifest** (KBs even for thousands of stories):

```jsonc
{
  "hashSchemaVersion": 2,            // bump when the algorithm/normalization changes
  "hashAlgo": "xxhash64",            // + normalization id, so mismatches are detectable
  "sharedSectionHash": "…",          // preview/config/externals folded section
  "stories": {
    "src/Button.stories.tsx": "…"    // the per-story rolled-up hash (the diff key)
  },
  "modules": {                       // optional but recommended (B): enables flexible
    "src/Button.tsx": "…"            // backend rollups + "why did story X re-capture?"
  }
}
```

**The diff becomes:** fetch the baseline build's manifest **by the baseline build id the CLI
already resolves** (no commit checkout), then `changed = stories where hash !== baseline.hash`.
That's it — the inputs that determined the result are stored, not recomputed from git.

**The backend/CLI must then handle:**

- **Baseline selection** stays as-is (server-authoritative, by build id) — it does *not* need
  a git diff, which is what retires the shallow-clone bails.
- **No baseline manifest** (ancestor predates this feature, or was built by an old
  CLI/builder) ⇒ `baselineHashesMissing` ⇒ capture all. Gate on `hashSchemaVersion` presence.
- **Schema/algo mismatch** between builds ⇒ `hashSchemaMismatch` ⇒ capture all (don't compare
  hashes computed by different normalization).
- **Multiple ancestors** (merge commits): decide the policy — diff against each and union the
  changed sets (conservative) or intersect (aggressive). Document it; it replaces today's
  git-ancestry logic.
- **Client-side residue:** `untraced`, `externals`, and the out-of-graph static/config disk
  hashes are applied where the manifest is produced, so they're baked into the stored hashes.

The remaining decision is the **`publishBuild` schema** itself (per-story only, shared +
per-story, or module/chunk-level too) — tracked in [Open questions](#open-questions-shared).

## Key learnings

### Builder stats are not portable

- **Webpack** `preview-stats.json` is the real compiler graph — complete, includes the
  preview config and its dependencies.
- **Vite** stats are synthesized by a Rollup plugin (`storybook:rollup-plugin-webpack-stats`)
  that filters out the virtual modules the preview config is wired through. Result:
  `.storybook/preview.*` and its external dependencies are **absent** from the Vite graph.

This is why behavior diverges by builder, and why either a fuller builder-emitted graph
(strategy B) or an own-trace (strategy A) is needed. The Vite-side fix lives in the
[strategy B doc](./hash-based-turbosnap-strategy-b-builder-emit.md#what-the-plugins-need-to-change-vite-and-webpack5).

### How preview changes are handled today (for context)

Production TurboSnap **bails** (re-captures everything) when anything in the Storybook
config dir changes, and — on webpack — when a changed file traces up to a config file.
On Vite, preview's external deps are a pre-existing blind spot. The hash prototypes match
this conservatively by folding the whole `.storybook` dir into the shared section, and the
esbuild variant improves on it by tracing preview's real graph.

### Hashing files beats sniffing versions

`hash-stories` reads `node_modules/<pkg>/package.json` versions (nested-resolution aware).
That works and catches version bumps, but it can't see same-version content changes
(`patch-package`) and is more moving parts. Both options hash the actual content instead —
strategy A hashes the bundled dependency files, strategy B emits per-module content hashes
— so any change that affects the bundle is caught by construction.

### Stories can depend on stories

CSF composition (`import * as x from './other.stories'`) means story files are sometimes
dependencies of other stories. A dependency-tracing hash handles this for free; a naive
"a story only affects itself" model would not.

### A bare resolver is not enough

Resolution-only tracing (no TS type-elision, no tree-shaking) massively over-captures and
defeats TurboSnap's purpose. This is why the own-trace (strategy A) is built on esbuild
rather than a plain resolver; the measurements are in the
[strategy A doc](./hash-based-turbosnap-strategy-a-own-trace.md#trace-fidelity--is-an-own-trace-trustworthy).

### Hashing source files directly isn't sufficient (the original approach)

The original plan — list a story's dependencies and hash each **source file on disk** — is
correct for the common case (the prototypes do exactly this with xxhash and it holds for
most stories), but two gaps make raw-file hashing insufficient as the *sole* mechanism.
Both point to hashing the builder's **transformed module content**, driven by the real
bundled graph (strategy B), rather than raw files in isolation:

1. **You can't know *which* files to hash without the real bundled graph.** A file list
   produced by a resolver/parser over-captures badly (see *A bare resolver is not enough* —
   ~9,200 extra files from type-only imports and missing tree-shaking). The list must come
   from the post-elision, post-tree-shake build graph.
2. **Raw on-disk bytes miss build- and transform-driven changes.** A change can alter a
   story's rendered output *without changing any source file's bytes*:
   - a `define`/env value that gets inlined,
   - a Vite/webpack **plugin option** change,
   - an **alias retarget** (the same import resolves to a different file),
   - **asset / SVGR / CSS-modules** transform output changing for the same input.

   A raw-file hash sees none of these, so it can **under-capture** — skip a story that
   actually changed, which is the dangerous direction. Hashing the builder's *transformed*
   module content catches them because it hashes what was actually bundled. The raw-vs-
   transformed-vs-normalized trade-off and how to keep transformed hashes deterministic are
   in the [strategy B doc](./hash-based-turbosnap-strategy-b-builder-emit.md).

## Open questions (shared)

- Exact `publishBuild` schema and how the backend stores/compares baseline hashes.
- Whether the shared section is sent as one hash or folded into each story hash.

Option-specific open questions live in each strategy's doc.

## Running the scripts

```bash
# Build a Storybook with stats first (for hash-stories / story enumeration):
yarn build-storybook   # produces storybook-static/preview-stats.json

# 1. stats-based hashing (shared-core demo, this doc)
chromatic hash-stories -s storybook-static/preview-stats.json [--mode expanded] [--baseline base.json] [--json]

# 2. esbuild hashing with node_modules (strategy A)
chromatic hash-stories-esbuild -s storybook-static/preview-stats.json [--mode expanded] [--baseline base.json] [--json]

# 3. fidelity check (strategy A; oxc resolver requires: npm i oxc-parser oxc-resolver)
chromatic trace-fidelity -s storybook-static/preview-stats.json --resolver esbuild|oxc [--worst N] [--json]

# 4. hybrid B∩C diff (needs preview-stats.json + chunk-graph.json from a baseline and current build)
node bin-src/hashStoriesHybrid.mjs <baseline-stats> <current-stats> <baseline-chunks> <current-chunks>
```
