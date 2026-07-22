# TurboSnap v2 hash-manifest — test report

**Date:** 2026-07-22
**Area:** `node-src/lib/turbosnap/v2` (`manifest.ts`, `index.ts`)
**Goal:** Verify that the v2 `turbosnap-manifest.json` produces per-story file hashes that
change exactly when a story's dependencies change, and a `storybookHash` that flips whenever
*anything* in the Storybook changes — across the Vite, Webpack, and rspack builders.

## TL;DR

- The v2 algorithm is **correct for the Vite builder** — transitive dependency tracking, leaf
  inclusion, determinism, and the `storybookHash` fast-path all behave exactly as designed.
- Out of the box it is **completely broken for the Webpack and rspack builders**: it throws and
  the error is **silently swallowed**, so v2 never produces a manifest for ~half of real
  Storybook projects and quietly falls back to v1.
- Three fixes bring **all three builders to green** (15/15 scenarios). Two are algorithm fixes
  (committed here); one is a stats-build config change (module concatenation off), applied to the
  monorepo and recommended for the CLI's own builds.

## How it was tested

Monorepo dependency graph under test (identical in each UI package):

```
Button.stories.tsx  ─▶ Button.tsx  ─▶ @myorg/shared, moment
UserCard.stories.tsx ─▶ UserCard.tsx ─▶ @myorg/shared, Badge.tsx
Badge.stories.tsx   ─▶ Badge.tsx
```

Note `Badge.tsx` is shared by `UserCard` and `Badge`, and `@myorg/shared` is shared by `Button`
and `UserCard` — so the graph has real fan-out to test transitivity.

Five scenarios per project, each with a declared expectation the harness checks automatically:

| Scenario | Change | Expected story hashes to change | `storybookHash` |
|---|---|---|---|
| `noop-rebuild` | none (rebuild only) | *none* | unchanged |
| `edit-button-component` | `Button.tsx` | Button | changed |
| `edit-badge-component` | `Badge.tsx` | Badge + UserCard | changed |
| `edit-button-story` | `Button.stories.tsx` | Button | changed |
| `edit-shared-lib` | `@myorg/shared` | Button + UserCard (not Badge) | changed |

Builders: `ui` = `@storybook/react-vite`, `ui-webpack` = `@storybook/react-webpack5`,
`ui-rsbuild` = `storybook-react-rsbuild` (rspack).

## Results

### Before fixes

| Builder | Outcome |
|---|---|
| **Vite** (`ui`) | ✅ 5/5 scenarios PASS |
| **Webpack** (`ui-webpack`) | ❌ **crash** — `TypeError: Cannot read properties of null (reading 'includes')` at manifest generation. No manifest produced. |
| **rspack** (`ui-rsbuild`) | ❌ **crash** — `TypeError: Cannot read properties of undefined (reading 'includes')`. No manifest produced. |

### After fixes

| Builder | noop | button-cmp | badge-cmp | button-story | shared-lib |
|---|---|---|---|---|---|
| **Vite** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Webpack** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **rspack** | ✅ | ✅ | ✅ | ✅ | ✅ |

Every builder now agrees on the exact same behaviour, e.g. editing `@myorg/shared` re-hashes
**Button + UserCard** and leaves **Badge** untouched; editing `Badge.tsx` re-hashes
**Badge + UserCard** (transitively, via `UserCard → Badge`) and leaves Button untouched; a plain
rebuild changes **nothing** (hashes are content-derived and order-independent).

## Findings

### F1 — 🔴 Critical: v2 crashes on Webpack & rspack, and the crash is invisible

`buildManifest`/`hashFiles` assume every `module.name` and every `reason.moduleName` is a string.
Webpack and rspack violate both:

- Runtime/entry helper modules can have `name: null`.
- `entry`-type reasons carry `moduleName: null` (Webpack) / `undefined` (rspack) — they represent
  the entry point itself, which has no importer.

`hashFiles` then calls `rawPath.includes('virtual:')` on that null and throws. Worse, the caller
(`node-src/lib/turbosnap/index.ts`) wraps v2 in `try/catch` and on **any** error logs a debug line
and falls back to v1. Net effect: **for every Webpack/rspack project, v2 silently never runs** —
you'd see v1 behaviour and no manifest, with nothing surfaced to the user.

**Fix (committed):** null-guard module names and reason names in both the main loop and
`hashFiles`. → `manifest.ts`.

### F2 — 🟠 High: module concatenation pollutes story keys and hashes

Webpack's `ModuleConcatenationPlugin` (and rspack's equivalent) merge modules into a single scope
whose stats `name` looks like:

```
./src/lib/Button/Button.stories.tsx + 1 modules
```

That string is not a real path. It never resolves on disk (so its content hash is `''`) and, most
damagingly, it becomes the **story key**. The Index matches stories across builds by key, so a
key of `src/lib/Button/Button.stories.tsx + 1 modules` would never line up with a clean baseline
key — every such story would look "new" forever. (Confirmed: with concatenation on, even after the
F1/F3 fixes, two of three story keys came back as `… + 1 modules`.)

**Fix (recommended, applied to the monorepo):** disable module concatenation for the stats build so
each source file stays its own module, exactly like Vite:

- Webpack — `.storybook/main.ts` `webpackFinal`: `config.optimization.concatenateModules = false`.
- rspack — `rsbuild.config.ts`: `tools.rspack.optimization.concatenateModules = false`.

This is the low-risk lever and it brings Webpack/rspack to full parity with Vite. See "Recommended
fixes" for the in-algorithm alternative.

### F3 — 🟠 High: story-file detection misses Webpack/rspack (lazy `require.context`)

v2 flags a module as a story file when one of its importers is in `STORIES_ENTRY_FILES`
(e.g. `./storybook-stories.js`). That holds for Vite, whose virtual entry imports the stories
directly. Webpack and rspack instead route stories through a lazy `require.context`
("namespace object") module:

```
storybook-stories.js ─▶ "./src/lib/ lazy … namespace object" ─▶ *.stories.tsx
```

So the stories' direct importer is the context module, not the entry — and **zero** real stories
were detected (rspack), or only the garbage context module was picked up as a "story" (Webpack).

**Fix (committed):** treat any lazy/`namespace object` module that is imported by a story-entry file
as a *story container*, and detect story files imported by any container. The container modules
themselves are excluded from the story set. → `manifest.ts`.

### F4 — 🟢 Works: the Vite path is solid

Every design goal held on Vite (and, post-fix, on all builders):

- **Transitive dependency tracking** — deep and correct (`shared → Button.tsx → story`).
- **Leaf inclusion** — editing a leaf dependency re-hashes its dependent stories (the
  `hashes`-not-`files` fix from the design doc is working).
- **Determinism / order-independence** — a no-op rebuild yields byte-identical hashes; the
  `storybookHash` is stable across module iteration order.
- **`storybookHash` fast-path** — unchanged on no-op, flips on any story change. Good as a cheap
  "did anything change?" gate before per-story comparison.

### F5 — 🔵 Observation: third-party `node_modules` are folded into story hashes

Real dependencies that resolve on disk (e.g. `moment`, imported by `Button.tsx`) are hashed and
included in the per-story hash. Consequence: bumping a dependency's content changes the hash of
**every story that transitively imports it**, triggering a re-snapshot. That may be intended (it is
a real visual-risk surface), but it means a lockfile bump to a widely-used package can invalidate a
large fraction of stories at once, and it makes `storybookHash` sensitive to dependency upgrades. v1
handled dependency changes separately via the lockfile; decide deliberately whether v2 should keep
node_modules in the per-story content hash or exclude them and detect dep changes another way.

### F6 — 🔵 Observation: the silent v1 fallback masks real breakage

Because the F1 crash surfaced only as a debug log, a production run would look "fine" while quietly
never using v2. Any v2 fallback should be visible (telemetry / a warning), so a regression in
manifest generation can't hide.

## Recommended fixes

| # | Fix | Type | Status |
|---|---|---|---|
| 1 | Null-guard `module.name` and `reason.moduleName` in `buildManifest` + `hashFiles` | Algorithm | ✅ committed |
| 2 | Detect stories imported via a lazy `require.context`; exclude container modules | Algorithm | ✅ committed |
| 3 | Disable module concatenation for the stats build (Webpack + rspack) | Stats-build config | ✅ applied to monorepo |
| 4 | Surface the v2→v1 fallback (warning / telemetry) instead of a debug log | Observability | ⬜ recommended |
| 5 | Add a builder-matrix test (Vite/Webpack/rspack) around the manifest | CI | ⬜ recommended |
| 6 | Decide whether `node_modules` content belongs in per-story hashes | Design | ⬜ open question |

### On fix #3 — config vs. in-algorithm

Disabling concatenation is the simplest, lowest-risk option and is fully validated here. Its limit:
it only works when the CLI controls the build. For **prebuilt** Storybooks (`--storybook-build-dir`
with a user-provided `preview-stats.json`), the CLI can't force it. To be robust there too, the
algorithm should additionally **expand concatenated modules** using the stats `module.modules[]`
array (which lists the merged children) — key the story by the concatenation's root child and fold
every child's content hash into the story hash. That is a larger change and should land with its own
tests; concatenation-off covers the CLI-built case today.

## Reproducing

```sh
# 1. build the bundled generator (chromatic-cli repo root)
node_modules/.bin/esbuild scripts/turbosnap-v2-harness/generateManifest.ts \
  --bundle --platform=node --format=cjs --packages=external \
  --outfile=scripts/turbosnap-v2-harness/generateManifest.cjs

# 2. run the full matrix
node scripts/turbosnap-v2-harness/run.mjs
```

To see the **before** state, revert the two `manifest.ts` fixes (or the monorepo
concatenation-off config) and re-run — Webpack/rspack will crash at baseline generation.
