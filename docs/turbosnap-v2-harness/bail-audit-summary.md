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
| `changedPackageFiles` Path B | **unexercised**, and v1+v2 both **should-bail-but-don't** for one dep | unexercised · v2 correct | unexercised · v2 over-captures |
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
2. **P0 — no guard for "a changed dependency traced to nothing."** `nodeModulesMissingInStats` needs
   `nodeModules.size === 0`; measured 30 / 264 / 198 / 24, so it never fires anywhere. `trace -d core-js`
   on vite → `traced`, **0 story files, no bail**; the same bump on webpack → 4. Nothing downstream
   catches it — `lib/upload.ts:196` reports `APPLIED`.
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
diff), the unpatched-vite invisible-CJS case (installed builder is patched; shared fixture), whether the
`<storybookGlobals>` bucket over-captures in a way that matters (all three fixture stories depend on
everything in it), and silent under-hashing (indistinguishable from an absent file in the written manifest).
