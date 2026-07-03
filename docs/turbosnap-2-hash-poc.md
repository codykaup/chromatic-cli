# TurboSnap 2.0 (Hash Based TS) — CLI Proof of Concept

This is a **proof of concept** for the CLI side of [TurboSnap 2.0 (Hash Based
TS)](https://www.notion.so/chromatic-ui/TurboSnap-2-0-Hash-Based-TS-3836e8162034809a86bee987beae86fd).
It demonstrates that a build's "which stories changed?" question can be answered by **diffing content
hashes** between two builds, with **no `git diff`, no lockfile parsing, and no baseline checkout**.

> Scope: this PoC only implements the **CLI side**. It produces a JSON manifest with all the
> information the Index would need, and proves the diff works entirely locally by comparing the
> manifest against one from a previous run. It does **not** touch the Index/API, the `uploadBuild`
> mutation, or the actual capture pipeline.

## The idea in one paragraph

TurboSnap 1.0 starts from a `git diff` and traces _forward_ through the builder's module graph to
find which story files depend on a changed file. That requires git, checked-out file blobs for the
baseline, and a bunch of lockfile/`node_modules` reconstruction. TurboSnap 2.0 flips it around: for
**every** story file we trace _downward_ through the module graph to collect the complete set of
source files it depends on, hash each of those files, and fold them into a **single hash per story**.
To decide what changed between two builds you just compare the per-story hashes. Same hash → copy the
baseline snapshot. Different hash → recapture.

## What this PoC adds

Two new CLI subcommands and the library code behind them:

| Command | What it does |
| --- | --- |
| `chromatic hash-manifest` | Reads `preview-stats.json`, traces per-story dependencies, hashes them on disk, and writes a `chromatic-hashes.json` manifest. |
| `chromatic hash-diff <baseline.json> <current.json>` | Compares two manifests and prints exactly which stories must be recaptured. |

Source layout:

- `node-src/lib/turbosnap/buildStoryHashes.ts` — pure graph tracing (stats → per-story dependency
  file sets + global/shared set). The mirror image of `getDependentStoryFiles.ts` (TS 1.0).
- `node-src/lib/turbosnap/hashManifest.ts` — hashing (reuses the existing `getFileHashes` xxhash
  helper), manifest assembly, and `diffManifests`.
- `bin-src/hashManifest.ts`, `bin-src/hashDiff.ts` — the CLI entrypoints.

## Manifest format

```jsonc
{
  "schemaVersion": 1,
  "algorithm": "xxhash64",
  "storybook": { "configDir": ".storybook", "baseDir": "", "staticDirs": [] },
  "csfGlobs": ["node-src/ui/..."],
  "global": {
    "hash": "….",                       // one hash for the whole shared section
    "files": { ".storybook/preview.tsx": "3f2a…" },
    "unhashable": [{ "path": "external \"react\"", "reason": "external", "hash": "external:…" }]
  },
  "stories": {
    "node-src/ui/components/link.stories.ts": {
      "hash": "9c1b…",                   // folds in global hash + story-local hash
      "files": {
        "node-src/ui/components/link.stories.ts": "aa11…",
        "node-src/ui/components/link.ts": "bb22…"
      },
      "unhashable": []
    }
  },
  "summary": { "storyCount": 42, "fileCount": 118, "missingFileCount": 447, "unhashableCount": 6 }
}
```

- Each story hash = `combine(globalHash, combine(storyFile + all its dependency file hashes))`.
  Folding in the global hash means a Storybook-config change invalidates every story (the TS 1.0
  `changedStorybookFiles` bail, expressed as a hash).
- The per-file `files` map is kept for **debuggability** (pitch Milestone Three): when a story's hash
  changes, `hash-diff` can point at the exact dependency file whose hash changed.

## Trying it

```sh
# Build once, snapshot the hashes as the baseline:
yarn hash-manifest -s ./storybook-static/preview-stats.json -o baseline-hashes.json

# ...make some source changes, rebuild Storybook...
yarn hash-manifest -s ./storybook-static/preview-stats.json -o current-hashes.json

# See exactly which stories need recapture:
yarn hash-diff baseline-hashes.json current-hashes.json
```

`hash-diff` exits `1` when there's anything to recapture and `0` when everything matches, so it drops
straight into CI.

## Edge cases found along the way

These are the interesting bits — the places where "just hash the files" isn't quite enough. Several
line up with the open questions in the pitch.

1. **The stats only record incoming edges (`reasons`).** To trace a story's dependencies we have to
   _invert_ the graph into outgoing edges. Done in `buildStoryHashes`.

2. **Story-to-story leakage via the CSF glob.** Every story file is a child of the builder-generated
   CSF "glob" module, and stories can import other stories (CSF composition). If we naively followed
   every edge we'd pull the entire Storybook into each story. We stop traversal at the CSF glob so a
   story only collects _its own_ subtree. (Direct story→story imports are still followed, matching the
   pitch note that "stories can depend on other stories".)

3. **Not every module is a hashable file.** Modules come in three flavors:
   - real files → hashed from disk (xxhash64);
   - **externals** (`external "__STORYBOOK_MODULE_PREVIEW_API__"`, `external "react"`) → no file to
     hash, recorded with a synthetic `external:<name>` hash;
   - **virtual modules** (Vite's `/virtual:/…`) and webpack bundle/namespace containers
     (`foo.js + 3 modules`, `… lazy …`) → recorded as `virtual:<name>`, or expanded to their
     constituent `modules` when the stats provide them.

   The synthetic hashes are **content-free**: they change if the _set_ of externals changes but not if
   an external's _contents_ change. That's a known PoC limitation → for `node_modules` the pitch's
   preferred answer is to hash the module contents (Strategy B) rather than sniff versions.

4. **Files referenced by the builder but absent on disk.** Under Yarn PnP (this very repo!) there is no
   `node_modules/` directory, so `node_modules/*` paths from the stats don't exist to hash. A single
   missing file must not fail the whole run, so we record it with a `"<missing>"` sentinel and keep
   going. `missingFileCount` surfaces how many. In production the builder plugins would emit
   already-hashed module content (per the pitch), sidestepping this entirely.

5. **`.storybook/main.js` and `preview.js` frequently aren't in the graph.** This is called out in the
   pitch as an open question. We collect whatever config-dir modules the stats _do_ expose into the
   global section, but modules Storybook doesn't surface in `preview-stats.json` are a **known blind
   spot** for the PoC. Fully solving it needs builder-plugin changes (pitch Milestone One).

6. **Raw source-byte hashing can under-detect.** Transform-driven changes (env inlining, alias
   retargeting, asset handling) can change a module's _output_ without changing its source bytes. This
   PoC hashes source bytes (cheap, reuses `getFileHashes`); the pitch's recommendation is to hash the
   builder-_transformed_ module content (Strategy B). Noted as a deliberate PoC simplification.

7. **Path normalization must match `git diff`.** We reuse TS 1.0's `normalizePath` + `?query` trimming
   so hashed paths line up with what the rest of the system already uses, and so a manifest is portable
   regardless of which subdirectory the stats were generated in (`--storybook-base-dir`).

8. **Schema/algorithm drift.** If a baseline manifest was written by a different schema version or hash
   algorithm, the hashes aren't comparable. `diffManifests` detects this and recaptures everything —
   the new-and-narrow `hashSchemaMismatch` bail, instead of a silently-wrong diff.

9. **`--untraced` still applies.** The existing escape hatch for ignoring files (and their deps) is
   honored during tracing, so hashes don't churn on files a user has explicitly opted out of.

## Bails this eliminates vs. introduces

Because change detection no longer depends on git or lockfiles, the whole
`changedPackageFiles`/`invalidChangedFiles` family of bails (baseline checkout failed, lockfile parse
failed, missing git ancestry, `node_modules` reconstruction) simply cannot occur. The only new failure
modes are `baselineHashesMissing` (first build / no ancestor manifest — recapture all) and
`hashSchemaMismatch` (handled above).

## What a real implementation would change

- Emit hashes from the **builder plugins** (transformed module content), rather than post-hashing
  source files from disk, to fix edge cases 3, 5, and 6.
- Upload the manifest alongside the build and fetch the ancestor manifest on the Index side; move the
  `diffManifests` comparison into the `uploadBuild` mutation (pitch Milestone Two).
- Persist the dependency path for each recaptured story to power the debuggability UI (Milestone
  Three).
