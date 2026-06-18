# TurboSnap source-graph strategy benchmark

Builder-independent ways to derive the "which source files are linked" graph that TurboSnap needs,
measured against the **real** `getDependentStoryFiles` run on the builder's `preview-stats.json`.

## Setup
- Target: this repo's own Storybook (`.storybook`, `@storybook/html-vite`), globbing `node-src/**`.
- Builder stats: **381 modules**.
- Ground truth: **225 changed-file scenarios** → **115 story files**; 0 bail scenarios.
- Metric per scenario: set of affected story files vs ground truth.
  - **recall** = fraction of GT-affected stories we caught. `<100%` ⇒ **false negatives = missed visual regressions (dangerous)**.
  - **precision** = fraction of our predictions that were real. `<100%` ⇒ false positives = wasted snapshots (safe but costly).
- Node v22.22.2; single-process isolated runs.

## Summary scorecard (preview-scoped mode)
| approach | recall | precision | speed | memory | dependency | verdict |
|---|--:|--:|--:|--:|---|---|
| esbuild metafile (scan) | 100.0% | 100.0% | 98 ms | 3 MB | esbuild (bundler) | ✅✅ unified ESM+CJS, simplest, fast; whole-program scan (not per-file incremental) |
| es-module-lexer (+esbuild strip) + oxc-resolver | 100.0% | 100.0% | 290 ms | 13 MB | pure JS + wasm | ✅ recommended — esbuild strip gives builder-faithful elision |
| esbuild-strip + oxc(import+require) | 100.0% | 100.0% | 346 ms | 23 MB | esbuild + native | ✅✅ unified ESM+CJS, type-elision kept, per-file/incremental — best for mixed repos |
| vite pluginContainer.resolveId + oxc-parser | 99.4% | 11.4% | 782 ms | 174 MB | the builder itself | ❌ heaviest, no fidelity gain, defeats "builder-independent" |
| typescript (preProcessFile + resolveModuleName) | 100.0% | 10.9% | 817 ms | 125 MB | pure JS (typescript) | ➖ accurate resolution, heavy, still needs type-aware elision |
| madge (dependency-tree/precinct) | 100.0% | 10.9% | 1556 ms | 230 MB | off-the-shelf | ❌ slowest; same fidelity ceiling as other syntactic tools |
| oxc-parser + oxc-resolver | 99.4% | 10.8% | 75 ms | 21 MB | native (prebuilt binary) | ⚠️ fastest, but needs usage-based elision to be correct |
| oxc + require() (import+require+dyn) | 99.4% | 10.8% | 157 ms | 37 MB | native + AST walk | ✅ CJS-capable; fast; over-captures on TS type-only imports |

> recall <100% = **misses a changed story (dangerous)**; precision <100% = **extra snapshots (wasteful but safe)**.

## Findings at a glance
| # | finding | evidence |
|---|---|---|
| 1 | The fidelity gap is **type-only import elision**, not parse/resolve | `fatalError.ts`: `import { Context } from '../../..'` (value syntax, type-only use) → builder drops it; syntactic parsers keep it |
| 2 | That one missed-elision edge creates a **giant false hub** | the kept edge reaches `node-src/index.ts` which imports ~44 error messages → precision ~11% |
| 3 | **es-module-lexer matches the builder** (100%/100%) | it lexes esbuild-stripped code, inheriting the builder's usage-based elision; lowest memory too |
| 4 | Stripping `import type` is **not enough** | filtering oxc's `isType` entries barely moved precision (10.8%); need usage-based elimination or type info |
| 5 | **ceiling** mode lifts every approach to ~100% precision | restricting to the builder's module set removes the type-barrel hub — confirms universe, not tooling |
| 6 | Recall is ~99–100% but **not always clean** | esbuild-lexer 100%; oxc/vite 99.4% (a few silently-missed stories — the dangerous direction) |
| 7 | Parser/resolver = **speed/packaging**, not correctness | oxc fastest (native), TS pure-JS but heavy, Vite heaviest with no fidelity gain, madge slowest |
| 8 | **Hashing is cheap** (Option C) | 5.2 ms to hash the whole tree (103 MB/s) → incremental graph cache is viable |
| 9 | **Comment-insensitive change detection** is free (Option C2) | hashing esbuild-stripped output (389.9 ms) ignores comment/format-only edits — reuses the graph transform |
| 10 | **Reproduces PR #3's module-hash on 9/11 e2e scenarios** | es-module-lexer + stripped hashing matches; only node_modules-dep scenarios (#6/#7) are out of source-graph scope |
| 11 | **es-module-lexer is a non-starter for CommonJS** | recovers 0/4 `require()` edges; require-aware parsers (oxc+AST, TS, precinct) recover 4/4. Type-elision (its TS edge) is moot in plain JS |
| 12 | **One tool handles ESM+CJS with no branching: esbuild `metafile`** | scan pass (write:false) recovers 4/4 CJS edges, sees import+require in one mixed file, elides type-only — and follows node_modules in the same pass |
| 13 | **All criteria incl. #6/#7 + CJS internals are met by esbuild-meta `bundle` + transform-aware hashing** | #6/#7 → 115/115, a require()-only CJS-internal change → busts (no miss); cost ~1.9s. Residual: dynamic require/import + esbuild-vs-builder fidelity → shadow-mode |

## Modes
- **whole**: parse the entire source tree, build the full import graph (no builder, no story scoping).
- **scoped**: crawl forward from story entry points only (entry points from Storybook's glob, not the builder).
- **ceiling**: scoped, then restrict the graph to the builder's actual module set — isolates parse/resolve
  fidelity from the *module-universe* problem (i.e. "what if we knew exactly which files the builder bundles").

> Note: `esbuild metafile` is entry-point driven (entries = stories + preview), so it is inherently
> scoped — its **whole** and **scoped** rows are the same scan; only **ceiling** restricts it further.

## Results — whole-repo static graph
| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |
|---|--:|--:|--:|--:|--:|--:|
| oxc-parser + oxc-resolver | 80 | 24.9 | 755 | 119/225 | 99.4% | 10.8% |
| esbuild metafile (scan) | 91 | 2.7 | 515 | 225/225 | 100.0% | 100.0% |
| oxc + require() (import+require+dyn) | 157 | 38.0 | 755 | 119/225 | 99.4% | 10.8% |
| es-module-lexer (+esbuild strip) + oxc-resolver | 455 | 13.3 | 639 | 225/225 | 100.0% | 100.0% |
| esbuild-strip + oxc(import+require) | 557 | 31.5 | 639 | 225/225 | 100.0% | 100.0% |
| typescript (preProcessFile + resolveModuleName) | 811 | 127.6 | 772 | 119/225 | 100.0% | 10.9% |
| vite pluginContainer.resolveId + oxc-parser | 811 | 201.9 | 746 | 125/225 | 99.4% | 11.4% |
| madge (dependency-tree/precinct) | 2032 | 244.1 | 981 | 119/225 | 100.0% | 10.9% |

## Results — preview-scoped (crawl from stories)
| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |
|---|--:|--:|--:|--:|--:|--:|
| oxc-parser + oxc-resolver | 75 | 20.8 | 743 | 119/225 | 99.4% | 10.8% |
| esbuild metafile (scan) | 98 | 3.0 | 515 | 225/225 | 100.0% | 100.0% |
| oxc + require() (import+require+dyn) | 157 | 37.4 | 743 | 119/225 | 99.4% | 10.8% |
| es-module-lexer (+esbuild strip) + oxc-resolver | 290 | 12.7 | 313 | 225/225 | 100.0% | 100.0% |
| esbuild-strip + oxc(import+require) | 346 | 23.2 | 313 | 225/225 | 100.0% | 100.0% |
| vite pluginContainer.resolveId + oxc-parser | 782 | 174.4 | 701 | 125/225 | 99.4% | 11.4% |
| typescript (preProcessFile + resolveModuleName) | 817 | 125.0 | 772 | 119/225 | 100.0% | 10.9% |
| madge (dependency-tree/precinct) | 1556 | 230.4 | 773 | 119/225 | 100.0% | 10.9% |

## Results — ceiling (scoped ∩ builder module set)
| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |
|---|--:|--:|--:|--:|--:|--:|
| oxc-parser + oxc-resolver | 78 | 21.5 | 312 | 222/225 | 99.4% | 100.0% |
| esbuild metafile (scan) | 107 | 3.0 | 313 | 225/225 | 100.0% | 100.0% |
| oxc + require() (import+require+dyn) | 160 | 36.2 | 312 | 222/225 | 99.4% | 100.0% |
| es-module-lexer (+esbuild strip) + oxc-resolver | 288 | 8.8 | 313 | 225/225 | 100.0% | 100.0% |
| esbuild-strip + oxc(import+require) | 350 | 23.1 | 313 | 225/225 | 100.0% | 100.0% |
| typescript (preProcessFile + resolveModuleName) | 793 | 127.5 | 313 | 225/225 | 100.0% | 100.0% |
| vite pluginContainer.resolveId + oxc-parser | 816 | 191.8 | 312 | 222/225 | 99.4% | 100.0% |
| madge (dependency-tree/precinct) | 1571 | 234.1 | 313 | 225/225 | 100.0% | 100.0% |

## Option C — source-file hashing cost (xxhash-wasm)
Hashing is not a graph builder; it's the change-detector/cache-key layer. Cost to read+hash the full
source tree (350 files, 0.5 MB):
**5.2 ms** (103 MB/s). Incremental runs only re-hash
changed files, so steady-state cost is effectively the changed subset.

### Option C2 — comment/format-insensitive change detection (hash the stripped output)
Instead of hashing raw bytes, hash the **esbuild-stripped** output of each file. Comments, whitespace,
and formatting then don't affect the hash, so comment-only / reformat-only commits produce no change
set → no trace → no snapshot. Same transform we already run for the graph, so it composes for free.

| hashing mode | cost (full tree) | sensitive to |
|---|--:|---|
| raw bytes (C) | 5.2 ms | any byte (incl. comments/formatting) |
| esbuild-stripped (C2) | 389.9 ms (75.0× standalone) | runtime code only |

Note the 75× is the *standalone* cost (the esbuild transform dominates).
But the recommended grapher (es-module-lexer) **already transforms every file**, so when graphing and
hashing run together the stripped output is already in hand and C2's marginal cost over C is just the
extra hash — effectively free. C2 only looks expensive if you hash *without* building the graph.

Demonstration on `node-src/context.ts` with a comment added: raw hash changed = **true**,
stripped hash changed = **false**. (350 files stripped cleanly,
0 fell back to raw on parse failure.)

**Trade-offs.** Pros: skips snapshots on pure-comment/formatting churn; reuses the graph transform.
Cons: (1) it's a *behavior change* — you'd stop snapshotting on comment-only edits, which must be
deliberate; (2) hashes are only stable for a fixed esbuild version, so a toolchain bump invalidates the
cache and forces one full re-snapshot; (3) needs a raw-hash fallback for files esbuild can't parse.


## End-to-end scenarios vs PR #3 (module-hash strategy)
PR #3 reduces each story to a content-hash rollup **from the builder's module graph + per-module
`contentHash`** and diffs builds. Here we run the **same 11 scenarios** but feed the rollup a
builder-INDEPENDENT graph (our static approaches) and our own content hashes (raw vs esbuild-stripped),
on this repo's Storybook (115 stories). Cells are the count of stories flagged for re-capture
(`changed`, or `+added` / `−removed`).

### Recommended unified option (esbuild metafile + stripped hashing) vs PR #3
| # | scenario | PR #3 (builder) | ours | match |
|---|---|--:|--:|:--:|
| 1 | rebuild, no edit (determinism) | 0 | 0 | ✅ |
| 2 | story file — substantive | 3 | 3 | ✅ |
| 3 | story file — comment-only | 0 | 0 | ✅ |
| 4 | used dependency — code change | 3 | 3 | ✅ |
| 5 | preview config (.storybook/preview.ts) | 115 | 115 | ✅ |
| 6 | preview dep (node_modules) — substantive | 115 | 0 | ➖ gap |
| 7 | preview dep (node_modules) — comment-only | 115 | 0 | ➖ gap |
| 8 | add 1 story | +1 | +1 | ✅ |
| 9 | remove 1 story | −1 | −1 | ✅ |
| 10 | README (out of graph) | 0 | 0 | ✅ |
| 11 | dep paths relocated, content identical | 0 | 0 | ✅ |

**9/11 scenarios match PR #3 exactly.** The only divergences are #6/#7 — a preview dependency
*inside node_modules*. PR #3 catches those because node_modules are modules in the builder graph; our
source-graph stops at the package boundary. That's the known trade-off: closing it means either
crawling into node_modules (costly) or keeping the existing dependency-change signal for that case.

### All options × 11 scenarios (+ build time + CJS), changed-story count
| # | scenario | PR | esbuild-meta | strip+oxc+req | es-lexer | es-lexer +raw | oxc+require | oxc | ts | vite | madge |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | rebuild, no edit (determinism) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2 | story file — substantive | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| 3 | story file — comment-only | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| 4 | used dependency — code change | 3 | 3 | 3 | 3 | 3 | 43 | 43 | 43 | 43 | 43 |
| 5 | preview config (.storybook/preview.ts) | 115 | 115 | 115 | 115 | 115 | 115 | 115 | 115 | 115 | 115 |
| 6 | preview dep (node_modules) — substantive | 115 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 7 | preview dep (node_modules) — comment-only | 115 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 8 | add 1 story | +1 | +1 | +1 | +1 | +1 | +1 | +1 | +1 | +1 | +1 |
| 9 | remove 1 story | −1 | −1 | −1 | −1 | −1 | −1 | −1 | −1 | −1 | −1 |
| 10 | README (out of graph) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 11 | dep paths relocated, content identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| — | **graph build (ms)** | — | 107 | 357 | 318 | 339 | 162 | 81 | 99 | 459 | 1364 |
| — | **CommonJS support** | — | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |

Reading the matrix: the only rows that separate the options are **#3** (hash mode) and **#4** (graph
faithfulness); #6/#7 are the node_modules gap (all source-only options report 0). Two scenarios echo
the earlier fidelity findings:
- **#3 (comment-only edit):** raw hashing re-captures 3 stories; **stripped hashing correctly reports 0** (matches PR #3, which strips via the builder transform).
- **#4 (edit a used dependency, `auth.ts`):** the correct answer is **3** (the CSF-composition set). **es-module-lexer gets 3**; oxc / TypeScript / vite / madge over-capture to **43** — the same type-only-import over-connection, now as 14× wasted snapshots. Only the esbuild-stripped parse matches the builder.

### Closing #6/#7 — crawling into node_modules
The crawl already *resolves* bare imports into node_modules; it just stops there. Following through
(only the reachable closure, not all of node_modules) plus **transform-aware hashing** — esbuild-stripped
for in-project source, **raw bytes for node_modules** (the builder passes those through untransformed) —
closes the gap:

| # | scenario | PR #3 | source-only | + node_modules |
|---|---|--:|--:|--:|
| 3 | story comment-only | 0 | 0 | 0 |
| 4 | used dependency | 3 | 3 | 3 |
| 6 | preview dep (node_modules) substantive | 115 | — | 115 |
| 7 | preview dep (node_modules) comment-only | 115 | — | 115 |

With node_modules included, es-module-lexer matches PR #3 on **all 11** scenarios. Raw hashing for
node_modules is what makes #7 (comment-only dep edit) correctly bust — comments survive in an
untransformed dependency, exactly as the builder sees it. Cost barely moved: 226 → 234
reached files (~295 ms).

**The catch — CommonJS.** That +8-file growth is suspiciously small because es-module-lexer only
follows ESM `import`. Most node_modules (e.g. `chalk`, `ansi-html` here) are CommonJS and use
`require()`, which the lexer doesn't see — so a CJS dependency's *internal* files aren't in the graph.
`#6/#7` work because we edit the package's reached *entry* file, but a change to a deep CJS-internal
file would be **missed (under-capture — the dangerous direction)**. Fully completing the node_modules
graph needs CJS-aware import detection (an AST walk for `require(...)` via oxc/acorn) — more cost and
its own dynamic-`require` edge cases. The pragmatic alternative is to **not** re-derive node_modules
content and instead pair the source-graph with the existing dependency-change signal
(`findChangedDependencies`, lockfile/version diff) for the node_modules boundary — coarser
(package-level) but robust and already in TurboSnap.


## Meeting ALL criteria — no missed captures
The source-only options miss #6/#7 (a preview dependency inside node_modules) → **under-capture, the
unacceptable direction**. Closing it requires following into node_modules with a parser that also
handles **CJS internals**. esbuild metafile with **`bundle: true`** (no `packages:external`) does this
natively — it bundles CommonJS, so it traces `require()` chains inside node_modules — paired with
**transform-aware hashing** (source esbuild-stripped, node_modules raw).

| # | scenario | required | esbuild-meta (bundle + node_modules) |
|---|---|--:|--:|
| 3 | story comment-only | 0 | 0 |
| 4 | used dependency | 3 | 3 |
| 5 | preview config | 115 | 115 |
| 6 | preview dep (node_modules) substantive | 115 | 115 |
| 7 | preview dep (node_modules) comment-only | 115 | 115 |
| 8 | **CJS-internal dep** (`node_modules/chalk/source/util.js`, reached only via `require()`) | >0 | 115 |

All criteria met — including the CJS-internal change that es-module-lexer would silently miss. Reached
258 files (32 in node_modules) in **1890 ms** (vs ~90 ms source-only — the cost of completeness).

**Residual under-capture risks (must be handled before trusting it):**
1. **Dynamic `require(variable)` / `import(variable)`** — unresolvable statically by *any* tool. A real miss surface.
2. **esbuild ≠ the real builder.** This is a *second* bundler used as a proxy; plugin-injected or
   framework-virtual modules (Vue SFC, MDX, svgr, vite plugins) may resolve/transform differently, so
   esbuild's graph can diverge from what Vite/webpack actually bundles — a potential miss.

Because of #2, the only approach with **zero** second-bundler risk is using the **real builder's** graph +
content hashes — which is exactly what PR #3 does. A builder-independent esbuild scan is the faster,
lighter option but must run in **shadow mode** (diff against the real builder stats, bail to full
snapshot on any divergence) until trusted. If "never miss a capture" is an absolute, PR #3's
builder-graph approach is the safer foundation; the esbuild scan is the portable approximation.


## CommonJS support (require()) — a hard requirement for some repos
es-module-lexer only sees ESM `import`. For a CJS codebase whose edges are all `require()`, that's a
**non-starter**: it recovers almost no graph → mass under-capture (the dangerous direction). Measured on
a small all-`require()` fixture (4 real edges):

| parser | edges recovered | |
|---|--:|--:|
| es-module-lexer (+strip) | 0/4 | 0% |
| oxc module record (import only) | 0/4 | 0% |
| oxc + AST require() walk | 4/4 | 100% |
| typescript preProcessFile | 4/4 | 100% |
| esbuild-strip + oxc(import + require) | 4/4 | 100% |
| madge (precinct/detective-cjs) | 4/4 | 100% |

### Parser capability matrix
| parser | ESM `import` | dyn `import()` | CJS `require()` | TS type-only elision |
|---|:--:|:--:|:--:|:--:|
| es-module-lexer (+esbuild strip) | ✅ | ✅ | ❌ | ✅ (esbuild usage-based) |
| oxc module record | ✅ | ✅ | ❌ | ⚠️ (drops `import type` only) |
| oxc + AST `require()` walk | ✅ | ✅ | ✅ | ⚠️ (syntactic) |
| TypeScript `preProcessFile` | ✅ | ✅ | ✅ | ❌ (keeps) |
| madge / precinct | ✅ | ✅ | ✅ | ❌ (keeps) |
| **esbuild-strip + oxc(import + require)** | ✅ | ✅ | ✅ | ✅ |

The type-only-elision column (the reason es-module-lexer won on TS) is a **TypeScript-only** concern —
plain CJS/JS has no type imports, so for a pure-CJS repo a require-aware syntactic parser is both
complete and correct. The combination that covers **both** worlds is **esbuild-strip (type elision for
TS) → oxc parse for `import` + `import()` + an AST `require()` walk**: it recovers the full CJS
fixture (4/4) and, because the esbuild strip drops type-only imports, it also avoids the
TS over-capture (it inherits es-module-lexer's scenario-#4 = 3 behavior, not oxc's 43).


## A single approach for ESM + CJS with no branching — esbuild `metafile`
The per-file parsers force a choice (lexer for ESM, require-walk for CJS). To handle both **uniformly,
in one tool, with no module-system branching**, use the one tool that already understands every module
system: **esbuild**, run as a scan pass (`bundle: true, metafile: true, write: false`). esbuild resolves
with the real resolver, elides TS types, follows `import`, dynamic `import()`, and `require()` alike,
and its `metafile` reports every edge with its `kind`. Nothing is emitted — we only read the graph.

Validated here:
- All-CJS fixture: **4/4** `require()` edges recovered (all tagged `require-call`).
- One mixed `.ts` file (`import` + `require` + a type-only import): sees the ESM import = **true**,
  sees the CJS require = **true**, drops the type-only import = **true**. One pass, no branching.

Because `bundle: true` follows into node_modules, this also covers CJS-internal files and the #6/#7
dependency boundary in the same pass — the things the lexer/oxc paths needed extra machinery for.

**Trade-offs.** It is a real resolve+load pass (heavier than per-file lexing, though esbuild is Go-fast
and writes nothing). It must resolve everything, so non-JS imports (CSS, SVG, assets) need a loader
shim or `external` rule or the pass errors; `packages: 'external'` stops at the node_modules boundary if
you only want source. Dynamic `require(variable)` / `import(variable)` remain unresolvable (universal).
Conceptually it's the middle ground between static lexing and PR #3's "use the real build": a fast,
**builder-independent** bundler used purely to extract the graph. The metafile gives the graph; you
still roll up per-file content hashes yourself (Option C/C2) for the change signal.

## Key findings
1. **The fidelity gap is about *type-only import elision*, not parsing or resolution.** The builder
   (esbuild/Rollup) drops imports used only in type positions — even when written with value syntax and
   no `type` keyword. Concrete case: `node-src/ui/messages/errors/fatalError.ts` has
   `import { Context, InitialContext } from '../../..'`; those names are used only as types, so after
   type-stripping the import is dead and the builder removes it. A *syntactic* parser keeps the edge,
   reaches `node-src/index.ts` (which imports ~44 error-message modules), and invents a giant false
   hub → **precision collapses to ~11%**.
2. **es-module-lexer is the most builder-faithful** because it runs on esbuild-transformed code and so
   inherits the exact usage-based import elision the builder does — **100% precision and 100% recall,
   225/225 exact** in every mode, with the lowest memory. Its cost is the per-file esbuild transform
   (the speed gap vs raw oxc).
3. **Purely syntactic parsers (oxc-parser, TS `preProcessFile`, madge/precinct) over-connect (~11%)**
   until you elide semantically-type-only imports. Dropping `import type` statements is not enough (it
   barely moved oxc) — you need *usage-based* elimination (an esbuild/oxc transform pass) or full
   type-checking. The `ceiling` mode confirms this: restrict to the builder's module set and every
   approach hits ~100%.
4. **Recall is ~99–100% but not always a clean 100%.** The esbuild-backed lexer hit 100%; oxc and vite
   missed a few stories (99.4%) from edges their parse/resolve dropped. Sub-100% recall is the
   *dangerous* direction (a changed story silently skipped), so any approach must be validated against
   the builder graph before being trusted.
5. **Parser/resolver choice is a performance/packaging decision.** oxc is fastest but native (per-
   platform prebuilt binary); TypeScript is pure-JS but heavy; Vite is heaviest and buys nothing here
   because resolution was never the bottleneck; madge is slowest.

## Implication for the path forward (revised — must support CommonJS)
Builder-independent source-graphing is viable, but the parser choice depends on the codebase, and
**es-module-lexer alone is ruled out where CommonJS must be supported** (0/4 `require()` edges).

- **Pure TS/ESM:** es-module-lexer + esbuild strip is the simplest faithful option (type-only elision
  for free, lowest memory).
- **Any CommonJS (or mixed):** use a **require-aware** parser. The recommended single tool is
  **esbuild-strip → oxc `import` + `import()` + AST `require()` walk** (+ oxc-resolver): it covers
  ESM, dynamic import, and CJS (4/4 on the fixture) *and* keeps the type-only elision that avoids the
  TS over-capture. TypeScript `preProcessFile` and madge/precinct also handle require() but keep
  type-only imports (TS over-capture) and are heavier.
- **No missed captures (must cover #6/#7 + CJS internals):** the source-only graph is not enough — you
  must follow into node_modules. **esbuild metafile with `bundle: true`** does this in one pass
  (bundles CJS internals natively) + **transform-aware hashing** (source stripped, node_modules raw):
  all 11 criteria met, ~1.9s. But esbuild is a *proxy* builder, so for an absolute no-miss guarantee
  the safest foundation is the **real builder's** graph + content hashes (PR #3); run the esbuild scan
  in **shadow mode** against it (bail to full snapshot on divergence) until trusted.

Layer **content hashing (Option C/C2)** on top for change detection + an incrementally-cached graph,
with **transform-aware hashing** (stripped for source, raw for node_modules) if the node_modules
boundary is crawled. Remaining risk is recall edge-cases (dynamic/conditional `require`/`import`), so
the safe rollout is **shadow mode** against the builder stats — bail to a full snapshot whenever the two
disagree — before making it the source of truth.
