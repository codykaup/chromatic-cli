# TurboSnap v2 change-detection test harness

Scripts for verifying what the TurboSnap v2 (hash-based) algorithm catches and misses. They build
per-story hash manifests with `chromatic turbosnap-manifest`, then diff them across source edits to
see which stories *would* be recaptured. Full findings: [`../turbosnap-v2-test-report.md`](../turbosnap-v2-test-report.md).

## What each script does

| Script | Purpose |
|---|---|
| `gen.sh <pkg> <out.json> [stats.json]` | Build a v2 manifest for one fixture package. Pass a stats file to read the graph from a snapshot. |
| `tsdiff.mjs <base.json> <cur.json>` | Diff two manifests → Storybook-hash change + every changed per-story hash. The core "which stories recapture?" assertion. |
| `trace.mjs <manifest.json> <story-substring>` | Print a story's transitive deps, split into first-party vs. node_modules. Use to see *why* a story did/didn't change. |
| `matrix.sh <pkg>` | Run the full edit matrix (leaf / transitive / isolated / story-file / cross-package / preview / main / node_modules) for one builder and print results. |
| `parity.mjs <base.json> <cur.json> <v1.json>` | Compare what v1 would recapture against what v2 would recapture, and print a verdict. |
| `parity.sh <pkg>` | Run the v1-vs-v2 comparison across the edit matrix for one builder. Exits non-zero on a regression. |
| `depfile.mjs <manifest.json> <pkg>` | Pick a file of `<pkg>` from the graph, to stand in for a version bump. |

> ⚠️ `trace.mjs` walks the **written** manifest, whose graph is pruned (`pruneSyntheticFiles` runs
> after hashing). Do not use it to answer "what is in `<storybookGlobals>`?" — removed synthetic nodes
> leave holes, so a reachability walk reports correctly-attributed files as orphans. That mistake
> produced the false "137 of 186 bucket files are moment" figure. Measure behaviourally instead: edit
> one file, regenerate, and diff.

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

## Comparing against TurboSnap v1

`parity.sh` answers the question `tsdiff.mjs` cannot: *is v2 ever worse than v1?* It runs both
algorithms over the same edit and prints the two recapture sets side by side.

```sh
bash parity.sh ui           # vite    — gates
bash parity.sh ui-webpack   # webpack — gates
bash parity.sh ui-rsbuild   # rspack  — informational only
```

The two sides are driven differently, because v1 is not stats-only:

- **v1** — `chromatic trace --json`. A source edit passes the file path; a dependency bump passes
  `-d <package>`, which is the package *name* that `findChangedDependencies` derives from a lockfile
  diff during a real build. Passing the name directly avoids building synthetic git history.
- **v2** — two manifests, before and after the edit.

Two details matter when reading a verdict:

- **v2's recapture set is not just its changed story hashes.** `storybookFiles` is the backend's
  "did Storybook itself change" gate (`manifest.ts`), so if any entry moves — including
  `<storybookGlobals>` — *every* story recaptures.
- **v1 reports module bundles, not story files.** On webpack a concatenated module lists a story file
  together with its imports, so its output is intersected with the manifest's story keys. Story files
  v1 finds that v2 never indexed are reported as `NOT INDEXED BY v2`, since v2 cannot recapture what
  it has no entry for.

Verdicts: `parity`, `v2 wider` (over-captures — safe), `v2 narrower` (v1 was blunt, i.e. it bailed, so
no per-story evidence was lost), and `v2 MISSES a story v1 caught` — the only failing one.

## Expected results (baseline, all reverted cleanly)

- Leaf / transitive / isolated / story-file / cross-package edits → the exact dependent stories, no more.
- `.storybook/preview.ts` → **all stories**. v1 bails (`changedStorybookFiles`); v2 moves its
  `.storybook/preview.ts` entry in `storybookFiles`, which is also recapture-everything.
- `.storybook/main.ts` → **0 stories** (never in the module graph).
- `moment` bump → **Button** on vite and webpack.
- `react` bump → **all stories on webpack**. On **vite**, v1 recaptures **0 stories** and v2
  recaptures **all** via `<storybookGlobals>`: the vite react cluster has no importer edge, so it
  orphans into the bucket. Both algorithms lose the edge — v2's bucket is what keeps it safe.
- **rspack** → v2 indexes **0 stories**, so every rspack verdict is vacuous. v1 does detect them.

If any of these change, the algorithm's behavior has changed — investigate before assuming the
harness is wrong.

## Two traps that have already produced wrong conclusions

1. **The fixture is shared and gets rebuilt.** A concurrent `build-storybook` swaps the module graph
   mid-run and silently changes results. `parity.sh` snapshots the stats file for the whole run and
   prints its sha; compare verdicts only across runs with the same sha.
2. **A dependency's entry file differs per builder.** vite resolves `moment` to
   `moment/dist/moment.js`, webpack and rspack to `moment/moment.js`. Editing a fixed path shows the
   two algorithms *different changes* and reads as a v2 regression. `depfile.mjs` picks the file from
   the builder's own graph instead.
