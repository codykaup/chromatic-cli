import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashOutOfGraphFiles, rollUpOutOfGraphFiles } from './outOfGraphFiles';

// An in-memory tree of absolute directory -> entry names. A key that maps to entries is a directory;
// anything else named by a parent is a file. Backing the sweep this way keeps these tests off disk.
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
}));

// Content hashes are keyed by the absolute path getFileHashes is called with.
const { fileHashesRef } = vi.hoisted(() => ({
  fileHashesRef: { current: {} as Record<string, string> },
}));

vi.mock('../../getFileHashes', () => ({
  getFileHashes: (files: string[]) =>
    Promise.resolve(Object.fromEntries(files.map((f) => [f, fileHashesRef.current[f] ?? 'x']))),
}));

const roots = { projectRoot: '/repo/packages/ui', gitRoot: '/repo' };
const input = { configDir: '.storybook', staticDirs: ['.storybook/static'] };

const h64ToString = (value: string) => `h(${value})`;

beforeEach(() => {
  directoryTreeRef.current = {};
  fileHashesRef.current = {};
});

describe('hashOutOfGraphFiles', () => {
  it('hashes every config file recursively, keyed by canonical git-root-relative path', async () => {
    directoryTreeRef.current = {
      '/repo/packages/ui/.storybook': ['main.ts', 'preview.ts', 'nested'],
      '/repo/packages/ui/.storybook/nested': ['helper.ts'],
    };

    const { storybookConfigFiles } = await hashOutOfGraphFiles(input, roots);

    expect([...storybookConfigFiles.keys()]).toEqual([
      'packages/ui/.storybook/main.ts',
      'packages/ui/.storybook/nested/helper.ts',
      'packages/ui/.storybook/preview.ts',
    ]);
  });

  it('hashes preview.* alongside the rest of the config dir, so its bytes are covered too', async () => {
    directoryTreeRef.current = { '/repo/packages/ui/.storybook': ['main.ts', 'preview.ts'] };

    const { storybookConfigFiles } = await hashOutOfGraphFiles(input, roots);

    // The graph-rolled `.storybook/preview.ts` entry covers its *imports*; this covers its bytes,
    // which is what closes the empty-preview.ts case where the builder elides the module entirely.
    expect(storybookConfigFiles.has('packages/ui/.storybook/preview.ts')).toBe(true);
  });

  it('gives static files their own section, excluding them from the config sweep', async () => {
    directoryTreeRef.current = {
      '/repo/packages/ui/.storybook': ['main.ts', 'static'],
      '/repo/packages/ui/.storybook/static': ['mockServiceWorker.js'],
    };

    const { storybookConfigFiles, staticFiles } = await hashOutOfGraphFiles(input, roots);

    // Static wins over the config dir, mirroring v1 testing isStaticFile before isStorybookFile.
    expect([...storybookConfigFiles.keys()]).toEqual(['packages/ui/.storybook/main.ts']);
    expect([...staticFiles.keys()]).toEqual(['packages/ui/.storybook/static/mockServiceWorker.js']);
  });

  it('returns an empty static section when staticDirs is unset', async () => {
    directoryTreeRef.current = { '/repo/packages/ui/.storybook': ['main.ts'] };

    const { staticFiles } = await hashOutOfGraphFiles(
      { configDir: '.storybook', staticDirs: [] },
      roots
    );

    expect(staticFiles.size).toBe(0);
  });

  it('treats a configured but missing directory as contributing nothing rather than throwing', async () => {
    directoryTreeRef.current = {};

    const { storybookConfigFiles, staticFiles } = await hashOutOfGraphFiles(input, roots);

    expect(storybookConfigFiles.size).toBe(0);
    expect(staticFiles.size).toBe(0);
  });

  it('collects static files from every configured static directory', async () => {
    directoryTreeRef.current = {
      '/repo/packages/ui/.storybook': ['main.ts'],
      '/repo/packages/ui/public': ['logo.svg'],
      '/repo/packages/ui/assets': ['font.woff2'],
    };

    const { staticFiles } = await hashOutOfGraphFiles(
      { configDir: '.storybook', staticDirs: ['public', 'assets'] },
      roots
    );

    expect([...staticFiles.keys()]).toEqual([
      'packages/ui/assets/font.woff2',
      'packages/ui/public/logo.svg',
    ]);
  });
});

describe('rollUpOutOfGraphFiles', () => {
  it('rolls each section into its own synthetic entry', async () => {
    directoryTreeRef.current = {
      '/repo/packages/ui/.storybook': ['main.ts', 'static'],
      '/repo/packages/ui/.storybook/static': ['logo.svg'],
    };

    const rollUps = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    expect([...rollUps.keys()]).toEqual(['<storybookConfig>', '<staticFiles>']);
  });

  it('moves the config roll-up when a config file content changes', async () => {
    directoryTreeRef.current = { '/repo/packages/ui/.storybook': ['main.ts'] };
    fileHashesRef.current = { '/repo/packages/ui/.storybook/main.ts': 'M1' };
    const before = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    fileHashesRef.current = { '/repo/packages/ui/.storybook/main.ts': 'M2' };
    const after = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    expect(after.get('<storybookConfig>')).not.toBe(before.get('<storybookConfig>'));
  });

  it('moves the static roll-up when a static file content changes, leaving the config roll-up alone', async () => {
    directoryTreeRef.current = {
      '/repo/packages/ui/.storybook': ['main.ts', 'static'],
      '/repo/packages/ui/.storybook/static': ['logo.svg'],
    };
    const staticFile = '/repo/packages/ui/.storybook/static/logo.svg';
    fileHashesRef.current = { '/repo/packages/ui/.storybook/main.ts': 'M', [staticFile]: 'A1' };
    const before = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    fileHashesRef.current = { '/repo/packages/ui/.storybook/main.ts': 'M', [staticFile]: 'A2' };
    const after = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    expect(after.get('<staticFiles>')).not.toBe(before.get('<staticFiles>'));
    expect(after.get('<storybookConfig>')).toBe(before.get('<storybookConfig>'));
  });

  it('omits a section that has no files, matching how the globals catch-all behaves', async () => {
    directoryTreeRef.current = { '/repo/packages/ui/.storybook': ['main.ts'] };

    const rollUps = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    expect(rollUps.has('<staticFiles>')).toBe(false);
  });

  it('keeps a roll-up stable when the project moves, since it hashes content not paths', async () => {
    directoryTreeRef.current = { '/repo/packages/ui/.storybook': ['main.ts'] };
    fileHashesRef.current = { '/repo/packages/ui/.storybook/main.ts': 'M' };
    const before = rollUpOutOfGraphFiles(await hashOutOfGraphFiles(input, roots), h64ToString);

    directoryTreeRef.current = { '/repo/apps/web/.storybook': ['main.ts'] };
    fileHashesRef.current = { '/repo/apps/web/.storybook/main.ts': 'M' };
    const after = rollUpOutOfGraphFiles(
      await hashOutOfGraphFiles(input, { projectRoot: '/repo/apps/web', gitRoot: '/repo' }),
      h64ToString
    );

    expect(after.get('<storybookConfig>')).toBe(before.get('<storybookConfig>'));
  });
});
