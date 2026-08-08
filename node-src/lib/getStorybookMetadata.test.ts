import { describe, expect, it, vi } from 'vitest';

import {
  findStaticDirectories,
  getStorybookMetadata,
  MainConfigReader,
} from './getStorybookMetadata';

// The two config forms are read by `readMainConfig`, so these only need a reader answering
// `staticDirs`; the forms themselves are covered by the fixture-based tests below.
function makeConfig(returnValue: any): MainConfigReader {
  return { readField: vi.fn().mockReturnValue(returnValue) };
}

describe('findStaticDirs', () => {
  it('returns string entries resolved relative to configDirectory', () => {
    const config = makeConfig(['./static', '../public']);
    expect(findStaticDirectories(config, '.storybook')).toEqual({
      staticDir: ['.storybook/static', 'public'],
    });
  });

  it('extracts `from` from object entries and resolves relative to configDirectory', () => {
    const config = makeConfig([
      { from: './static', to: '/' },
      { from: '../public', to: '/public' },
    ]);
    expect(findStaticDirectories(config, '.storybook')).toEqual({
      staticDir: ['.storybook/static', 'public'],
    });
  });

  it('handles mixed string and object entries', () => {
    const config = makeConfig(['./static', { from: '../public', to: '/' }]);
    expect(findStaticDirectories(config, '.storybook')).toEqual({
      staticDir: ['.storybook/static', 'public'],
    });
  });

  it('leaves absolute paths unchanged', () => {
    const config = makeConfig(['/absolute/path']);
    expect(findStaticDirectories(config, '.storybook')).toEqual({
      staticDir: ['/absolute/path'],
    });
  });

  it('uses nested configDirectory when provided', () => {
    const config = makeConfig(['./static']);
    expect(findStaticDirectories(config, 'packages/ui/.storybook')).toEqual({
      staticDir: ['packages/ui/.storybook/static'],
    });
  });

  it('returns {} for empty array', () => {
    const config = makeConfig([]);
    expect(findStaticDirectories(config)).toEqual({});
  });

  it('returns {} when the main config could not be read', () => {
    expect(findStaticDirectories(undefined)).toEqual({});
  });

  it('returns {} when staticDirs is not present on config', () => {
    const config = makeConfig(undefined);
    expect(findStaticDirectories(config)).toEqual({});
  });

  it('returns {} when staticDirs is a non-array value', () => {
    const config = makeConfig('./static');
    expect(findStaticDirectories(config)).toEqual({});
  });

  it('returns {} when all entries have no valid path', () => {
    const config = makeConfig([null, undefined, { to: '/' }]);
    expect(findStaticDirectories(config)).toEqual({});
  });
});

// Each fixture is a real project directory, because whether `require()` of the config succeeds
// depends on the file's extension and the nearest package.json `type`.
const FIXTURES = 'node-src/__mocks__/storybookMainConfig';

function getDeps(project: string) {
  return {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    options: { storybookConfigDir: `${FIXTURES}/${project}/.storybook` },
    // Pinned so the viewlayer lookup can't reach into this repo's own node_modules.
    env: { CHROMATIC_STORYBOOK_VERSION: '@storybook/react@8.0.0' },
    packageJson: {},
  } as any;
}

describe('getStorybookMetadata staticDirs discovery', () => {
  // Every config the shared pattern loads contributes its staticDirs the same way, whether
  // `require()` evaluated it (an ordinary cjs `main.js`) or it fell back to an AST parse (a
  // `main.ts`, or a `main.js` `require()` can't evaluate). The resolved paths are identical.
  it.each([
    { project: 'ts-esm', shape: 'a parsed main.ts' },
    { project: 'js-cjs', shape: 'an evaluated cjs main.js' },
    { project: 'js-esm-unrequirable', shape: "a main.js require() can't evaluate" },
  ])('resolves staticDirs from $shape', async ({ project }) => {
    const metadata = await getStorybookMetadata(getDeps(project));

    expect(metadata.staticDir).toEqual([
      `${FIXTURES}/${project}/.storybook/static`,
      `${FIXTURES}/${project}/public`,
    ]);
  });

  // `main.mjs` and `main.cjs` sit outside SHARED_MAIN_CONFIG_PATTERN, so the shared metadata path
  // never reads them and staticDirs stays unset. (TurboSnap v2 reads them via a wider pattern.)
  it.each([
    { project: 'mjs-esm', file: 'main.mjs' },
    { project: 'cjs', file: 'main.cjs' },
  ])('leaves staticDirs unset for $file (outside the shared pattern)', async ({ project }) => {
    const metadata = await getStorybookMetadata(getDeps(project));

    expect(metadata.staticDir).toBeUndefined();
  });
});

// Everything `getStorybookMetadata` returns lands on `ctx.storybook`, which TurboSnap v1 reads and
// the build announcement consumes. This pins the exact field set each config shape produces, so a
// change to how a config is read shows up here as a deliberate diff rather than slipping through.
describe('getStorybookMetadata fields visible on ctx.storybook', () => {
  it.each([
    { project: 'ts-esm', shape: 'a parsed main.ts', fields: ['staticDir', 'version'] },
    { project: 'mjs-esm', shape: 'an unreadable main.mjs', fields: ['builder', 'version'] },
    { project: 'cjs', shape: 'an unreadable main.cjs', fields: ['builder', 'version'] },
    { project: 'js-cjs', shape: 'an evaluated cjs main.js', fields: ['staticDir', 'version'] },
    {
      project: 'js-esm-unrequirable',
      shape: 'a parsed main.js',
      fields: ['staticDir', 'version'],
    },
    {
      project: 'builder-js-esm',
      shape: 'a main.js declaring a framework',
      fields: ['builder', 'version'],
    },
  ])('exposes exactly $fields for $shape', async ({ project, fields }) => {
    const metadata = await getStorybookMetadata(getDeps(project));

    expect(Object.keys(metadata).sort()).toEqual(fields);
  });

  // An ESM `main.js` is evaluated where `require(esm)` is available (unflagged from Node 22.12) and
  // AST-parsed where it is not (this package supports Node >=22.0). Both forms are now read the same
  // way, so both expose `staticDir` — the runtime path no longer changes what lands on ctx.storybook.
  it('exposes staticDir and version for an esm main.js regardless of the runtime read path', async () => {
    const metadata = await getStorybookMetadata(getDeps('js-esm'));

    expect(Object.keys(metadata).sort()).toEqual(['staticDir', 'version']);
  });

  // The sentinel is what v1 sees when no config could be read; a real name here means the config
  // was parsed after all.
  it.each([
    { project: 'mjs-esm', shape: 'main.mjs', builderName: 'unknown' },
    { project: 'cjs', shape: 'main.cjs', builderName: 'unknown' },
    { project: 'builder-js-esm', shape: 'main.js', builderName: '@storybook/react-vite' },
  ])('reports the $builderName builder for $shape', async ({ project, builderName }) => {
    const metadata = await getStorybookMetadata(getDeps(project));

    expect(metadata.builder?.name).toBe(builderName);
  });
});
