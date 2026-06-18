# Hash-based TurboSnap — design

> This is the agreed design. The exploration that led here (every alternative, with data) is in
> [`results/report.md`](./results/report.md); a runnable proof of concept is [`poc.mts`](./poc.mts).

## Goal

Replace TurboSnap's git-diff + lockfile change detection with **content hashing**, comparing against a
**baseline manifest stored in the backend** — not against git blobs.

The motivation is operational: the lockfile path forces us to obtain the *baseline* lockfile to diff it,
which means checking out a blob that may be thousands of commits back and may not exist in a shallow CI
clone. Instead we **hash the files that exist in the working tree right now** and diff those hashes
against the baseline build's manifest fetched from our API. We still use the commit graph to *find* the
baseline build — but we never need its file contents.

A second consequence: **dependency changes stop being a special case.** A `node_modules` file a story
reaches is just another file in its graph; we hash it and diff. No lockfile parsing, no dependency
graph diffing.

## What the builder must provide

**Nothing new.** This runs against today's released `@storybook/builder-vite` output:
`preview-stats.json` already contains the module graph via `reasons`, including `node_modules` modules.
We do **not** need the builder to emit `contentHash`, and we do **not** need the preview-gap fix —
preview is covered by its own signal (below), so it never has to be connected into the per-story graph.

## The three signals

All computed CLI-side, all from files on disk now, all diffed against the baseline manifest.

### 1. Preview bail (global)
Trace the **require-aware import closure of `.storybook/preview.*`** (follow `import`, dynamic
`import()`, and **CJS `require()`**, into `node_modules`). Hash every file; combine. Also fold in the
out-of-graph render inputs: **`*-head.html`** (e.g. `preview-head.html`) and the **`staticDirs`** file
list.
- Changed ⇒ **recapture everything** (preview affects every story).
- Tracing what `preview.*` *imports* naturally excludes auto-injected addons like **docs** (not imported
  by `preview.*`, doesn't affect the canvas). The implicit, correct rule: a canvas-affecting addon is one
  the user imports into `preview.*` (e.g. a theme decorator) — so it's in this closure; docs/a11y/actions
  aren't, and shouldn't be.
- Must be **require-aware**: the closure is largely CommonJS (`chalk` + transitive deps). An ESM-only
  lexer recovers almost none of it.

### 2. Main / config bail (global)
**Evaluate** `.storybook/main.*` (the way Storybook loads it) to read its config, then hash:
`main.*` itself + its local imports + the resolved **framework** and **`core.builder`** entries.
- Changed ⇒ **recapture everything** (these change how everything builds/renders).
- We deliberately **don't classify addons** as "canvas vs not" (you can't infer it statically). Addons
  that affect the canvas are caught by signal #1 (they're imported in preview); addons that don't (docs)
  are ignored. Residual: a build-affecting addon that isn't imported in preview would need a maintained
  allowlist — out of scope for v1.

### 3. Per-story (granular)
From `preview-stats.json` `reasons`, build the forward graph and, for each story, collect its reachable
modules. Hash each reachable file (raw bytes, **cached per file**), and roll them up into a single
**content-only digest** per story (sort the content hashes; paths are *not* hashed, so a dependency that
moves on disk with identical content doesn't false-bust).
- Per-story hash differs from baseline ⇒ recapture that story. New story ⇒ recapture. Missing ⇒ removed.
- This is where `node_modules` dependency changes land **per-story**: bump a dep, only the stories that
  actually reach it recapture (e.g. a dep reached by 1 story → 1 recapture) — no lockfile.

## Decision algorithm

```
manifest = { version, previewBail, mainBail, storyHashes: { [story]: hash } }

# always compute the current manifest and UPLOAD it (seeds the next build's baseline)
baseline = api.getManifest(ancestorBuild)        # no git blobs — just the stored manifest

if baseline is null OR baseline.version != manifest.version:
    → FALLBACK to the legacy git-diff/getDependentStoryFiles algorithm for THIS run
elif baseline.previewBail != manifest.previewBail: → recapture ALL (preview changed)
elif baseline.mainBail   != manifest.mainBail:   → recapture ALL (main/config changed)
else:
    recapture = stories whose hash changed, plus added; (removed are dropped)
```

## Migration (gradual, no flag day)

Every build **computes and uploads** the manifest unconditionally. The new algorithm only activates once
the baseline build *also* has a (version-compatible) manifest; otherwise this run falls back to the
legacy algorithm. So hashes accumulate, and projects cut over automatically with zero breakage. Bumping
`version` (algorithm/normalization change) forces a one-time capture-all rather than a silent mis-compare.

## Accepted trade-offs / residual miss surfaces

- **Comment/format-only edits recapture** (raw file hash). Accepted — "you changed story A, so we
  recaptured" is easy to explain, and it's safe (over-capture, never a miss).
- **Virtual modules** (~4: the vite entry/glue) have no on-disk file and are skipped — a pre-existing,
  tolerated gap.
- **Dynamic `require(var)` / `import(var)`** are unresolvable by anyone — same as today.
- **Build-affecting, non-imported addons** — see signal #2.

## Proof of concept

[`poc.mts`](./poc.mts) implements all three signals + fallback and prints a decision table on this repo's
Storybook (115 stories):

| edit | decision |
|---|---|
| no edit | TurboSnap — 0 recaptured |
| a component (`ui/tasks/auth.ts`) | TurboSnap — **3** |
| a per-story `node_modules` dep (`strip-ansi`) | TurboSnap — **1** (no lockfile) |
| a shared preview dep (`chalk`) | BAIL preview — ALL |
| `preview.ts` | BAIL preview — ALL |
| a preview-only dep (`ansi-html`) | BAIL preview — ALL |
| `preview-head.html` | BAIL preview — ALL |
| `main.ts` | BAIL main — ALL |
| a static asset | BAIL preview — ALL |
| first build (no baseline manifest) | FALLBACK (legacy) + manifest uploaded |
