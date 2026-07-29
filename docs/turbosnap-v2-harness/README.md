# TurboSnap v2 change-detection test harness

Scripts for verifying what the TurboSnap v2 (hash-based) algorithm catches and misses. They build
per-story hash manifests with `chromatic turbosnap-manifest`, then diff them across source edits to
see which stories *would* be recaptured. Full findings: [`../turbosnap-v2-test-report.md`](../turbosnap-v2-test-report.md).

## What each script does

| Script | Purpose |
|---|---|
| `gen.sh <pkg> <out.json> [stats.json]` | Build a v2 manifest for one fixture package. Pass a stats file to read the graph from a snapshot. |
| `tsdiff.mjs <base.json> <cur.json>` | Diff two manifests → Storybook-hash change, every changed per-story hash, **and** every changed `storybookFiles` entry. The core "which stories recapture?" assertion. |
| `bucket.mjs <manifest.json> [path-substring]` | List `<storybookGlobals>` membership, or report which set a given file was attributed to. See [Seeing what's in the bucket](#seeing-whats-in-the-bucket). |
| `trace.mjs <manifest.json> <story-substring>` | Print a story's transitive deps, split into first-party vs. node_modules. Use to see *why* a story did/didn't change. Walks the **pruned** graph — use `bucket.mjs`, never this, to ask what is in the bucket. |
| `matrix.sh <pkg>` | Run the full edit matrix (leaf / transitive / isolated / story-file / cross-package / preview / main / node_modules) for one builder and print results. |
| `parity.mjs <base.json> <cur.json> <v1.json>` | Compare what v1 would recapture against what v2 would recapture, and print a verdict. |
| `parity.sh <pkg>` | Run the v1-vs-v2 comparison across the edit matrix for one builder. Exits non-zero on a regression. |
| `depfile.mjs <manifest.json> <pkg>` | Pick a file of `<pkg>` from the graph, to stand in for a version bump. |
| `cjs-edge-probe.sh [pkg]` | Vite-only structural probe: temporarily imports a CJS-only dependency from one story, rebuilds patched-builder stats, and verifies a dependency edit recaptures only that story. |

## Prerequisites

1. **Build the CLI** — the scripts run the compiled `dist/bin.cjs`, so rebuild after any code change:
   ```sh
   cd ~/Projects/chromatic-cli && yarn build
   ```
2. **Fixture repo** — `~/Projects/turbosnap-monorepo`, with prebuilt `storybook-static/preview-stats.json`
   for the packages you test (`ui`, `ui-webpack`, `ui-rsbuild` ship with one). If a stats file is
   missing or stale, rebuild it: `cd ~/Projects/turbosnap-monorepo && yarn build-storybook:all`.

### Path overrides (env vars)

Defaults assume `~/Projects/chromatic-cli` and `~/Projects/turbosnap-monorepo`. Override if needed:

```sh
export CHROMATIC_CLI=/path/to/chromatic-cli/dist/bin.cjs
export MONOREPO=/path/to/turbosnap-monorepo
```

## Quick start

```sh
cd ~/Projects/chromatic-cli/docs/turbosnap-v2-harness

# Full matrix for each builder (vite / webpack / rsbuild):
bash matrix.sh ui
bash matrix.sh ui-webpack
bash matrix.sh ui-rsbuild
```

## The fixture graph (what to expect)

```
Badge.stories.tsx    → Badge.tsx                                  (leaf)
Button.stories.tsx   → Button.tsx   → @myorg/shared (capitalize), moment
UserCard.stories.tsx → UserCard.tsx → Badge.tsx, @myorg/shared (formatDate)
```

`@myorg/shared` = `packages/shared/src/index.ts`, a barrel re-exporting every util (so editing it
recaptures every story that imports *anything* from it — Button **and** UserCard).

Builders: `ui` = `@storybook/react-vite`, `ui-webpack` = `react-webpack5`, `ui-rsbuild` =
`storybook-react-rsbuild`. `marketing-ui` is also Vite.

## How the matrix works (and why edits are safe)

Each test appends a **comment** to a file (content-only — no new imports), regenerates the manifest
from the **unchanged** `preview-stats.json`, and diffs. This isolates *hash propagation through the
existing graph* from the story-detection logic. Edits are reverted immediately: `git checkout` for
tracked source files, backup/restore for `node_modules` (which git ignores). `matrix.sh` writes all
temp manifests to a `mktemp -d` dir that's cleaned up on exit.

> If you want to test **structural** changes (a *new* import, a new story file, a moved file), a
> content-only edit is not enough — you must rebuild the Storybook so `preview-stats.json` reflects
> the new graph, then regenerate the manifest.

## Doing a one-off manual test

```sh
cd ~/Projects/chromatic-cli/docs/turbosnap-v2-harness

bash gen.sh ui /tmp/base.json                       # baseline
echo '// tweak' >> ~/Projects/turbosnap-monorepo/packages/ui/src/lib/Badge/Badge.tsx
bash gen.sh ui /tmp/cur.json                         # after edit
node tsdiff.mjs /tmp/base.json /tmp/cur.json         # -> Badge + UserCard changed
git -C ~/Projects/turbosnap-monorepo checkout -- packages/ui/src/lib/Badge/Badge.tsx

node trace.mjs /tmp/base.json UserCard              # inspect why (transitive deps)
```

## Seeing what's in the bucket

Every real file in the graph is hashed in exactly one of three places, and the manifest's
`attribution` section records which — emitted by the same pass that computes the hashes:

| Set | Hashed into |
|---|---|
| `storyReachable` | the `storyFiles` entry of each story whose subtree contains it |
| `previewSubtree` | the `storybookFiles` entry keyed by a `.storybook/preview.*` path |
| `storybookGlobals` | the single `<storybookGlobals>` catch-all entry |

```sh
node bucket.mjs /tmp/base.json                  # counts + full <storybookGlobals> member list
node bucket.mjs /tmp/base.json moment           # which set(s) matching files landed in
jq -r '.attribution.storybookGlobals[]' /tmp/base.json
```

> **Never reconstruct these sets by walking `files` from the stories.** `pruneSyntheticFiles` runs
> *after* hashing by design, so the written graph has holes where synthetic nodes (require-context
> globs, externals, virtual modules) were removed. A reachability walk hits those holes and reports
> correctly-attributed files as orphans. That artifact produced the false "137 of 186
> `<storybookGlobals>` files are `moment`" reading — `moment` is in fact story-attributed on both
> vite and webpack. Read `attribution`, or diff behaviourally with `tsdiff.mjs`.

## Comparing against TurboSnap v1

`parity.sh` answers the question `tsdiff.mjs` cannot: *is v2 ever worse than v1?* It runs both
algorithms over the same edit and prints the two recapture sets side by side.

```sh
bash parity.sh ui           # vite    — gates
bash parity.sh ui-webpack   # webpack — gates
bash parity.sh ui-rsbuild   # rspack  — informational only
```

The production `--only-changed` path has an additional compatibility gate: Vite stats produced by
`@storybook/builder-vite` versions before `10.6.0-alpha.4` fall back to TurboSnap v1 instead of
uploading v2 hashes. That is a temporary builder-stats trust gate, not a correctness fix for the
invisible CJS-dependency blind spot — v1 can miss that case too. The `turbosnap-manifest` harness
command intentionally bypasses this gate so local patched-builder stats can still be measured.

To measure the blind spot after applying the parked `builder-vite` patch locally:

```sh
bash cjs-edge-probe.sh ui
```

The probe creates a temporary CJS-only package under the fixture's `node_modules`, imports it from
`Button.stories.tsx`, rebuilds Vite stats, asserts the package ships in `modules[]`, then edits that
dependency and verifies only the Button story file hash changes. It restores the fixture source and
temporary package with a trap, rebuilds the normal patched stats, and prints the patched
`<storybookGlobals>` bucket listing for the follow-on classification ticket.

The two sides are driven differently, because v1 is not stats-only:

- **v1** — `chromatic trace --json`. A source edit passes the file path; a dependency bump passes
  `-d <package>`, which is the package *name* that `findChangedDependencies` derives from a lockfile
  diff during a real build. Passing the name directly avoids building synthetic git history.
- **v2** — two manifests, before and after the edit.

Two details matter when reading a verdict:

- **v2's recapture set is not just its changed story hashes.** `storybookFiles` is the backend's
  "did Storybook itself change" gate, so if any entry moves — including `<storybookGlobals>` —
  *every* story recaptures. Same rule as the note on *Expected results* below.
- **v1 reports module bundles, not story files.** On webpack a concatenated module lists a story file
  together with its imports, so its output is intersected with the manifest's story keys. Story files
  v1 finds that v2 never indexed are reported as `NOT INDEXED BY v2`, since v2 cannot recapture what
  it has no entry for.

Verdicts: `parity`, `v2 wider` (over-captures — safe), `v2 narrower` (v1 was blunt, i.e. it bailed, so
no per-story evidence was lost), and `v2 MISSES a story v1 caught` — the only failing one.

Measured 2026-07-29: **0 regressions on vite and webpack.** Where the two differ:

- **`react` on vite** — v1 recaptures **0 stories**; v2 recaptures all 3 via `<storybookGlobals>`.
  Neither reaches `react/index.js` from a story, because esbuild elides the type-only
  `import React from 'react'` (see *Why `react/index.js` is bucketed on vite but not on webpack*);
  v2's bucket is what keeps it safe. So **parity cannot justify the vite edge-loss fix — v1 fails
  this case too** — and the bucket must not shrink before the edges are restored.
- **rspack** — v2 indexes **0 stories** while v1 detects all 3, so every rspack verdict is vacuous
  until story detection is fixed. Reported, never gated.
- **A dependency absent from a builder's graph** — `parity.sh` skips it, stating that v2 cannot see
  the bump. v1 traces it to 0 stories too, so it is a shared blind spot, not parity.

## Expected results (baseline, all reverted cleanly)

Re-measured 2026-07-29. A `storybookFiles` entry moving means **recapture everything**, so read the
story count and the `storybookFiles` line together — "0 stories changed" is not "nothing recaptures".

- Leaf / transitive / isolated / story-file / cross-package edits → the exact dependent stories, no more.
- `.storybook/preview.ts` → **0 stories**, but its keyed `storybookFiles` entry changes ⇒ recapture everything.
- `.storybook/main.ts` → **0 stories**, no entry moves (never in the module graph).
- `moment` → **Button only** on vite (`moment/dist/moment.js`) and webpack (`moment/moment.js`, and
  each `moment/locale/*.js`); the bucket does **not** move. On **rsbuild** 0 stories are detected at
  all, so `moment` is in the bucket and any edit recaptures everything.
- `react/index.js` → **`storyReachable` on webpack**; **`<storybookGlobals>` on vite** (bucket moves
  ⇒ recapture everything). **This asymmetry is not edge loss** — see below.
- `react/jsx-runtime.js` → **`storyReachable` on both**; an edit recaptures all 3 stories.

### Why `react/index.js` is bucketed on vite but not on webpack

The two builders transpile the same source differently, so their stats truthfully describe two
different graphs. Every fixture component writes `import React from 'react'` but uses `React` only
in a **type** position (`React.CSSProperties`):

- **esbuild (vite)** elides the import entirely — the emitted module imports only
  `react/jsx-runtime`, `@myorg/shared` and `moment`. There is no `Button.tsx → react/index.js` edge
  to lose.
- **babel (webpack)** preserves `import React from 'react'` alongside the injected
  `react/jsx-runtime` import, so the edge is real there.

So the missing edge is **not** a further instance of the `?commonjs-es-import` unwrap gap, and the
`builder-vite` fork commit is not incomplete on this point. Both outcomes are safe: on vite a `react`
bump moves `<storybookGlobals>` (recapture everything) *and* changes `react/jsx-runtime.js`, which is
story-attributed, so all 3 stories recapture regardless.

Bucket sizes at that measurement: vite **27 of 39** files, webpack 49 of 284, rsbuild 201 of 202.

If any of these change, the algorithm's behavior has changed — investigate before assuming the
harness is wrong.

> The fixture repo may be edited by concurrent sessions. If a baseline you took earlier disagrees
> with a fresh one, regenerate the baseline immediately before the probe rather than reusing it.

## Two traps that have already produced wrong conclusions

1. **The fixture is shared and gets rebuilt mid-run.** A concurrent `build-storybook` swaps the module
   graph underneath a running probe and silently changes results — `preview-stats.json` changed three
   times during one session of parallel work, flipping two verdicts. `parity.sh` snapshots the stats
   file for the whole run and prints its sha; compare verdicts only across runs with the same sha.
2. **A dependency's entry file differs per builder.** vite resolves `moment` to
   `moment/dist/moment.js`, webpack and rspack to `moment/moment.js`. A fixed path shows v1 (which
   works from the package *name*) and v2 (which works from the *file*) **two different changes**, and
   reads as a false "v2 MISSES". `depfile.mjs` picks the file from the builder's own graph, and
   `parity.sh` prints which file it edited.
