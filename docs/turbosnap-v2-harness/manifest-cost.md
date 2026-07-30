# What the TurboSnap v2 manifest costs

Measured 2026-07-30. Scripts: [`cost-phases.mjs`](./cost-phases.mjs), [`cost-scale.mjs`](./cost-scale.mjs),
[`cost-profile.mjs`](./cost-profile.mjs), [`cost-e2e.sh`](./cost-e2e.sh), shared plumbing in
[`cost-lib.mjs`](./cost-lib.mjs).

## Verdict: acceptable as-is

On the two real Storybooks measured, building the manifest costs **17 ms** (400-module Storybook) and
**99 ms** (1962-module Storybook) of CPU, on top of a `dist/bin.cjs` process that takes ~260 ms just to
start. Peak RSS is **127 MB** and **143 MB**, against a 112 MB floor for the CLI doing nothing. Against
TurboSnap v1 on the same repo and the same stats file, v2 costs **+80 ms wall and +22 MB RSS** — i.e.
both algorithms disappear into process startup, and v2's extra work is under a tenth of a second on a
build that takes minutes.

Nothing degrades non-linearly. The three suspected cases were probed and all three are linear or flat:
a 512 MiB single file hashes at 3.0 GiB/s with **+192 KiB** of RSS, 50 000 byte-identical files are
linear at ~29 µs/file, and a 50 000-file `staticDir` costs 1.2 s. Deliberately hashing a 52 486-file /
578 MB directory as a `staticDir` end-to-end through the real binary took **1.84 s and 340 MB RSS** —
that is the pathological case for the uncapped design, and it is still not a problem.

Two things are worth recording as **non-blocking follow-ups**, not fixes for this ticket:

1. **Redundant path normalization is the single biggest cost cluster — bigger than the hashing.**
   `node:path` `resolve`/`normalizeString`/`relative` plus `posix`, `resolveStatsPath` and
   `normalizeStatsPath` account for **~30 % of `buildManifest` self time at both sizes**. The same stats
   path is normalized three or four times (once in `hashFiles`, once in `collectStoryImporters`, once
   per module and once per `reason` in the main loop). A memo keyed on the raw stats string would cut
   roughly a quarter of the total, and would be a pure win with no behaviour change. See
   [Where the time goes](#where-the-time-goes).
2. **The roll-up work is linear in `stories × subtree size`, so it is quadratic in project size.**
   `rollUpHash` + `collectTransitiveDependencies` are ~22 % of self time on the 1962-module Storybook
   and below the top-20 cut on the 400-module one. Synthetically it is 0.25 µs per subtree visit, dead linear out to
   2 000 000 visits (491 ms). A Storybook with 4 000 stories over a 2 000-module shared base would land
   around 1.5 s. That is the shape to watch, not a present problem. See
   [Scaling shape](#scaling-shape).

Neither changes the rollout answer. The risk this ticket was opened for is closed.

## Method

| | |
|---|---|
| Machine | Apple M1 Pro, 10 cores, 32 GiB, macOS 26.3 |
| Node | v22.22.3 |
| chromatic-cli | `0cfc869f` (branch `cody/turbosnap-v2`), **`yarn build` run before every measurement** |
| Cache state | warm unless a row says cold; see [Cold vs. warm](#cold-vs-warm-page-cache) |

Two measurement paths, deliberately:

- **End-to-end** (`cost-e2e.sh`) runs the real compiled `dist/bin.cjs turbosnap-manifest` under
  `/usr/bin/time -l`, N times. This is the only source of trustworthy *absolute* peak RSS and the only
  thing that measures the algorithm that actually ships.
- **Phase breakdown** (`cost-phases.mjs`, `cost-profile.mjs`, `cost-scale.mjs`) loads the TypeScript
  source through a Vite SSR server, because `dist/bin.cjs` is bundled and minified so its internals
  aren't addressable and its function names are gone. Its absolute memory figures are meaningless (the
  Vite server alone is ~105 MB), so it reports RSS *growth*. Its `buildManifest` total is 17 ms /
  99 ms against an end-to-end delta over the CLI's own floor of ~20 ms / ~90 ms, so the two paths agree
  and the source-vs-bundle substitution is sound.

Every number below is a median of 5–10 runs with the spread reported. Phase medians are taken
independently, so the derived rows (`staticHashDerived`, `assemblyDerived`) are only meaningful with
enough samples — `--runs 10` was used.

### The two repos

| | chromatic-cli | Storybook monorepo |
|---|---|---|
| Repo | `~/Projects/chromatic-cli` | `~/Projects/storybook-codykaup` |
| Commit | `0cfc869f` | `49cd7635df7` |
| Storybook project | repo root | `code/` (the `storybook:ui` Storybook) |
| Builder | `@storybook/react-vite` 10.3.5, **stock** `builder-vite` | `@storybook/react-vite`, **patched** `builder-vite` (`49cd7635df7`, "Include react/jsx-runtime") |
| Stats built by | `yarn build-storybook` (`--stats-json`) | `core/dist/bin/dispatcher.js build --config-dir ./.storybook --webpack-stats-json`, output written **outside** the repo |
| `preview-stats.json` | 160 KiB, 400 modules, 978 reasons | 873 KiB, 1962 modules, 5366 reasons |
| Graph files hashed | 400 (4.85 MiB, largest 1.41 MiB, 155 in `node_modules`) | 1957 (20 MiB, largest 1.50 MiB, 921 in `node_modules`) |
| Config files hashed | 4 (6.58 KiB) | 11 (33 KiB) |
| Static files hashed | 1 (739 B) | 3 (69 KiB) |
| Manifest | 400 files, 117 stories, 5 `storybookFiles` entries | 1957 files, 306 stories, 5 `storybookFiles` entries |

The Storybook monorepo was treated as read-only: nothing was written inside it, the Storybook build
output and stats went to a scratch directory, and `turbosnap-manifest` only writes to stdout.

Reproduce:

```sh
cd ~/Projects/chromatic-cli && yarn build
cd docs/turbosnap-v2-harness

# chromatic-cli
node cost-phases.mjs --project ~/Projects/chromatic-cli \
  --stats ~/Projects/chromatic-cli/storybook-static/preview-stats.json \
  --static-dir static --runs 10 --concurrency-sweep
bash cost-e2e.sh ~/Projects/chromatic-cli 6 -- turbosnap-manifest -b .

# Storybook monorepo (stats file built to $SB, outside the repo)
node cost-phases.mjs --project ~/Projects/storybook-codykaup/code \
  --git-root ~/Projects/storybook-codykaup --stats $SB/preview-stats.json \
  --static-dir .storybook/bench/bundle-analyzer --runs 10 --concurrency-sweep
bash cost-e2e.sh ~/Projects/storybook-codykaup 6 -- turbosnap-manifest -b code -s $SB/preview-stats.json
```

## 1. Wall clock, broken down by phase

`cost-phases.mjs`, 10 runs each, warm cache. All values in ms.

**chromatic-cli** — 400 graph files, 117 stories:

| Phase | min | median | max | spread | RSS growth |
|---|---|---|---|---|---|
| read the stats file | 1.0 | **1.1** | 10.9 | 884 % | +112 KiB |
| discover graph files (`existsSync` + normalize) | 1.1 | **1.3** | 1.6 | 42 % | 0 |
| hash graph files | 6.3 | **7.6** | 42.0 | 471 % | +9.47 MiB |
| hash the config dir | 0.4 | **0.5** | 2.1 | 352 % | 0 |
| hash config + static dirs | 0.5 | **0.6** | 0.8 | 55 % | 0 |
| *static dirs alone* (derived) | | **0.1** | | | |
| **`buildManifest` total** | 14.1 | **16.7** | 17.9 | 23 % | +6.89 MiB |
| *graph assembly + roll-ups* (derived) | | **7.3** | | | |

**Storybook monorepo** — 1957 graph files, 306 stories:

| Phase | min | median | max | spread | RSS growth |
|---|---|---|---|---|---|
| read the stats file | 4.3 | **4.7** | 34.0 | 629 % | +4.02 MiB |
| discover graph files | 5.6 | **6.1** | 13.3 | 124 % | 0 |
| hash graph files | 32.0 | **35.2** | 174.6 | 406 % | +25 MiB |
| hash the config dir | 0.8 | **1.0** | 2.5 | 169 % | 0 |
| hash config + static dirs | 0.8 | **1.1** | 2.0 | 122 % | 0 |
| *static dirs alone* (derived) | | **0.1** | | | |
| **`buildManifest` total** | 93.8 | **99.2** | 151.5 | 58 % | +16 MiB |
| *graph assembly + roll-ups* (derived) | | **56.9** | | | |

Reading these:

- **Reading the stats file is free** relative to everything else — 4.7 ms for 873 KiB, because
  `parseChunked` streams it. It is *not* part of `buildManifest`; the caller reads it.
- **Hashing the graph is a third of the cost, not most of it.** 35 ms for 1957 files / 20 MiB is
  ~18 µs per file, and that is per-file syscall overhead, not bandwidth (the same machine hashes a
  single large file at 3.0 GiB/s).
- **The out-of-graph sections are noise on both repos** — 1 ms combined. That is because neither repo has
  a meaningful `staticDir`. The uncapped static walk is exercised synthetically in
  [Scaling shape](#scaling-shape) and end-to-end in [Pathological cases](#5-pathological-cases) instead.
- **Graph assembly and roll-ups are the *largest* phase on the bigger repo** — 57 of 99 ms. The high
  `max` values on the individual phases are first-run JIT and GC; note that `buildManifest`'s own spread
  is the *tightest* of any row (9–58 %), because it is the longest.

The end-to-end picture, `cost-e2e.sh`, real `dist/bin.cjs`:

| Command | median wall | peak RSS |
|---|---|---|
| chromatic-cli, `trace --json` with no changed files (CLI floor + stats read) | 0.27 s | 112 MB |
| chromatic-cli, `turbosnap-manifest -b .` | **0.29 s** | **127 MB** |
| Storybook monorepo, `trace --json` with no changed files | 0.25 s | 120 MB |
| Storybook monorepo, `turbosnap-manifest -b code` | **0.34 s** | **143 MB** |

## 2. Peak memory, and the read-buffer question

Absolute peak RSS from `/usr/bin/time -l` on the shipped binary: **127 MB** on chromatic-cli and
**143 MB** on the Storybook monorepo, against a **112 MB floor** for `dist/bin.cjs` doing nothing at all.
So the manifest itself costs 15–23 MB on real Storybooks. The written manifest is 106 KB and 605 KB
respectively, and holding the whole thing in memory as Maps and Sets before serializing is what that
23 MB is.

**Concurrency × buffer size is not the driver.** `getFileHashes` allocates a 64 KiB
`Buffer.allocUnsafe` inside the `pLimit` callback, so at concurrency *c* at most *c* × 64 KiB is live.
At the shipped `c = 10` that is 640 KiB — three orders of magnitude below the measured cost. Sweeping
concurrency over 20 000 files, each level in a **fresh child process** (RSS is a high-water mark, so
in-process levels contaminate each other):

| concurrency | hash ms | child peak RSS | over harness baseline | *c* × 64 KiB |
|---|---|---|---|---|
| 0 (baseline, no files) | 1.5 | 105 MiB | — | 0 |
| 1 | 1225 | 169 MiB | +65 MiB | 64 KiB |
| 5 | 623 | 171 MiB | +66 MiB | 320 KiB |
| **10 (shipped)** | **429** | **178 MiB** | **+73 MiB** | **640 KiB** |
| 25 | 621 | 176 MiB | +72 MiB | 1.56 MiB |
| 50 | 366 | 177 MiB | +73 MiB | 3.13 MiB |
| 100 | 364 | 174 MiB | +70 MiB | 6.25 MiB |
| 250 | 532 | 182 MiB | +78 MiB | 16 MiB |
| 1000 | 732 | 247 MiB | +142 MiB | 63 MiB |

The +65…+78 MiB is flat from *c* = 1 to *c* = 250 — it is the 20 000 path strings and the result object,
not the buffers. Only at *c* = 1000 does the buffer allocation show up, and the +64 MiB jump from the
250 row matches the 63 MiB of live buffers almost exactly. **The decision to allocate inside the
callback is doing its job**: at the shipped concurrency the buffers are invisible, and the failure mode
the comment warns about (allocating up front, so a large static directory reserves gigabytes before the
first read) would be real — 52 486 static files × 64 KiB is 3.2 GiB.

The same sweep for *time* over the real graphs (`cost-phases.mjs --concurrency-sweep`, in-process, which
is more stable for timing):

| concurrency | chromatic-cli, 400 files | Storybook monorepo, 1957 files |
|---|---|---|
| 1 | 19.7 ms | 109.3 ms |
| 5 | 9.3 ms | 49.1 ms |
| **10 (shipped)** | **6.2 ms** | **34.7 ms** |
| 25 | 5.2 ms | 35.2 ms |
| 50 | 5.4 ms | 28.4 ms |
| 100 | 6.5 ms | 27.9 ms |
| 250 | 6.3 ms | 30.1 ms |
| 1000 | 7.0 ms | 39.4 ms |

10 is 15–25 % off the optimum (25–100), worth single-digit ms. Not worth touching, and see
[Cold vs. warm](#cold-vs-warm-page-cache) — raising it does **not** help on a cold cache.

## 3. Scaling shape

Real Storybooks only give two points, and they move both axes at once. `cost-scale.mjs` builds synthetic
projects — real files on disk plus a real `preview-stats.json` — and runs the same `buildManifest`, so one
axis moves at a time. Graph shape: each story imports one hub module and the hub imports every shared
module, so a story's subtree is `modules + 2` files. That is how a real Storybook looks: every story
reaches the same framework and renderer base.

**Story count swept, 500 shared modules:**

| stories | modules | graph files | subtree visits | median ms |
|---|---|---|---|---|
| 100 | 500 | 601 | 50 200 | 41.6 |
| 500 | 500 | 1001 | 251 000 | 95.1 |
| 1000 | 500 | 1501 | 502 000 | 164.7 |
| 2000 | 500 | 2501 | 1 004 000 | 346.6 |
| 4000 | 500 | 4501 | 2 008 000 | 529.0 |

**Shared-module count swept, 500 stories:**

| stories | modules | graph files | subtree visits | median ms |
|---|---|---|---|---|
| 500 | 100 | 601 | 51 000 | 30.7 |
| 500 | 500 | 1001 | 251 000 | 89.7 |
| 500 | 1000 | 1501 | 501 000 | 234.0 |
| 500 | 2000 | 2501 | 1 001 000 | 367.1 |

Both tables collapse onto the same line: **cost tracks `stories × subtree size` at ~0.25 µs per subtree
visit**, and it is linear in that product out to 2 000 000 visits. 601 graph files cost 41.6 ms in one
table and 30.7 ms in the other — the file count is not the variable; the visit count is.

The practical consequence: **because a real Storybook grows both axes together, this term is quadratic in
project size.** Doubling a project doubles the stories *and* the shared base, so it roughly quadruples
this phase. Extrapolating the fit, 4 000 stories over a 2 000-module base is ~2 000 000 visits ≈ 1.5 s.
The Storybook monorepo's 306 stories over its own base is nowhere near that.

**`staticDir` walk + hash, uncapped by design:**

| static files | median ms | max ms | RSS growth | µs/file |
|---|---|---|---|---|
| 100 | 2.9 | 3.2 | 0 | 29.4 |
| 1 000 | 28.1 | 32.6 | +32 KiB | 28.1 |
| 10 000 | 293.5 | 316.5 | +16 MiB | 29.3 |
| 50 000 | 1286.9 | 1512.9 | +99 MiB | 25.7 |

Flat at ~28 µs/file — linear, no cliff. Memory is ~2 KB per file, which is the absolute path string held
in the paths array, the result `Map` and the sorted array.

## 4. Comparison against TurboSnap v1

Same repo, same commit, same `preview-stats.json`, same compiled `dist/bin.cjs`, same
`/usr/bin/time -l` harness. v1 is driven through `chromatic trace --json`, which is what `parity.sh`
uses; v2 through `chromatic turbosnap-manifest`. v1's cost depends on how many files changed, so it is
measured at 1 changed file and at *every first-party graph file* changed — v1's worst case.

**chromatic-cli** (`0cfc869f`, 400 modules):

| | median wall | peak RSS |
|---|---|---|
| CLI floor (`trace --json`, no changed files) | 0.27 s | 112 MB |
| **v1**, 245 changed first-party files | 0.28 s | 113 MB |
| **v2**, whole manifest | **0.29 s** | **127 MB** |
| **v2 − v1** | **+0.01 s** | **+14 MB** |

**Storybook monorepo** (`49cd7635df7`, 1962 modules):

| | median wall | peak RSS |
|---|---|---|
| CLI floor (`trace --json`, no changed files) | 0.25 s | 120 MB |
| **v1**, 1 changed file | 0.26 s | 120 MB |
| **v1**, 1036 changed first-party files | 0.27 s | 122 MB |
| **v2**, whole manifest | **0.34 s** | **143 MB** |
| **v2 − v1** | **+0.07 s** | **+21 MB** |

v1 is essentially free: even with 1036 changed files it is 20 ms over the floor, because it walks the
graph and hashes nothing. v2 is 90 ms over the floor because it hashes 1957 files and rolls up 306 story
subtrees. **In absolute terms the difference is 70–80 ms and ~20 MB**, on a CLI invocation that spends
260 ms starting up and a build that spends minutes bundling and uploading.

One piece of context that makes this cheaper than it looks: **every Chromatic build already runs
`getFileHashes` over the entire Storybook output directory** (`tasks/prepare/calculateFileHashes.ts`, at
`CHROMATIC_HASH_CONCURRENCY`) to deduplicate the upload. v2's graph hashing is the same machinery
against a comparable number of files, so the build already pays this class of cost once and v2 makes it
twice, not once-from-zero.

## 5. Pathological cases

Each of the three suspected non-linear cases was probed directly.

**A very large individual file.** `hashFile` reads in 64 KiB chunks and hashes incrementally, so this
should be linear in bytes with flat memory. It is: **512 MiB in 171 ms (3.0 GiB/s), RSS growth
+192 KiB.** No cliff and no proportional memory — the incremental path is doing what it claims.

**A very wide `staticDir`.** Synthetically linear to 50 000 files at ~28 µs/file (table above). Also
measured end-to-end through the real binary, by pointing `--static-dir` at chromatic-cli's own
`node_modules` — 52 486 files, 578 MB, the worst case the uncapped design permits:

```sh
bash cost-e2e.sh ~/Projects/chromatic-cli 4 -- turbosnap-manifest -b . --static-dir node_modules
```

| run | wall | peak RSS | manifest bytes |
|---|---|---|---|
| 1 (first touch) | 2.96 s | 339 MB | 4 511 069 |
| 2 | 1.84 s | 341 MB | 4 511 069 |
| 3 | 1.95 s | 334 MB | 4 511 069 |
| 4 | 1.84 s | 339 MB | 4 511 069 |

**1.84 s and 340 MB** for a 52 486-file static directory. That is 6× the wall clock and 2.7× the peak RSS
of the same repo's normal run, for a `staticDir` no real project has. It is a cost, not a cliff, and the
count cap that was rejected would have bought ~1.5 s at the price of a silent coverage gap. The trade
holds.

**Deep `node_modules` duplication.** Nothing dedupes by content, so many byte-identical files are hashed
independently, and their identical hashes all sort together in `rollUpHash`. Neither degrades:

| byte-identical files | ms | RSS growth | µs/file |
|---|---|---|---|
| 1 000 | 15.8 | +16 KiB | 15.8 |
| 10 000 | 175.3 | 0 | 17.5 |
| 50 000 | 1449.2 | +34 MiB | 29.0 |

Linear, and the same ~µs/file as distinct files. Note this is by design: TurboSnap 2.0 hashes
`node_modules` on purpose so a dependency upgrade moves story hashes.

## Cold vs. warm page cache

`purge` needs root on this machine, so the whole-repo runs above could not be taken cold. Instead, an
APFS sparse disk image was created, populated, and **detached and reattached** between samples, which
genuinely empties the cache for that volume. `getFileHashes` was then run against it in a fresh process:

| file set | cold | warm | cold/warm |
|---|---|---|---|
| 2 000 files × 10 KiB (mirrors the Storybook monorepo graph) | 155 ms | 71 ms | **2.2×** |
| 20 000 files × 4 KiB | 906 / 914 / 930 ms | 331 ms | **2.8×** |

So **cold cache roughly triples the hashing phase** — 35 ms becomes ~100 ms on the Storybook monorepo,
taking the whole `buildManifest` from ~99 ms to ~165 ms. Still nothing.

Raising concurrency does **not** help when cold: at *c* = 50 the same cold 20 000-file set took 934 and
1046 ms versus 906–930 ms at *c* = 10. The device, not the scheduler, is the limit.

Two caveats, stated rather than smoothed over:

- The disk image adds a layer of indirection, so 2.2–2.8× is an **upper bound** on the ratio for files on
  the raw volume.
- The production sequence is `build-storybook` → hash the output → build the manifest. The build has just
  *written* most of the graph files and read all of them, so **warm is the production-representative
  state**, and the cold number is a worst case for a cache-cold CI runner with a restored dependency
  cache.

## Where the time goes

`cost-profile.mjs` samples the V8 CPU profiler around 5 `buildManifest` runs and aggregates self time by
function name. Storybook monorepo, top rows, two independent runs agreeing to within a point:

```
  13.3%  (idle)
  10.9%  rollUpHash                        turbosnap/v2/graph.ts
   9.8%  resolve                           node:path
   9.6%  normalizeString                   node:path
   8.7%  collectTransitiveDependencies     turbosnap/v2/graph.ts
   4.1%  relative                          node:path
   3.7%  (garbage collector)
   3.5%  posix                             lib/posix.ts
   2.7%  existsSync
   2.7%  (anonymous)                       turbosnap/v2/graph.ts
   2.6%  resolveStatsPath                  turbosnap/v2/paths.ts
   2.2%  open
   2.1%  buildManifest                     turbosnap/v2/manifest.ts
   1.9%  read
   1.7%  getFileHashes                     lib/getFileHashes.ts
   1.4%  close
   1.2%  createUnsafeBuffer                node:internal/buffer
```

Grouped:

| cluster | Storybook monorepo | chromatic-cli |
|---|---|---|
| **path normalization** (`resolve`, `normalizeString`, `relative`, `posix`, `resolveStatsPath`, `normalizeStatsPath`, `join`) | **~30 %** | **~29 %** |
| roll-ups (`rollUpHash`, `collectTransitiveDependencies`, graph.ts anon) | ~22 % | ≲4 % (below the top-20 cut) |
| file I/O + hashing (`open`, `read`, `close`, `createUnsafeBuffer`, `wasm-*`, `getFileHashes`) | ~11 % | ~17 % |
| `existsSync` (graph discovery) | ~2.7 % | ~3.2 % |
| idle / GC / program | ~21 % | ~26 % |

**Content hashing every installed file in `stats.modules` is not what this costs.** The dominant cluster
at both sizes is path-string normalization, and it is redundant: `normalizeStatsPath` /
`resolveStatsPath` are called on the same raw stats string from `hashFiles` (once per module name and
once per reason), from `collectStoryImporters` (once per module), and again from `buildManifest`'s main
loop (once per module name and once per reason). A `Map<string, string>` memo keyed on the raw stats path
would remove most of ~30 % of `buildManifest`, change no behaviour, and touch one file. Sized here, not
fixed — it becomes its own ticket if anyone wants the 25 ms.

## What was not measured

- **Cold cache on the real repos.** Only on a disk image, as a ratio (above). `purge` needs root.
- **rspack and webpack builders.** Both real Storybooks are Vite. The fixture repo (`turbosnap-monorepo`,
  which has all three builders) was off limits during this measurement, and its largest bucket is 284
  files — smaller than either repo here, so it would not have added a scale point. Webpack stats carry
  concatenated modules, which add a second `moduleFileNames` pass per module; the path-normalization
  cluster would therefore be *larger* on webpack, not smaller. Unmeasured.
- **Linux / CI hardware.** Everything here is one Apple M1 Pro. The µs/file and µs/visit constants are
  reported so they can be re-derived elsewhere; the *shapes* are hardware-independent.
- **A Storybook with thousands of stories.** The largest real one available has 306. The 4 000-story
  point is synthetic.
