# TurboSnap v2 Relocation-Stable Hashes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TurboSnap v2 story-file keys and hashes invariant when the Storybook project moves within a monorepo, so unchanged stories are not falsely re-snapshotted.

**Architecture:** Re-anchor every stats module path to a canonical project-relative POSIX form (relative to the Storybook base directory) so the *identity* uploaded to the Index is stable; source per-story hashes from the content-hash map (so leaf dependencies are included) and combine them in sorted-by-hash order so the *hash value* depends only on content, not on path ordering.

**Tech Stack:** TypeScript (Node), Vitest, `xxhash-wasm`, existing `getFileHashes` and `posix` helpers.

## Global Constraints

- All manifest paths (story keys, `files` keys, dependency entries) are POSIX, produced via the existing `posix()` helper (`node-src/lib/posix.ts`).
- The canonical anchor is the absolute Storybook project root = `path.resolve(ctx.git.rootPath, ctx.storybook.baseDir)`. When `rootPath` or `baseDir` is unavailable, fall back to `process.cwd()`.
- Only file **content** may affect a story's hash value; only its **project-relative path** may affect its key. Nothing about the project's location in the repo may leak into either.
- Follow existing repo conventions: `function` declarations for exported functions (helpers below them), no mutating caller-owned arguments.
- Verify every task with `yarn typescript:check` (no output means success) and `yarn lint --quiet` before committing.
- Run single test files with `yarn vitest run <path>`.

## File Structure

- **Create** `node-src/lib/turbosnap/v2/paths.ts` — two pure helpers: `normalizeStatsPath` (stats path → canonical project-relative POSIX path) and `resolveStatsPath` (stats path → absolute on-disk path for hashing). Single responsibility: path canonicalization. Isolated so it is unit-testable without fs or stats.
- **Create** `node-src/lib/turbosnap/v2/paths.test.ts` — unit tests for the helpers.
- **Create** `node-src/lib/turbosnap/v2/manifest.test.ts` — tests for normalized keys, leaf inclusion, and relocation-stable hashing.
- **Modify** `node-src/lib/turbosnap/v2/manifest.ts` — normalize keys at build time, hash by absolute path, include leaf content, order-independent hashing, simplify `writeManifest`.
- **Modify** `node-src/lib/turbosnap/v2/index.ts` — add `projectRoot` to `TraceChangedFilesInput`, pass it to `buildManifest`.
- **Modify** `node-src/lib/turbosnap/index.ts` — compute the anchor from `ctx` and pass it into v2.

---

### Task 1: Path canonicalization helpers

**Files:**
- Create: `node-src/lib/turbosnap/v2/paths.ts`
- Test: `node-src/lib/turbosnap/v2/paths.test.ts`

**Interfaces:**
- Consumes: `posix` from `node-src/lib/posix.ts`.
- Produces:
  - `normalizeStatsPath(statsPath: string, projectRoot: string): string`
  - `resolveStatsPath(statsPath: string, projectRoot: string): string`

- [ ] **Step 1: Write the failing test**

Create `node-src/lib/turbosnap/v2/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { normalizeStatsPath, resolveStatsPath } from './paths';

const projectRoot = '/repo/packages/ui';

describe('normalizeStatsPath', () => {
  it('strips a leading ./ from an already project-relative path', () => {
    expect(normalizeStatsPath('./src/Button.stories.tsx', projectRoot)).toBe(
      'src/Button.stories.tsx'
    );
  });

  it('relativizes an absolute path against the project root', () => {
    expect(normalizeStatsPath('/repo/packages/ui/src/Button.stories.tsx', projectRoot)).toBe(
      'src/Button.stories.tsx'
    );
  });

  it('keeps external dependencies as a ../ path relative to the project root', () => {
    expect(normalizeStatsPath('/repo/packages/shared/theme.ts', projectRoot)).toBe(
      '../shared/theme.ts'
    );
  });

  it('returns virtual modules unchanged', () => {
    expect(
      normalizeStatsPath('virtual:@storybook/builder-vite/storybook-stories.js', projectRoot)
    ).toBe('virtual:@storybook/builder-vite/storybook-stories.js');
  });
});

describe('resolveStatsPath', () => {
  it('resolves a relative path against the project root', () => {
    expect(resolveStatsPath('./src/x.ts', projectRoot)).toBe('/repo/packages/ui/src/x.ts');
  });

  it('returns an absolute path unchanged', () => {
    expect(resolveStatsPath('/repo/packages/shared/theme.ts', projectRoot)).toBe(
      '/repo/packages/shared/theme.ts'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run node-src/lib/turbosnap/v2/paths.test.ts`
Expected: FAIL — cannot resolve module `./paths`.

- [ ] **Step 3: Write minimal implementation**

Create `node-src/lib/turbosnap/v2/paths.ts`:

```ts
import path from 'path';

import { posix } from '../../posix';

/**
 * Converts a stats module path into a canonical POSIX path relative to the Storybook project root,
 * so a file keeps the same identity when the project moves within the repository. Virtual modules
 * (e.g. Vite's `virtual:` entries) have no on-disk location and are returned unchanged.
 *
 * @param statsPath The module name from the stats file (relative like `./src/x` or absolute).
 * @param projectRoot The absolute Storybook project root to anchor against.
 *
 * @returns The canonical project-relative POSIX path.
 */
export function normalizeStatsPath(statsPath: string, projectRoot: string): string {
  if (statsPath.includes('virtual:')) return statsPath;

  const stripped = statsPath.replace(/^\.\//, '');
  return path.isAbsolute(stripped) ? posix(path.relative(projectRoot, stripped)) : posix(stripped);
}

/**
 * Resolves a stats module path to an absolute on-disk path for hashing, anchoring relative paths at
 * the Storybook project root.
 *
 * @param statsPath The module name from the stats file.
 * @param projectRoot The absolute Storybook project root to anchor against.
 *
 * @returns The absolute path to the file on disk.
 */
export function resolveStatsPath(statsPath: string, projectRoot: string): string {
  const stripped = statsPath.replace(/^\.\//, '');
  return path.isAbsolute(stripped) ? stripped : path.resolve(projectRoot, stripped);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run node-src/lib/turbosnap/v2/paths.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify types and lint**

Run: `yarn typescript:check` (expect no output) and `yarn lint --quiet` (expect no output).

- [ ] **Step 6: Commit**

```bash
git add node-src/lib/turbosnap/v2/paths.ts node-src/lib/turbosnap/v2/paths.test.ts
git commit -m "Add project-relative path helpers for TurboSnap v2"
```

---

### Task 2: Normalize manifest keys and thread the project root

**Files:**
- Modify: `node-src/lib/turbosnap/v2/manifest.ts`
- Modify: `node-src/lib/turbosnap/v2/index.ts`
- Modify: `node-src/lib/turbosnap/index.ts`
- Test: `node-src/lib/turbosnap/v2/manifest.test.ts`

**Interfaces:**
- Consumes: `normalizeStatsPath`, `resolveStatsPath` from `./paths` (Task 1); `getFileHashes` from `node-src/lib/getFileHashes.ts`.
- Produces: `buildManifest(stats: Stats, projectRoot: string): Promise<TurboSnapManifest>` (adds the `projectRoot` parameter). `TraceChangedFilesInput` gains `projectRoot: string`.

This task switches the manifest's identity from raw `module.name` to the canonical project-relative path, and threads the anchor through the call chain. Per-story hashing (including the leaf gap and ordering) is deliberately left unchanged here — Tasks 3 and 4 handle it.

- [ ] **Step 1: Write the failing test**

Create `node-src/lib/turbosnap/v2/manifest.test.ts`. The `fileHashesRef` mock lets later tasks set per-file content hashes; here everything defaults to `'x'`.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Stats } from '../../../types';
import { buildManifest } from './manifest';

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: () => true,
  writeFileSync: vi.fn(),
}));

// A hoisted ref so tests can control the content hash returned for each absolute file path.
// getFileHashes is called with absolute paths and returns hashes keyed by those paths.
const { fileHashesRef } = vi.hoisted(() => ({
  fileHashesRef: { current: {} as Record<string, string> },
}));

vi.mock('../../../lib/getFileHashes', () => ({
  getFileHashes: (files: string[]) =>
    Promise.resolve(Object.fromEntries(files.map((f) => [f, fileHashesRef.current[f] ?? 'x']))),
}));

const projectRoot = '/repo/packages/ui';

beforeEach(() => {
  fileHashesRef.current = {};
});

describe('buildManifest', () => {
  it('keys story files by their canonical project-relative path', async () => {
    const stats: Stats = {
      modules: [
        {
          id: 1,
          name: '/repo/packages/ui/src/Button.stories.tsx',
          reasons: [{ moduleName: './storybook-stories.js' }],
        },
        {
          id: 2,
          name: '/repo/packages/ui/src/helper.ts',
          reasons: [{ moduleName: '/repo/packages/ui/src/Button.stories.tsx' }],
        },
      ],
    };

    const manifest = await buildManifest(stats, projectRoot);

    expect([...manifest.storyFileHashes.keys()]).toEqual(['src/Button.stories.tsx']);
    expect(manifest.files.has('src/Button.stories.tsx')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run node-src/lib/turbosnap/v2/manifest.test.ts`
Expected: FAIL — `buildManifest` currently takes one argument and keys by raw `module.name`, so the key is `/repo/packages/ui/src/Button.stories.tsx`, not `src/Button.stories.tsx`.

- [ ] **Step 3: Rewrite `buildManifest` and `hashFiles` to normalize keys**

In `node-src/lib/turbosnap/v2/manifest.ts`, add the import below the existing imports:

```ts
import { normalizeStatsPath, resolveStatsPath } from './paths';
```

Replace `buildManifest` (currently lines 64-105) with:

```ts
export async function buildManifest(stats: Stats, projectRoot: string): Promise<TurboSnapManifest> {
  const hashes = await hashFiles(stats, projectRoot);
  const files = new Map<FilePath, TurboSnapFile>();
  // A temporary set to collect the story file names before we build the story file hashes because
  // we need to parse the entire list of dependencies first.
  const storyFileNames = new Set<FilePath>();

  for (const module of stats.modules) {
    const sourceFilePath = normalizeStatsPath(module.name, projectRoot);
    // Match story entry files against the raw importer names, since STORIES_ENTRY_FILES holds the
    // builder's own entry paths (e.g. `./storybook-stories.js`).
    const rawImporters = module.reasons?.map((reason) => reason.moduleName) ?? [];

    if (rawImporters.some((importer) => STORIES_ENTRY_FILES.has(importer))) {
      storyFileNames.add(sourceFilePath);
    }

    for (const rawImporter of rawImporters) {
      const importer = normalizeStatsPath(rawImporter, projectRoot);
      const file = files.get(importer);
      if (file) {
        file.dependencies.add(sourceFilePath);
      } else {
        files.set(importer, {
          hash: hashes.get(importer) ?? '',
          dependencies: new Set([sourceFilePath]),
        });
      }
    }
  }

  const { h64ToString } = await xxHashWasm();
  const storyFileHashes = new Map<FilePath, FileHash>();
  for (const storyFile of storyFileNames) {
    const dependencyPaths = [...collectTransitiveDependencies(files, storyFile)].sort();
    const combined = dependencyPaths.map((filePath) => files.get(filePath)?.hash).join('');
    storyFileHashes.set(storyFile, h64ToString(combined));
  }

  const storybookHash = h64ToString([...storyFileHashes.values()].join(''));

  return { files, storyFileHashes, storybookHash };
}
```

Replace `hashFiles` (currently lines 185-206) with a version that hashes absolute paths but keys by the normalized path:

```ts
async function hashFiles(stats: Stats, projectRoot: string): Promise<Map<FilePath, FileHash>> {
  // Collect every referenced module path once.
  const rawPaths = new Set<FilePath>();
  for (const module of stats.modules) {
    rawPaths.add(module.name);
    for (const reason of module.reasons ?? []) {
      rawPaths.add(reason.moduleName);
    }
  }

  // Map each hashable file's canonical project-relative name to its absolute on-disk path. Virtual
  // modules (e.g. Vite's `virtual:` entries) don't exist on disk and can't be hashed or traced.
  const normalizedToAbsolute = new Map<FilePath, string>();
  for (const rawPath of rawPaths) {
    if (rawPath.includes('virtual:')) continue;
    const absolutePath = resolveStatsPath(rawPath, projectRoot);
    if (!existsSync(absolutePath)) continue;
    normalizedToAbsolute.set(normalizeStatsPath(rawPath, projectRoot), absolutePath);
  }

  // getFileHashes joins its directory argument with each file; pass '' so the absolute paths are
  // used as-is, and it returns hashes keyed by those absolute paths.
  const absolutePaths = [...normalizedToAbsolute.values()];
  const fileHashes = await getFileHashes(absolutePaths, '', 10);

  const hashes = new Map<FilePath, FileHash>();
  for (const [normalizedName, absolutePath] of normalizedToAbsolute) {
    hashes.set(normalizedName, fileHashes[absolutePath]);
  }

  return hashes;
}
```

Simplify `writeManifest` (currently lines 114-138) since keys are already normalized. Replace it with:

```ts
export function writeManifest(manifest: TurboSnapManifest, outputDirectory: string) {
  const storyFiles: ManifestFile['storyFiles'] = Object.fromEntries(manifest.storyFileHashes);

  const files: ManifestFile['files'] = {};
  for (const [filePath, file] of manifest.files) {
    files[filePath] = {
      hash: file.hash,
      dependencies: [...file.dependencies],
    };
  }

  const manifestFile: ManifestFile = {
    storybookHash: manifest.storybookHash,
    storyFiles,
    files,
  };

  writeFileSync(path.join(outputDirectory, 'turbosnap-manifest.json'), JSON.stringify(manifestFile));
}
```

Finally, delete the now-unused local `normalizePath` and `isHashable` functions (currently lines 167-183): `isHashable`'s logic now lives inline in `hashFiles` (the `virtual:` check and `existsSync`), and `normalizePath` is replaced by `normalizeStatsPath`.

- [ ] **Step 4: Run the manifest test to verify it passes**

Run: `yarn vitest run node-src/lib/turbosnap/v2/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `projectRoot` through the v2 index**

In `node-src/lib/turbosnap/v2/index.ts`, add `projectRoot` to the input interface (currently lines 7-12):

```ts
interface TraceChangedFilesInput {
  graphqlClient: GraphQLClient;
  buildId: string;
  statsPath: string;
  manifestOutputDirectory: string;
  projectRoot: string;
}
```

And pass it to `buildManifest` (currently line 34):

```ts
  const manifest = await buildManifest(stats, input.projectRoot);
```

- [ ] **Step 6: Compute and pass the anchor from context**

In `node-src/lib/turbosnap/index.ts`, replace the `traceChangedFilesV2` call block (currently lines 32-38) with:

```ts
  try {
    const projectRoot =
      ctx.git.rootPath && ctx.storybook?.baseDir
        ? path.resolve(ctx.git.rootPath, ctx.storybook.baseDir)
        : process.cwd();

    const result = await traceChangedFilesV2({
      graphqlClient: ctx.client,
      buildId: ctx.build.id,
      statsPath: ctx.fileInfo.statsPath,
      manifestOutputDirectory: path.join(ctx.sourceDir, '.chromatic'),
      projectRoot,
    });
```

(`path` is already imported at the top of the file.)

- [ ] **Step 7: Verify the whole turbosnap suite, types, and lint**

Run: `yarn vitest run node-src/lib/turbosnap/`
Expected: PASS (existing `index.test.ts` still green).
Run: `yarn typescript:check` (expect no output) and `yarn lint --quiet` (expect no output).

- [ ] **Step 8: Commit**

```bash
git add node-src/lib/turbosnap/v2/manifest.ts node-src/lib/turbosnap/v2/manifest.test.ts node-src/lib/turbosnap/v2/index.ts node-src/lib/turbosnap/index.ts
git commit -m "Key TurboSnap v2 manifest by project-relative paths"
```

---

### Task 3: Include leaf-dependency content in the story hash

**Files:**
- Modify: `node-src/lib/turbosnap/v2/manifest.ts`
- Test: `node-src/lib/turbosnap/v2/manifest.test.ts`

**Interfaces:**
- Consumes: `buildManifest(stats, projectRoot)` from Task 2 (unchanged signature). The in-scope `hashes` map (normalized-path → content-hash) and `collectTransitiveDependencies`.
- Produces: no signature change; the per-story hash now reflects the content of *every* transitive file, including leaves.

Background: the `files` map is keyed only by files that import something. A **leaf** dependency (imports nothing) is never a key there, so `files.get(leaf)?.hash` is `undefined` and its content is dropped from the story hash. The fix is to look each transitive path up in the `hashes` map instead, which holds a content hash for every hashed file.

- [ ] **Step 1: Write the failing test**

Append to `node-src/lib/turbosnap/v2/manifest.test.ts`:

```ts
describe('buildManifest leaf inclusion', () => {
  const story = '/repo/packages/ui/src/Button.stories.tsx';
  const leaf = '/repo/packages/ui/src/theme.ts';

  // theme.ts is a leaf: the story imports it, but it imports nothing itself.
  const stats: Stats = {
    modules: [
      { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
      { id: 2, name: leaf, reasons: [{ moduleName: story }] },
    ],
  };

  it('changes the story hash when a leaf dependency content changes', async () => {
    fileHashesRef.current = { [story]: 'S', [leaf]: 'T1' };
    const before = await buildManifest(stats, projectRoot);

    fileHashesRef.current = { [story]: 'S', [leaf]: 'T2' };
    const after = await buildManifest(stats, projectRoot);

    expect(after.storyFileHashes.get('src/Button.stories.tsx')).not.toBe(
      before.storyFileHashes.get('src/Button.stories.tsx')
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run node-src/lib/turbosnap/v2/manifest.test.ts`
Expected: FAIL — the leaf `theme.ts` is not a key in `files`, so it contributes `''` regardless of its content; both story hashes equal `h64('S')`, so `.not.toBe` fails.

- [ ] **Step 3: Source the combine from the `hashes` map**

In `node-src/lib/turbosnap/v2/manifest.ts`, within `buildManifest`, replace the per-story hash loop:

```ts
  const { h64ToString } = await xxHashWasm();
  const storyFileHashes = new Map<FilePath, FileHash>();
  for (const storyFile of storyFileNames) {
    const dependencyPaths = [...collectTransitiveDependencies(files, storyFile)].sort();
    const combined = dependencyPaths.map((filePath) => files.get(filePath)?.hash).join('');
    storyFileHashes.set(storyFile, h64ToString(combined));
  }
```

with a version that reads content hashes from `hashes` (leaves included):

```ts
  const { h64ToString } = await xxHashWasm();
  const storyFileHashes = new Map<FilePath, FileHash>();
  for (const storyFile of storyFileNames) {
    // Look content hashes up in `hashes` (which has an entry for every hashed file) rather than
    // `files` (keyed only by importers), so leaf dependencies contribute their content too.
    const dependencyPaths = [...collectTransitiveDependencies(files, storyFile)].sort();
    const combined = dependencyPaths.map((filePath) => hashes.get(filePath) ?? '').join('');
    storyFileHashes.set(storyFile, h64ToString(combined));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run node-src/lib/turbosnap/v2/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the turbosnap suite, types, and lint**

Run: `yarn vitest run node-src/lib/turbosnap/`
Expected: PASS.
Run: `yarn typescript:check` (expect no output) and `yarn lint --quiet` (expect no output).

- [ ] **Step 6: Commit**

```bash
git add node-src/lib/turbosnap/v2/manifest.ts node-src/lib/turbosnap/v2/manifest.test.ts
git commit -m "Include leaf dependency content in TurboSnap v2 story hashes"
```

---

### Task 4: Order-independent hashing

**Files:**
- Modify: `node-src/lib/turbosnap/v2/manifest.ts`
- Test: `node-src/lib/turbosnap/v2/manifest.test.ts`

**Interfaces:**
- Consumes: `buildManifest(stats, projectRoot)` from Task 3 (unchanged signature).
- Produces: no signature change; `storyFileHashes` values and `storybookHash` become independent of dependency and module ordering.

- [ ] **Step 1: Write the failing tests**

Append to `node-src/lib/turbosnap/v2/manifest.test.ts`:

```ts
describe('buildManifest relocation stability', () => {
  it('produces identical story keys and hashes when the whole project moves', async () => {
    const before = await (async () => {
      fileHashesRef.current = {
        '/repo/packages/ui/src/Button.stories.tsx': 'S',
        '/repo/packages/ui/src/helper.ts': 'H',
      };
      return buildManifest(
        {
          modules: [
            {
              id: 1,
              name: '/repo/packages/ui/src/Button.stories.tsx',
              reasons: [{ moduleName: './storybook-stories.js' }],
            },
            {
              id: 2,
              name: '/repo/packages/ui/src/helper.ts',
              reasons: [{ moduleName: '/repo/packages/ui/src/Button.stories.tsx' }],
            },
          ],
        },
        '/repo/packages/ui'
      );
    })();

    const after = await (async () => {
      fileHashesRef.current = {
        '/repo/apps/web/ui/src/Button.stories.tsx': 'S',
        '/repo/apps/web/ui/src/helper.ts': 'H',
      };
      return buildManifest(
        {
          modules: [
            {
              id: 1,
              name: '/repo/apps/web/ui/src/Button.stories.tsx',
              reasons: [{ moduleName: './storybook-stories.js' }],
            },
            {
              id: 2,
              name: '/repo/apps/web/ui/src/helper.ts',
              reasons: [{ moduleName: '/repo/apps/web/ui/src/Button.stories.tsx' }],
            },
          ],
        },
        '/repo/apps/web/ui'
      );
    })();

    expect([...after.storyFileHashes.entries()]).toEqual([...before.storyFileHashes.entries()]);
    expect(after.storybookHash).toBe(before.storybookHash);
  });

  it('keeps a story hash stable when a dependency moves and reorders its siblings', async () => {
    const story = '/repo/packages/ui/src/Button.stories.tsx';

    // Build 1: deps a.ts and b.ts sort as [Button, a, b].
    fileHashesRef.current = {
      [story]: 'S',
      '/repo/packages/ui/src/a.ts': 'HA',
      '/repo/packages/ui/src/b.ts': 'HB',
    };
    const before = await buildManifest(
      {
        modules: [
          { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
          { id: 2, name: '/repo/packages/ui/src/a.ts', reasons: [{ moduleName: story }] },
          { id: 3, name: '/repo/packages/ui/src/b.ts', reasons: [{ moduleName: story }] },
        ],
      },
      projectRoot
    );

    // Build 2: a.ts moved to z.ts (content unchanged), so paths now sort as [Button, b, z].
    fileHashesRef.current = {
      [story]: 'S',
      '/repo/packages/ui/src/z.ts': 'HA',
      '/repo/packages/ui/src/b.ts': 'HB',
    };
    const after = await buildManifest(
      {
        modules: [
          { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
          { id: 2, name: '/repo/packages/ui/src/z.ts', reasons: [{ moduleName: story }] },
          { id: 3, name: '/repo/packages/ui/src/b.ts', reasons: [{ moduleName: story }] },
        ],
      },
      projectRoot
    );

    expect(after.storyFileHashes.get('src/Button.stories.tsx')).toBe(
      before.storyFileHashes.get('src/Button.stories.tsx')
    );
  });

  it('produces the same storybookHash regardless of module iteration order', async () => {
    const forwards: Stats = {
      modules: [
        { id: 1, name: './src/A.stories.tsx', reasons: [{ moduleName: './storybook-stories.js' }] },
        { id: 2, name: './src/B.stories.tsx', reasons: [{ moduleName: './storybook-stories.js' }] },
      ],
    };
    const backwards: Stats = {
      modules: [
        { id: 2, name: './src/B.stories.tsx', reasons: [{ moduleName: './storybook-stories.js' }] },
        { id: 1, name: './src/A.stories.tsx', reasons: [{ moduleName: './storybook-stories.js' }] },
      ],
    };
    fileHashesRef.current = {
      '/repo/packages/ui/src/A.stories.tsx': 'HA',
      '/repo/packages/ui/src/B.stories.tsx': 'HB',
    };

    const first = await buildManifest(forwards, projectRoot);
    const second = await buildManifest(backwards, projectRoot);

    expect(second.storybookHash).toBe(first.storybookHash);
  });
});
```

- [ ] **Step 2: Run tests to verify the ordering tests fail**

Run: `yarn vitest run node-src/lib/turbosnap/v2/manifest.test.ts`
Expected: FAIL —
- "dependency moves and reorders its siblings": path-sort puts the deps in `[Button, a, b]` order but `[Button, b, z]` after the move, so the joined hash string is `S·HA·HB` vs `S·HB·HA` — different hashes.
- "same storybookHash regardless of module iteration order": story hashes are joined in Map-insertion (module) order, so reversing the modules reverses the join and changes the hash.
(The whole-project-move test already passes; it guards against regression.)

- [ ] **Step 3: Sort by hash instead of by path**

In `node-src/lib/turbosnap/v2/manifest.ts`, within `buildManifest`, replace the per-story hash loop and the storybook hash line:

```ts
  const { h64ToString } = await xxHashWasm();
  const storyFileHashes = new Map<FilePath, FileHash>();
  for (const storyFile of storyFileNames) {
    // Look content hashes up in `hashes` (which has an entry for every hashed file) rather than
    // `files` (keyed only by importers), so leaf dependencies contribute their content too.
    const dependencyPaths = [...collectTransitiveDependencies(files, storyFile)].sort();
    const combined = dependencyPaths.map((filePath) => hashes.get(filePath) ?? '').join('');
    storyFileHashes.set(storyFile, h64ToString(combined));
  }

  const storybookHash = h64ToString([...storyFileHashes.values()].join(''));
```

with a version that sorts the content hashes (not the paths) and the story hashes:

```ts
  const { h64ToString } = await xxHashWasm();
  const storyFileHashes = new Map<FilePath, FileHash>();
  for (const storyFile of storyFileNames) {
    // Combine dependency content-hashes in sorted-hash order so the result depends only on the set
    // of contents, not on where the files live. Reading from `hashes` (not `files`) also includes
    // leaf dependencies. Together this keeps a story's hash stable when the project or a dependency
    // moves within the repository.
    const combined = [...collectTransitiveDependencies(files, storyFile)]
      .map((filePath) => hashes.get(filePath) ?? '')
      .sort()
      .join('');
    storyFileHashes.set(storyFile, h64ToString(combined));
  }

  // Sort the story hashes so the Storybook hash is independent of module iteration order.
  const storybookHash = h64ToString([...storyFileHashes.values()].sort().join(''));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run node-src/lib/turbosnap/v2/manifest.test.ts`
Expected: PASS (all buildManifest tests green).

- [ ] **Step 5: Verify the full turbosnap suite, types, and lint**

Run: `yarn vitest run node-src/lib/turbosnap/`
Expected: PASS.
Run: `yarn typescript:check` (expect no output) and `yarn lint --quiet` (expect no output).

- [ ] **Step 6: Commit**

```bash
git add node-src/lib/turbosnap/v2/manifest.ts node-src/lib/turbosnap/v2/manifest.test.ts
git commit -m "Make TurboSnap v2 story hashes order-independent"
```

---

## Notes for the implementer

- The manifest keeps raw `module.name` only long enough to detect story entry files (`STORIES_ENTRY_FILES` holds builder-emitted entry paths like `./storybook-stories.js`); everything stored or uploaded uses the normalized project-relative path.
- Two maps, two roles: `files` holds the dependency graph (edges, keyed by importers), `hashes` holds a content hash for every hashed file. Per-story hashing must read content from `hashes`, not `files` (Task 3).
- `getFileHashes(absolutePaths, '', 10)` relies on `path.join('', absolutePath) === absolutePath`. Keep the `''` directory argument; passing `projectRoot` here would corrupt absolute paths.
- Do not add a Windows-backslash unit assertion: `posix()` keys off `path.sep`, so backslash conversion only occurs on Windows and such an assertion would fail on macOS/Linux CI. Rely on `posix()`, as v1 does.
