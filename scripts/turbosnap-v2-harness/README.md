# TurboSnap v2 hash-manifest test harness

A local-only harness for exercising the TurboSnap **v2** manifest algorithm
(`node-src/lib/turbosnap/v2`) against real, built Storybooks and verifying that
per-story file hashes change exactly when — and only when — the files that a story
depends on change.

It talks to **no backend**: `traceChangedFiles` (v2) has the `uploadBuildHashes`
GraphQL mutation to the Index skipped for local testing, so we only generate and
inspect `turbosnap-manifest.json`.

## What it does

For every Storybook project in the sibling `turbosnap-monorepo` it:

1. Builds the Storybook with `--stats-json` (emits `storybook-static/preview-stats.json`).
2. Runs the v2 manifest algorithm on the stats → `turbosnap-manifest.json` (baseline).
3. Applies a source change (story / component / shared lib), rebuilds, regenerates.
4. Diffs the baseline manifest against the new one: which `storyFiles` hashes changed,
   and whether the top-level `storybookHash` changed.
5. Marks each scenario PASS/FAIL against a declared expectation.

## Files

- `generateManifest.ts` — thin entrypoint that calls the real v2 `traceChangedFiles`
  with a stats file, a project root, and an output dir. Bundle it with esbuild:

  ```sh
  # from the chromatic-cli repo root
  node_modules/.bin/esbuild scripts/turbosnap-v2-harness/generateManifest.ts \
    --bundle --platform=node --format=cjs --packages=external \
    --outfile=scripts/turbosnap-v2-harness/generateManifest.cjs
  ```

  Standalone use:

  ```sh
  node scripts/turbosnap-v2-harness/generateManifest.cjs \
    --stats  <path>/storybook-static/preview-stats.json \
    --project-root <path-to-storybook-project> \
    --out    <output-dir>
  ```

- `run.mjs` — the orchestrator (build → generate → edit → rebuild → diff) across all
  projects and scenarios. Writes `results/summary.json` and per-scenario manifests.

  ```sh
  node scripts/turbosnap-v2-harness/run.mjs               # all projects
  node scripts/turbosnap-v2-harness/run.mjs --projects ui # subset
  ```

- `REPORT.md` — findings, the pass/fail matrix, and recommended fixes.

## Assumptions

- `turbosnap-monorepo` is checked out at `/home/user/turbosnap-monorepo` and its deps
  are installed. Adjust `MONOREPO` in `run.mjs` if it lives elsewhere.
- The project root passed to the algorithm is the Storybook project directory
  (e.g. `packages/ui`), matching `path.resolve(git.rootPath, storybook.baseDir)` in
  the real CLI.
