# Bail-reason audit — fixture-repo behavioural verification

Measured 2026-07-29 on `cody/turbosnap-v2` (`b4ff35c8`, rebuilt before every run) against
`~/Projects/turbosnap-monorepo`: `ui` (vite), `ui-webpack` (webpack5), `ui-rsbuild` (rspack),
`marketing-ui` (vite). Full classified inventory: [`bail-audit.html`](./bail-audit.html).

## Framing correction that changes how to read this

`v2/index.ts:56` unconditionally returns `{ status: 'fallback' }`, so **v2 emits zero bail reasons in
production today** — every shipped bail comes from `gitInfo.ts`, `tasks/initialize/`, or v1. The
`turbosnap-manifest` harness bypasses that gate, so all "v2" verdicts below describe the evidence the
manifest *would* carry once the fallback is removed. That is the question worth auditing now.

## Verdict summary

| Reason | vite | webpack5 | rspack |
|---|---|---|---|
| `noAncestorBuild` / `rebuild` / `invalidChangedFiles` / `changedExternalFiles` / `unavailable` | unexercised | unexercised | unexercised |
| `missingStatsFile` (path unset) | correct (both) | correct (both) | correct (both) |
| `missingStatsFile` (path set, unreadable) | **unnamed throw** | **unnamed throw** | **unnamed throw** |
| `changedPackageFiles` Path A | v1 unexercised · **v2 absent** | v1 unexercised · **v2 absent** | v1 unexercised · **v2 absent** |
| `changedPackageFiles` Path B | **unexercised**; per-package absence deliberately unguarded (gap 2) | unexercised · v2 correct | unexercised · v2 over-captures |
| `changedStorybookFiles` — `preview.ts` / `test.ts` | correct (both) — except **`marketing-ui`: v2 misses** | correct (both) | correct (both) |
| `changedStorybookFiles` — **`main.ts`** | v1 correct · **v2 should-bail-but-doesn't** | v1 correct · **v2 should-bail-but-doesn't** | v1 correct · **v2 should-bail-but-doesn't** |
| `changedStaticFiles` | v1 correct · **v2 should-bail-but-doesn't** | v1 correct · **v2 should-bail-but-doesn't** | v1 correct · **v2 should-bail-but-doesn't** |
| builder-vite version gate (v2-only) | **bails unnecessarily** | unexercised | unexercised |
| `<storybookGlobals>` catch-all | correct (0 first-party members) | correct (0 first-party) | **over-captures** (201/202) |

`parity.sh`: 0 regressions on vite and webpack. Every gap below is in a class `parity.sh` structurally
cannot see.

## Ranked gaps

1. **P0 — v2 is blind to every Storybook input that is not a module in the builder graph.**
   `main.ts` and `.storybook/static/*` edits produce a byte-identical manifest on all four packages
   (`storybookHash` unchanged, 0 stories, 0 `storybookFiles`) while v1 bails on every one. Also covers
   `preview-head.html`, `manager.ts`, `package.json`, lockfiles. No stats rebuild fixes it.
2. **~~P0~~ ACCEPTED GAP — no guard for "a changed dependency traced to nothing."**
   `nodeModulesMissingInStats` needs `nodeModules.size === 0`; measured 30 / 264 / 198 / 24, so it never
   fires anywhere. **Downgraded and closed 2026-07-29: v2 matches v1 deliberately, and no per-package
   guard is possible.** Three states share one piece of evidence (a dependency name with no files in the
   stats) and only the third is a defect: the name *has* files that trace to no story (already handled —
   they sit in `<storybookGlobals>` and a bump recaptures everything); the name is genuinely not a
   preview input (`eslint`, `typescript`, `core-js` on vite — correct, and the **majority**, since
   `getDependencies.ts:52` passes `dev: true`); or the builder dropped the module (the real silent miss,
   unpatched `builder-vite` only, fixed at source by fork commit `49cd7635df7`, and missed identically by
   v1 — so not a v1-parity regression). The signal this gap originally proposed,
   `changedDependencies.length > 0 && tracedFiles.length === 0`, is therefore **unusable** — it fires on
   every dev-dep bump. `APPLIED` with an empty `onlyStoryFiles` is likewise **correct**, not a defect:
   the Index treats an empty list as "capture nothing", which is what a dev-dep-only commit should do.
   A v2-side installed-vs-manifest completeness check was ruled **out of scope** (same class as the
   already-rejected `iframe.html` guard). Full reasoning in [`bail-audit.html`](./bail-audit.html).
3. **P1 — the builder-vite gate is a version-string proxy and fires on stats that are fine.** Measured:
   the *patched* 10.6.0-alpha.3 builder is rejected on both vite fixtures. Fallback is `log.info` only,
   with no bail reason and no manifest or hash upload. rspack's much worse graph is ungated.
4. **P1 — `changedPackageFiles` has no v2 counterpart.** 0 `package.json` and 0 lockfile entries in every
   manifest. Four of nine taxonomy reasons lose their producer when v2 stops falling back.
5. **P2 — v2's `previewSubtree` key exists only if the builder emits the preview module.**
   `marketing-ui/.storybook/preview.ts` is 0 lines, vite elides it, v2 has no key, v1 bails.
6. **P2 — a set-but-unreadable stats file has no named reason** (raw `ENOENT`, swallowed by v2's generic
   catch into a silent v1 fallback).
7. **P2 — the five pre-algorithm reasons are unexercised.** Not a correctness risk for the v2 rollout
   (v1 and v2 cannot disagree about them), but uncovered.
8. **P2 informational — rspack over-captures via the catch-all.** Already ticketed.

## Corrections to established facts

- **`react` on vite: v1 now recaptures 3/3, not 0.** Against the installed *patched* builder, verdict is
  `parity`. The README's "parity cannot justify the vite edge-loss fix" is stale for a patched builder.
- **The CAP-4422 `shouldBail` check-order mis-categorization is fixed** — static dirs are tested before
  the config dir (`getDependentStoryFiles.ts:284-292`) and a `.storybook/static/*` file correctly yields
  `changedStaticFiles`.
- `missingStatsFile` is a *throw*, not a bail key: the taxonomy is 8 producible + 1 backend-supplied.
- **`core-js` measures the legitimate case, not the invisible-CJS defect.** `ui-webpack/.babelrc` sets
  `useBuiltIns: "usage"`, so babel injects 84 `core-js` modules into webpack's graph while vite injects
  none — verified against both fixtures' stats, and the *patched* vite builder still reports 0, which it
  would not if this were the `?commonjs-es-import` class. Consequence: **webpack-as-ground-truth does not
  hold for packages one builder injects and the other doesn't**; disagreement there is correct.
- Bucket composition re-confirmed: vite 27/39, webpack 49/284, rspack 201/202, marketing-ui 29/36; zero
  first-party files on vite, webpack and marketing-ui.

## Method traps for the harness README

1. `chromatic trace` never populates `ctx.storybook.staticDir`, so `changedStaticFiles` is unreachable
   through it and a static file is mis-reported as `changedStorybookFiles`.
2. `staticDir` entries are joined onto `baseDir`; pass `.storybook/static`, not `packages/ui/.storybook/static`.
3. Don't test `missingStatsFile` by deleting the file — that throws raw `ENOENT`; the bail covers only an
   *unset* path.
4. `marketing-ui/.storybook/preview.ts` is empty, so that package has no preview `storybookFiles` key.
5. Content-only edits cannot distinguish permanently-invisible (`main.ts`) from would-appear-once-populated
   (empty `preview.ts`).
6. The fixture's builder-vite is patched but still reports 10.6.0-alpha.3, so the production v2 gate fires
   on every vite fixture — record `getBuilderViteFallbackReason`'s verdict beside every vite measurement.

## Not measured

Pre-algorithm reasons (need a published build), `changedPackageFiles` Path A (needs an unparseable lockfile
diff), the unpatched-vite invisible-CJS case (installed builder is patched; shared fixture — and
**knowingly left unmeasured**, since `-d core-js` measured the legitimate case rather than this one and the
"no guard, match v1" decision is invariant to the result), whether the
`<storybookGlobals>` bucket over-captures in a way that matters (all three fixture stories depend on
everything in it), and silent under-hashing (indistinguishable from an absent file in the written manifest).
