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
| es-module-lexer (+esbuild strip) + oxc-resolver | 100.0% | 100.0% | 297 ms | 12 MB | pure JS + wasm | ✅ recommended — esbuild strip gives builder-faithful elision |
| vite pluginContainer.resolveId + oxc-parser | 99.4% | 11.4% | 738 ms | 186 MB | the builder itself | ❌ heaviest, no fidelity gain, defeats "builder-independent" |
| typescript (preProcessFile + resolveModuleName) | 100.0% | 10.9% | 802 ms | 128 MB | pure JS (typescript) | ➖ accurate resolution, heavy, still needs type-aware elision |
| madge (dependency-tree/precinct) | 100.0% | 10.9% | 1419 ms | 215 MB | off-the-shelf | ❌ slowest; same fidelity ceiling as other syntactic tools |
| oxc-parser + oxc-resolver | 99.4% | 10.8% | 75 ms | 22 MB | native (prebuilt binary) | ⚠️ fastest, but needs usage-based elision to be correct |

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
| 8 | **Hashing is cheap** (Option C) | 6.2 ms to hash the whole tree (157 MB/s) → incremental graph cache is viable |

## Modes
- **whole**: parse the entire source tree, build the full import graph (no builder, no story scoping).
- **scoped**: crawl forward from story entry points only (entry points from Storybook's glob, not the builder).
- **ceiling**: scoped, then restrict the graph to the builder's actual module set — isolates parse/resolve
  fidelity from the *module-universe* problem (i.e. "what if we knew exactly which files the builder bundles").

## Results — whole-repo static graph
| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |
|---|--:|--:|--:|--:|--:|--:|
| es-module-lexer (+esbuild strip) + oxc-resolver | 615 | 16.3 | 834 | 225/225 | 100.0% | 100.0% |
| typescript (preProcessFile + resolveModuleName) | 1600 | 129.3 | 977 | 119/225 | 100.0% | 10.9% |
| oxc-parser + oxc-resolver | 1714 | 30.1 | 959 | 119/225 | 99.4% | 10.8% |
| madge (dependency-tree/precinct) | 2402 | 211.5 | 981 | 119/225 | 100.0% | 10.9% |
| vite pluginContainer.resolveId + oxc-parser | 3031 | 189.9 | 939 | 125/225 | 99.4% | 11.4% |

## Results — preview-scoped (crawl from stories)
| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |
|---|--:|--:|--:|--:|--:|--:|
| oxc-parser + oxc-resolver | 75 | 22.5 | 743 | 119/225 | 99.4% | 10.8% |
| es-module-lexer (+esbuild strip) + oxc-resolver | 297 | 11.6 | 313 | 225/225 | 100.0% | 100.0% |
| vite pluginContainer.resolveId + oxc-parser | 738 | 185.9 | 701 | 125/225 | 99.4% | 11.4% |
| typescript (preProcessFile + resolveModuleName) | 802 | 128.5 | 772 | 119/225 | 100.0% | 10.9% |
| madge (dependency-tree/precinct) | 1419 | 214.6 | 773 | 119/225 | 100.0% | 10.9% |

## Results — ceiling (scoped ∩ builder module set)
| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |
|---|--:|--:|--:|--:|--:|--:|
| oxc-parser + oxc-resolver | 148 | 24.7 | 312 | 222/225 | 99.4% | 100.0% |
| es-module-lexer (+esbuild strip) + oxc-resolver | 295 | 8.5 | 313 | 225/225 | 100.0% | 100.0% |
| vite pluginContainer.resolveId + oxc-parser | 743 | 179.0 | 312 | 222/225 | 99.4% | 100.0% |
| typescript (preProcessFile + resolveModuleName) | 788 | 129.7 | 313 | 225/225 | 100.0% | 100.0% |
| madge (dependency-tree/precinct) | 1448 | 211.5 | 313 | 225/225 | 100.0% | 100.0% |

## Option C — source-file hashing cost (xxhash-wasm)
Hashing is not a graph builder; it's the change-detector/cache-key layer. Cost to read+hash the full
source tree (424 files, 1.0 MB):
**6.2 ms** (157 MB/s). Incremental runs only re-hash
changed files, so steady-state cost is effectively the changed subset.

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

## Implication for the path forward
Builder-independent source-graphing is **viable on this codebase** — but only with an approach that
replicates the builder's type-only import elision. The natural fit is **es-module-lexer + esbuild
type-strip + a resolver (oxc-resolver)**: it matched the builder exactly here, with low memory, and its
only real cost (per-file transform) is amortized by **content hashing (Option C)** — re-transform and
re-resolve only files whose hash changed, and cache the graph between runs. The remaining risk is recall
edge-cases (dynamic/conditional imports), so the safe rollout is to **shadow** this graph against the
builder stats and bail to a full snapshot whenever the two disagree, before making it the source of truth.
