# Which `@storybook/*` code runs in the preview but is invisible to `preview-stats.json`

Findings for the TurboSnap 2.0 map ticket *Determine which `@storybook/*` packages ship
out-of-graph preview runtime*. Measured 2026-07-29 against `~/Projects/turbosnap-monorepo`
on Storybook `10.6.0-alpha.3`.

## Bottom line

| Builder | Preview-executing code absent from `preview-stats.json` |
| --- | --- |
| vite (`ui`) | `@storybook/global` only |
| webpack5 (`ui-webpack`) | `@storybook/global`, **plus the core preview runtime** `storybook/dist/preview/runtime.js` (1,577,931 bytes) shipped as the prebuilt asset `sb-preview/runtime.js`, and `sb-preview/globals.js` |
| rspack (`ui-rsbuild`) | same shape as webpack |

The scoped-package question turns out to be a near-miss: the significant out-of-graph
runtime is not an `@storybook/*` package at all, it is the **unscoped `storybook` core
package's prebuilt preview bundle**, and only on the webpack-family builders.

## The core runtime, per builder

`storybook/dist/preview/runtime.js` defines `__STORYBOOK_MODULE_GLOBAL__`,
`__STORYBOOK_MODULE_PREVIEW_API__`, the channel, and the instrumenter. It *is* the preview
runtime. Builders disagree on how it reaches the iframe:

- **webpack — invisible.** `@storybook/builder-webpack5` copies it byte-identically to
  `storybook-static/sb-preview/runtime.js`, and `iframe.html` loads it as the **first**
  import, ahead of every webpack bundle:

  ```html
  <script type="module">import './sb-preview/runtime.js';
        import './mocker-runtime-injected.js';
        import './runtime~main.d2af05b0.iframe.bundle.js';
  ```

  `grep -c 'storybook/dist/preview/runtime' packages/ui-webpack/storybook-static/preview-stats.json`
  → **0**. It executes in the iframe and appears nowhere in the stats.

- **vite — visible.** No `sb-preview/` directory is emitted; `iframe.html` loads only
  `./assets/iframe-*.js`. `./../../node_modules/storybook/dist/preview/runtime.js` **is** a
  module in the vite stats (2 occurrences). On vite it is one hashable 1.5 MB file.

So a `storybook` core bump changes preview behaviour on webpack with **zero** stats-visible
file changes, and on vite it is caught by content hashing for free.

## `@storybook/global`

Version `5.0.0`, out-of-repo (`storybookjs/global`), consumed as `^5.0.0`. `dist/index.js`
is a ~40-line browser shim exporting `global = window`; its exports map has only `"."` and
`"./package.json"` — no `/manager`, no `/preset`, no `bin`. It runs in the iframe on every
builder, and is unhashable on every builder:

- webpack: aliased to an external stub, `"name": "external \"__STORYBOOK_MODULE_GLOBAL__\""`,
  `nameForCondition: null` — no file on disk. Issued by `@storybook/react/dist/entry-preview.js`,
  `storybook/dist/csf/index.js`, `storybook/dist/instrumenter/index.js`, and
  `./storybook-config-entry.js`.
- vite: `grep -c 'node_modules/@storybook/global'` → **0**, yet `__STORYBOOK_MODULE_GLOBAL__`
  occurs in the emitted `assets/iframe-*.js`.

## Everything else in the installed-minus-stats difference is harmless

In-stats `@storybook/*` files on **both** builders are just `@storybook/react`
(`entry-preview.js`, `entry-preview-argtypes.js`, `_browser-chunks/chunk-*.js`) and
`@storybook/react-dom-shim` (`react-18.js`) — the two packages the bucket-classification
ticket already found in the graph.

| Package | Builder | Class | Evidence |
| --- | --- | --- | --- |
| `@storybook/icons` 2.1.0 | both | **manager only** | referenced only from `storybook/dist/manager-api/*`, `dist/manager/globals*.js`; zero preview references. Cannot change a snapshot (map *Out of scope*). |
| `@storybook/builder-vite` | vite | node/build | exports `"."`, `"./preset"`, `"./input/iframe.html"`. Its `/virtual:/@storybook/builder-vite/*.js` entries in the stats are generated strings with no file on disk — not hashable, and not shipped code. |
| `@storybook/csf-plugin` | vite | node/build | unplugin + webpack loader; no `/preview` export. |
| `@storybook/react-vite`, `@storybook/react-webpack5` | resp. | node/build in practice | `dist/index.js` is `export * from "@storybook/react"`, but exports are `"."`, `"./node"`, `"./preset"` and nothing pulls them into the iframe (stories import types from `@storybook/react`). |
| `@storybook/builder-webpack5` | webpack | node/build | appears only as `templates/preview.ejs` via `html-webpack-plugin`. |
| `@storybook/preset-react-webpack` | webpack | node/build | appears only as a loader prefix inside `identifier`. |
| `@storybook/addon-webpack5-compiler-babel` 4.0.1 | webpack | node/build | `dist/` is `index.js` + `preset.js`; no `preview.js`, no `manager.js`. |
| `@storybook/core-webpack`, `@storybook/react-docgen-typescript-plugin` | webpack | node/build | node-only plugin/config. |

Note the trap: `preset-react-webpack`, `builder-webpack5` and `addon-webpack5-compiler-babel`
*do* appear as strings in the webpack stats, but as loader and template paths. Attributing to
them would be a false positive — none ships preview code.

## Do `@storybook/*` packages move in lockstep with `storybook`?

**In-repo: yes, mechanically.** The monorepo uses hand-rolled fixed versioning — no lerna,
no changesets (`lerna.json` and `.changeset/config.json` are both 404 on `next`; `nx.json`
exists but is a task runner, its `publish` target points at a local Verdaccio).

- [`scripts/release/version.ts`](https://github.com/storybookjs/storybook/blob/next/scripts/release/version.ts)
  maps over every yarn workspace and sets `packageJson.version = nextVersion` — no per-package opt-out.
- [`scripts/release/publish.ts`](https://github.com/storybookjs/storybook/blob/next/scripts/release/publish.ts)
  is one fan-out: `yarn workspaces foreach --all --parallel --no-private npm publish`.
- [`code/core/src/common/versions.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/common/versions.ts)
  is `// auto generated file, do not edit` and maps ~45 packages to one identical string.

The last 8 non-canary versions are byte-identical across `storybook`, `@storybook/react`,
`@storybook/react-dom-shim`, `@storybook/builder-vite`, `@storybook/vue3`, `@storybook/addon-docs`.

**But an installed tree can still diverge, three ways:**

1. **The peer is a caret.** `@storybook/react@10.5.5` declares `storybook: "^10.5.5"`, so
   `storybook` may be *newer* than the renderer and still resolve clean (the common shape
   after `npm update storybook` or a Dependabot bump). In-repo cross-deps are exact pins
   (`@storybook/react-dom-shim: "10.5.5"`), and `storybook` itself depends on **no** in-repo
   `@storybook/*` — the arrows point from the satellites to core, never back.
2. **Out-of-repo packages under the same scope.** `@storybook/global` 5.0.0, `@storybook/csf`
   0.1.13, `@storybook/icons` 2.1.0 have their own schemes. `@storybook/react-native` is a
   live counterexample: **10.5.4 while core is 10.5.5, today**. `storybook-react-rsbuild`
   3.3.4 peers `storybook: "^10.3.5"` — deliberately decoupled across all of 10.x.
3. **Nested duplicates.** Exact in-repo pins mean a monorepo holding two Storybook versions
   gets two nested copies rather than a dedupe; reading one hoisted `storybook/package.json`
   misses the nested tree.

### It matters which major

- **Storybook 8:** preview runtime was spread across separately-installed
  `@storybook/preview-api`, `components`, `theming`, `blocks`, `instrumenter`, `test`, `core`.
  A version string on `storybook` alone told you almost nothing.
- **Storybook 9/10:** those were folded into the `storybook` tarball (public subpaths
  `storybook/preview-api`, `storybook/test`, `storybook/actions`, …, and `storybook/internal/*`).
  `@storybook/react@10.5.5` now has just three deps. The surface shrank dramatically.

**So:** a single version string off `storybook` is a good proxy for the in-repo set on 9/10,
but not a proof. Its real false negatives are the caret-lagging renderer/framework/builder and
the out-of-repo scoped packages. In practice, though, the only preview code that string needs
to cover is the *out-of-graph* part — and that is small: the webpack/rspack prebuilt
`sb-preview/runtime.js` (which comes from `storybook` itself, so the string does cover it) and
`@storybook/global` (which it does not).

## Sources

Storybook release tooling and `MIGRATION.md` on `storybookjs/storybook@next`; npm registry
queried 2026-07-29. Fixture stats read raw (never via a pruned chromatic manifest, per the
map's *Agreed design 6*).
