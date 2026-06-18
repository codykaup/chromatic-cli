# TurboSnap source-graph strategy benchmark

Throwaway research harness exploring **builder-independent** ways to derive the "which source files
are linked" graph TurboSnap needs, as a step toward source-file **hashing** for baseline comparison.

It compares several strategies for reconstructing the dependency graph against the **ground truth**:
the real `getDependentStoryFiles` run on the builder-emitted `preview-stats.json`.

## TL;DR

See [`results/report.md`](./results/report.md) for the full tables. Headline:

- The fidelity gap between static analysis and the builder is **type-only import elision**, not
  parsing or resolution. The builder drops imports used only in type positions (even without the
  `type` keyword); syntactic parsers keep them and over-connect badly (~11% precision).
- **es-module-lexer + esbuild type-strip + oxc-resolver** matched the builder exactly here
  (100% precision/recall) because it inherits esbuild's usage-based import elision — and it's the
  lowest-memory option.
- Parser/resolver choice (oxc vs TypeScript vs vite vs madge) is a speed/packaging decision, not a
  fidelity one.
- Hashing the whole source tree costs single-digit milliseconds, so an incrementally-cached graph
  keyed on file hashes is cheap.

## Layout

- `lib/common.mts` — repo-path helpers, reverse-graph + trace, forward crawl, fidelity scoring, timing.
- `lib/groundtruth.mts` — runs the real `getDependentStoryFiles` per scenario → `results/groundtruth.json`.
- `approaches/` — one module per strategy (`oxc`, `eslexer`, `typescript`, `vite`, `madge`), each
  exposing a `parse` + `resolve` (or a `run`).
- `bench.mts` — runs one approach in one mode (`whole` | `scoped` | `ceiling`), prints a JSON result.
- `report.mts` — orchestrator: runs every approach × mode in isolated processes, plus the hashing
  micro-benchmark, folds in the scenario results, and writes `results/results.json` + `results/report.md`.
- `scenarios.mts` — reproduces PR #3's 11-scenario end-to-end matrix using our builder-independent
  graph + our own content hashes (raw vs esbuild-stripped), for every approach → `results/scenarios.json`.
- `build-gt.mjs` — esbuild bundling for the ground-truth entry (stubs `findChangedDependencies` to
  keep the snyk/execa subtree out of the bundle).

## Reproduce

```bash
# from repo root, with deps installed and Storybook built with stats:
yarn install
yarn build-storybook                       # emits storybook-static/preview-stats.json
cd experiments/turbosnap-hashing && npm install && cd -

# ground truth (bundled to dodge an ESM/CJS interop issue in the dep tree):
node experiments/turbosnap-hashing/build-gt.mjs
node experiments/turbosnap-hashing/.gt-bundle.mjs

# full benchmark + report:
experiments/turbosnap-hashing/node_modules/.bin/tsx experiments/turbosnap-hashing/report.mts
```

## Caveats

- Single target (this repo's own ~381-module Vite/HTML Storybook). Numbers are directional; validate
  on a larger React/Vite app before committing to a path.
- `ceiling` mode uses the builder's module set to isolate parse/resolve fidelity — it is **not** a
  builder-independent approach, just a measurement aid.
