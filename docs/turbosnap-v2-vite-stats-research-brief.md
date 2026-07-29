# Research brief: why does Storybook's Vite builder orphan `react` in `preview-stats.json`?

> Self-contained handoff for a research agent. You do **not** need any prior conversation to do this
> task. Report findings only — **do not modify any files.**

## The repo to investigate

`~/Projects/storybook-codykaup` — a checkout of the Storybook monorepo we control (a fork). Note: this
checkout already contains some TurboSnap-related commits; be aware they may have touched the stats
code. Base your analysis on the source in this checkout.

Cross-check against the *installed* builder in the fixture repo if versions differ:
`~/Projects/turbosnap-monorepo/node_modules/@storybook/builder-vite`. Note any version mismatch, but
treat `~/Projects/storybook-codykaup` as the source of truth.

## Context: what `preview-stats.json` is

Each Storybook builder emits a `preview-stats.json` in webpack-stats shape: a top-level `modules`
array. Each module has an `id`/`name` and a `reasons` array. **`reasons` lists the modules that import
this module** (i.e. incoming edges). A downstream tool (TurboSnap v2) walks these `reasons` edges to
compute, for each story, its full transitive dependency set, then content-hashes those files. If a
file isn't reachable via `reasons` edges from a story, changes to it are invisible to that story.

## The verified problem

We built the **same** fixture app with three builders and compared their stats:

- `@storybook/react-vite` (Vite builder)
- `@storybook/react-webpack5` (webpack builder)
- `storybook-react-rsbuild` (rsbuild builder)

**On the Vite build, `react` and `react-dom` are present in `modules` but form a disconnected
"island": no module lists them in its `reasons`.** Nothing points to them — not the components, not
the render shim. So `node_modules/react/index.js` exists in the stats but is unreachable by walking
`reasons` from any root (neither from a story, nor from the preview-app root).

On **webpack** and **rsbuild**, the same `react` module IS reachable — components have recorded edges
to `react/index.js` and `react/jsx-runtime.js`, and `@storybook/react-dom-shim` links down to
react-dom.

### Concrete evidence from the actual stats files

Downward reachability of `node_modules/react/index.js`, computed by inverting `reasons` into
parent→child edges and BFS-ing from each root:

| Builder | `react/index.js` in `modules`? | reachable from any story? | reachable from preview-app root? |
|---|---|---|---|
| **Vite** (`ui`)        | yes | **no** | **no** |
| webpack (`ui-webpack`) | yes | yes | yes |
| rsbuild (`ui-rsbuild`) | yes | yes | yes |

On Vite specifically:
- `Button.tsx`'s only recorded outgoing edges are to `moment` and `@myorg/shared` — both **explicit**
  bare imports written in the component source. Its dependency on `react`/`react/jsx-runtime` (which
  is **auto-injected** by the JSX transform — the source never writes `import React`) is **absent**.
- `@storybook/react-dom-shim` (which performs the actual `react-dom` render for stories) appears as a
  **leaf** — it has no recorded edge down to `react-dom`.
- Net effect: the react/react-dom cluster is internally connected (react-dom → react) but has **no
  incoming edge from anything reachable from a root**. It's an island.

So the pattern is: **explicit bare imports survive as edges on Vite; auto-injected / framework
render-path imports do not.**

## What to root-cause

Find **where in `~/Projects/storybook-codykaup` the Vite `preview-stats.json` is generated, and why
these edges are missing.** Answer these specifically:

1. **Which code emits the Vite stats?** Find the plugin/module in the Vite builder that produces
   `preview-stats.json` (likely under `code/builders/builder-vite/`; look for a "stats" module or a
   Rollup plugin that assembles the `modules`/`reasons` structure). Give exact file(s) + function(s).

2. **How does it derive `modules` and `reasons`?** Does it read Rollup's module graph
   (`this.getModuleInfo`, `moduleParsed`, the `bundle` in `generateBundle`,
   `importedIds`/`dynamicallyImportedIds`), or something else? Key question: at the phase where it
   records edges, would auto-injected JSX-runtime imports and the shim→react-dom edge already be
   present, or already stripped/rewritten?

3. **Why is `react` an orphan?** Give a concrete, code-backed conclusion. Confirm or rule out each:
   - **`optimizeDeps` pre-bundling**: Vite pre-bundles react/react-dom into a single served chunk, so
     in the graph the edges point at the pre-bundled chunk (e.g. under `.vite/deps` or a virtual id),
     not at `node_modules/react/index.js`; the stats plugin then records the real file separately with
     no incoming edge.
   - **id filtering/normalization**: the plugin drops or rewrites module ids (virtual/`\0`-prefixed
     modules, `?v=` query suffixes, optimized-dep paths) in a way that severs the edge linkage between
     the importer's recorded id and react's recorded id.
   - **JSX automatic runtime**: the `react/jsx-runtime` import is injected by esbuild / the react
     plugin at transform time and never surfaces as a Rollup import edge in the phase the plugin reads.
   - **shim dynamic import**: `@storybook/react-dom-shim` reaches react-dom via a conditional/dynamic
     path the stats plugin doesn't traverse.

4. **webpack contrast (brief):** how does `builder-webpack5` produce its stats — likely webpack's
   native `stats.toJson`, which is why the edges stay intact? One or two lines.

5. **Fixability (we control this source):** Could the Vite stats-generation code be changed to record
   the missing edges? For example: read edges from a phase where JSX-runtime and pre-bundle-resolved
   edges are intact, or resolve optimized-dep / virtual ids back to their real `node_modules` paths
   and re-link the edges. Point to the **exact spot** a fix would go, and name any **hard blockers**
   (cases where the information genuinely isn't available at that phase).

## How to work

- Locate the Vite builder package and its stats code first. Search for strings: `preview-stats`,
  `stats.json`, `reasons`, `getModuleInfo`, `generateBundle`, `moduleParsed`, `optimizeDeps`,
  `jsx-runtime`, `\0`, `?v=`.
- Read the actual code paths and quote them with `file:line` references.
- If helpful, inspect the real stats files to ground claims:
  `~/Projects/turbosnap-monorepo/packages/{ui,ui-webpack,ui-rsbuild}/storybook-static/preview-stats.json`.

## Report format

- **Emitting code**: `file:line` of the Vite stats plugin + 2–3 sentences on how it builds
  modules/reasons.
- **Root cause**: the confirmed reason react is an orphan, with code evidence. If not fully
  confirmable, give the best-supported hypothesis and what remains uncertain.
- **webpack contrast**: one line on why webpack keeps the edges.
- **Fixability**: can we fix it in the builder source, where exactly, and any blockers.
- Keep it tight and evidence-backed. Quote code with `file:line`.
