import { access } from 'fs/promises';
import path from 'path';
import xxHashWasm from 'xxhash-wasm';

import { Stats } from '../../types';
import { getFileHashes } from '../getFileHashes';
import {
  buildStoryHashes,
  BuildStoryHashesOptions,
  UnhashableDependency,
} from './buildStoryHashes';

/**
 * TurboSnap 2.0 (Hash Based TS) — manifest generation and diffing (PoC, CLI side).
 *
 * {@link buildHashManifest} turns a builder `preview-stats.json` (plus the source tree on disk)
 * into a self-contained hash manifest. {@link diffManifests} compares two such manifests and
 * reports exactly which stories must be recaptured — no git, no lockfiles, no baseline checkout.
 */

export const HASH_MANIFEST_SCHEMA_VERSION = 1;
export const HASH_ALGORITHM = 'xxhash64';

/** Sentinel hash for a dependency the builder referenced but which isn't present on disk. */
export const MISSING_FILE_HASH = '<missing>';

export interface HashedSection {
  /** Single combined hash for this section, derived from all its file + module hashes. */
  hash: string;
  /** Map of repo-relative file path -> content hash (`<missing>` if absent on disk). */
  files: Record<string, string>;
  /** Non-file modules (externals / virtual) with a synthetic, content-free hash. */
  unhashable: (UnhashableDependency & { hash: string })[];
}

export interface HashManifest {
  schemaVersion: number;
  algorithm: string;
  storybook: {
    configDir: string;
    baseDir: string;
    staticDirs: string[];
  };
  csfGlobs: string[];
  /** Shared section (Storybook config etc) folded into every story hash. */
  global: HashedSection;
  /** Per story-file section, keyed by repo-relative story path. */
  stories: Record<string, HashedSection>;
  summary: {
    storyCount: number;
    fileCount: number;
    missingFileCount: number;
    unhashableCount: number;
  };
}

/**
 * Deterministic, content-free hash marker for a non-file module.
 *
 * @param dep The unhashable (external/virtual) dependency.
 *
 * @returns A stable synthetic hash string derived from the module name.
 */
const syntheticHash = (dep: UnhashableDependency) => `${dep.reason}:${dep.path}`;

const byFirstEntry = (a: [string, string], b: [string, string]) => a[0].localeCompare(b[0]);

/**
 * Combine a set of (path, hash) pairs into a single stable hash. The input is sorted so the result
 * is independent of iteration order, and each entry is length-prefixed-ish via NUL separators so
 * that `a|bc` and `ab|c` can't collide.
 *
 * @param h64Raw The xxhash64 raw-hashing function.
 * @param entries The (key, hash) pairs to combine.
 *
 * @returns A single 16-char hex hash covering all entries.
 */
const combineHashes = (
  h64Raw: (input: Uint8Array) => bigint,
  entries: [string, string][]
): string => {
  const serialized = [...entries]
    .sort(byFirstEntry)
    .map(([key, value]) => `${key}\0${value}`)
    .join('\n');
  return h64Raw(Buffer.from(serialized)).toString(16).padStart(16, '0');
};

/**
 * Build a hash manifest for a build.
 *
 * @param stats Parsed `preview-stats.json`.
 * @param options Repo root + Storybook layout, plus hashing concurrency.
 * @param options.concurrency Max concurrent file reads while hashing (default 10).
 *
 * @returns The full hash manifest, ready to serialize to JSON.
 */
export async function buildHashManifest(
  stats: Stats,
  options: BuildStoryHashesOptions & { concurrency?: number }
): Promise<HashManifest> {
  const { rootPath, concurrency = 10 } = options;
  const traced = buildStoryHashes(stats, options);

  // Partition referenced files into those present on disk vs missing, so a single missing file
  // (e.g. a node_modules path under Yarn PnP, or a generated file) doesn't fail the whole run.
  const existing: string[] = [];
  const missing = new Set<string>();
  await Promise.all(
    traced.allFiles.map(async (file) => {
      try {
        await access(path.join(rootPath, file));
        existing.push(file);
      } catch {
        missing.add(file);
      }
    })
  );

  const fileHashes = await getFileHashes(existing, rootPath, concurrency);
  const hashOf = (file: string) => fileHashes[file] ?? MISSING_FILE_HASH;

  const { h64Raw } = await xxHashWasm();

  const toSection = (files: string[], unhashable: UnhashableDependency[]): HashedSection => {
    const fileMap: Record<string, string> = {};
    for (const file of files) fileMap[file] = hashOf(file);

    const unhashableWithHashes = unhashable.map((dep) => ({ ...dep, hash: syntheticHash(dep) }));

    const entries: [string, string][] = [
      ...Object.entries(fileMap),
      ...unhashableWithHashes.map((dep): [string, string] => [dep.path, dep.hash]),
    ];

    return {
      hash: combineHashes(h64Raw, entries),
      files: fileMap,
      unhashable: unhashableWithHashes,
    };
  };

  const global = toSection(traced.globalFiles, traced.globalUnhashable);

  const stories: Record<string, HashedSection> = {};
  for (const story of traced.stories) {
    // A story's hash folds in the global hash, so any global change invalidates every story.
    const section = toSection(story.files, story.unhashable);
    section.hash = combineHashes(h64Raw, [
      ['@@global', global.hash],
      [`@@self:${story.storyFile}`, section.hash],
    ]);
    stories[story.storyFile] = section;
  }

  return {
    schemaVersion: HASH_MANIFEST_SCHEMA_VERSION,
    algorithm: HASH_ALGORITHM,
    storybook: {
      configDir: options.storybookConfigDir ?? '.storybook',
      baseDir: options.baseDir ?? '',
      staticDirs: options.staticDir ?? [],
    },
    csfGlobs: traced.csfGlobs,
    global,
    stories,
    summary: {
      storyCount: traced.stories.length,
      fileCount: existing.length,
      missingFileCount: missing.size,
      unhashableCount:
        traced.globalUnhashable.length +
        traced.stories.reduce((sum, s) => sum + s.unhashable.length, 0),
    },
  };
}

export interface StoryDiff {
  storyFile: string;
  /** Which specific dependency files changed hash (for debuggability — resolves TS problem #4). */
  changedFiles: { file: string; from?: string; to?: string }[];
}

export interface ManifestDiff {
  /** Storybook config / shared section changed → recapture everything. */
  globalChanged: boolean;
  /** Stories present in both manifests whose hash changed. */
  changed: StoryDiff[];
  /** Stories present only in the current manifest. */
  added: string[];
  /** Stories present only in the baseline manifest. */
  removed: string[];
  /** The final recapture set: every story that must be re-snapshotted. */
  recapture: string[];
  /** True if the baseline could not be meaningfully compared (schema/algorithm mismatch). */
  incompatible?: boolean;
}

/**
 * Diff a section's file maps, reporting which entries were added / removed / changed.
 *
 * @param from The baseline section.
 * @param to The current section.
 *
 * @returns The list of files whose hash differs, with before/after values.
 */
const diffFiles = (from: HashedSection, to: HashedSection) => {
  const changedFiles: StoryDiff['changedFiles'] = [];
  const keys = new Set([...Object.keys(from.files), ...Object.keys(to.files)]);
  for (const file of [...keys].sort()) {
    const before = from.files[file];
    const after = to.files[file];
    if (before !== after) changedFiles.push({ file, from: before, to: after });
  }
  return changedFiles;
};

/**
 * Compare a baseline manifest against the current build's manifest and determine which stories need
 * to be recaptured. This is the heart of the PoC — it replaces the entire git-diff + lockfile +
 * baseline-checkout machinery of TS 1.0 with a hash comparison.
 *
 * @param baseline The previous build's manifest.
 * @param current The current build's manifest.
 *
 * @returns The set of changed / added / removed stories and the final recapture list.
 */
export function diffManifests(baseline: HashManifest, current: HashManifest): ManifestDiff {
  // A schema or algorithm change means hashes aren't comparable — recapture everything, just as
  // TS 1.0 bails when it can't trust its inputs (new bail: `hashSchemaMismatch`).
  if (
    baseline.schemaVersion !== current.schemaVersion ||
    baseline.algorithm !== current.algorithm
  ) {
    return {
      globalChanged: true,
      changed: [],
      added: Object.keys(current.stories).sort(),
      removed: Object.keys(baseline.stories).sort(),
      recapture: Object.keys(current.stories).sort(),
      incompatible: true,
    };
  }

  const globalChanged = baseline.global.hash !== current.global.hash;

  const changed: StoryDiff[] = [];
  const added: string[] = [];
  for (const [storyFile, section] of Object.entries(current.stories)) {
    const baselineSection = baseline.stories[storyFile];
    if (!baselineSection) {
      added.push(storyFile);
    } else if (baselineSection.hash !== section.hash) {
      changed.push({ storyFile, changedFiles: diffFiles(baselineSection, section) });
    }
  }

  const removed = Object.keys(baseline.stories).filter((story) => !current.stories[story]);

  // If the global section changed, every current story is recaptured. Otherwise only the added +
  // individually-changed stories are.
  const recapture = globalChanged
    ? Object.keys(current.stories).sort()
    : [...added, ...changed.map((c) => c.storyFile)].sort();

  return {
    globalChanged,
    changed: changed.sort((a, b) => a.storyFile.localeCompare(b.storyFile)),
    added: added.sort(),
    removed: removed.sort(),
    recapture,
  };
}
