# TurboSnap v2 (Hash-Based) — Change-Detection Test Report

**Date:** 2026-07-24
**CLI:** `chromatic-cli` @ `cody/turbosnap-v2` (`438bee8c`)
**Fixture repo:** `~/Projects/turbosnap-monorepo` (Nx monorepo, three Storybook builders)
**Method:** `chromatic turbosnap-manifest -b packages/<pkg>` → per-story `xxhash64` hashes, diffed before/after edits.

## How the algorithm works (as tested)

For every story file, `buildManifest` walks *down* the builder's module graph, collects the story's
complete transitive dependency set, and folds each file's content hash (sorted, so it's
location-independent) into a single **per-story hash**. The whole-Storybook hash is the sorted fold
of all per-story hashes. A story is recaptured when its hash changes; two builds are compared by
diffing these hashes. No `git diff`, no lockfile parsing, no baseline checkout.

Tests changed a file's **content only** (appended a comment) and regenerated the manifest from the
**same** stats file, isolating hash propagation through the existing graph from the story-detection
logic.

## Test fixture dependency graph

```
Badge.stories.tsx  → Badge.tsx                       (leaf)
Button.stories.tsx → Button.tsx  → @myorg/shared (capitalize), moment
UserCard.stories.tsx → UserCard.tsx → Badge.tsx, @myorg/shared (formatDate)
```

`@myorg/shared` resolves to `packages/shared/src/index.ts` — a **barrel** re-exporting every util.
Builders tested: **ui** (`@storybook/react-vite`), **ui-webpack** (`react-webpack5`), **ui-rsbuild**
(`storybook-react-rsbuild`). `marketing-ui` is also Vite (not separately built; same behavior as `ui`).

---

## ✅ What the algorithm catches (correct on all three builders)

Every result below was **identical** across vite, webpack, and rsbuild unless noted.

| Edit | Expected recapture | Result |
|---|---|---|
| Leaf component `Badge.tsx` | Badge + UserCard (UserCard imports Badge) | ✅ Badge + UserCard |
| `UserCard.tsx` | UserCard only | ✅ UserCard only |
| `Button.tsx` | Button only | ✅ Button only |
| Story file `Badge.stories.tsx` | Badge only | ✅ Badge only |
| Cross-package `shared/src/index.ts` | stories using shared | ✅ Button + UserCard |

**Strengths confirmed:**

- **Transitive tracing is correct** — a leaf change bubbles up to every dependent story and no
  further. No over-capture, no story-to-story leakage through the CSF glob.
- **Cross-package / monorepo edges work** — editing `packages/shared` correctly invalidated stories
  in the consuming package. Manifest keys are git-root-relative, so shared code is tracked across
  package boundaries.
- **Builder-agnostic for source files** — vite, webpack, and rsbuild produce the same story→file
  graph for first-party source. Content-based hashing even yields *identical* hashes across builders
  for a story with the same dependency contents (e.g. Badge's hash was byte-identical in webpack and
  rsbuild after the same react edit).
- **Location independence** — hashes fold sorted content, so moving a file within the repo does not
  change a story hash.

---

## ❌ What the algorithm misses (blind spots)

### 1. `.storybook/preview.*` changes invalidate **nothing** — CONFIRMED (all builders)

Editing `.storybook/preview.ts` changed **0 stories** and left the Storybook hash **unchanged** on
vite, webpack, and rsbuild.

`preview.ts` *is* in the stats graph, but it hangs off the preview-app branch, not any story's
downward trace:
- vite: imported by `/virtual:/@storybook/builder-vite/vite-app.js`
- webpack/rsbuild: imported by `./storybook-config-entry.js` (deliberately excluded from story
  importers — it's only used to locate the require-context)

So it appears in the manifest `files` map with a real hash but **empty dependents**, and the
Storybook hash is derived solely from per-story hashes, so it never notices. This is the ticket you
already filed. It's the single highest-impact gap: `preview.js` configures decorators, globals,
parameters, and theming that affect **every** story.

### 2. Dependency (`node_modules`) upgrades — silently builder-dependent

This is the most surprising finding. Editing `node_modules/react/index.js`:

| Builder | node_modules in a story's dep set | React edit → recapture |
|---|---|---|
| **webpack** | 241 files (react, core-js, …) | ✅ all 3 stories |
| **rsbuild** | 157 files | ✅ all 3 stories |
| **vite** | app deps absent from story sets | ❌ **0 stories** |

Vite pre-bundles (`optimizeDeps`) framework/core dependencies into optimized chunks, so the
component→`react` edge is **not** in the stats graph — react attaches only to the preview runtime.
A **React (or any optimized-dep) upgrade would not recapture any story in a Vite Storybook.**

Worse, vite coverage is **inconsistent**: `moment` (a non-optimized, explicitly imported dep) *is*
traced — editing `node_modules/moment/dist/moment.js` correctly recaptured Button on vite. So on
vite some dependency changes are caught and some aren't, with no signal to the user about which.

> Note: this contradicts the stated design goal that "dependency upgrades must change story hashes."
> The goal holds for webpack/rsbuild but **not** for Vite's optimized deps.

### 3. `.storybook/main.ts` changes invalidate nothing (all builders)

`main.ts` never appears in the module graph (it's build-time config, not bundled). Confirmed: editing
it changed 0 stories. Changes to `main.ts` — addon list, framework options, `env`, `staticDirs`,
webpack/vite `final` config, feature flags — can alter **every** rendered story yet are invisible to
the hash. Same class of gap as `preview.*` but not reachable via the graph at all.

### 4. File-level (not symbol-level) granularity → barrel over-capture

Editing `formatDate` in `shared/src/index.ts` recaptured **Button too**, because Button imports
`capitalize` from the same barrel file. The whole file is hashed as one unit, so any export change
invalidates every story importing *anything* from that file. Correct (safe) but a real over-capture
cost for projects that funnel everything through `index.ts` barrels — common in monorepos and design
systems. Not a correctness bug; a precision cost.

### 5. Not tested here, but structurally present

- **Non-JS graph assets (CSS/SCSS/SVG imported by components):** hashed only if the builder emits
  them as modules in the stats. Coverage will vary by builder/loader config — worth a dedicated test.
- **`staticDirs` / public assets:** copied verbatim, never in the module graph → never hashed.
- **Source-byte hashing vs. transformed output:** the manifest hashes raw source bytes off disk.
  Transform-driven changes that don't touch source bytes (env inlining, alias retargeting, a
  `define`/`env` change in config) can alter rendered output without changing any hash. (Config
  changes are also caught by fixing #1–#3.)

---

## Suggested changes

**P0 — Trace Storybook config files as global dependencies (fixes #1, and #3 for `preview`).**
Treat the files imported by the config entry / vite-app entry (excluding the require-context glob) —
`preview.*` and anything it imports — as **global** dependencies folded into *every* per-story hash,
**and** into the Storybook hash. This mirrors TS 1.0's `changedStorybookFiles` global bail, expressed
as a hash. `preview.ts` is already in the graph on both builder families, so this is reachable today.

**P0 — Close the Vite `node_modules` gap, or fail loud (#2).** Decide the contract for dependency
upgrades and make it uniform:
- If dependency changes *should* recapture: don't rely on the Vite module graph for deps. Fold a
  hash of the resolved dependency set (e.g. lockfile-derived versions for the packages a story
  transitively imports) into story hashes, so upgrades invalidate consistently across builders.
- If they should *not*: strip node_modules from webpack/rsbuild sets too, so all builders behave the
  same — today webpack recaptures on a React bump and vite doesn't, which is a silent inconsistency.

Either way, **the current state (works on webpack/rsbuild, silently not on vite) is the trap.**

**P1 — Account for `main.ts` (#3).** It's not in the graph, so hash it (and its local imports)
explicitly as a global config input, alongside the `preview.*` handling in P0.

**P2 — Measure barrel over-capture (#4).** Accept file-level granularity, but document it and
consider surfacing "N stories recaptured due to `shared/index.ts`" so users can see when a barrel is
the cause. Symbol-level splitting is likely not worth the complexity.

**P2 — Add builder-matrix regression tests.** The test matrix used here (leaf / transitive /
isolated / story-file / cross-package / preview / main / node_modules, run against all three
builders) should be a checked-in fixture so builder-specific divergences (like #2) are caught
automatically rather than by manual spot-checks.

**P2 — Add coverage tests for CSS/asset imports and transformed output (#5)** to confirm whether the
raw-source-byte approach under-detects in real projects.

---

## Appendix — reproduction

Harness in scratchpad: `gen.sh` (build a manifest for a package), `tsdiff.mjs` (diff two manifests'
story hashes), `trace.mjs` (print a story's transitive deps), `matrix.sh` (run the full edit matrix
for one builder). Each edit appends a comment, regenerates from the unchanged stats file, diffs, then
`git checkout`s the file. node_modules edits back up/restore the file directly (not git-tracked).

```
bash matrix.sh ui          # vite
bash matrix.sh ui-webpack  # webpack
bash matrix.sh ui-rsbuild  # rsbuild
```
