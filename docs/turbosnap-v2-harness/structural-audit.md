# TurboSnap v2 structural-change audit

Measured 2026-07-30 with `structural-probe.sh` (this directory). Re-run with:

```sh
cd ~/Projects/chromatic-cli && yarn build
cd docs/turbosnap-v2-harness
bash structural-probe.sh ui           # vite
bash structural-probe.sh ui-webpack   # webpack5
```

This audit ran in two rounds. The first found one residual gap — a **byte-preserving move recaptured
nothing** — which was then measured to a mechanism, fixed by making every roll-up path-sensitive, and
re-measured. The verdict table below is the **post-fix** state; [The byte-preserving move](#the-byte-preserving-move)
records what the first round found and what the fix changed.

## Why this audit exists

Every other probe in this harness is **content-only against a fixed `preview-stats.json`, by design** —
the attribution matrix and the bail matrix append bytes to files already in the graph and regenerate
the manifest from the same snapshot. That isolates hash propagation from story detection, but it means
one whole class had never been measured: changes that alter the **shape** of the graph. A real build
regenerates the stats, so `structural-probe.sh` rebuilds the fixture's Storybook for every case.

## Setup

| | |
|---|---|
| Fixture | `~/Projects/turbosnap-monorepo`, packages `ui` (vite) and `ui-webpack` (webpack5) |
| `ui` builder | **patched** `@storybook/builder-vite` from the fork at `~/Projects/storybook-codykaup`, commit `49cd7635df7` (probe verifies and prints `PATCHED (fork build)`) |
| Storybook | `10.6.0-alpha.3` |
| `ui` clean baseline | `storybookHash 5ebb8e8b1c4f0abd`, 44 files, `storyReachable 15 / previewSubtree 3 / storybookGlobals 27` |
| `ui-webpack` clean baseline | `storybookHash e3bff68a52e8b3b8`, 346 files, `storyReachable 293 / previewSubtree 3 / storybookGlobals 51` |
| Out of scope | `ui-rsbuild` (indexes 0 stories, so every structural probe there only moves the bucket) |
| Deliberately not rebuilt | `marketing-ui` — its stats predate the fork and are the live unpatched-vite control |

Both baselines are higher than the first round's (40 / 285 files) because this round added the
`PathDerived` fixture — see [The byte-preserving move](#the-byte-preserving-move).

Fixture restored and verified after the run: `git status` clean, and freshly generated manifests hash
back to the baselines above.

`storybookFiles moved` is the column that matters most: any entry moving means **recapture
everything**, so "0 stories changed" is not "nothing recaptures".

## Verdict table

### vite (`ui`, patched builder-vite `49cd7635df7`)

| # | Case | What was edited | `storybookHash` | Stories recaptured | `storybookFiles` moved | Attribution change | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `new-import` | new `src/lib/Button/spacing.ts`, imported by `Button.tsx` | CHANGED | 1 — `Button.stories.tsx` | 0 | `+ spacing.ts [storyReachable]` | **correct** |
| 2 | `new-story` | new `src/lib/Badge/BadgeExtra.stories.tsx` (explicit title) | CHANGED | 1 — `BadgeExtra.stories.tsx` `ABSENT -> 32ca3baaef1a96a6` | 0 | `+ BadgeExtra.stories.tsx [storyReachable]` | **correct** |
| 3 | `delete-story` | `Badge.stories.tsx` removed | CHANGED | 1 — `Badge.stories.tsx` `b6b7b86d1cec56fb -> ABSENT` | 0 | `- Badge.stories.tsx` | **correct** |
| 4 | `move-module` | `src/theme.ts` → `src/theme/index.ts`, bytes intact, **no importer edits** | CHANGED | 1 — `Button.stories.tsx`, **plus everything** | 1 — `./.storybook/preview.ts` | re-keyed, same homes (`storyReachable+previewSubtree`) | **over-captures** (v1 bails here too) |
| 5 | `move-component` | `Badge.tsx` → `Badge/index.tsx`, bytes intact, **no importer edits** | CHANGED | 2 — `Badge.stories.tsx`, `UserCard.stories.tsx` | 0 | re-keyed, `storyReachable` | **correct** — exactly v1's traced set |
| 6 | `move-path-derived` | `PathDerived.tsx` + its CSS Module → `PathDerived/index.tsx`, bytes intact | CHANGED | 2 — `PathDerived.stories.tsx`, `PathDerivedShared.stories.tsx` | 0 | re-keyed, `storyReachable` | **correct** — exactly v1's traced set |
| 7 | `move-package` | `Badge.tsx` → `packages/shared/src/Badge.tsx`, importers updated | CHANGED | 2 — `Badge.stories.tsx`, `UserCard.stories.tsx` | 0 | `+ ../shared/src/Badge.tsx [storyReachable]` | **correct** |
| 8 | `move-story` | `Badge.stories.tsx` → `BadgeRenamed.stories.tsx`, bytes intact, explicit `title` | CHANGED | 2 — old key `-> ABSENT`, new key `ABSENT -> 32f9aac135cb43a2` | 0 | re-keyed, `storyReachable` | **correct** (over-captures: IDs did not change) |
| 9 | `move-story-autotitle` | autotitled `AutoTitle.stories.tsx` moved `lib/Badge/` → `lib/Renamed/`, bytes intact | CHANGED | 2 — old key `-> ABSENT`, new key `ABSENT -> 8b589f97ee12b996` | 0 | re-keyed, `storyReachable` | **correct** — story IDs changed `badge-autotitle--auto` → `renamed-autotitle--auto` and the gate now moves |
| 10 | `new-dep` | first `import { nanoid } from 'nanoid'` in `Button.tsx` | CHANGED | 1 — `Button.stories.tsx` | 0 | `+ nanoid/index.browser.js`, `+ nanoid/url-alphabet/index.js` — both `[storyReachable]` | **correct** |
| 11 | `remove-import` | `Button.tsx` stops importing `src/theme.ts` (still imported by `preview.ts`) | CHANGED | 1 — `Button.stories.tsx` | 0 | `~ theme.ts [storyReachable+previewSubtree] -> [previewSubtree]` | **correct** |
| 12 | `remove-dep` | `Button.tsx` stops importing `moment` | CHANGED | 1 — `Button.stories.tsx` | 0 | `- moment/dist/moment.js`; bucket count unchanged at 27 | **correct** |
| 13 | `orphan-to-bucket` | `src/globalToken.ts` imported by both `Button.tsx` and a `main.ts` `previewAnnotations` module; the story importer removed | CHANGED | 1 — `Button.stories.tsx`, **plus everything** | 1 — `<storybookGlobals>` `9815060bcf358478 -> 5e7cf218b54cf1a7` | `~ globalToken.ts [storyReachable] -> [storybookGlobals]` | **over-captures** (safe, by design) |

### webpack5 (`ui-webpack`)

Every verdict is identical to vite. Differences are in the graph, not the behaviour.

| # | Case | `storybookHash` | Stories recaptured | `storybookFiles` moved | Verdict |
|---|---|---|---|---|---|
| 1 | `new-import` | CHANGED | 1 — `Button.stories.tsx` | 0 | **correct** |
| 2 | `new-story` | CHANGED | 1 — `ABSENT -> c940163c0f3527df` | 0 | **correct** |
| 3 | `delete-story` | CHANGED | 1 — `0bb2db1b962e850f -> ABSENT` | 0 | **correct** |
| 4 | `move-module` | CHANGED | 1 + **everything** | 1 — `./.storybook/preview.ts` | **over-captures** (v1 bails here too) |
| 5 | `move-component` | CHANGED | 2 — `Badge.stories.tsx`, `UserCard.stories.tsx` | 0 | **correct** — matches v1's story set |
| 6 | `move-path-derived` | CHANGED | 2 — `PathDerived.stories.tsx`, `PathDerivedShared.stories.tsx` | 0 | **correct** — exactly v1's traced set |
| 7 | `move-package` | CHANGED | 2 — `Badge.stories.tsx`, `UserCard.stories.tsx` | 0 | **correct** |
| 8 | `move-story` | CHANGED | 2 — key swap, new hash | 0 | **correct** |
| 9 | `move-story-autotitle` | CHANGED | 2 — key swap, new hash | 0 | **correct** — IDs `badge-autotitle--auto` → `renamed-autotitle--auto` |
| 10 | `new-dep` | CHANGED | 1 — `Button.stories.tsx` | 0 | **correct** — and no new `core-js` |
| 11 | `remove-import` | CHANGED | 1 — `Button.stories.tsx` | 0 | **correct** |
| 12 | `remove-dep` | CHANGED | 1 — `Button.stories.tsx` | 0 | **correct** — 138 files left the graph (346 → 208) |
| 13 | `orphan-to-bucket` | CHANGED | 1 + **everything** | 1 — `<storybookGlobals>` | **over-captures** (safe, by design) |

Two webpack-specific notes:

- Case 10 pulled in **only** the two `nanoid` files. The 84 `core-js` modules that `.babelrc`'s
  `useBuiltIns: "usage"` injects webpack-side were already in the graph, so they do not confound the
  new-dependency measurement.
- Case 12's 138 departures are `moment`'s locale require-context, which vite never builds. That
  asymmetry is correct, not a disagreement.

On case 5, v1's `storyFiles` list is 3 entries webpack-side because it includes `UserCard.tsx`, a
component rather than a story. The **story** set is the same two, so this is parity.

## The byte-preserving move

Getting a byte-preserving move requires avoiding importer edits, since an import specifier is part of
the importer's bytes. Directory-index resolution does it: `src/theme.ts → src/theme/index.ts` keeps
`'../../theme'` byte-identical, and `Badge.tsx → Badge/index.tsx` keeps both `'./Badge'` and
`'../Badge/Badge'` byte-identical. Real-world equivalents are a package move under a workspace name,
a `tsconfig` path alias, and a barrel file.

### What the first round found

`rollUpHash` combined content hashes **in sorted-hash order**, so a roll-up depended only on the
multiset of contents, never on paths — documented as deliberate, so a project or dependency moving
inside the repo would not churn hashes. The prediction was therefore that **any move changing no
file's bytes leaves `storybookHash`, every story hash and every `storybookFiles` entry untouched**.
That is exactly what cases 4, 5, 8 and 9 measured, on both builders.

Case 5 was the sharp one. v1, traced against the post-move stats, **traced** — it did not bail — and
recaptured two stories, while v2 recaptured zero. That is the one verdict class `parity.mjs` treats as
failing (*v2 MISSES a story v1 caught*), and the standing bar's "v1 was blunt, so no per-story evidence
was lost" escape did not apply.

The defence was that identical bytes render identically. The ticket required measuring that before
designing anything, so the fixture gained a `PathDerived` component carrying every suspected
path-derived mechanism, and `outdiff.mjs` was added to diff the emitted `storybook-static` bytes — the
thing a browser actually fetches — rather than reasoning from indexed story IDs.

### The mechanism, measured

Moving that component with its bytes intact, on both builders:

| Suspected mechanism | vite (`ui`) | webpack (`ui-webpack`) |
|---|---|---|
| CSS-Module class name | `_panel_1n58f_1` unchanged — content-hashed, **not** path-hashed | unscoped `.panel`; Storybook's default webpack config doesn't scope `.module.css` at all |
| `new URL('./logo.svg', import.meta.url)` asset URL | `logo-DOxA0yNj.svg` unchanged (basename + content hash) | `logo.34edcf0e.svg` unchanged |
| Rendered raw `import.meta.url` | **CHANGED** — chunk URL `/assets/PathDerived-AMkm_eRL.js` → `/assets/index-BCnqsKJG.js` | **CHANGED** — absolute source path baked in: `…/PathDerived/PathDerived.tsx` → `…/PathDerived/PathDerived/index.tsx` |
| Emitted chunk/CSS filenames | `PathDerived-*.js`/`.css` → `index-*.js`/`.css`; `iframe.html` rewritten | story bundles + `runtime~main` rewritten |

So the risk is **real but narrower than the audit had reasoned**: the two mechanisms the first round
named as the likely culprits are provably path-independent. What survives is output that embeds the
module's own path or URL — which is enough, because the emitted bytes differ and the browser fetches
them.

Supporting facts measured alongside, because they bound how much churn path-sensitivity can cause:

- Two consecutive builds with no source change are **byte-identical** — there is no per-build churn to
  mistake for a path effect.
- **Neither manifest contains any absolute path** — 54 keys (vite) / 356 (webpack), all `./`-prefixed
  and project-root-relative — so local vs CI does not churn v2, path-sensitivity or not.
- Environment-driven v2-only churn does exist (differing line endings, differing installed dependency
  content) but in the safe direction, and it is unrelated to paths.

### The decision, and what changed

**Make the graph roll-ups path-sensitive.** The reason is the parity bar, not the exoticness of the
rendering mechanism: v1 traced the move and recaptured two stories, v2 recaptured zero, and *Agreed
design 2* has no escape clause for that. It also deletes the "modules are the exception" carve-out —
every roll-up now hashes path and content alike.

`rollUpHash` and `rollUpPathSensitiveHash` collapsed into one recipe, since the contrast between them
no longer exists: `rollUpEntryHashes` rolls up length-prefixed `path + contentHash` pairs, and
`rollUpFileHashes` is the adapter for callers holding a subtree of paths (`v2/graph.ts`). The three
graph-rolled call sites — story-file hashes in `manifest.ts` and both `storybookFiles` roll-ups in
`storybookFiles.ts` — now go through it, joining the two out-of-graph roll-ups that were already
path-sensitive.

**What did *not* change is load-bearing:** manifest keys are project-root-relative, so *moving the
whole project still moves nothing at all*. That is the property path-independence existed to protect,
and it is preserved by the keying rather than by the roll-up recipe. `manifest.test.ts` pins it.

### What the fix bought

- Case 5 and case 6 now recapture **exactly v1's traced story set** on both builders — the parity
  regression is closed at the case that defined it.
- Case 9 (**autotitle**) is closed as a side effect, as predicted: `storybookHash` mixes story hash
  *values*, and those now move when a story file's path moves, so a rename that changes story IDs no
  longer reports "Storybook unchanged". This was the whole of the sibling ticket's defect.
- Case 4 went from recapturing 0 to recapturing everything (via the `./.storybook/preview.ts` entry).
  v1 bails there, so this is over-capture into a case v1 was already blunt about — permitted, not a
  new cost.
- Case 8 over-captures: a story file renamed with an *explicit* title changes no story ID, so the two
  recaptures are unnecessary. Accepted — distinguishing it would mean parsing `title` out of the story
  source, and the standing preference is the simple legible mechanism.

Path-sensitivity did **not** blunt the manifest. `attribution-matrix.sh` is clean on both packages —
all 24 probes match their expectations, including the negative controls: an unreferenced
`src/index.ts` still moves nothing, and both narrow-`<storybookVersion>` probes still report `SAME`.

## What was *not* spuriously moved

Across all 13 cases on both builders:

- `<storybookConfig>`, `<staticFiles>` and `<storybookVersion>` never moved. Every case's edits were
  outside the config dir except case 13, whose `main.ts` and `previewAnnotation.ts` edits are in the
  *setup* (present on both sides of that diff) rather than the measured edit.
- `<storybookGlobals>` moved in exactly one case — case 13, by construction. In particular
  **removing an import does not spill the orphaned module into the bucket**: cases 11 and 12 show it
  either re-homes to `previewSubtree` (still reachable from `preview.ts`) or leaves the graph outright
  (no importer left at all). The bucket count was unchanged at 27 (vite) / 51 (webpack).
- The `previewSubtree` count was 3 in every single measurement.

## The one way into the bucket, and what it costs

Case 13 answers the ticket's "does it fall into `<storybookGlobals>`, and does that then recapture
everything?" — **yes, and yes, but only when a non-story, non-preview importer keeps the edge alive.**
`storybookFiles.ts` defines the catch-all by *absence* from `storyReachable` and `previewSubtree`,
so a module needs a surviving importer that is itself a bucket resident. The realistic mechanism is
`main.ts` `previewAnnotations`, which the probe uses: a module imported by both a story and a preview
annotation, losing only its story importer, moves into the bucket and its hash change makes every
story recapture. Over-capture, so safe, but worth knowing that in a project leaning on
`previewAnnotations` an ordinary refactor can trip a full recapture.

## Ranked gaps

| Rank | Gap | Severity | Evidence | Notes |
|---|---|---|---|---|
| 1 | **A byte-preserving move of a story file with an explicit `title` recaptures it anyway.** | Low (safe direction) | Case 8, both builders: 2 recaptures where the indexed story IDs are unchanged | Accepted. Telling this apart from the autotitle case means reading `title` out of the story source; the simple mechanism over-captures instead. |
| 2 | **Losing the last story importer of a module that a `previewAnnotations` global still imports recaptures everything.** | Low (safe direction) | Case 13, both builders: `<storybookGlobals>` moved | By design and in the safe direction, but it makes ordinary refactors expensive in projects that use `previewAnnotations`. Only worth a ticket if that pattern shows up in real customer builds. |

Closed since the first round: the byte-preserving module move (was rank 1), the story-file rename
invisible to `storybookHash` (was rank 2), the preview-reachable module move (was rank 3, subsumed),
and the absence of bundle-level verification (was rank 5, now `outdiff.mjs`).

## Explicitly not measured

- **rspack (`ui-rsbuild`)** — out of scope on this map; it indexes 0 stories, so every structural
  probe there only moves the bucket and every verdict is vacuous.
- **unpatched vite (`marketing-ui`)** — deliberately not rebuilt; rebuilding destroys the live
  unpatched-builder control permanently. The probe refuses to run on it.
- **Backend gate ordering** — whether `storybookHash` short-circuits the per-story comparison is not
  observable from the CLI. It no longer changes any verdict here, since the gate now moves in every
  case where the per-story map moves, but it is still unconfirmed.
- **How often a byte-preserving move happens on a real repo.** The CLI is monitoring-only, so this
  would have shown up as a `CHANGED_FILE_ABSENT` / `EDGE_MISSING` disagreement rather than a bad
  build. It was fixed on the parity bar rather than on frequency evidence, so the frequency is still
  unknown — and now unobservable, since the disagreement is gone.

## Correction to an established fact

The README's static-file section justified `rollUpHash`'s path-independence as "correct for modules
(identical bytes render identically), wrong for static files (the URL is the identity)". The first
round narrowed that to "correct for modules whose path does not reach the output"; this round
**retired it**. A module's path does reach the output — measured, via `import.meta.url` and emitted
chunk names — so every roll-up is path-sensitive and the module/static-file distinction is gone.

What remains true, and is the part worth carrying forward: **path-sensitivity is anchored at the
project root**, so a project moving within the repository still changes nothing.

## Known wart

`outdiff.mjs` normalizes bundler content hashes out of filenames so two builds are comparable. That
normalization can collide two logically distinct chunks that both normalize to `index-*.js`, which
shows up as a spurious `~ assets/index-*.js` line. Read the added/removed lines around it before
trusting a `~` on a normalized name.
