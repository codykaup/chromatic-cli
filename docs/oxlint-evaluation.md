# oxlint evaluation (prototype)

This is a working prototype that adds [oxlint](https://oxc.rs/docs/guide/usage/linter)
as a fast first-pass linter in front of the existing ESLint setup. It exists to answer:
does it make sense to adopt oxlint, what do we gain, what do we lose, and how much faster is it?

**TL;DR:** oxlint reproduces **217** of our lint rules and runs them in **~0.15s** (vs.
a 26s cold / 3.3s warm ESLint run). But it cannot replace ESLint yet — our most expensive
rule, the type-aware `@typescript-eslint/no-floating-promises`, plus Prettier, JSDoc,
`no-secrets`, `security`, `simple-import-sort` and `sort-class-members` have no native
oxlint equivalent. Because ESLint still has to run (and is dominated by the type-aware
TypeScript program build), the **full hybrid gate is not faster end-to-end**. The real
value today is near-instant feedback for the covered rules in editors / pre-commit, and a
clear path to a big speedup once oxlint's type-aware mode leaves alpha.

## How the prototype is wired up

| Piece | Change |
| --- | --- |
| `.oxlintrc.json` | Generated with `@oxlint/migrate` from `eslint.config.mjs`, then curated. Runs ESLint-core + `typescript` + `unicorn` + `oxc` rules natively (217 rules). |
| `eslint.config.mjs` | Appends `oxlint.buildFromOxlintConfigFile('./.oxlintrc.json')` (last, so it wins) to turn off every rule oxlint now owns, leaving ESLint to run only the gap rules. |
| `package.json` | `lint` now runs `lint:oxlint` (fast fail) then `lint:js` (ESLint for the gaps). |

`yarn lint` is green with this setup.

## Performance

Measured on this repo (433 files, 4-core container), oxlint `1.70.0`, eslint `9.39.4`.
"Cold" = cache cleared; "warm" = ESLint cache populated.

| Setup | Cold | Warm |
| --- | --- | --- |
| **ESLint only** (baseline, today) | 25.95s | 3.27s |
| **oxlint standalone** (the 217 covered rules) | **0.15s** | **0.15s** |
| Hybrid `yarn lint` (oxlint → ESLint) | 22.7s | 4.5s |

Supplementary measurements that explain the numbers:

- ESLint running only the gap rules **without** type-aware linting (`project: false`):
  **~13s** uncached. Re-enabling the single type-aware rule `no-floating-promises`
  (which forces `project: true` and a full TypeScript program build) adds **~7–9s** and is
  the dominant cost of the ESLint pass.
- Invoking oxlint through `yarn` adds ~0.9s of Node/yarn startup (0.15s binary → ~1s script).

### What the numbers mean

- oxlint runs our 217 covered rules **~170× faster** than a cold ESLint run and **~22× faster**
  than a warm one.
- The full **hybrid gate is not a speed win** — it's marginally *slower* on warm runs (4.5s vs
  3.3s) because ESLint still has to do its expensive type-aware pass and we now pay for a second
  process on top.
- The achievable wins are: (1) sub-second feedback for the covered rules in editors and
  pre-commit hooks, and (2) a path to delete the ~20s type-aware ESLint pass entirely once
  oxlint's type-aware mode is production-ready.

## What we gain

- **Near-instant feedback** (0.15s) for 217 of our rules — great for editor LSP and pre-commit.
- **`oxc`-unique rules** — extra correctness checks ESLint doesn't have.
- A migration on-ramp: `@oxlint/migrate` did most of the config translation automatically.

## What we lose / friction encountered

- **No type-aware rules (stable).** `@typescript-eslint/no-floating-promises` stays in ESLint.
  oxlint's type-aware mode exists but is **alpha** — too early to gate CI on.
- **No native equivalent** for: Prettier (`eslint-plugin-prettier`), `eslint-plugin-no-secrets`,
  `eslint-plugin-security`, `eslint-plugin-simple-import-sort`, `eslint-plugin-sort-class-members`,
  and `eslint-plugin-jsdoc` (most rules). These all remain ESLint's job.
- **`eslint-plugin-eslint-comments`** is only available via oxlint's **alpha JS-plugin bridge**;
  kept in ESLint to avoid depending on alpha tooling.
- **`--report-unused-disable-directives` had to be turned off** (in both tools). With rules split
  across two linters, neither tool sees the full rule set, so each produces false "unused
  directive" reports (e.g. an `eslint-disable unicorn/prevent-abbreviations` comment looks unused
  to oxlint because oxlint doesn't implement that rule). This is a real regression vs. today.
- **Inline rule-option overrides are unsupported.** oxlint honors `disable` directives but not
  `/* eslint max-lines: ["error", 550] */`; `node-src/tasks/gitInfo.ts` needed an explicit
  per-file override in `.oxlintrc.json` to match the existing intent.
- **Rule-implementation divergences.** oxlint's Rust implementations of `complexity`,
  `no-unsafe-optional-chaining` and `unicorn/consistent-function-scoping` are stricter than
  ESLint's and flagged code ESLint passes. These rules are deferred to ESLint (still enforced
  there) via per-file overrides in `.oxlintrc.json`.
- **~22 unicorn + JSDoc rules and `unicorn/prevent-abbreviations`** are not yet implemented in
  oxlint and stay in ESLint.

## Recommendation

Adopt oxlint **as a complement, not a replacement** (this prototype). It's an easy, reversible
add that gives instant feedback for most rules. Hold off on dropping ESLint until:

1. oxlint's **type-aware** mode is production-ready (lets us drop the ~20s `no-floating-promises`
   pass — the single biggest lever), and
2. we decide how to cover `no-secrets` / `sort-class-members` (oxlint JS plugins, or accept the loss).

At that point a full migration would take linting from ~26s/3.3s to well under a second.
