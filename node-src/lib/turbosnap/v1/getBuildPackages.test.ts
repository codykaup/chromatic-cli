import { describe, expect, it } from 'vitest';

import { Context, Stats } from '../../../types';
import { getBuildPackages, isManifestRelevant } from './getBuildPackages';

const getContext = (input: any = {}) =>
  ({
    git: { rootPath: '/root' },
    storybook: { baseDir: '' },
    ...input,
  }) as Context;

const statsFromModuleNames = (names: string[]): Stats =>
  ({ modules: names.map((name) => ({ id: name, name, reasons: [] })) }) as unknown as Stats;

describe('getBuildPackages', () => {
  it('collects node_modules package names and non-node_modules source paths', () => {
    const stats = statsFromModuleNames([
      './src/components/Button.jsx',
      './node_modules/react/index.js',
      './node_modules/@storybook/react/dist/index.js',
      './packages/ui/src/index.ts',
    ]);

    const result = getBuildPackages(getContext(), stats);

    expect(result).toBeDefined();
    expect([...(result?.packageNames ?? [])]).toEqual(
      expect.arrayContaining(['react', '@storybook/react'])
    );
    expect(result?.sourceModulePaths).toEqual(
      expect.arrayContaining(['src/components/Button.jsx', 'packages/ui/src/index.ts'])
    );
  });

  it('prepends the storybook baseDir to relative source paths', () => {
    const stats = statsFromModuleNames(['./src/index.ts']);

    const result = getBuildPackages(getContext({ storybook: { baseDir: 'frontend' } }), stats);

    expect(result?.sourceModulePaths).toContain('frontend/src/index.ts');
  });

  it('returns undefined when the repository root is unknown', () => {
    const stats = statsFromModuleNames(['./src/index.ts']);

    expect(getBuildPackages(getContext({ git: {} }), stats)).toBeUndefined();
  });

  it('returns undefined when the stats file yields no usable modules', () => {
    expect(getBuildPackages(getContext(), statsFromModuleNames([]))).toBeUndefined();
  });
});

describe('isManifestRelevant', () => {
  const buildPackages = {
    packageNames: new Set(['react', '@acme/design-system']),
    sourceModulePaths: ['packages/ui/src/index.ts', 'src/app.tsx'],
  };

  it('always considers the root manifest relevant', () => {
    expect(isManifestRelevant('package.json', undefined, buildPackages)).toBe(true);
    expect(isManifestRelevant('package.json', 'root-pkg', buildPackages)).toBe(true);
  });

  it('considers a manifest relevant when its directory contains build source', () => {
    expect(isManifestRelevant('packages/ui/package.json', undefined, buildPackages)).toBe(true);
  });

  it('considers a manifest relevant when its declared name is bundled from node_modules', () => {
    expect(
      isManifestRelevant(
        'packages/design-system/package.json',
        '@acme/design-system',
        buildPackages
      )
    ).toBe(true);
  });

  it('considers a manifest irrelevant when nothing links it to the build', () => {
    expect(
      isManifestRelevant('packages/backend/package.json', '@acme/backend', buildPackages)
    ).toBe(false);
  });

  it('does not match on a partial directory prefix', () => {
    // `packages/u` must not match `packages/ui/...`
    expect(isManifestRelevant('packages/u/package.json', undefined, buildPackages)).toBe(false);
  });
});
