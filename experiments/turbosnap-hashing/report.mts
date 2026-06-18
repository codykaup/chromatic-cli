/**
 * Orchestrator: runs every approach in isolated processes across modes, runs the hashing
 * micro-benchmark (Option C), and writes results.json + report.md.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { REPO_ROOT, candidateSourceFiles } from './lib/common.mts';

const HERE = path.join(REPO_ROOT, 'experiments/turbosnap-hashing');
const TSX = path.join(HERE, 'node_modules/.bin/tsx');
const RESULTS = path.join(HERE, 'results');
fs.mkdirSync(RESULTS, { recursive: true });

const APPROACHES = ['oxc', 'eslexer', 'typescript', 'vite', 'madge', 'oxcRequire', 'oxcStripRequire', 'esbuildmeta'];
const MODES = ['whole', 'scoped', 'ceiling'] as const;

interface Row {
  approach: string;
  mode: string;
  buildMs: number;
  peakRssMb: number;
  graphNodes: number;
  graphEdges: number;
  exactMatch: number;
  totalScenarios: number;
  recall: number;
  precision: number;
  falseNegativeScenarios: string[];
  notes: string[];
  fileCount: number;
}

function runOne(approach: string, mode: string): Row | null {
  try {
    const out = execFileSync(TSX, ['experiments/turbosnap-hashing/bench.mts', approach, mode], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
    const line = out.split('\n').find((l) => l.startsWith('@@RESULT@@'));
    if (!line) {
      console.error(`  no result for ${approach}/${mode}`);
      return null;
    }
    return JSON.parse(line.slice('@@RESULT@@'.length));
  } catch (e: any) {
    console.error(`  FAILED ${approach}/${mode}: ${e.message?.split('\n')[0]}`);
    return null;
  }
}

const rows: Row[] = [];
for (const approach of APPROACHES) {
  for (const mode of MODES) {
    process.stderr.write(`running ${approach}/${mode}...\n`);
    const r = runOne(approach, mode);
    if (r) rows.push(r);
  }
}

// ---- Option C: source-file hashing micro-benchmark (xxhash-wasm, the repo's choice) ----
async function hashingBench() {
  const xxhash = (await import('xxhash-wasm')).default;
  const { create64 } = await xxhash();
  const { transform } = await import('esbuild');
  const files = candidateSourceFiles();
  const h = (s: string | Uint8Array) => create64().update(s).digest().toString(16);

  // Mode 1: raw-bytes hashing (comment/format SENSITIVE) — current behavior.
  let t0 = performance.now();
  let bytes = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    bytes += buf.length;
    h(buf);
  }
  const rawMs = performance.now() - t0;

  // Mode 2: hash the esbuild-stripped output (comment/format INSENSITIVE).
  t0 = performance.now();
  let stripped = 0;
  let fellBack = 0;
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8');
    const ext = path.extname(f);
    try {
      const loader = ext === '.tsx' || ext === '.jsx' ? 'tsx' : ext === '.mdx' ? 'tsx' : 'ts';
      const out = await transform(code, { loader, format: 'esm', legalComments: 'none' });
      h(out.code);
      stripped++;
    } catch {
      h(code); // fall back to raw on parse failure
      fellBack++;
    }
  }
  const normMs = performance.now() - t0;

  // Demonstration: a comment-only edit changes the raw hash but NOT the normalized hash.
  const sample = files.find((f) => f.endsWith('.ts')) ?? files[0];
  const original = fs.readFileSync(sample, 'utf8');
  const edited = `// a newly added comment\n${original}\n/* trailing */`;
  const stripOf = async (c: string) =>
    h((await transform(c, { loader: 'ts', format: 'esm', legalComments: 'none' })).code);
  const demo = {
    file: path.relative(REPO_ROOT, sample),
    rawHashChanged: h(original) !== h(edited),
    normHashChanged: (await stripOf(original)) !== (await stripOf(edited)),
  };

  return {
    files: files.length,
    bytes,
    rawMs,
    rawMbPerSec: bytes / 1024 / 1024 / (rawMs / 1000),
    normMs,
    normMultiplier: normMs / rawMs,
    stripped,
    fellBack,
    demo,
    // kept for backwards-compatible report fields
    ms: rawMs,
    mbPerSec: bytes / 1024 / 1024 / (rawMs / 1000),
  };
}
const hashing = await hashingBench();

const gt = JSON.parse(fs.readFileSync(path.join(RESULTS, 'groundtruth.json'), 'utf8'));
const summary = {
  groundTruth: {
    scenarioFiles: gt.scenarioFiles.length,
    storyFiles: gt.storyFiles.length,
    bailFiles: gt.bailFiles.length,
    statsModules: 381,
  },
  hashing,
  rows,
};
fs.writeFileSync(path.join(RESULTS, 'results.json'), JSON.stringify(summary, null, 2));

// ---- Markdown report ----
const fmt = (n: number, d = 0) => n.toFixed(d);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ---- End-to-end scenarios vs PR #3 (module-hash) ----
function scenarioSection(): string {
  const p = path.join(RESULTS, 'scenarios.json');
  if (!fs.existsSync(p)) return '';
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const runs = data.runs as Record<string, { storyCount: number; results: Record<string, any> }>;

  // PR #3's documented module-hash expectations (changed unless +added / −removed).
  const LABELS: Record<string, string> = {
    '1_rebuild_no_edit': 'rebuild, no edit (determinism)',
    '2_story_substantive': 'story file — substantive',
    '3_story_comment_only': 'story file — comment-only',
    '4_used_dep_code': 'used dependency — code change',
    '5_preview_config': 'preview config (.storybook/preview.ts)',
    '6_preview_dep_substantive': 'preview dep (node_modules) — substantive',
    '7_preview_dep_comment': 'preview dep (node_modules) — comment-only',
    '8_add_story': 'add 1 story',
    '9_remove_story': 'remove 1 story',
    '10_readme_out_of_graph': 'README (out of graph)',
    '11_paths_relocated_same_content': 'dep paths relocated, content identical',
  };
  const PR: Record<string, string> = {
    '1_rebuild_no_edit': '0', '2_story_substantive': '3', '3_story_comment_only': '0',
    '4_used_dep_code': '3', '5_preview_config': '115', '6_preview_dep_substantive': '115',
    '7_preview_dep_comment': '115', '8_add_story': '+1', '9_remove_story': '−1',
    '10_readme_out_of_graph': '0', '11_paths_relocated_same_content': '0',
  };
  const cell = (r: any) => (r.added ? `+${r.added}` : r.removed ? `−${r.removed}` : `${r.changed}`);
  const ids = Object.keys(LABELS);

  // Main table: PR vs recommended unified option (esbuild metafile + stripped).
  const rec = runs['esbuildmeta_stripped']?.results ?? {};
  const mainRows = ids
    .map((id, i) => {
      const got = cell(rec[id]);
      const match = got === PR[id] ? '✅' : rec[id]?.note ? '➖ gap' : '⚠️';
      return `| ${i + 1} | ${LABELS[id]} | ${PR[id]} | ${got} | ${match} |`;
    })
    .join('\n');

  // Divergence matrix across ALL options (changed-count cells), stripped hashing unless noted.
  const cols: [string, string][] = [
    ['esbuildmeta_stripped', 'esbuild-meta'],
    ['oxcStripRequire_stripped', 'strip+oxc+req'],
    ['eslexer_stripped', 'es-lexer'],
    ['eslexer_raw', 'es-lexer +raw'],
    ['oxcRequire_stripped', 'oxc+require'],
    ['oxc_stripped', 'oxc'],
    ['typescript_stripped', 'ts'],
    ['vite_stripped', 'vite'],
    ['madge_stripped', 'madge'],
  ];
  const matrixHead = `| # | scenario | PR | ${cols.map((c) => c[1]).join(' | ')} |\n|---|---|--:|${cols.map(() => '--:').join('|')}|`;
  const matrixRows = ids
    .map((id, i) => {
      const cells = cols.map(([k]) => cell(runs[k]?.results?.[id] ?? {}));
      return `| ${i + 1} | ${LABELS[id]} | ${PR[id]} | ${cells.join(' | ')} |`;
    })
    .join('\n');
  const perfRow = `| — | **graph build (ms)** | — | ${cols.map(([k]) => runs[k]?.buildMs ?? '?').join(' | ')} |`;
  const cjsRow = `| — | **CommonJS support** | — | ${cols.map(([k]) => (/(esbuildmeta|Require|typescript|madge)/.test(k) ? '✅' : '❌')).join(' | ')} |`;

  const matches = ids.filter((id) => cell(rec[id]) === PR[id]).length;

  return `
## End-to-end scenarios vs PR #3 (module-hash strategy)
PR #3 reduces each story to a content-hash rollup **from the builder's module graph + per-module
\`contentHash\`** and diffs builds. Here we run the **same 11 scenarios** but feed the rollup a
builder-INDEPENDENT graph (our static approaches) and our own content hashes (raw vs esbuild-stripped),
on this repo's Storybook (${runs['eslexer_stripped']?.storyCount ?? '?'} stories). Cells are the count of stories flagged for re-capture
(\`changed\`, or \`+added\` / \`−removed\`).

### Recommended unified option (esbuild metafile + stripped hashing) vs PR #3
| # | scenario | PR #3 (builder) | ours | match |
|---|---|--:|--:|:--:|
${mainRows}

**${matches}/11 scenarios match PR #3 exactly.** The only divergences are #6/#7 — a preview dependency
*inside node_modules*. PR #3 catches those because node_modules are modules in the builder graph; our
source-graph stops at the package boundary. That's the known trade-off: closing it means either
crawling into node_modules (costly) or keeping the existing dependency-change signal for that case.

### All options × 11 scenarios (+ build time + CJS), changed-story count
${matrixHead}
${matrixRows}
${perfRow}
${cjsRow}

Reading the matrix: the only rows that separate the options are **#3** (hash mode) and **#4** (graph
faithfulness); #6/#7 are the node_modules gap (all source-only options report 0). Two scenarios echo
the earlier fidelity findings:
- **#3 (comment-only edit):** raw hashing re-captures 3 stories; **stripped hashing correctly reports 0** (matches PR #3, which strips via the builder transform).
- **#4 (edit a used dependency, \`auth.ts\`):** the correct answer is **3** (the CSF-composition set). **es-module-lexer gets 3**; oxc / TypeScript / vite / madge over-capture to **43** — the same type-only-import over-connection, now as 14× wasted snapshots. Only the esbuild-stripped parse matches the builder.
${nodeModulesSection()}`;
}

// ---- Unified ESM+CJS option ----
function unifiedSection(): string {
  const p = path.join(RESULTS, 'esbuild-meta.json');
  if (!fs.existsSync(p)) return '';
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  return `
## A single approach for ESM + CJS with no branching — esbuild \`metafile\`
The per-file parsers force a choice (lexer for ESM, require-walk for CJS). To handle both **uniformly,
in one tool, with no module-system branching**, use the one tool that already understands every module
system: **esbuild**, run as a scan pass (\`bundle: true, metafile: true, write: false\`). esbuild resolves
with the real resolver, elides TS types, follows \`import\`, dynamic \`import()\`, and \`require()\` alike,
and its \`metafile\` reports every edge with its \`kind\`. Nothing is emitted — we only read the graph.

Validated here:
- All-CJS fixture: **${d.cjsFixture.recovered}/${d.cjsFixture.expectedEdges}** \`require()\` edges recovered (all tagged \`require-call\`).
- One mixed \`.ts\` file (\`import\` + \`require\` + a type-only import): sees the ESM import = **${d.mixedFile.seesEsmImport}**,
  sees the CJS require = **${d.mixedFile.seesCjsRequire}**, drops the type-only import = **${d.mixedFile.elidesTypeOnly}**. One pass, no branching.

Because \`bundle: true\` follows into node_modules, this also covers CJS-internal files and the #6/#7
dependency boundary in the same pass — the things the lexer/oxc paths needed extra machinery for.

**Trade-offs.** It is a real resolve+load pass (heavier than per-file lexing, though esbuild is Go-fast
and writes nothing). It must resolve everything, so non-JS imports (CSS, SVG, assets) need a loader
shim or \`external\` rule or the pass errors; \`packages: 'external'\` stops at the node_modules boundary if
you only want source. Dynamic \`require(variable)\` / \`import(variable)\` remain unresolvable (universal).
Conceptually it's the middle ground between static lexing and PR #3's "use the real build": a fast,
**builder-independent** bundler used purely to extract the graph. The metafile gives the graph; you
still roll up per-file content hashes yourself (Option C/C2) for the change signal.
`;
}

// ---- Meeting all criteria (no missed captures) ----
function completenessSection(): string {
  const p = path.join(RESULTS, 'scenarios-complete.json');
  if (!fs.existsSync(p)) return '';
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = d._meta;
  const cell = (v: any) => (typeof v === 'number' ? `${v}` : '—');
  return `
## Meeting ALL criteria — no missed captures
The source-only options miss #6/#7 (a preview dependency inside node_modules) → **under-capture, the
unacceptable direction**. Closing it requires following into node_modules with a parser that also
handles **CJS internals**. esbuild metafile with **\`bundle: true\`** (no \`packages:external\`) does this
natively — it bundles CommonJS, so it traces \`require()\` chains inside node_modules — paired with
**transform-aware hashing** (source esbuild-stripped, node_modules raw).

| # | scenario | required | esbuild-meta (bundle + node_modules) |
|---|---|--:|--:|
| 3 | story comment-only | 0 | ${cell(d['3_story_comment_only'])} |
| 4 | used dependency | 3 | ${cell(d['4_used_dep_code'])} |
| 5 | preview config | 115 | ${cell(d['5_preview_config'])} |
| 6 | preview dep (node_modules) substantive | 115 | ${cell(d['6_preview_dep_substantive'])} |
| 7 | preview dep (node_modules) comment-only | 115 | ${cell(d['7_preview_dep_comment'])} |
| 8 | **CJS-internal dep** (\`${m.cjsInternalProbe}\`, reached only via \`require()\`) | >0 | ${cell(d['8_cjs_internal_dep'])} |

All criteria met — including the CJS-internal change that es-module-lexer would silently miss. Reached
${m.totalReached} files (${m.nodeModulesReached} in node_modules) in **${m.buildMs} ms** (vs ~90 ms source-only — the cost of completeness).

**Residual under-capture risks (must be handled before trusting it):**
1. **Dynamic \`require(variable)\` / \`import(variable)\`** — unresolvable statically by *any* tool. A real miss surface.
2. **esbuild ≠ the real builder.** This is a *second* bundler used as a proxy; plugin-injected or
   framework-virtual modules (Vue SFC, MDX, svgr, vite plugins) may resolve/transform differently, so
   esbuild's graph can diverge from what Vite/webpack actually bundles — a potential miss.

Because of #2, the only approach with **zero** second-bundler risk is using the **real builder's** graph +
content hashes — which is exactly what PR #3 does. A builder-independent esbuild scan is the faster,
lighter option but must run in **shadow mode** (diff against the real builder stats, bail to full
snapshot on any divergence) until trusted. If "never miss a capture" is an absolute, PR #3's
builder-graph approach is the safer foundation; the esbuild scan is the portable approximation.
`;
}

// ---- CJS support ----
function cjsSection(): string {
  const p = path.join(RESULTS, 'cjs-fixture.json');
  if (!fs.existsSync(p)) return '';
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const exp = d.expectedEdges;
  const rec = d.edgesRecovered as Record<string, number>;
  const rows = Object.entries(rec)
    .map(([name, n]) => `| ${name} | ${n}/${exp} | ${((n / exp) * 100).toFixed(0)}% |`)
    .join('\n');
  return `
## CommonJS support (require()) — a hard requirement for some repos
es-module-lexer only sees ESM \`import\`. For a CJS codebase whose edges are all \`require()\`, that's a
**non-starter**: it recovers almost no graph → mass under-capture (the dangerous direction). Measured on
a small all-\`require()\` fixture (${exp} real edges):

| parser | edges recovered | |
|---|--:|--:|
${rows}

### Parser capability matrix
| parser | ESM \`import\` | dyn \`import()\` | CJS \`require()\` | TS type-only elision |
|---|:--:|:--:|:--:|:--:|
| es-module-lexer (+esbuild strip) | ✅ | ✅ | ❌ | ✅ (esbuild usage-based) |
| oxc module record | ✅ | ✅ | ❌ | ⚠️ (drops \`import type\` only) |
| oxc + AST \`require()\` walk | ✅ | ✅ | ✅ | ⚠️ (syntactic) |
| TypeScript \`preProcessFile\` | ✅ | ✅ | ✅ | ❌ (keeps) |
| madge / precinct | ✅ | ✅ | ✅ | ❌ (keeps) |
| **esbuild-strip + oxc(import + require)** | ✅ | ✅ | ✅ | ✅ |

The type-only-elision column (the reason es-module-lexer won on TS) is a **TypeScript-only** concern —
plain CJS/JS has no type imports, so for a pure-CJS repo a require-aware syntactic parser is both
complete and correct. The combination that covers **both** worlds is **esbuild-strip (type elision for
TS) → oxc parse for \`import\` + \`import()\` + an AST \`require()\` walk**: it recovers the full CJS
fixture (${rec['esbuild-strip + oxc(import + require)']}/${exp}) and, because the esbuild strip drops type-only imports, it also avoids the
TS over-capture (it inherits es-module-lexer's scenario-#4 = 3 behavior, not oxc's 43).
`;
}

// ---- Closing #6/#7 by crawling into node_modules ----
function nodeModulesSection(): string {
  const p = path.join(RESULTS, 'scenarios-nodemodules.json');
  if (!fs.existsSync(p)) return '';
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const so = d.sourceOnly;
  const nm = d.withNodeModules;
  const c = (r: any) => (r?.note ? '—' : r.added ? `+${r.added}` : r.removed ? `−${r.removed}` : `${r.changed}`);
  return `
### Closing #6/#7 — crawling into node_modules
The crawl already *resolves* bare imports into node_modules; it just stops there. Following through
(only the reachable closure, not all of node_modules) plus **transform-aware hashing** — esbuild-stripped
for in-project source, **raw bytes for node_modules** (the builder passes those through untransformed) —
closes the gap:

| # | scenario | PR #3 | source-only | + node_modules |
|---|---|--:|--:|--:|
| 3 | story comment-only | 0 | ${c(so['3_story_comment_only'])} | ${c(nm['3_story_comment_only'])} |
| 4 | used dependency | 3 | ${c(so['4_used_dep_code'])} | ${c(nm['4_used_dep_code'])} |
| 6 | preview dep (node_modules) substantive | 115 | ${c(so['6_preview_dep_substantive'])} | ${c(nm['6_preview_dep_substantive'])} |
| 7 | preview dep (node_modules) comment-only | 115 | ${c(so['7_preview_dep_comment'])} | ${c(nm['7_preview_dep_comment'])} |

With node_modules included, es-module-lexer matches PR #3 on **all 11** scenarios. Raw hashing for
node_modules is what makes #7 (comment-only dep edit) correctly bust — comments survive in an
untransformed dependency, exactly as the builder sees it. Cost barely moved: ${so._meta.reached} → ${nm._meta.reached}
reached files (~${nm._meta.buildMs} ms).

**The catch — CommonJS.** That +${nm._meta.reached - so._meta.reached}-file growth is suspiciously small because es-module-lexer only
follows ESM \`import\`. Most node_modules (e.g. \`chalk\`, \`ansi-html\` here) are CommonJS and use
\`require()\`, which the lexer doesn't see — so a CJS dependency's *internal* files aren't in the graph.
\`#6/#7\` work because we edit the package's reached *entry* file, but a change to a deep CJS-internal
file would be **missed (under-capture — the dangerous direction)**. Fully completing the node_modules
graph needs CJS-aware import detection (an AST walk for \`require(...)\` via oxc/acorn) — more cost and
its own dynamic-\`require\` edge cases. The pragmatic alternative is to **not** re-derive node_modules
content and instead pair the source-graph with the existing dependency-change signal
(\`findChangedDependencies\`, lockfile/version diff) for the node_modules boundary — coarser
(package-level) but robust and already in TurboSnap.
`;
}

function table(mode: string) {
  const r = rows.filter((x) => x.mode === mode).sort((a, b) => a.buildMs - b.buildMs);
  const head =
    '| approach | build ms | peak RSS MB | edges | exact match | recall (1−FN) | precision (1−FP) |\n' +
    '|---|--:|--:|--:|--:|--:|--:|';
  const body = r
    .map(
      (x) =>
        `| ${x.approach} | ${fmt(x.buildMs)} | ${fmt(x.peakRssMb, 1)} | ${x.graphEdges} | ${x.exactMatch}/${x.totalScenarios} | ${pct(
          x.recall
        )} | ${pct(x.precision)} |`
    )
    .join('\n');
  return `${head}\n${body}`;
}

// Per-approach verdicts (qualitative, keyed by approach name). Numbers come from scoped-mode rows.
const VERDICTS: Record<string, { dep: string; fidelity: string; verdict: string }> = {
  'oxc-parser + oxc-resolver': {
    dep: 'native (prebuilt binary)',
    fidelity: 'over-connects (type-only imports kept)',
    verdict: '⚠️ fastest, but needs usage-based elision to be correct',
  },
  'es-module-lexer (+esbuild strip) + oxc-resolver': {
    dep: 'pure JS + wasm',
    fidelity: 'matches builder exactly',
    verdict: '✅ recommended — esbuild strip gives builder-faithful elision',
  },
  'typescript (preProcessFile + resolveModuleName)': {
    dep: 'pure JS (typescript)',
    fidelity: 'over-connects (syntactic imports)',
    verdict: '➖ accurate resolution, heavy, still needs type-aware elision',
  },
  'vite pluginContainer.resolveId + oxc-parser': {
    dep: 'the builder itself',
    fidelity: 'over-connects (resolution was never the issue)',
    verdict: '❌ heaviest, no fidelity gain, defeats "builder-independent"',
  },
  'madge (dependency-tree/precinct)': {
    dep: 'off-the-shelf',
    fidelity: 'over-connects (syntactic imports)',
    verdict: '❌ slowest; same fidelity ceiling as other syntactic tools',
  },
  'oxc + require() (import+require+dyn)': {
    dep: 'native + AST walk',
    fidelity: 'over-connects on TS (syntactic)',
    verdict: '✅ CJS-capable; fast; over-captures on TS type-only imports',
  },
  'esbuild-strip + oxc(import+require)': {
    dep: 'esbuild + native',
    fidelity: 'matches builder + CJS',
    verdict: '✅✅ unified ESM+CJS, type-elision kept, per-file/incremental — best for mixed repos',
  },
  'esbuild metafile (scan)': {
    dep: 'esbuild (bundler)',
    fidelity: 'matches builder + CJS',
    verdict: '✅✅ unified ESM+CJS, simplest, fast; whole-program scan (not per-file incremental)',
  },
};

function scorecard() {
  const r = rows.filter((x) => x.mode === 'scoped').sort((a, b) => b.precision - a.precision || a.buildMs - b.buildMs);
  const head =
    '| approach | recall | precision | speed | memory | dependency | verdict |\n' +
    '|---|--:|--:|--:|--:|---|---|';
  const body = r
    .map((x) => {
      const v = VERDICTS[x.approach] ?? { dep: '?', fidelity: '?', verdict: '?' };
      return `| ${x.approach} | ${pct(x.recall)} | ${pct(x.precision)} | ${fmt(x.buildMs)} ms | ${fmt(
        x.peakRssMb,
        0
      )} MB | ${v.dep} | ${v.verdict} |`;
    })
    .join('\n');
  return `${head}\n${body}`;
}

const md = `# TurboSnap source-graph strategy benchmark

Builder-independent ways to derive the "which source files are linked" graph that TurboSnap needs,
measured against the **real** \`getDependentStoryFiles\` run on the builder's \`preview-stats.json\`.

## Setup
- Target: this repo's own Storybook (\`.storybook\`, \`@storybook/html-vite\`), globbing \`node-src/**\`.
- Builder stats: **${summary.groundTruth.statsModules} modules**.
- Ground truth: **${summary.groundTruth.scenarioFiles} changed-file scenarios** → **${summary.groundTruth.storyFiles} story files**; ${summary.groundTruth.bailFiles} bail scenarios.
- Metric per scenario: set of affected story files vs ground truth.
  - **recall** = fraction of GT-affected stories we caught. \`<100%\` ⇒ **false negatives = missed visual regressions (dangerous)**.
  - **precision** = fraction of our predictions that were real. \`<100%\` ⇒ false positives = wasted snapshots (safe but costly).
- Node ${process.version}; single-process isolated runs.

## Summary scorecard (preview-scoped mode)
${scorecard()}

> recall <100% = **misses a changed story (dangerous)**; precision <100% = **extra snapshots (wasteful but safe)**.

## Findings at a glance
| # | finding | evidence |
|---|---|---|
| 1 | The fidelity gap is **type-only import elision**, not parse/resolve | \`fatalError.ts\`: \`import { Context } from '../../..'\` (value syntax, type-only use) → builder drops it; syntactic parsers keep it |
| 2 | That one missed-elision edge creates a **giant false hub** | the kept edge reaches \`node-src/index.ts\` which imports ~44 error messages → precision ~11% |
| 3 | **es-module-lexer matches the builder** (100%/100%) | it lexes esbuild-stripped code, inheriting the builder's usage-based elision; lowest memory too |
| 4 | Stripping \`import type\` is **not enough** | filtering oxc's \`isType\` entries barely moved precision (10.8%); need usage-based elimination or type info |
| 5 | **ceiling** mode lifts every approach to ~100% precision | restricting to the builder's module set removes the type-barrel hub — confirms universe, not tooling |
| 6 | Recall is ~99–100% but **not always clean** | esbuild-lexer 100%; oxc/vite 99.4% (a few silently-missed stories — the dangerous direction) |
| 7 | Parser/resolver = **speed/packaging**, not correctness | oxc fastest (native), TS pure-JS but heavy, Vite heaviest with no fidelity gain, madge slowest |
| 8 | **Hashing is cheap** (Option C) | ${hashing.rawMs.toFixed(1)} ms to hash the whole tree (${hashing.rawMbPerSec.toFixed(0)} MB/s) → incremental graph cache is viable |
| 9 | **Comment-insensitive change detection** is free (Option C2) | hashing esbuild-stripped output (${hashing.normMs.toFixed(1)} ms) ignores comment/format-only edits — reuses the graph transform |
| 10 | **Reproduces PR #3's module-hash on 9/11 e2e scenarios** | es-module-lexer + stripped hashing matches; only node_modules-dep scenarios (#6/#7) are out of source-graph scope |
| 11 | **es-module-lexer is a non-starter for CommonJS** | recovers 0/4 \`require()\` edges; require-aware parsers (oxc+AST, TS, precinct) recover 4/4. Type-elision (its TS edge) is moot in plain JS |
| 12 | **One tool handles ESM+CJS with no branching: esbuild \`metafile\`** | scan pass (write:false) recovers 4/4 CJS edges, sees import+require in one mixed file, elides type-only — and follows node_modules in the same pass |
| 13 | **All criteria incl. #6/#7 + CJS internals are met by esbuild-meta \`bundle\` + transform-aware hashing** | #6/#7 → 115/115, a require()-only CJS-internal change → busts (no miss); cost ~1.9s. Residual: dynamic require/import + esbuild-vs-builder fidelity → shadow-mode |

## Modes
- **whole**: parse the entire source tree, build the full import graph (no builder, no story scoping).
- **scoped**: crawl forward from story entry points only (entry points from Storybook's glob, not the builder).
- **ceiling**: scoped, then restrict the graph to the builder's actual module set — isolates parse/resolve
  fidelity from the *module-universe* problem (i.e. "what if we knew exactly which files the builder bundles").

> Note: \`esbuild metafile\` is entry-point driven (entries = stories + preview), so it is inherently
> scoped — its **whole** and **scoped** rows are the same scan; only **ceiling** restricts it further.

## Results — whole-repo static graph
${table('whole')}

## Results — preview-scoped (crawl from stories)
${table('scoped')}

## Results — ceiling (scoped ∩ builder module set)
${table('ceiling')}

## Option C — source-file hashing cost (xxhash-wasm)
Hashing is not a graph builder; it's the change-detector/cache-key layer. Cost to read+hash the full
source tree (${hashing.files} files, ${(hashing.bytes / 1024 / 1024).toFixed(1)} MB):
**${hashing.rawMs.toFixed(1)} ms** (${hashing.rawMbPerSec.toFixed(0)} MB/s). Incremental runs only re-hash
changed files, so steady-state cost is effectively the changed subset.

### Option C2 — comment/format-insensitive change detection (hash the stripped output)
Instead of hashing raw bytes, hash the **esbuild-stripped** output of each file. Comments, whitespace,
and formatting then don't affect the hash, so comment-only / reformat-only commits produce no change
set → no trace → no snapshot. Same transform we already run for the graph, so it composes for free.

| hashing mode | cost (full tree) | sensitive to |
|---|--:|---|
| raw bytes (C) | ${hashing.rawMs.toFixed(1)} ms | any byte (incl. comments/formatting) |
| esbuild-stripped (C2) | ${hashing.normMs.toFixed(1)} ms (${hashing.normMultiplier.toFixed(1)}× standalone) | runtime code only |

Note the ${hashing.normMultiplier.toFixed(0)}× is the *standalone* cost (the esbuild transform dominates).
But the recommended grapher (es-module-lexer) **already transforms every file**, so when graphing and
hashing run together the stripped output is already in hand and C2's marginal cost over C is just the
extra hash — effectively free. C2 only looks expensive if you hash *without* building the graph.

Demonstration on \`${hashing.demo.file}\` with a comment added: raw hash changed = **${hashing.demo.rawHashChanged}**,
stripped hash changed = **${hashing.demo.normHashChanged}**. (${hashing.stripped} files stripped cleanly,
${hashing.fellBack} fell back to raw on parse failure.)

**Trade-offs.** Pros: skips snapshots on pure-comment/formatting churn; reuses the graph transform.
Cons: (1) it's a *behavior change* — you'd stop snapshotting on comment-only edits, which must be
deliberate; (2) hashes are only stable for a fixed esbuild version, so a toolchain bump invalidates the
cache and forces one full re-snapshot; (3) needs a raw-hash fallback for files esbuild can't parse.

${scenarioSection()}
${completenessSection()}
${cjsSection()}
${unifiedSection()}
## Key findings
1. **The fidelity gap is about *type-only import elision*, not parsing or resolution.** The builder
   (esbuild/Rollup) drops imports used only in type positions — even when written with value syntax and
   no \`type\` keyword. Concrete case: \`node-src/ui/messages/errors/fatalError.ts\` has
   \`import { Context, InitialContext } from '../../..'\`; those names are used only as types, so after
   type-stripping the import is dead and the builder removes it. A *syntactic* parser keeps the edge,
   reaches \`node-src/index.ts\` (which imports ~44 error-message modules), and invents a giant false
   hub → **precision collapses to ~11%**.
2. **es-module-lexer is the most builder-faithful** because it runs on esbuild-transformed code and so
   inherits the exact usage-based import elision the builder does — **100% precision and 100% recall,
   225/225 exact** in every mode, with the lowest memory. Its cost is the per-file esbuild transform
   (the speed gap vs raw oxc).
3. **Purely syntactic parsers (oxc-parser, TS \`preProcessFile\`, madge/precinct) over-connect (~11%)**
   until you elide semantically-type-only imports. Dropping \`import type\` statements is not enough (it
   barely moved oxc) — you need *usage-based* elimination (an esbuild/oxc transform pass) or full
   type-checking. The \`ceiling\` mode confirms this: restrict to the builder's module set and every
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
**es-module-lexer alone is ruled out where CommonJS must be supported** (0/4 \`require()\` edges).

- **Pure TS/ESM:** es-module-lexer + esbuild strip is the simplest faithful option (type-only elision
  for free, lowest memory).
- **Any CommonJS (or mixed):** use a **require-aware** parser. The recommended single tool is
  **esbuild-strip → oxc \`import\` + \`import()\` + AST \`require()\` walk** (+ oxc-resolver): it covers
  ESM, dynamic import, and CJS (4/4 on the fixture) *and* keeps the type-only elision that avoids the
  TS over-capture. TypeScript \`preProcessFile\` and madge/precinct also handle require() but keep
  type-only imports (TS over-capture) and are heavier.
- **No missed captures (must cover #6/#7 + CJS internals):** the source-only graph is not enough — you
  must follow into node_modules. **esbuild metafile with \`bundle: true\`** does this in one pass
  (bundles CJS internals natively) + **transform-aware hashing** (source stripped, node_modules raw):
  all 11 criteria met, ~1.9s. But esbuild is a *proxy* builder, so for an absolute no-miss guarantee
  the safest foundation is the **real builder's** graph + content hashes (PR #3); run the esbuild scan
  in **shadow mode** against it (bail to full snapshot on divergence) until trusted.

Layer **content hashing (Option C/C2)** on top for change detection + an incrementally-cached graph,
with **transform-aware hashing** (stripped for source, raw for node_modules) if the node_modules
boundary is crawled. Remaining risk is recall edge-cases (dynamic/conditional \`require\`/\`import\`), so
the safe rollout is **shadow mode** against the builder stats — bail to a full snapshot whenever the two
disagree — before making it the source of truth.
`;

fs.writeFileSync(path.join(RESULTS, 'report.md'), md);
console.log('\n' + md);
