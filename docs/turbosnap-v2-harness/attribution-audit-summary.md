# TurboSnap v2 attribution audit — summary

Measured 2026-07-30 against `cody/turbosnap-v2` at `63410b78` (plus the uncommitted `outOfGraphFiles.ts`
comment, docs-only). 86 matrix probes across all four fixtures, 84 executed, plus 6 targeted follow-ups.
Full report: [`attribution-audit.html`](./attribution-audit.html).

## Verdict

**Every manifest entry attributes correctly on vite and webpack.** All 13 coverage claims hold:

- Story hashes are exact to the importing story on both builders — leaf → 2 stories, single-importer → 1,
  story file → itself, cross-package barrel → both importers, a barrel no story imports → nothing.
- `<storybookConfig>` catches bytes, an added file, a file added in a *nested* subdir, and a deletion, on
  **all four** fixtures. `<staticFiles>` catches bytes, add and delete on all three fixtures that have a
  static dir.
- The two out-of-graph sections stay **partitioned** even though `.storybook/static` nests inside the
  config dir: a static edit never moves `<storybookConfig>`.
- `preview.*`'s deliberate double coverage is **load-bearing** — `src/theme.ts`, imported by both
  `preview.ts` and `Button.tsx`, moves the preview graph entry *and* Button's story hash, which a flat
  content hash could not do.
- `marketing-ui`'s 0-byte `preview.ts` is covered by `<storybookConfig>` alone, confirming the
  empty-preview gap closed **with no special case**.
- `<storybookVersion>` moves on a `storybook` core bump and on nothing else; `@storybook/react` and
  `@storybook/react-dom-shim` version bumps correctly move nothing.
- `<storybookGlobals>` holds **zero first-party files on all three non-rspack fixtures** — composition is
  exclusively Storybook core runtime + the React renderer. This extends the earlier vite/webpack
  classification to `marketing-ui`, which had never been classified.
- `storybookHash` is complete over the entries that exist: every probe that moved an entry moved it, and
  none moved an entry without it.

## One new defect (since fixed)

**G2 — symlinks under a `staticDir` were skipped entirely (P1, FIXED).** `listFilesRecursively` gated
on `Dirent.isFile()`/`isDirectory()`, both false for a symlink, and its comment wrongly claimed symlinks
"have no bytes of their own to hash". Measured: a symlinked asset was never hashed (count `1 → 1`,
`storybookHash` SAME when its target's bytes changed), and adding a symlinked *directory* of two assets
contributed **nothing at all**. So `.storybook/static/vendor -> ../../node_modules/pkg/dist` — a common
monorepo pattern — made a whole served asset tree invisible, with no source edit to save it. v1 is blind
too (git stores the link, not the tree), so parity held and this was judged by absolute correctness, where
it failed.

**Fixed as described:** an entry that is neither file nor directory is resolved with `stat`, so a symlinked
file is hashed by its target's bytes (keyed by the *link's* path — the URL it is served at) and a symlinked
directory is descended into. Each directory is resolved with `realpath` before being walked and the resolved
paths tracked, so a cycle terminates; a broken symlink contributes nothing. Re-measured on `ui`: S1 moves
both `<staticFiles>` and `storybookHash`, S2's hashed count goes `1 → 3`, and G1's two cases still report
`UNDER-CAPTURES` as intended.

## Accepted, not ticketed

**G1 — `<staticFiles>` is path-independent, but a static asset's identity is its URL.** Renaming an asset
with its bytes intact, or swapping two assets' contents, moves nothing (`41406bed805f3c65` both sides, no
source file touched). `rollUpHash` folds paths out by design (`graph.ts:29`) — correct for modules, where
identical bytes render identically; wrong for static files. The consequence is **unexercised**: no fixture
story references a static asset by URL, so only the mechanism is measured. Accepted alongside the
"`staticDirs` unresolvable" gap — exotic, almost always accompanied by a source edit that moves a story
hash, and path-independence is worth keeping uniform. A knowing v1-parity exception, since v1 does bail.

## Two corrections to the record

- **A story-file or config-file rename moving nothing is correct, not a gap.** `storybookHash` hashes
  values, not keys, so a pure rename is invisible — but identical bytes mean the same `title`, same story
  IDs and an identical render, so v2 recapturing 0 where v1 recaptures 1 is v2 being *more* precise.
  Where a config filename *is* load-bearing (`preview.ts` → `preview-old.ts`), a real rebuild drops the
  module and the graph entry disappears, so it is caught.
- **The two vite fixtures measure different builders.** `ui`'s snapshot (Jul 30) is patched —
  `react/jsx-runtime.js` carries reasons from all three components. `marketing-ui`'s (Jul 28) has **no
  `reasons` entry for `jsx-runtime` at all**, making it a live **unpatched-vite control**, not a stale
  fixture. Every `react` row must be read against the right one.

## Still open, unchanged by this audit

- **G3 rspack** indexes 0 stories, so all six graph probes move only the bucket (`201/202`,
  `storyReachable: 0`) — already ticketed, informational per *Agreed design 3*.
- **G4 dangling reasons** at `manifest.ts:147` invent parentless roots (webpack 7, incl. two story files
  and `preview.ts`) — the one unticketed item in *Not yet specified*; the open question is scope.
- Both the builder-vite gate and the zero-story guard remain **inert** while `v2/index.ts:72` returns
  `fallback` unconditionally.

## Not covered

Structural graph changes (new import, new story file, moved module) — every probe is content-only against
a fixed stats snapshot by design. The dual-importer class now has the fixture on `ui`, `ui-webpack` and
`ui-rsbuild`, so `preview.*`'s double coverage is verified on vite and webpack; on rsbuild only the
preview half is observable, because that manifest carries zero story hashes. Unpatched vite is the one
builder still missing the fixture — `marketing-ui` is an unpatched control *because* its stats predate
the fork, and rebuilding it to add the importer would convert it into a second patched-vite fixture.
v2's bail vocabulary and the Index-side comparison logic are their own ticket and out of scope
respectively.
