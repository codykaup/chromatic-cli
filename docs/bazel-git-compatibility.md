# Chromatic CLI & Git assumptions — Bazel compatibility analysis

> **Engineering analysis · chromatic-cli**

The Chromatic CLI treats a working Git repository as a hard prerequisite. This
document maps every place that assumption is baked in, explains which are fatal
vs. degrading, and proposes fixes — including changes to the Index backend.

The motivating case: a customer who **cannot use Git at all** — no `git` binary,
no `.git` directory, no history — because they build with Bazel.

---

## TL;DR

- **Git isn't optional today.** Before any environment-variable override is even
  consulted, the CLI shells out to `git --version`, `git log`, `git branch`,
  `git log --skip=1`, and `git rev-parse --show-toplevel`. In a sandbox with no
  `git` binary (as in this Bazel environment) the build **crashes immediately**.
- **The `CHROMATIC_SHA`/`CHROMATIC_BRANCH` escape hatch doesn't save them.** Those
  env vars substitute the *values* of commit/branch/slug — they do **not** stop
  the CLI from *executing* the surrounding Git commands. There is no "no-git" mode.
- **Baselines are computed client-side by walking Git history** (`git rev-list`,
  `git cat-file`) and correlating SHAs with the Index. A Bazel user has no Git
  commit graph, so ancestry resolution collapses and every build looks unrelated
  to its predecessors.
- **TurboSnap is Git-native** (`git diff` + `git show`) and simply bails to a full
  build — ironic, because Bazel knows precisely what changed and is a *better*
  change source than a git diff.
- **The good news:** the actual dependency-tracing engine (`getDependentStoryFiles`)
  is already Git-agnostic. It only needs a `changedFiles: string[]` array and a
  root path. The fix is mostly about *how those inputs are produced*, plus letting
  the Index own ancestry.

---

## 1 · The three ways Chromatic assumes Git

Everything git-related in the CLI serves one of three purposes. Understanding
these makes the failure modes obvious.

| Pillar | What it means |
| --- | --- |
| **① Build identity** | A build is identified by its **commit SHA** + **branch**. These are read from Git and sent to the Index as the primary key that ties a build to a point in history. |
| **② Ancestry & baselines** | To decide **what a snapshot is compared against**, the CLI walks the Git ancestry graph, finds commits that have prior Chromatic builds, and picks baselines. This is the load-bearing assumption. |
| **③ TurboSnap change detection** | `--only-changed` runs `git diff` between the baseline commit and the working tree to find changed files, then traces them to affected stories. |

**Why Bazel specifically collides with this.** Bazel builds are hermetic and
sandboxed: the action executes against a materialized source tree with **no
`.git` directory and no `git` binary on the PATH**. Bazel's unit of identity is a
*content hash*, not a git SHA, and its notion of "what changed" comes from the
action graph / query results — not from commit ancestry. So all three pillars
above lose their footing at once.

---

## 2 · What actually breaks

### 2.1 · Unconditional hard crashes

These run in `gatherGitInfo` and `getCommitAndBranch` on **every** build, are
**not** wrapped in try/catch, and fire *before* any env-var override is applied.

| What | Git command | Location | Impact |
| --- | --- | --- | --- |
| `getVersion` | `git --version` | `gitInfo.ts:154` | **crash** — first git call. Errors out instantly if git is missing. |
| `getCommit` | `git --no-pager log -n 1` | `getCommitAndBranch.ts:55` | **crash** — base call is uncaught. |
| `getBranch` | `git branch --show-current` (+ fallbacks) | `getCommitAndBranch.ts:56` | **crash** — unless `--branch-name` / `patchBaseRef` supplied. |
| `hasPreviousCommit` | `git log -n 1 --skip=1` | `getCommitAndBranch.ts:92` | **crash** in CI (throws `gitOneCommit`); warns locally. Runs *before* the env-var branch. |
| `getRepositoryRoot` | `git rev-parse --show-toplevel` | `gitInfo.ts:170` | **crash** — sets `git.rootPath`, later required by TurboSnap. |
| `getParentCommits` | `git rev-list HEAD …` | `getParentCommits.ts:107, 197` | **crash** — fires as soon as the project has *any* prior build. Skipped only for a brand-new app. |
| local-build email gate | `git config user.email` | `gitInfo.ts:191–193` | **crash** — local (non-CI) builds throw `gitUserEmailNotFound` if empty. |

> **Bonus footgun: "git not installed" is detected by string-matching.**
> `execGitCommand` only recognizes a missing binary if the error text contains
> the literal `'git not found'` (`execGit.ts:71–73`). A truly absent binary
> usually surfaces as `ENOENT` / "command not found", which falls through to a
> **raw, unhelpful re-throw** (`execGit.ts:79`). So the Bazel user won't even get
> the friendly "Chromatic only works with Git installed" message — they'll get a
> cryptic shell error.

### 2.2 · The env-var escape hatch — and why it isn't one

The intended override for non-standard environments is the pair `CHROMATIC_SHA`
+ `CHROMATIC_BRANCH` (plus optional `CHROMATIC_SLUG`, `CHROMATIC_PULL_REQUEST_SHA`),
used by Chromatic's own GitHub Action.

```js
// getCommitAndBranch.ts
const commit = await getCommit(deps);                 // ← line 55, ALWAYS runs, uncaught
let branch  = notHead(branchName) || … getBranch();   // ← line 56, runs unless branchName set
if (!(await hasPreviousCommit(deps))) { … }           // ← line 92, ALWAYS runs first
…
const isFromEnvironmentVariable = CHROMATIC_SHA && CHROMATIC_BRANCH;  // ← line 87, consulted LATER
if (isFromEnvironmentVariable) { commit = …; branch = CHROMATIC_BRANCH; }  // only overrides VALUES
```

The env vars change *what* commit/branch are reported, but the git binary is
still invoked at lines 55, 56, and 92 — and back in the task at `getVersion`,
`getRepositoryRoot`, and `getParentCommits`. **Setting `CHROMATIC_SHA`/`CHROMATIC_BRANCH`
alone does not make the CLI git-free.**

### 2.3 · TurboSnap (`--only-changed`)

TurboSnap depends on git in three spots, all of which fail without real history:

| Step | Git dependency | Location |
| --- | --- | --- |
| Changed-file list | `git diff --name-only <baseline> <head>` | `git.ts:210` |
| Dependency (lockfile) diff | `git show <commit>:<file>` to read baseline manifests | `git.ts:442` · `findChangedDependencies.ts:159` |
| Manifest discovery / root | `git ls-files`, `git rev-parse --show-toplevel` | `git.ts:509, 496` |

Failures here are caught and converted into a TurboSnap "bail"
(`gitInfo.ts:381–392`), so the build still completes — but as a **full snapshot
of every story**, losing the entire cost/speed benefit the customer is paying for.

> **Key insight for the fix.** The tracing engine itself — `getDependentStoryFiles`
> — has **zero git calls**. It consumes `ctx.git.changedFiles` (a plain `string[]`)
> plus `ctx.git.rootPath` and the Storybook stats file. If we can feed
> `changedFiles` from a non-git source, TurboSnap works end-to-end. Bazel is an
> *ideal* such source.

### 2.4 · Patch builds (`--patch-build`) & workspace tasks

`prepareWorkspace` hard-fails on `isClean` (`git status --porcelain`),
`findMergeBase`, and `checkout`; `restoreWorkspace` runs `git reset --hard` /
`git checkout -`. These only run with `--patch-build`, so they're a secondary
concern — but they're wholly unusable without git.

### 2.5 · What already degrades gracefully (no action needed)

- `getUserEmail`, `getUncommittedHash`, `getSlug` — caught in `gatherGitInfo`,
  default to `undefined`.
- All project metadata — `getRepositoryCreationDate`, `getStorybookCreationDate`,
  `getNumberOfCommitters`, `getCommittedFileCount` — wrapped in try/catch, return
  `undefined` (they're explicitly documented as "not necessary for the build").
- `isUpToDate` returns `true` on error; `commitExists` returns `false`; the
  `--skip` path and the share/upload `getRepositoryRoot` both swallow errors.

---

## 3 · Root cause, in one sentence

> The CLI **both executes git plumbing unconditionally** (build identity) **and
> performs ancestry resolution on the client using the git commit graph**
> (baselines). A git-less environment has neither the binary nor the graph, so
> there is no supported path for it to produce a correct, baseline-linked build.

---

## 4 · Proposed solutions

Two tracks: **CLI changes** to stop requiring git and to accept external inputs,
and **Index (backend) changes** to own ancestry when the client can't. The most
robust answer combines a small CLI change with the Index taking over baseline
selection.

### CLI-side

**1. A first-class "external SCM / no-git" mode** *(enabler)*

Introduce an explicit mode (e.g. `--no-git`, or auto-detected when the git binary
is absent) that:

- Requires **commit + branch** to be supplied via flags/env (reuse
  `CHROMATIC_SHA`/`CHROMATIC_BRANCH`). The "commit" can be any opaque revision
  Bazel provides — a workspace status stamp (`--workspace_status_command`), the
  underlying VCS revision if known, or a content hash.
- **Skips** `getVersion`, `getRepositoryRoot`, `getBranch`, `hasPreviousCommit`,
  and the `getParentCommits` git walk entirely.
- Guards the few remaining uncaught git calls so absence is never fatal.

*This is the minimum change that stops the immediate crashes. On its own it
produces builds with no baseline linkage — pair with #4/#5.*

**2. Accept an externally-supplied changed-files list for TurboSnap** *(high value, low risk)*

Add `--changed-files` / `--changed-files-from <file>` that populates
`ctx.git.changedFiles` directly, short-circuiting the baseline-diff step. Because
`getDependentStoryFiles` is already git-agnostic, tracing then runs unchanged.

Bazel can generate this list precisely (`bazel query` / rdeps against the changed
targets, or comparing action-graph hashes) — arguably **more accurate than
`git diff`**. Today's `--only-story-files` is a cruder cousin (it names story
files and skips tracing); a changed-files input keeps the full dependency graph.

**3. Harden git-absence detection & messaging** *(quick win)*

Broaden the `execGitCommand` classifier to catch `ENOENT`/"command not found", so
a missing binary yields the intended friendly guidance instead of a raw shell
error (`execGit.ts:71–79`). Cheap, and improves every non-standard environment,
not just Bazel.

### Index (backend)-side

**4. Move ancestry resolution server-side ("linear / branch-based baselines")** *(core fix)*

Today the CLI walks `git rev-list` and asks the Index "which of these commits have
builds?". For git-less projects, invert it: the CLI sends only
`{ revision, branch, [parentRevision] }` and the Index selects the baseline. The
simplest correct strategy that needs **no commit graph**:

- **Baseline = the previous build on the same branch** (plus the standard
  cross-branch rules the Index already applies on merge). This is a slightly
  weaker model than true git ancestry, but it's well-defined, requires zero
  client git, and matches how many users mentally model "compare to last time".
- Gate it behind a per-project / per-build flag (e.g. `externalScm: true` on
  `announceBuild`) so existing git users are unaffected.

*The Index already receives `branch`, `commit`, `parentCommits`, and `committedAt`
on `AnnounceBuildMutation` — this extends the mutation rather than reinventing it.*

**5. Decouple build identity from git SHAs (opaque revisions + client-declared parents)** *(core fix)*

Let the Index store an **opaque revision identifier** (not assumed to be a
40-char git SHA) and accept **explicitly-declared parent build(s)** — e.g.
`parentBuildIds` or `parentRevisions` on `announceBuild`. Bazel/CI knows its own
predecessor (the last build it produced on this pipeline) and can name it
directly, giving correct baseline continuity without any ancestry graph.

**6. Optional: ingest a commit graph out-of-band** *(larger effort)*

For customers who *do* have git upstream but not in the build sandbox, allow
feeding the parent/commit relationships to the Index via the Git provider
integration (GitHub/GitLab app) or a lightweight "report ancestry" call, so the
Index can reconstruct the graph server-side and keep full-fidelity baselines.
Heaviest option; only worth it if linear baselines (#4) prove insufficient.

---

## 5 · Recommended path

1. **Phase 1 (unblock):** #3 (better detection) + #1 (no-git mode) + extend
   `announceBuild` with `externalScm` and a declared parent (#5). Result: git-less
   builds succeed and are correctly baselined against the previous build on the
   branch (#4, linear mode).
2. **Phase 2 (restore TurboSnap):** #2 (external changed-files input). Result:
   Bazel users get change-based snapshotting again, fed by Bazel's own change
   detection.
3. **Phase 3 (optional fidelity):** #6, only if customers need true multi-branch
   ancestry semantics.

Phase 1's Index work is the load-bearing piece: **without server-side/declared
ancestry, no amount of CLI patching gives a git-less user correct baselines.** The
CLI changes are comparatively small because the hard parts (tracing) are already
git-agnostic.

---

*Sources are file:line references into `node-src/`. Primary files: `git/execGit.ts`,
`git/git.ts`, `git/getCommitAndBranch.ts`, `git/getParentCommits.ts`,
`git/getBaselineBuilds.ts`, `git/getChangedFilesWithReplacement.ts`,
`tasks/gitInfo.ts`, `tasks/initialize/announceBuild.ts`, `tasks/prepareWorkspace.ts`.
A rendered HTML version of this document lives alongside it at
[`bazel-git-compatibility.html`](./bazel-git-compatibility.html).*
