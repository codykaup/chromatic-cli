# TurboSnap v2: relocation-stable hashes

**Date:** 2026-07-22
**Status:** Design approved, pending implementation plan
**Area:** `node-src/lib/turbosnap/v2`

## Problem

TurboSnap v2 (`buildManifest` in `node-src/lib/turbosnap/v2/manifest.ts`) uploads two things
to the Index that drive change detection:

- `storyFileHashes` — a map keyed by **file path**, where each value is an xxhash of the
  concatenated content-hashes of a story's transitively-imported files.
- `storybookHash` — a hash of all the story-file hash values.

The Index matches stories **by their path key** across builds to decide which stories changed.
This breaks when the Storybook project moves inside a monorepo, in two independent ways:

1. **The story key.** Today the key comes from the raw stats `module.name`, which is relative to
   whatever context the builder ran in — sometimes the project directory, sometimes the repo root.
   The CLI does not control this. When the project relocates (e.g. `packages/ui` →
   `packages/design-system`, or nesting it deeper), every key can change, so the Index can no
   longer line up "same story, old build" with "same story, new build."

2. **The hash value.** The per-story hash joins dependency content-hashes in **path-sorted** order
   (`manifest.ts:97-99`). A dependency outside the project keeps a `../` relative path, and the
   relative distance to it changes when the project moves (`../shared` → `../../packages/shared`).
   That reordering changes the hash even though no file content changed.

## Scope

Must survive without falsely re-snapshotting unchanged stories:

- **Whole-project move / rename** — the project's internal layout is unchanged; only its location
  in the repo changes.
- **Repo restructure around the project** — shared dependency packages move elsewhere in the repo
  while the story files themselves stay put.

Explicit non-goal:

- **Moving a file within the project** (e.g. `src/Button.stories.tsx` →
  `src/components/Button.stories.tsx`) gets a new key and will re-snapshot once. Solving this would
  require content-based story identity, which is out of scope.

## Guiding principle

Only **content** determines a story's hash value, and only its **project-relative location**
determines its key. Nothing about where the project sits within the repo should leak into either.

## Design

### 1. Path re-anchoring

Introduce a single canonical anchor: the **absolute Storybook project root** =
`path.resolve(ctx.git.rootPath, ctx.storybook.baseDir)`. `baseDir` is "the directory you run
Storybook from" and is already computed relative to the git root by
`getStorybookBaseDirectory` (`node-src/lib/getStorybookBaseDirectory.ts`).

Every path in the manifest — story keys, `files` keys, and dependency entries — is normalized to
POSIX and expressed relative to that anchor:

- Relative stats paths (`./src/x`) are already project-relative → strip the leading `./`
  (today's behavior, retained).
- Absolute stats paths (`/repo/packages/ui/src/x`) → relativized against the anchor → `src/x`.
- External dependencies remain as `../shared/x`. They are never story keys, and §2 makes their
  ordering irrelevant to the hash.

This replaces two ad-hoc normalizations that exist today:

- `normalizePath` in `writeManifest` (strips `./` only) → re-anchor to the project root.
- `isHashable` / `hashFiles` using `process.cwd()` → hash files relative to the anchor instead, so
  hashing works regardless of which directory the CLI or the builder ran from.

### 2. Order-independent hashing

- **Per-story hash** (`manifest.ts:97-99`): stop sorting dependency *paths*. Instead collect each
  dependency's content-hash, **sort the hash strings**, then join. The result depends only on the
  *set* of content hashes, so any move that preserves content preserves the hash.
- **Storybook hash** (`manifest.ts:102`): today it joins story-hash values in Map-insertion order,
  which follows webpack module order and is not stable across builds. **Sort the story-hash values
  before joining.**

### 3. Include leaf-dependency content in the hash

There is a latent gap in the current per-story hash. The `files` map is keyed only by files that
are *importers* (files that import something else); a **leaf** dependency — a file that imports
nothing, e.g. a shared CSS file, an SVG, or a pure constants module — is never a key in `files`. So
`files.get(leaf)?.hash` is `undefined` and the leaf contributes `''`: its content is dropped from
the story hash, and editing it would not re-snapshot the story.

`collectTransitiveDependencies` already returns the full set of transitive paths (leaves included);
the bug is only that the hash lookup reads from `files` (the dependency graph) rather than from the
`hashes` map (content hashes for *every* hashed file). The fix is to source the combine from
`hashes.get(filePath)`:

```ts
const combined = [...collectTransitiveDependencies(files, storyFile)]
  .map((filePath) => hashes.get(filePath) ?? '')
  .sort()
  .join('');
```

This both fixes the leaf-content gap and is where the sorted-by-hash ordering from §2 lives.

### 4. Threading the anchor into v2

`buildManifest` currently receives only `stats`. It needs the anchor. `TraceChangedFilesInput`
(`node-src/lib/turbosnap/v2/index.ts`) gains the resolved project root, passed from `ctx` by the
top-level `traceChangedFiles` (`node-src/lib/turbosnap/index.ts:33`). If `rootPath` or `baseDir`
are unavailable, fall back to `process.cwd()` (current behavior) so nothing regresses.

## Edge cases

- **Windows**: all keys are forced through the existing `posix()` helper so hashes match across
  mixed-OS teams.
- **Missing / virtual files**: unchanged. Virtual modules and unhashable files keep contributing
  the empty string `''`, which now sorts deterministically among the content-hashes.
- **Missing base directory**: when the repo root is known but the Storybook base directory is not
  (e.g. a non-monorepo where Storybook lives at `<repo_root>/.storybook`), anchor at the repo root.
  Only when the repo root itself is unknown do we fall back to `process.cwd()`.

## Testing

- Unit tests for the new normalization: relative paths, absolute paths, and external `../` paths.
  (No Windows-separator assertion — `posix()` keys off `path.sep`, so backslash conversion only
  occurs on Windows and such an assertion would fail on macOS/Linux CI.)
- **Leaf-inclusion test**: changing a leaf dependency's content changes the story hash.
- **Project-moved test**: identical `storyFileHashes` keys *and* values before/after relocating the
  anchor with unchanged content.
- **Dependency-moved test**: unchanged per-story hash when a dependency's path shifts (reordering it
  among its siblings) but its content does not.
- **Storybook-hash stability test**: identical `storybookHash` when the story set and content are
  unchanged but module iteration order differs.

## Files touched

- `node-src/lib/turbosnap/v2/manifest.ts` — re-anchoring, order-independent hashing.
- `node-src/lib/turbosnap/v2/index.ts` — extend `TraceChangedFilesInput` with the anchor.
- `node-src/lib/turbosnap/index.ts` — pass the resolved project root from `ctx`.
- Tests alongside the above.
