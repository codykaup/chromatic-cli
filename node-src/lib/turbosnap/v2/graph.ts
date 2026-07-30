export type FilePath = string;
export type FileHash = string;

export interface TurboSnapFile {
  hash: FileHash;
  dependencies: Set<FilePath>;
}

/**
 * Rolls a set of files up into a single hash. Content-hashes are combined in sorted-hash order so
 * the result depends only on the set of contents, not on where the files live — this keeps a hash
 * stable when the project or a dependency moves within the repository. Reading from `hashes` (not
 * `files`) also includes leaf dependencies.
 *
 * This is the shared recipe for both a story-file hash and a `storybookFiles` entry, so the two are
 * directly comparable.
 *
 * @param hashes The content hashes keyed by canonical file path.
 * @param filePaths The files to roll up.
 * @param h64ToString The hash function.
 *
 * @returns The rolled-up hash.
 */
export function rollUpHash(
  hashes: Map<FilePath, FileHash>,
  filePaths: Iterable<FilePath>,
  h64ToString: (input: string) => string
): FileHash {
  const combined = [...filePaths]
    .map((filePath) => hashes.get(filePath) ?? '')
    .sort()
    .join('');
  return h64ToString(combined);
}

/**
 * Rolls a set of files up into a single hash that depends on both content and path. Entries are
 * sorted so the result doesn't depend on iteration order.
 *
 * This is the recipe for files whose path is part of their meaning: a static asset is served at its
 * path and a Storybook config file is loaded by name, so a byte-preserving rename changes what
 * Storybook renders and has to move the hash. Contrast {@link rollUpHash}, where a module's path is
 * incidental.
 *
 * @param entries The path/content-hash pairs to roll up.
 * @param h64ToString The hash function.
 *
 * @returns The rolled-up hash.
 */
export function rollUpPathSensitiveHash(
  entries: Iterable<[FilePath, FileHash]>,
  h64ToString: (input: string) => string
): FileHash {
  const combined = [...entries]
    .map((entry) => hashEntryIdentity(entry))
    .sort()
    .join('');
  return h64ToString(combined);
}

/**
 * Encodes a key and value as a single string, length-prefixing each so no pair of entries can
 * concatenate into the same bytes as a different pair.
 *
 * @param entry The key/value pair to encode.
 *
 * @returns The encoded entry.
 */
export function hashEntryIdentity([key, value]: [string, string]): string {
  return `${key.length}:${key}${value.length}:${value}`;
}

/**
 * Walks the dependency graph from a file, collecting it and every file it transitively depends on.
 *
 * @param files The map of files to their hashes and dependencies.
 * @param filePath The file to collect the transitive dependencies of.
 * @param dependencies The set of dependencies to add to.
 *
 * @returns A set of all the files that the given file transitively depends on.
 */
export function collectTransitiveDependencies(
  files: Map<FilePath, TurboSnapFile>,
  filePath: FilePath,
  dependencies = new Set<FilePath>()
) {
  if (dependencies.has(filePath)) {
    return dependencies;
  }

  dependencies.add(filePath);
  for (const dependency of files.get(filePath)?.dependencies ?? []) {
    collectTransitiveDependencies(files, dependency, dependencies);
  }

  return dependencies;
}
