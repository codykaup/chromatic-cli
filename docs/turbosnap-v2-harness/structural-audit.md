# TurboSnap v2 structural-change audit

Measured 2026-07-30 with `structural-probe.sh` (this directory). Re-run with:

```sh
cd ~/Projects/chromatic-cli && yarn build
cd docs/turbosnap-v2-harness
bash structural-probe.sh ui           # vite
bash structural-probe.sh ui-webpack   # webpack5
```

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
| `ui` clean baseline | `storybookHash ef1d44f403a0a945`, 40 files, `storyReachable 11 / previewSubtree 3 / storybookGlobals 27` |
| `ui-webpack` clean baseline | `storybookHash 8071d53beb8232d4`, 285 files, `storyReachable 234 / previewSubtree 3 / storybookGlobals 49` |
| Out of scope | `ui-rsbuild` (indexes 0 stories, so every structural probe there only moves the bucket) |
| Deliberately not rebuilt | `marketing-ui` — its stats predate the fork and are the live unpatched-vite control |

Fixture restored and verified after the run: `git status` clean, and freshly generated manifests hash
back to the baselines above.

`storybookFiles moved` is the column that matters most: any entry moving means **recapture
everything**, so "0 stories changed" is not "nothing recaptures".

## Verdict table

### vite (`ui`, patched builder-vite `49cd7635df7`)

| # | Case | What was edited | `storybookHash` | Stories recaptured | `storybookFiles` moved | Attribution change | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `new-import` | new `src/lib/Button/spacing.ts`, imported by `Button.tsx` | CHANGED | 1 — `Button.stories.tsx` | 0 | `+ spacing.ts [storyReachable]` | **correct** |
| 2 | `new-story` | new `src/lib/Badge/BadgeExtra.stories.tsx` (explicit title) | CHANGED | 1 — `BadgeExtra.stories.tsx` `ABSENT -> 0c89101fcf56c067` | 0 | `+ BadgeExtra.stories.tsx [storyReachable]` | **correct** |
| 3 | `delete-story` | `Badge.stories.tsx` removed | CHANGED | 1 — `Badge.stories.tsx` `5d59dfbcb83fc59e -> ABSENT` | 0 | `- Badge.stories.tsx` | **correct** |
| 4 | `move-module` | `src/theme.ts` → `src/theme/index.ts`, bytes intact, **no importer edits** | **SAME** | **0** | 0 | re-keyed, same homes (`storyReachable+previewSubtree`) | **under-captures** (v1 bails) |
| 5 | `move-component` | `Badge.tsx` → `Badge/index.tsx`, bytes intact, **no importer edits** | **SAME** | **0** | 0 | re-keyed, `storyReachable` | **under-captures** (v1 traced 2 stories) |
| 6 | `move-package` | `Badge.tsx` → `packages/shared/src/Badge.tsx`, importers updated | CHANGED | 2 — `Badge.stories.tsx`, `UserCard.stories.tsx` | 0 | `+ packages/shared/src/Badge.tsx [storyReachable]` | **correct** |
| 7 | `move-story` | `Badge.stories.tsx` → `BadgeRenamed.stories.tsx`, bytes intact, explicit `title` | **SAME** | key swap only: `5d59dfbcb83fc59e` moves from old key to new | 0 | re-keyed, `storyReachable` | **under-captures at the gate** (benign here) |
| 8 | `move-story-autotitle` | autotitled `AutoTitle.stories.tsx` moved `lib/Badge/` → `lib/Renamed/`, bytes intact | **SAME** | key swap only: `33404febd157fa5a` | 0 | re-keyed, `storyReachable` | **under-captures** — story IDs changed: `badge-autotitle--auto` → `renamed-autotitle--auto` |
| 9 | `new-dep` | first `import { nanoid } from 'nanoid'` in `Button.tsx` | CHANGED | 1 — `Button.stories.tsx` | 0 | `+ nanoid/index.browser.js`, `+ nanoid/url-alphabet/index.js` — both `[storyReachable]` | **correct** |
| 10 | `remove-import` | `Button.tsx` stops importing `src/theme.ts` (still imported by `preview.ts`) | CHANGED | 1 — `Button.stories.tsx` | 0 | `~ theme.ts [storyReachable+previewSubtree] -> [previewSubtree]` | **correct** |
| 11 | `remove-dep` | `Button.tsx` stops importing `moment` | CHANGED | 1 — `Button.stories.tsx` | 0 | `- moment/dist/moment.js`; bucket count unchanged at 27 | **correct** |
| 12 | `orphan-to-bucket` | `src/globalToken.ts` imported by both `Button.tsx` and a `main.ts` `previewAnnotations` module; the story importer removed | CHANGED | 1 — `Button.stories.tsx`, **plus everything** | 1 — `<storybookGlobals>` `35188833f564a754 -> 95c4fe5d39914dba` | `~ globalToken.ts [storyReachable] -> [storybookGlobals]` | **over-captures** (safe, by design) |

### webpack5 (`ui-webpack`)

Every verdict is identical to vite. Differences are in the graph, not the behaviour.

| # | Case | `storybookHash` | Stories recaptured | `storybookFiles` moved | Attribution change | Verdict |
|---|---|---|---|---|---|---|
| 1 | `new-import` | CHANGED | 1 — `Button.stories.tsx` | 0 | `+ spacing.ts [storyReachable]` | **correct** |
| 2 | `new-story` | CHANGED | 1 — `ABSENT -> 3d718a021c034a4f` | 0 | `+ BadgeExtra.stories.tsx [storyReachable]` | **correct** |
| 3 | `delete-story` | CHANGED | 1 — `e5b5279ef73a005b -> ABSENT` | 0 | `- Badge.stories.tsx` | **correct** |
| 4 | `move-module` | **SAME** | **0** | 0 | re-keyed, same homes | **under-captures** (v1 bails) |
| 5 | `move-component` | **SAME** | **0** | 0 | re-keyed, `storyReachable` | **under-captures** (v1 traced 2 stories) |
| 6 | `move-package` | CHANGED | 2 — `Badge.stories.tsx`, `UserCard.stories.tsx` | 0 | `+ packages/shared/src/Badge.tsx [storyReachable]` | **correct** |
| 7 | `move-story` | **SAME** | key swap only (`e5b5279ef73a005b`) | 0 | re-keyed | **under-captures at the gate** |
| 8 | `move-story-autotitle` | **SAME** | key swap only (`5b8745b1e8da7a59`) | 0 | re-keyed; story IDs `badge-autotitle--auto` → `renamed-autotitle--auto` | **under-captures** |
| 9 | `new-dep` | CHANGED | 1 — `Button.stories.tsx` | 0 | `+ nanoid/index.browser.js`, `+ nanoid/url-alphabet/index.js` — **and no new `core-js`** | **correct** |
| 10 | `remove-import` | CHANGED | 1 — `Button.stories.tsx` | 0 | `~ theme.ts [storyReachable+previewSubtree] -> [previewSubtree]` | **correct** |
| 11 | `remove-dep` | CHANGED | 1 — `Button.stories.tsx` | 0 | **138** files left the graph (`moment/moment.js` + 137 `moment/locale/*`); bucket count unchanged at 49 | **correct** |
| 12 | `orphan-to-bucket` | CHANGED | 1 + **everything** | 1 — `<storybookGlobals>` `c8f045ef0e046539 -> 635573d994e0f1d8` | `~ globalToken.ts [storyReachable] -> [storybookGlobals]` | **over-captures** (safe, by design) |

Two webpack-specific notes:

- Case 9 pulled in **only** the two `nanoid` files. The 84 `core-js` modules that `.babelrc`'s
  `useBuiltIns: "usage"` injects webpack-side were already in the graph, so they do not confound the
  new-dependency measurement.
- Case 11's 138 departures are `moment`'s locale require-context, which vite never builds. That
  asymmetry is correct, not a disagreement.

## The moved-module cases, predicted from the code first

`rollUpHash` (`v2/graph.ts:24-34`) combines content hashes **in sorted-hash order**, so a roll-up
depends only on the multiset of contents, never on paths — documented as deliberate, so a project or
dependency moving inside the repo doesn't churn hashes. And `storybookHash` (`v2/manifest.ts:191-197`)
mixes the *sorted story hash values* with `hashEntryIdentity` of each `storybookFiles` entry; the
comment states the asymmetry outright:

> Story file paths deliberately stay out of the gate so a project move can preserve captures, but
> Storybook-wide entries include their keys so additions, removals and renames are visible.

So the prediction was: **any move that changes no file's bytes leaves `storybookHash`, every story
hash and every `storybookFiles` entry untouched** — including a move of a story file itself. That is
exactly what cases 4, 5, 7 and 8 measured, on both builders.

Getting a byte-preserving move required avoiding importer edits, since an import specifier is part of
the importer's bytes. Directory-index resolution does it: `src/theme.ts → src/theme/index.ts` keeps
`'../../theme'` byte-identical, and `Badge.tsx → Badge/index.tsx` keeps both `'./Badge'` and
`'../Badge/Badge'` byte-identical. Real-world equivalents are a package move under a workspace name,
a `tsconfig` path alias, and a barrel file.

### Is the observed behaviour correct?

**Case 5 (`move-component`) is the sharp one.** v1, traced against the post-move stats:

```
ui           {"status":"traced","storyFiles":["…/Badge/Badge.stories.tsx","…/UserCard/UserCard.stories.tsx"]}
ui-webpack   {"status":"traced","storyFiles":["…/Badge/Badge.stories.tsx","…/UserCard/UserCard.stories.tsx","…/UserCard/UserCard.tsx"]}
```

v1 **traced** — it did not bail — and recaptured two stories. v2 recaptures zero. This is the one
verdict class `parity.mjs` treats as failing (*v2 MISSES a story v1 caught*), and the standing bar's
"v1 was blunt, so no per-story evidence was lost" escape does not apply.

The defence is that identical bytes render identically, so the snapshots would have matched anyway.
That defence holds for a plain component, and it fails wherever the bundler bakes a module's path into
its output: CSS-Module class names hashed from the file path, `new URL('./asset.png', import.meta.url)`,
`__dirname`-derived strings, and — measured below — autotitled story IDs. **No fixture exercises the
path-derived-output class**, so I classify it as a reasoned risk, not a measured failure.

**Case 4 (`move-module`) is not a bar violation.** v1 bails there, because the trace reaches
`.storybook/preview.ts`:

```
{"status":"bailed","storyFiles":[],"bailReason":{"changedStorybookFiles":["packages/ui/.storybook/preview.ts"]}}
```

That is the same bail the README documents for a `theme.ts` edit. v1 recaptures all 9 stories, v2
recaptures 0 — the widest absolute gap in the audit, but permitted by the bar since no per-story
evidence existed on the v1 side.

**Cases 7 and 8 are where path-independence becomes observable end to end.** Renaming a story file
with its bytes intact leaves `storybookHash` bit-identical while `storyFiles` swaps one key for
another holding the *same* hash. With an explicit `title` (case 7) the indexed story IDs are unchanged
(9 before, 9 after), so nothing is lost. With **autotitle** (case 8) the title is derived from the
path, so the probe measured the index actually changing:

```
storybookHash: 5a43177a80bcc5f1 -> 5a43177a80bcc5f1  SAME
story IDs:  < badge-autotitle--auto
            > renamed-autotitle--auto
```

A build whose story set changed reports "Storybook unchanged" at the top-level gate. v1 traces the
moved story file and recaptures it (`{"status":"traced","storyFiles":["…/BadgeRenamed.stories.tsx"]}`).

## What was *not* spuriously moved

Across all 12 cases on both builders:

- `<storybookConfig>`, `<staticFiles>` and `<storybookVersion>` never moved. Every case's edits were
  outside the config dir except case 12, whose `main.ts` and `previewAnnotation.ts` edits are in the
  *setup* (present on both sides of that diff) rather than the measured edit.
- `<storybookGlobals>` moved in exactly one case — case 12, by construction. In particular
  **removing an import does not spill the orphaned module into the bucket**: cases 10 and 11 show it
  either re-homes to `previewSubtree` (still reachable from `preview.ts`) or leaves the graph outright
  (no importer left at all). The bucket count was unchanged at 27 (vite) / 49 (webpack).
- The `previewSubtree` count was 3 in every single measurement.

## The one way into the bucket, and what it costs

Case 12 answers the ticket's "does it fall into `<storybookGlobals>`, and does that then recapture
everything?" — **yes, and yes, but only when a non-story, non-preview importer keeps the edge alive.**
`storybookFiles.ts:77-83` defines the catch-all by *absence* from `storyReachable` and `previewSubtree`,
so a module needs a surviving importer that is itself a bucket resident. The realistic mechanism is
`main.ts` `previewAnnotations`, which the probe uses: a module imported by both a story and a preview
annotation, losing only its story importer, moves into the bucket and its hash change makes every
story recapture. Over-capture, so safe, but worth knowing that in a project leaning on
`previewAnnotations` an ordinary refactor can trip a full recapture.

## Ranked gaps

| Rank | Gap | Severity | Evidence | Notes for the ticket |
|---|---|---|---|---|
| 1 | **A byte-preserving module move recaptures nothing, while a *tracing* v1 recaptures the dependent stories.** | Medium | Case 5, both builders: `storybookHash` SAME, 0 stories, 0 `storybookFiles`; v1 `traced` 2 stories | The only measured case where v2 scopes strictly narrower than a v1 that did **not** bail, so the parity bar's escape clause doesn't cover it. Benign for a plain re-render; unsafe wherever the bundler derives output from a module's path (CSS-Module class names, `new URL(..., import.meta.url)`, autotitle). Deciding this means deciding whether `rollUpHash`'s path-independence should hold for first-party modules or only for dependency trees. **No fixture exercises path-derived output — add one before designing a fix.** |
| 2 | **A story-file rename is invisible to `storybookHash`, including when it changes story IDs.** | Medium | Case 8, both builders: gate hash bit-identical while the index went `badge-autotitle--auto` → `renamed-autotitle--auto` | `manifest.ts:191-197` excludes story paths from the gate *on purpose*. `storyFiles` still carries the new key, so whether this actually loses a capture depends on whether the backend short-circuits on `storybookHash` before drilling into the per-story map — **that ordering needs confirming backend-side before sizing this.** Cheapest fix if it is real: mix story-file keys into the gate via `hashEntryIdentity`, as `storybookFiles` entries already do, and accept churn on project moves. |
| 3 | **A move of a preview-reachable module: v1 bails (9 stories), v2 recaptures 0.** | Low | Case 4, both builders; v1 `bailed` on `changedStorybookFiles: [.storybook/preview.ts]` | Widest absolute gap but *permitted* by the standing bar (v1 was blunt). Subsumed by gap 1 — fixing that fixes this. |
| 4 | **Losing the last story importer of a module that a `previewAnnotations` global still imports recaptures everything.** | Low (safe direction) | Case 12, both builders: `<storybookGlobals>` moved | By design and in the safe direction, but it makes ordinary refactors expensive in projects that use `previewAnnotations`. Only worth a ticket if that pattern shows up in real customer builds. |
| 5 | **The `move-*` verdicts are unverified against actual render output.** | Info | Not measured | The audit's render-identity evidence is the indexed story IDs, not the emitted bundles. A follow-up could diff `storybook-static` output across a byte-preserving move to settle gap 1 empirically. |

## Explicitly not measured

- **rspack (`ui-rsbuild`)** — out of scope on this map; it indexes 0 stories, so every structural
  probe there only moves the bucket and every verdict is vacuous.
- **unpatched vite (`marketing-ui`)** — deliberately not rebuilt; rebuilding destroys the live
  unpatched-builder control permanently. The probe refuses to run on it.
- **Path-derived output** (CSS Modules, `import.meta.url` asset URLs) — no fixture has it, so gap 1's
  worst case is reasoned from the code, not observed.
- **Backend gate ordering** — whether `storybookHash` short-circuits the per-story comparison is not
  observable from the CLI, and gap 2's severity hinges on it.

## Correction to an established fact

The README's static-file section justifies `rollUpHash`'s path-independence as "correct for modules
(identical bytes render identically), wrong for static files (the URL is the identity)". This audit
narrows that: for modules it is correct only when nothing downstream derives meaning from the path.
Two measured or code-evident exceptions exist — **autotitled story IDs** (measured, case 8) and
path-derived bundler output (code-evident, unexercised) — so "correct for modules" should read
"correct for modules whose path does not reach the output".
