import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { Stats } from '../../types';
import {
  buildHashManifest,
  diffManifests,
  HASH_ALGORITHM,
  HASH_MANIFEST_SCHEMA_VERSION,
  HashManifest,
  MISSING_FILE_HASH,
} from './hashManifest';

const stats: Stats = {
  modules: [
    { id: './entry', name: './storybook-config-entry.js', reasons: [] },
    {
      id: './glob',
      name: String.raw`./src lazy recursive ^\.\/.*$`,
      reasons: [{ moduleName: './storybook-config-entry.js' }],
    },
    {
      id: './src/button.stories.js',
      name: './src/button.stories.js',
      reasons: [{ moduleName: String.raw`./src lazy recursive ^\.\/.*$` }],
    },
    {
      id: './src/button.js',
      name: './src/button.js',
      reasons: [{ moduleName: './src/button.stories.js' }],
    },
    {
      id: './src/header.stories.js',
      name: './src/header.stories.js',
      reasons: [{ moduleName: String.raw`./src lazy recursive ^\.\/.*$` }],
    },
    {
      // References a file the builder saw but which won't exist on disk in our fixture.
      id: './src/missing.js',
      name: './src/missing.js',
      reasons: [{ moduleName: './src/header.stories.js' }],
    },
    {
      id: './.storybook/preview.js',
      name: './.storybook/preview.js',
      reasons: [{ moduleName: './storybook-config-entry.js' }],
    },
  ],
};

const writeTree = (root: string, files: Record<string, string>) => {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
};

async function manifestFor(files: Record<string, string>): Promise<HashManifest> {
  const root = await mkdtemp(path.join(tmpdir(), 'ts2-hash-'));
  writeTree(root, files);
  const manifest = await buildHashManifest(stats, { rootPath: root });
  await rm(root, { recursive: true, force: true });
  return manifest;
}

const baseFiles = {
  'src/button.stories.js': 'export const Button = {};',
  'src/button.js': 'export const button = 1;',
  'src/header.stories.js': 'export const Header = {};',
  '.storybook/preview.js': 'export const parameters = {};',
};

describe('buildHashManifest', () => {
  let manifest: HashManifest;
  beforeAll(async () => {
    manifest = await manifestFor(baseFiles);
  });

  it('emits schema + algorithm metadata', () => {
    expect(manifest.schemaVersion).toBe(HASH_MANIFEST_SCHEMA_VERSION);
    expect(manifest.algorithm).toBe(HASH_ALGORITHM);
  });

  it('produces a hash per story', () => {
    expect(Object.keys(manifest.stories).sort()).toEqual([
      'src/button.stories.js',
      'src/header.stories.js',
    ]);
    for (const section of Object.values(manifest.stories)) {
      expect(section.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('records missing files with the missing sentinel', () => {
    const header = manifest.stories['src/header.stories.js'];
    expect(header.files['src/missing.js']).toBe(MISSING_FILE_HASH);
    expect(manifest.summary.missingFileCount).toBe(1);
  });

  it('folds the global section into every story hash', () => {
    expect(manifest.global.files['.storybook/preview.js']).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('diffManifests', () => {
  it('reports no recapture when nothing changed', async () => {
    const a = await manifestFor(baseFiles);
    const b = await manifestFor(baseFiles);
    const diff = diffManifests(a, b);
    expect(diff.recapture).toEqual([]);
    expect(diff.globalChanged).toBe(false);
  });

  it('recaptures only the story whose dependency changed', async () => {
    const baseline = await manifestFor(baseFiles);
    const current = await manifestFor({
      ...baseFiles,
      'src/button.js': 'export const button = 2; // edited',
    });
    const diff = diffManifests(baseline, current);
    expect(diff.recapture).toEqual(['src/button.stories.js']);
    expect(diff.changed[0].changedFiles.map((c) => c.file)).toContain('src/button.js');
  });

  it('recaptures the story when the story file itself changes', async () => {
    const baseline = await manifestFor(baseFiles);
    const current = await manifestFor({
      ...baseFiles,
      'src/header.stories.js': 'export const Header = { edited: true };',
    });
    const diff = diffManifests(baseline, current);
    expect(diff.recapture).toEqual(['src/header.stories.js']);
  });

  it('recaptures every story when the global section changes', async () => {
    const baseline = await manifestFor(baseFiles);
    const current = await manifestFor({
      ...baseFiles,
      '.storybook/preview.js': 'export const parameters = { layout: "fullscreen" };',
    });
    const diff = diffManifests(baseline, current);
    expect(diff.globalChanged).toBe(true);
    expect(diff.recapture.sort()).toEqual(['src/button.stories.js', 'src/header.stories.js']);
  });

  it('detects added and removed stories', () => {
    const baseline: HashManifest = {
      schemaVersion: 1,
      algorithm: HASH_ALGORITHM,
      storybook: { configDir: '.storybook', baseDir: '', staticDirs: [] },
      csfGlobs: [],
      global: { hash: 'g', files: {}, unhashable: [] },
      stories: {
        'a.stories.js': { hash: 'h1', files: {}, unhashable: [] },
        'gone.stories.js': { hash: 'h2', files: {}, unhashable: [] },
      },
      summary: { storyCount: 2, fileCount: 0, missingFileCount: 0, unhashableCount: 0 },
    };
    const current: HashManifest = {
      ...baseline,
      stories: {
        'a.stories.js': { hash: 'h1', files: {}, unhashable: [] },
        'new.stories.js': { hash: 'h3', files: {}, unhashable: [] },
      },
    };
    const diff = diffManifests(baseline, current);
    expect(diff.added).toEqual(['new.stories.js']);
    expect(diff.removed).toEqual(['gone.stories.js']);
    expect(diff.recapture).toEqual(['new.stories.js']);
  });

  it('recaptures everything on a schema/algorithm mismatch', () => {
    const baseline: HashManifest = {
      schemaVersion: 0,
      algorithm: 'md5',
      storybook: { configDir: '.storybook', baseDir: '', staticDirs: [] },
      csfGlobs: [],
      global: { hash: 'g', files: {}, unhashable: [] },
      stories: { 'a.stories.js': { hash: 'h1', files: {}, unhashable: [] } },
      summary: { storyCount: 1, fileCount: 0, missingFileCount: 0, unhashableCount: 0 },
    };
    const current: HashManifest = {
      ...baseline,
      schemaVersion: 1,
      algorithm: HASH_ALGORITHM,
    };
    const diff = diffManifests(baseline, current);
    expect(diff.incompatible).toBe(true);
    expect(diff.recapture).toEqual(['a.stories.js']);
  });
});
