import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Stats } from '../../../types';
import { buildManifest, serializeManifest } from './manifest';

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

// The version is read off the resolved Storybook package on disk, which no fixture here installs;
// stub it so these tests exercise graph hashing only. See storybookVersion.test.ts for the probe.
const { storybookVersionRef } = vi.hoisted(() => ({
  storybookVersionRef: { current: '9.1.20' },
}));

vi.mock('./storybookVersion', () => ({
  resolveStorybookVersion: () => storybookVersionRef.current,
}));

// The config and static directories are swept off disk, which no fixture here has. Back the sweep with
// an in-memory tree of absolute directory -> entry names so these tests control it; see
// outOfGraphFiles.test.ts for the sweep's own behaviour.
const { directoryTreeRef } = vi.hoisted(() => ({
  directoryTreeRef: { current: {} as Record<string, string[]> },
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  readdir: (directory: string) => {
    const entries = directoryTreeRef.current[directory];
    if (!entries) return Promise.reject(new Error(`ENOENT: ${directory}`));
    return Promise.resolve(
      entries.map((name) => ({
        name,
        isDirectory: () => Boolean(directoryTreeRef.current[`${directory}/${name}`]),
        isFile: () => !directoryTreeRef.current[`${directory}/${name}`],
      }))
    );
  },
  // The sweep resolves each directory before walking it, to terminate on a symlink cycle. This tree has
  // no symlinks, so every path is already real — but a missing directory must still reject.
  realpath: async (directory: string) => {
    if (!directoryTreeRef.current[directory]) throw new Error(`ENOENT: ${directory}`);
    return directory;
  },
}));

// Manifest keys anchor at the git root, so a project in a subdirectory keys its files by their
// repo-relative path (e.g. `packages/ui/src/...`). See StatsPathRoots for why the two roots differ.
const projectRoot = '/repo/packages/ui';
const gitRoot = '/repo';
const roots = { projectRoot, gitRoot };
const outOfGraph = { configDir: '.storybook', staticDirs: ['.storybook/static'] };

beforeEach(() => {
  fileHashesRef.current = {};
  storybookVersionRef.current = '9.1.20';
  directoryTreeRef.current = {};
});

describe('serializeManifest', () => {
  it('converts the manifest maps and sets into JSON-safe objects and arrays', async () => {
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/helper.ts': 'H',
    };
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

    const manifest = await buildManifest(stats, roots, outOfGraph);
    const serialized = serializeManifest(manifest);

    // JSON-safe: storyFiles is a plain object, dependencies is an array.
    expect(serialized.storybookHash).toBe(manifest.storybookHash);
    expect(serialized.storyFiles).toEqual(Object.fromEntries(manifest.storyFileHashes));
    expect(serialized.files['packages/ui/src/Button.stories.tsx'].dependencies).toEqual([
      'packages/ui/src/helper.ts',
    ]);
    // structuredClone can hide fields that are not friendly to JSON.parse/JSON>stringify so we test the exact flow instead.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it('emits storybookFiles as a JSON-safe object', async () => {
    const story = '/repo/packages/ui/src/Button.stories.tsx';
    const preview = '/repo/packages/ui/.storybook/preview.ts';
    fileHashesRef.current = { [story]: 'S', [preview]: 'P' };
    const stats: Stats = {
      modules: [
        { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
        { id: 2, name: preview, reasons: [{ moduleName: './storybook-config-entry.js' }] },
      ],
    };

    const manifest = await buildManifest(stats, roots, outOfGraph);
    const serialized = serializeManifest(manifest);

    expect(serialized.storybookFiles['packages/ui/.storybook/preview.ts']).toBe(
      manifest.storybookFiles.get('packages/ui/.storybook/preview.ts')
    );
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });
});

describe('buildManifest', () => {
  it('keys story files by their canonical git-root-relative path', async () => {
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

    const manifest = await buildManifest(stats, roots, outOfGraph);

    expect([...manifest.storyFileHashes.keys()]).toEqual(['packages/ui/src/Button.stories.tsx']);
    expect(manifest.files.has('packages/ui/src/Button.stories.tsx')).toBe(true);
  });
});

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
    const before = await buildManifest(stats, roots, outOfGraph);

    fileHashesRef.current = { [story]: 'S', [leaf]: 'T2' };
    const after = await buildManifest(stats, roots, outOfGraph);

    expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).not.toBe(
      before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
    );
  });
});

describe('buildManifest relocation stability', () => {
  it('keeps story hashes stable when the whole project moves, even as the keys track the new location', async () => {
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
        { projectRoot: '/repo/packages/ui', gitRoot },
        outOfGraph
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
        { projectRoot: '/repo/apps/web/ui', gitRoot },
        outOfGraph
      );
    })();

    // The keys are git-root-relative, so moving the project changes where each story is keyed.
    expect([...before.storyFileHashes.keys()]).toEqual(['packages/ui/src/Button.stories.tsx']);
    expect([...after.storyFileHashes.keys()]).toEqual(['apps/web/ui/src/Button.stories.tsx']);
    // The content-based hashes are unchanged by the move.
    expect([...after.storyFileHashes.values()]).toEqual([...before.storyFileHashes.values()]);
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
      roots,
      outOfGraph
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
      roots,
      outOfGraph
    );

    expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).toBe(
      before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
    );
  });

  it('keeps a story hash stable when an external dependency relocates further from the project', async () => {
    const story = '/repo/packages/ui/src/Button.stories.tsx';

    // Build 1: theme.ts lives in a sibling package. Anchored at the git root it keys as
    // 'packages/shared/theme.ts'.
    fileHashesRef.current = {
      [story]: 'S',
      '/repo/packages/shared/theme.ts': 'HT',
    };
    const before = await buildManifest(
      {
        modules: [
          { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
          { id: 2, name: '/repo/packages/shared/theme.ts', reasons: [{ moduleName: story }] },
        ],
      },
      roots,
      outOfGraph
    );

    // Build 2: the repo is restructured so theme.ts moves up to the repo root ('shared/theme.ts'),
    // but its content is unchanged. The story and its internal dependencies don't move.
    fileHashesRef.current = {
      [story]: 'S',
      '/repo/shared/theme.ts': 'HT',
    };
    const after = await buildManifest(
      {
        modules: [
          { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
          { id: 2, name: '/repo/shared/theme.ts', reasons: [{ moduleName: story }] },
        ],
      },
      roots,
      outOfGraph
    );

    expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).toBe(
      before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
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

    const first = await buildManifest(forwards, roots, outOfGraph);
    const second = await buildManifest(backwards, roots, outOfGraph);

    expect(second.storybookHash).toBe(first.storybookHash);
  });
});

describe('buildManifest concatenated modules', () => {
  // Webpack/rspack concatenate the story and its local imports into one module: the module name
  // carries a ` + N modules` suffix and the real files live in `module.modules`.
  const concatenatedStory: Stats = {
    modules: [
      {
        id: 1,
        name: '/repo/packages/ui/src/Button.stories.tsx + 1 modules',
        modules: [
          { name: '/repo/packages/ui/src/Button.stories.tsx' },
          { name: '/repo/packages/ui/src/Button.tsx' },
        ],
        reasons: [{ moduleName: './storybook-stories.js' }],
      },
    ],
  };

  it('keys the story by its root file, stripping the concatenation suffix', async () => {
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B',
    };
    const manifest = await buildManifest(concatenatedStory, roots, outOfGraph);

    expect([...manifest.storyFileHashes.keys()]).toEqual(['packages/ui/src/Button.stories.tsx']);
  });

  it('records each concatenated sub-file as a dependency of the root file', async () => {
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B',
    };
    const manifest = await buildManifest(concatenatedStory, roots, outOfGraph);

    expect([
      ...(manifest.files.get('packages/ui/src/Button.stories.tsx')?.dependencies ?? []),
    ]).toContain('packages/ui/src/Button.tsx');
  });

  it('changes the story hash when a concatenated sub-file content changes', async () => {
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B1',
    };
    const before = await buildManifest(concatenatedStory, roots, outOfGraph);

    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B2',
    };
    const after = await buildManifest(concatenatedStory, roots, outOfGraph);

    expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).not.toBe(
      before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
    );
  });
});

describe('buildManifest concatenated modules with rspack-style child names', () => {
  // rspack labels a concatenated child's `name` with the parent group name (e.g.
  // `./Button.stories.tsx + 1 modules`) rather than the child's own file. The real path is only in
  // `nameForCondition`. Without reading `nameForCondition` the child collapses onto the root file
  // and its content is never hashed.
  const rspackConcatenatedStory: Stats = {
    modules: [
      {
        id: 1,
        name: '/repo/packages/ui/src/Button.stories.tsx + 1 modules',
        nameForCondition: '/repo/packages/ui/src/Button.stories.tsx',
        modules: [
          {
            name: '/repo/packages/ui/src/Button.stories.tsx',
            nameForCondition: '/repo/packages/ui/src/Button.stories.tsx',
          },
          {
            // The buggy child: `name` is the group label, real file is in nameForCondition.
            name: '/repo/packages/ui/src/Button.stories.tsx + 1 modules',
            nameForCondition: '/repo/packages/ui/src/Button.tsx',
          },
        ],
        reasons: [{ moduleName: './storybook-stories.js' }],
      },
    ],
  };

  it('recovers the concatenated child file from nameForCondition', async () => {
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B',
    };
    const manifest = await buildManifest(rspackConcatenatedStory, roots, outOfGraph);

    expect([...manifest.storyFileHashes.keys()]).toEqual(['packages/ui/src/Button.stories.tsx']);
    expect([
      ...(manifest.files.get('packages/ui/src/Button.stories.tsx')?.dependencies ?? []),
    ]).toContain('packages/ui/src/Button.tsx');
  });

  it('changes the story hash when the concatenated child content changes', async () => {
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B1',
    };
    const before = await buildManifest(rspackConcatenatedStory, roots, outOfGraph);

    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B2',
    };
    const after = await buildManifest(rspackConcatenatedStory, roots, outOfGraph);

    expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).not.toBe(
      before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
    );
  });
});

describe('buildManifest missing names', () => {
  it('skips reasons with a null moduleName without dropping the story', async () => {
    const stats: Stats = {
      modules: [
        {
          id: 1,
          name: '/repo/packages/ui/src/Button.stories.tsx',
          // An entry reason carries `moduleName: null`; the stories-entry reason must still apply.
          reasons: [
            { moduleName: null as unknown as string },
            { moduleName: './storybook-stories.js' },
          ],
        },
      ],
    };
    fileHashesRef.current = { '/repo/packages/ui/src/Button.stories.tsx': 'S' };

    const manifest = await buildManifest(stats, roots, outOfGraph);

    expect([...manifest.storyFileHashes.keys()]).toEqual(['packages/ui/src/Button.stories.tsx']);
  });

  it('uses module.modules when module.name is absent', async () => {
    const stats: Stats = {
      modules: [
        {
          id: 1,
          name: null as unknown as string,
          modules: [
            { name: '/repo/packages/ui/src/Button.stories.tsx' },
            { name: '/repo/packages/ui/src/Button.tsx' },
          ],
          reasons: [{ moduleName: './storybook-stories.js' }],
        },
      ],
    };
    fileHashesRef.current = {
      '/repo/packages/ui/src/Button.stories.tsx': 'S',
      '/repo/packages/ui/src/Button.tsx': 'B',
    };

    const manifest = await buildManifest(stats, roots, outOfGraph);

    expect([...manifest.storyFileHashes.keys()]).toEqual(['packages/ui/src/Button.stories.tsx']);
    expect([
      ...(manifest.files.get('packages/ui/src/Button.stories.tsx')?.dependencies ?? []),
    ]).toContain('packages/ui/src/Button.tsx');
  });
});

// The require-context glob is not a file on disk; everything else is. Spy on the shared `fs` mock
// (which hardcodes `existsSync: () => true`) so the glob module appears absent, then restore it.
function withGlobAbsent(run: () => Promise<void>) {
  const spy = vi
    .spyOn(fs, 'existsSync')
    .mockImplementation((candidate) => !String(candidate).includes('lazy'));
  return run().finally(() => spy.mockRestore());
}

// The builder's generated entries and require-context globs have no file at these paths in a real
// project. The shared `fs` mock says every path exists, so spy to make them absent.
function withSyntheticAbsent(run: () => Promise<void>) {
  const synthetic = ['storybook-stories.js', 'storybook-config-entry.js', 'lazy'];
  const spy = vi
    .spyOn(fs, 'existsSync')
    .mockImplementation((candidate) => !synthetic.some((name) => String(candidate).includes(name)));
  return run().finally(() => spy.mockRestore());
}

describe('buildManifest story detection through a require-context', () => {
  // Webpack/rspack don't import story files directly from the entry: the entry imports a lazy
  // require-context (a glob module that is not a real file), and that context imports the stories.
  const glob = './src/lib/ lazy namespace object';
  const story = '/repo/packages/ui/src/lib/Button.stories.tsx';

  const stats: Stats = {
    modules: [
      { id: 1, name: glob, reasons: [{ moduleName: './storybook-stories.js' }] },
      { id: 2, name: story, reasons: [{ moduleName: glob }] },
    ],
  };

  it('detects stories imported via a lazy require-context imported by the entry', async () => {
    await withGlobAbsent(async () => {
      fileHashesRef.current = { [story]: 'S' };
      const manifest = await buildManifest(stats, roots, outOfGraph);
      expect([...manifest.storyFileHashes.keys()]).toEqual([
        'packages/ui/src/lib/Button.stories.tsx',
      ]);
    });
  });

  it('excludes the require-context glob (no file on disk) from the files map', async () => {
    await withGlobAbsent(async () => {
      fileHashesRef.current = { [story]: 'S' };
      const manifest = await buildManifest(stats, roots, outOfGraph);
      expect([...manifest.files.keys()].some((key) => key.includes('lazy'))).toBe(false);
      expect(manifest.files.has('packages/ui/src/lib/Button.stories.tsx')).toBe(true);
    });
  });

  it('does not treat the require-context glob itself as a story file', async () => {
    await withGlobAbsent(async () => {
      fileHashesRef.current = { [story]: 'S' };
      const manifest = await buildManifest(stats, roots, outOfGraph);
      const keys = [...manifest.storyFileHashes.keys()];
      expect(keys.some((key) => key.includes('lazy'))).toBe(false);
    });
  });
});

describe('buildManifest story detection through a config-entry require-context', () => {
  // rsbuild imports the require-context from the config entry (not storybook-stories.js), and the
  // stories themselves are concatenated modules.
  const glob = './src/lib|lazy|namespace object';
  const configEntry = './node_modules/.cache/storybook-rsbuild-builder/storybook-config-entry.js';
  const story = '/repo/packages/ui/src/lib/Button.stories.tsx';
  const impl = '/repo/packages/ui/src/lib/Button.tsx';

  const stats: Stats = {
    modules: [
      { id: 1, name: glob, reasons: [{ moduleName: `${configEntry} + 1 modules` }] },
      {
        id: 2,
        name: `${story} + 1 modules`,
        modules: [{ name: story }, { name: impl }],
        reasons: [{ moduleName: glob }],
      },
      // A real file the config entry imports directly (like `.storybook/preview.ts`); it must not
      // be mistaken for a story just because the config entry imports it.
      {
        id: 3,
        name: '/repo/packages/ui/.storybook/preview.ts',
        reasons: [{ moduleName: `${configEntry} + 1 modules` }],
      },
    ],
  };

  it('detects a concatenated story imported via a context imported by the config entry', async () => {
    await withGlobAbsent(async () => {
      fileHashesRef.current = { [story]: 'S', [impl]: 'B' };
      const manifest = await buildManifest(stats, roots, outOfGraph);
      expect([...manifest.storyFileHashes.keys()]).toEqual([
        'packages/ui/src/lib/Button.stories.tsx',
      ]);
    });
  });

  it('does not treat a real file imported directly by the config entry as a story', async () => {
    await withGlobAbsent(async () => {
      fileHashesRef.current = { [story]: 'S', [impl]: 'B' };
      const manifest = await buildManifest(stats, roots, outOfGraph);
      expect([...manifest.storyFileHashes.keys()]).not.toContain('.storybook/preview.ts');
    });
  });
});

describe('buildManifest attribution', () => {
  const story = '/repo/packages/ui/src/Button.stories.tsx';
  const storyDep = '/repo/packages/ui/node_modules/moment/moment.js';
  const preview = '/repo/packages/ui/.storybook/preview.ts';
  const previewHelper = '/repo/packages/ui/.storybook/theme.ts';
  const orphan = '/repo/packages/ui/node_modules/@storybook/react/dist/entry-preview.js';
  const configEntry = './storybook-config-entry.js';

  const stats: Stats = {
    modules: [
      { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
      { id: 2, name: storyDep, reasons: [{ moduleName: story }] },
      { id: 3, name: preview, reasons: [{ moduleName: configEntry }] },
      { id: 4, name: previewHelper, reasons: [{ moduleName: preview }] },
      { id: 5, name: orphan, reasons: [{ moduleName: configEntry }] },
    ],
  };

  const hashes = {
    [story]: 'S',
    [storyDep]: 'M',
    [preview]: 'P',
    [previewHelper]: 'PT',
    [orphan]: 'EP',
  };

  it('records each real file in the set that hashes it', async () => {
    await withSyntheticAbsent(async () => {
      fileHashesRef.current = { ...hashes };

      const { attribution } = await buildManifest(stats, roots, outOfGraph);

      expect([...attribution.storyReachable].sort()).toEqual([
        'packages/ui/node_modules/moment/moment.js',
        'packages/ui/src/Button.stories.tsx',
      ]);
      expect([...attribution.previewSubtree].sort()).toEqual([
        'packages/ui/.storybook/preview.ts',
        'packages/ui/.storybook/theme.ts',
      ]);
      expect([...attribution.storybookGlobals]).toEqual([
        'packages/ui/node_modules/@storybook/react/dist/entry-preview.js',
      ]);
    });
  });

  it('reports a file reached only through a synthetic node as story-reachable', async () => {
    // The defect this exists to prevent: pruning runs after hashing, so the written graph has a hole
    // where the require-context was. A reachability walk over it calls a correctly-attributed file
    // an orphan — the artifact behind the false "moment is in the bucket" reading.
    const lazyGlob = './src/lib/ lazy namespace object';
    const throughGlob = '/repo/packages/ui/src/lib/Widget.stories.tsx';

    await withSyntheticAbsent(async () => {
      fileHashesRef.current = { [throughGlob]: 'W' };
      const manifest = await buildManifest(
        {
          modules: [
            { id: 1, name: lazyGlob, reasons: [{ moduleName: './storybook-stories.js' }] },
            { id: 2, name: throughGlob, reasons: [{ moduleName: lazyGlob }] },
          ],
        },
        roots,
        outOfGraph
      );

      expect([...manifest.attribution.storyReachable]).toEqual([
        'packages/ui/src/lib/Widget.stories.tsx',
      ]);
      expect([...manifest.attribution.storybookGlobals]).toEqual([]);
      // The synthetic node is gone from the written graph, so this attribution is unreconstructable.
      expect([...manifest.files.keys()].some((key) => key.includes('lazy'))).toBe(false);
    });
  });

  it('omits synthetic nodes from every set', async () => {
    await withSyntheticAbsent(async () => {
      fileHashesRef.current = { ...hashes };

      const { attribution } = await buildManifest(stats, roots, outOfGraph);

      const all = [
        ...attribution.storyReachable,
        ...attribution.previewSubtree,
        ...attribution.storybookGlobals,
      ];
      expect(all.some((filePath) => filePath.includes('storybook-config-entry'))).toBe(false);
      expect(all.some((filePath) => filePath.includes('storybook-stories'))).toBe(false);
    });
  });

  it('serializes each set as a sorted, JSON-safe array', async () => {
    await withSyntheticAbsent(async () => {
      fileHashesRef.current = { ...hashes };

      const serialized = serializeManifest(await buildManifest(stats, roots, outOfGraph));

      expect(serialized.attribution.previewSubtree).toEqual([
        'packages/ui/.storybook/preview.ts',
        'packages/ui/.storybook/theme.ts',
      ]);
      // eslint-disable-next-line unicorn/prefer-structured-clone
      expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
    });
  });
});

describe('buildManifest storybookFiles', () => {
  // Two stories imported straight from the stories entry (Vite style). Button also imports moment,
  // a per-story dependency. The config entry imports `.storybook/preview.ts`, which imports a
  // helper — preview and its helper form the preview subtree that no story reaches.
  const buttonStory = '/repo/packages/ui/src/Button.stories.tsx';
  const headerStory = '/repo/packages/ui/src/Header.stories.tsx';
  const moment = '/repo/packages/ui/node_modules/moment/moment.js';
  const preview = '/repo/packages/ui/.storybook/preview.ts';
  const previewHelper = '/repo/packages/ui/.storybook/theme.ts';
  const configEntry = './storybook-config-entry.js';
  // An orphan global: Storybook wires the framework's preview annotations into the config entry
  // alongside preview.ts, so it is neither story-reachable nor in the preview subtree.
  const entryPreview = '/repo/packages/ui/node_modules/@storybook/react/dist/entry-preview.js';
  const reactDom = '/repo/packages/ui/node_modules/react-dom/index.js';

  const previewKey = 'packages/ui/.storybook/preview.ts';
  const globalsKey = '<storybookGlobals>';

  function makeStats(): Stats {
    return {
      modules: [
        { id: 1, name: buttonStory, reasons: [{ moduleName: './storybook-stories.js' }] },
        { id: 2, name: headerStory, reasons: [{ moduleName: './storybook-stories.js' }] },
        { id: 3, name: moment, reasons: [{ moduleName: buttonStory }] },
        { id: 4, name: preview, reasons: [{ moduleName: configEntry }] },
        { id: 5, name: previewHelper, reasons: [{ moduleName: preview }] },
        { id: 6, name: entryPreview, reasons: [{ moduleName: configEntry }] },
        { id: 7, name: reactDom, reasons: [{ moduleName: entryPreview }] },
      ],
    };
  }

  const baseHashes = {
    [buttonStory]: 'S1',
    [headerStory]: 'S2',
    [moment]: 'M',
    [preview]: 'P',
    [previewHelper]: 'PT',
    [entryPreview]: 'EP',
    [reactDom]: 'RD',
  };

  it('keys an entry by the canonical preview config path', async () => {
    fileHashesRef.current = { ...baseHashes };

    const manifest = await buildManifest(makeStats(), roots, outOfGraph);

    expect([...manifest.storybookFiles.keys()]).toContain(previewKey);
  });

  it('rolls orphan globals into a single catch-all entry', async () => {
    fileHashesRef.current = { ...baseHashes };

    const manifest = await buildManifest(makeStats(), roots, outOfGraph);

    expect([...manifest.storybookFiles.keys()]).toContain(globalsKey);
  });

  it('changes the catch-all entry when an orphan global content changes', async () => {
    fileHashesRef.current = { ...baseHashes };
    const before = await buildManifest(makeStats(), roots, outOfGraph);

    // reactDom is reached only via the framework's preview annotations, so it lands in the bucket.
    fileHashesRef.current = { ...baseHashes, [reactDom]: 'RD2' };
    const after = await buildManifest(makeStats(), roots, outOfGraph);

    expect(after.storybookFiles.get(globalsKey)).not.toBe(before.storybookFiles.get(globalsKey));
  });

  it('changes the storybook hash when the preview config changes, leaving story hashes pure', async () => {
    fileHashesRef.current = { ...baseHashes };
    const before = await buildManifest(makeStats(), roots, outOfGraph);

    fileHashesRef.current = { ...baseHashes, [preview]: 'P2' };
    const after = await buildManifest(makeStats(), roots, outOfGraph);

    expect(after.storybookHash).not.toBe(before.storybookHash);
    // Pure per-story hashes: a config change must not perturb any individual story's hash. The
    // backend notices it via storybookHash and drills into storybookFiles instead.
    expect([...after.storyFileHashes]).toEqual([...before.storyFileHashes]);
  });

  it('changes the storybook hash when an orphan global changes', async () => {
    fileHashesRef.current = { ...baseHashes };
    const before = await buildManifest(makeStats(), roots, outOfGraph);

    fileHashesRef.current = { ...baseHashes, [entryPreview]: 'EP2' };
    const after = await buildManifest(makeStats(), roots, outOfGraph);

    expect(after.storybookHash).not.toBe(before.storybookHash);
    expect([...after.storyFileHashes]).toEqual([...before.storyFileHashes]);
  });

  it('keeps a story dependency out of the catch-all, scoping the change to that story', async () => {
    fileHashesRef.current = { ...baseHashes };
    const before = await buildManifest(makeStats(), roots, outOfGraph);

    // moment lives only in Button's subtree, so it is story-reachable and must not be bucketed.
    fileHashesRef.current = { ...baseHashes, [moment]: 'M2' };
    const after = await buildManifest(makeStats(), roots, outOfGraph);

    expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).not.toBe(
      before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
    );
    expect(after.storyFileHashes.get('packages/ui/src/Header.stories.tsx')).toBe(
      before.storyFileHashes.get('packages/ui/src/Header.stories.tsx')
    );
    expect(after.storybookFiles.get(globalsKey)).toBe(before.storybookFiles.get(globalsKey));
  });

  it('attributes a preview-subtree change to the preview entry, not the catch-all', async () => {
    fileHashesRef.current = { ...baseHashes };
    const before = await buildManifest(makeStats(), roots, outOfGraph);

    // theme.ts is reached only through preview.ts, so it belongs to the keyed preview entry. Landing
    // in both would double-count it and destroy the backend's attribution.
    fileHashesRef.current = { ...baseHashes, [previewHelper]: 'PT2' };
    const after = await buildManifest(makeStats(), roots, outOfGraph);

    expect(after.storybookFiles.get(previewKey)).not.toBe(before.storybookFiles.get(previewKey));
    expect(after.storybookFiles.get(globalsKey)).toBe(before.storybookFiles.get(globalsKey));
  });

  it('omits the preview entry when the graph has no preview config', async () => {
    // Real case: a Storybook project with no `.storybook/preview.*` in its graph at all.
    fileHashesRef.current = { [buttonStory]: 'S1' };
    const manifest = await buildManifest(
      {
        modules: [
          { id: 1, name: buttonStory, reasons: [{ moduleName: './storybook-stories.js' }] },
        ],
      },
      roots,
      outOfGraph
    );

    expect([...manifest.storybookFiles.keys()]).not.toContain(previewKey);
  });

  it('omits the catch-all entry when every global is synthetic', async () => {
    // The stories entry is the only non-story node here, and it has no file on disk, so there is
    // nothing real to bucket and no empty entry should appear.
    const spy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((candidate) => !String(candidate).includes('storybook-stories.js'));

    try {
      fileHashesRef.current = { [buttonStory]: 'S1' };
      const manifest = await buildManifest(
        {
          modules: [
            { id: 1, name: buttonStory, reasons: [{ moduleName: './storybook-stories.js' }] },
          ],
        },
        roots,
        outOfGraph
      );

      // The version entry is unconditional, so it is the only key left once the catch-all is gone.
      expect([...manifest.storybookFiles.keys()]).toEqual(['<storybookVersion>']);
    } finally {
      spy.mockRestore();
    }
  });

  it('records the installed Storybook version as its own entry, verbatim rather than hashed', async () => {
    // The value is deliberately legible: the preview core runtime is served outside the module graph
    // on webpack and rspack, so a version is the only signal of a Storybook upgrade there, and
    // keeping it readable means the manifest itself says which Storybook produced the build.
    storybookVersionRef.current = '10.6.0-alpha.3';
    fileHashesRef.current = { ...baseHashes };

    const manifest = await buildManifest(makeStats(), roots, outOfGraph);

    expect(manifest.storybookFiles.get('<storybookVersion>')).toBe('10.6.0-alpha.3');
  });

  it('changes the storybookHash when only the Storybook version changes', async () => {
    // A Storybook upgrade that touches no graph file must still force a recapture, which is the
    // whole point of the entry: on webpack and rspack no file hash can see it.
    fileHashesRef.current = { ...baseHashes };
    storybookVersionRef.current = '9.1.19';
    const before = await buildManifest(makeStats(), roots, outOfGraph);

    fileHashesRef.current = { ...baseHashes };
    storybookVersionRef.current = '9.1.20';
    const after = await buildManifest(makeStats(), roots, outOfGraph);

    expect(after.storybookHash).not.toBe(before.storybookHash);
    // Only the Storybook-wide gate moves; no individual story subtree changed.
    expect([...after.storyFileHashes]).toEqual([...before.storyFileHashes]);
  });

  it('produces identical storybookFiles and storybook hash when building the same stats twice', async () => {
    fileHashesRef.current = { ...baseHashes };
    const first = await buildManifest(makeStats(), roots, outOfGraph);
    fileHashesRef.current = { ...baseHashes };
    const second = await buildManifest(makeStats(), roots, outOfGraph);

    expect([...second.storybookFiles]).toEqual([...first.storybookFiles]);
    expect(second.storybookHash).toBe(first.storybookHash);
  });
});

describe('buildManifest hashFiles skip branches', () => {
  it('contributes the empty string to a story hash for a file missing on disk', async () => {
    const story = '/repo/packages/ui/src/Button.stories.tsx';
    const missing = '/repo/packages/ui/src/missing.ts';

    // Scoped override: the shared `fs` mock hardcodes `existsSync: () => true`, so spy on it just
    // for this test to make `missing` appear absent from disk, then restore it.
    const existsSyncSpy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((candidate) => candidate !== missing);

    try {
      const stats: Stats = {
        modules: [
          { id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] },
          { id: 2, name: missing, reasons: [{ moduleName: story }] },
        ],
      };

      fileHashesRef.current = { [story]: 'S', [missing]: 'WOULD-BE-A' };
      const before = await buildManifest(stats, roots, outOfGraph);

      // Change the content hash the missing file *would* have if it were hashed. If the skip
      // branch didn't treat it as contributing '', this toggle would change the story hash.
      fileHashesRef.current = { [story]: 'S', [missing]: 'WOULD-BE-B' };
      const after = await buildManifest(stats, roots, outOfGraph);

      expect(after.storyFileHashes.get('packages/ui/src/Button.stories.tsx')).toBe(
        before.storyFileHashes.get('packages/ui/src/Button.stories.tsx')
      );
    } finally {
      existsSyncSpy.mockRestore();
    }
  });
});

describe('buildManifest out-of-graph inputs', () => {
  const story = '/repo/packages/ui/src/Button.stories.tsx';
  const mainConfig = '/repo/packages/ui/.storybook/main.ts';
  const staticAsset = '/repo/packages/ui/.storybook/static/mockServiceWorker.js';

  const stats: Stats = {
    modules: [{ id: 1, name: story, reasons: [{ moduleName: './storybook-stories.js' }] }],
  };

  beforeEach(() => {
    directoryTreeRef.current = {
      '/repo/packages/ui/.storybook': ['main.ts', 'static'],
      '/repo/packages/ui/.storybook/static': ['mockServiceWorker.js'],
    };
    fileHashesRef.current = { [story]: 'S', [mainConfig]: 'M', [staticAsset]: 'A' };
  });

  it('emits a synthetic entry per out-of-graph section', async () => {
    const manifest = await buildManifest(stats, roots, outOfGraph);

    expect([...manifest.storybookFiles.keys()]).toContain('<storybookConfig>');
    expect([...manifest.storybookFiles.keys()]).toContain('<staticFiles>');
  });

  it('moves the storybook hash when main.ts changes, leaving story hashes untouched', async () => {
    const before = await buildManifest(stats, roots, outOfGraph);

    fileHashesRef.current = { ...fileHashesRef.current, [mainConfig]: 'M2' };
    const after = await buildManifest(stats, roots, outOfGraph);

    // This is the v1-parity regression the mechanism exists to close: v1 bails on any configDir
    // edit, while v2 previously produced a byte-identical manifest.
    expect(after.storybookHash).not.toBe(before.storybookHash);
    expect(after.storyFileHashes).toEqual(before.storyFileHashes);
  });

  it('moves the storybook hash when a static asset changes', async () => {
    const before = await buildManifest(stats, roots, outOfGraph);

    fileHashesRef.current = { ...fileHashesRef.current, [staticAsset]: 'A2' };
    const after = await buildManifest(stats, roots, outOfGraph);

    expect(after.storybookHash).not.toBe(before.storybookHash);
  });

  it('keeps out-of-graph files out of files and attribution, so they miss the globals catch-all', async () => {
    const manifest = await buildManifest(stats, roots, outOfGraph);

    // The catch-all is defined by absence from storyReachable/previewSubtree, which these satisfy by
    // construction — entering `files` would double-hash them into `<storybookGlobals>`.
    expect(manifest.files.has('packages/ui/.storybook/main.ts')).toBe(false);
    expect(manifest.attribution.storybookGlobals.has('packages/ui/.storybook/main.ts')).toBe(false);
    expect(
      manifest.attribution.storybookGlobals.has(
        'packages/ui/.storybook/static/mockServiceWorker.js'
      )
    ).toBe(false);
  });

  it('serializes the per-file detail sections for the debug view', async () => {
    const serialized = serializeManifest(await buildManifest(stats, roots, outOfGraph));

    expect(serialized.storybookConfigFiles).toEqual({ 'packages/ui/.storybook/main.ts': 'M' });
    expect(serialized.staticFiles).toEqual({
      'packages/ui/.storybook/static/mockServiceWorker.js': 'A',
    });
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it('covers a preview.* the builder elided, which has no graph-rolled entry at all', async () => {
    // marketing-ui's preview.ts is 0 lines, so vite emits no module for it: v2 had no entry and
    // missed where v1 bails. Hashing the config dir off disk closes that unconditionally.
    directoryTreeRef.current = { '/repo/packages/ui/.storybook': ['main.ts', 'preview.ts'] };
    const preview = '/repo/packages/ui/.storybook/preview.ts';
    fileHashesRef.current = { [story]: 'S', [mainConfig]: 'M', [preview]: 'P1' };
    const before = await buildManifest(stats, roots, outOfGraph);
    expect(before.storybookFiles.has('packages/ui/.storybook/preview.ts')).toBe(false);

    fileHashesRef.current = { ...fileHashesRef.current, [preview]: 'P2' };
    const after = await buildManifest(stats, roots, outOfGraph);

    expect(after.storybookHash).not.toBe(before.storybookHash);
  });
});
