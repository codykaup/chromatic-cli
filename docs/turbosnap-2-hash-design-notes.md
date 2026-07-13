# TurboSnap 2.0 (Hash Based TS) — Design Notes: Transport & Format Evolution

Companion to [`turbosnap-2-hash-poc.md`](./turbosnap-2-hash-poc.md). The PoC proves the hashing +
diff mechanics; this doc records the design thinking for two follow-on questions that came up in
review:

1. How do we get the hash information to the backend, given Storybooks can be huge and there's a
   ~16 MB payload limit?
2. Who computes what — does the CLI hash, does the backend hash, and is the big uploaded list
   actually used or just kept for debugging?
3. How do we evolve the manifest format over time without breaking existing builds?

Nothing here is implemented yet — it's the plan for milestones 1–4.

---

## 1. Getting the data to the backend

### The constraint is only real if everything goes through the mutation

The 16 MB ceiling is a **GraphQL mutation** limit. It only bites if we try to cram the whole
manifest into `uploadBuild`. We don't have to: the CLI **already uploads the built Storybook to S3
via presigned POST** (`node-src/tasks/upload.ts`, `lib/uploadFiles.ts`, `lib/uploadZip.ts`, with
optional zip). That path ships arbitrarily large files and never touches a GraphQL payload. The
pitch already anticipates this — hash info can arrive *"either via mutation or as raw files
alongside SB."*

So the manifest rides the existing presigned-upload path as a compressed artifact, and the
**mutation carries only a small pointer + metadata**, not the bulk data.

### What goes where

- **Mutation (small, always):** a key/pointer to the uploaded manifest artifact, the `globalHash`,
  the schema/recipe versions, and counts. Optionally a single **manifest-level rollup hash** so the
  backend can short-circuit the "byte-identical to the ancestor manifest, nothing changed" case
  without fetching and parsing the big file.
- **S3 artifact (the deduped hash list):** uploaded via the presigned path, gzip/brotli-compressed.
  Read by the backend during `uploadBuild`. **This is a primary input, not a debug sidecar** (see
  §2). The same artifact also powers the "why did this recapture?" debug view (Milestone 3).

### Keep the representation from blowing up

Big Storybooks are repetitive; the naive PoC format (per-story `{path: hash}` maps) scales with
`stories × deps` and duplicates paths/hashes heavily. Before worrying about transport, squeeze the
format:

- **Intern paths + content-dedup.** Emit one global table — `files: [[path, hash], …]` with each
  unique file once — and have each story reference **integer indices** instead of repeating
  `{path: hash}`. This turns the `stories × deps` blow-up into `unique_files + edges_as_ints`, which
  is the single biggest win because paths and file hashes are massively shared across stories.
- **Compression.** File hashes are high-entropy, but the path strings (the bulk) share prefixes and
  compress ~5–10×. Apply gzip/brotli on top of dedup.

Rough intuition at ~10k stories × ~200 deps: the naive per-story map is hundreds of MB; the deduped
table is tens of MB raw → a few MB compressed in S3. Comfortably clear of any limit in the place
that matters.

### If a mutation/HTTP endpoint is unavoidable

- **Stream it as NDJSON** — one record per line rather than a single JSON document, so neither side
  buffers the whole thing and there's no single-parse ceiling. The CLI already streams the giant
  stats file this way (`readStatsFile` → `@discoveryjs/json-ext` `parseChunked`), so the pattern is
  in-house.
- **Chunked/multipart upload** — split into sub-limit parts, reassemble server-side. Works but is
  the clunkiest option; only if the artifact path is unavailable.

---

## 2. Division of labor: who hashes, who combines, who decides

The pipeline has four steps:

1. **Trace** the per-story dependency file sets from `preview-stats.json`.
2. **Hash** each source file's contents.
3. **Combine** each story's dependency hashes (plus the global section) into one per-story hash.
4. **Compare** current vs. ancestor per-story hashes → the recapture set.

Where each step *can* run is constrained by who holds the inputs:

| Step | Runs on | Why |
| --- | --- | --- |
| 1 Trace | CLI | Needs `preview-stats.json`, produced at build time. |
| 2 Hash files | **CLI (only option)** | Only the CI machine has the source files. The backend gets the *built* (bundled) Storybook, not the source tree — and shouldn't receive source (size + privacy). Per-source-file hashes can't be recovered from bundled output. |
| 3 Combine | **Backend** | Per pitch Milestone 2/4: combine happens in `uploadBuild`, *after* the backend has picked the ancestor for each test, so it needs per-file hashes rather than a story hash the CLI baked in. |
| 4 Compare | **Backend (only option)** | Only the backend has the ancestor manifest; the CLI deliberately avoids fetching baselines (that's the point — no baseline checkout). |

### Answering the review question directly

> *"Are you saying we ship the entire list to S3 for debugging but ignore it, and upload the
> per-story hash to the backend? Should the backend do all the hashing and the CLI just ship the
> giant list?"*

- **The S3 list is not ignored.** It's the actual input the backend reads during `uploadBuild` to
  combine and compare. It doubles as the debug source, but its primary role is the decision itself.
- **The backend can't "do all the hashing."** Hashing individual files requires the file bytes,
  which live only on the CI machine. "Ship the giant list" means shipping already-computed
  *hashes*, not raw contents — shipping contents would be shipping the whole source tree.
- So the split is: **CLI hashes files + describes the graph; backend combines + decides.** The
  mutation carries a pointer + `globalHash` + versions, not the per-story hashes.

### One thing to *avoid*

Don't have the CLI pre-compute per-story **combined** hashes in addition to the backend doing it.
That duplicates the combine recipe in two codebases and they will drift. Keep the combine in exactly
one place (the backend). A single manifest-level rollup hash from the CLI is fine as a fast-path
signal (it's not the recipe); per-story combining is not.

---

## 3. Evolving the manifest format over time

The safety net is the comparability gate already prototyped as the `hashSchemaMismatch` bail
(incompatible baseline → recapture everything). The key refinement is to **split versioning into two
independent fields**, because they answer different questions.

### Two version fields

1. **`schemaVersion`** — the JSON *envelope/layout*. Question: "can I parse and read this?" Handled
   by **upgrade-on-read**: the backend keeps a small set of readers keyed by version and can
   mechanically upgrade an old ancestor when it loads it (e.g. supply a default for an added field).
   Additive, optional fields need no bump if consumers ignore unknown keys.

2. **`hashRecipe`** (a versioned `algorithm`) — *how the hashes are computed*: which files are
   included, path normalization, the per-file hash function, and the combine order/serialization.
   This is the **comparability key**. If two manifests disagree on the recipe, their hashes are not
   comparable → the diff must recapture-all for that build.

**Why split them:** if both are one number, a pure JSON reshape (layout only) would force a
fleet-wide recapture-all even though the hashes are byte-identical. With two fields you can reshape
the envelope freely as long as the recipe is unchanged, and only pay the recapture-all cost when the
hashing semantics genuinely change.

### Rules

- **Comparability rule:** compare hashes only when `hashRecipe(baseline) === hashRecipe(current)`;
  otherwise recapture-all for that one build. Every recipe migration is then safe-by-default — worst
  case is a single over-capturing build per project as new-CLI builds meet old-recipe ancestors,
  then steady state resumes. Bounded, self-healing.
- **Persist versions on every stored manifest.** The backend picks which ancestor to compare
  against, so it must read any historical version it might select. **Deploy readers before
  writers.**
- **"Do I bump?" rule of thumb:** anything that changes the bytes fed into a hash bumps
  `hashRecipe`; anything that only changes surrounding metadata is an additive `schemaVersion`
  change (or no bump). Example: moving from source-byte hashing to builder-*transformed*-content
  hashing (the Strategy B move) is a `hashRecipe` bump; adding a `generatedBy` CLI-version field is
  not.
- **Forward-compat:** consumers ignore unknown keys, so a newer CLI can add fields an older backend
  skips.
- **Namespace builder-specific quirks** under their own sub-object (`vite: {…}`, `webpack: {…}`) so
  one builder's extraction can evolve without perturbing the shared recipe or the other builders.
- Optionally carry a **`generator`** field (CLI version + builder + builder version) — invaluable
  telemetry when debugging why a specific customer's hashes churned.

### Migration playbook (recipe bump)

1. Ship backend readers/writers that understand the new recipe; keep reading old recipes.
2. Roll out the new CLI. New-CLI builds land against old-recipe ancestors → `hashRecipe` mismatch →
   one recapture-all per project (expected, bounded).
3. Once a project has a new-recipe baseline, subsequent builds compare normally again.

---

## Summary

- **Transport:** upload the (deduped, compressed) manifest as an S3 artifact via the existing
  presigned path; the mutation carries only a pointer + `globalHash` + versions + counts. The 16 MB
  mutation limit stops being relevant.
- **Roles:** CLI hashes files and describes the graph; backend combines and compares. The uploaded
  list is a primary input, not a debug-only sidecar. The backend can't hash source files — it never
  has them.
- **Evolution:** split `schemaVersion` (layout, upgrade-on-read) from `hashRecipe` (hashing
  semantics, comparability gate). Mismatched recipe → recapture-all, which makes every format
  migration safe and self-healing.
