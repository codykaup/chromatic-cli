import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { findStaticDirectories, getStorybookMetadata } from './getStorybookMetadata';
import { posix } from './posix';

const makeConfig = (returnValue: any) => ({
  getSafeFieldValue: vi.fn().mockReturnValue(returnValue),
});

describe('findStaticDirs', () => {
  it('returns string entries resolved relative to configDirectory', () => {
    const config = makeConfig(['./static', '../public']);
    expect(findStaticDirectories(config, true, '.storybook')).toEqual({
      staticDir: ['.storybook/static', 'public'],
    });
  });

  it('extracts `from` from object entries and resolves relative to configDirectory', () => {
    const config = makeConfig([
      { from: './static', to: '/' },
      { from: '../public', to: '/public' },
    ]);
    expect(findStaticDirectories(config, true, '.storybook')).toEqual({
      staticDir: ['.storybook/static', 'public'],
    });
  });

  it('handles mixed string and object entries', () => {
    const config = makeConfig(['./static', { from: '../public', to: '/' }]);
    expect(findStaticDirectories(config, true, '.storybook')).toEqual({
      staticDir: ['.storybook/static', 'public'],
    });
  });

  it('leaves absolute paths unchanged', () => {
    const config = makeConfig(['/absolute/path']);
    expect(findStaticDirectories(config, true, '.storybook')).toEqual({
      staticDir: ['/absolute/path'],
    });
  });

  it('uses nested configDirectory when provided', () => {
    const config = makeConfig(['./static']);
    expect(findStaticDirectories(config, true, 'packages/ui/.storybook')).toEqual({
      staticDir: ['packages/ui/.storybook/static'],
    });
  });

  it('returns {} for empty array', () => {
    const config = makeConfig([]);
    expect(findStaticDirectories(config, true)).toEqual({});
  });

  it('reads staticDirs off an evaluated CommonJS config module', () => {
    expect(findStaticDirectories({ staticDirs: ['./static'] }, false)).toEqual({
      staticDir: ['.storybook/static'],
    });
  });

  it('reads staticDirs off the default export of an evaluated ESM config module', () => {
    expect(findStaticDirectories({ default: { staticDirs: ['./static'] } }, false)).toEqual({
      staticDir: ['.storybook/static'],
    });
  });

  it('returns {} when mainConfig is null', () => {
    expect(findStaticDirectories(null, true)).toEqual({});
  });

  it('returns {} when staticDirs is not present on config', () => {
    const config = makeConfig(undefined);
    expect(findStaticDirectories(config, true)).toEqual({});
  });

  it('returns {} when staticDirs is a non-array value', () => {
    const config = makeConfig('./static');
    expect(findStaticDirectories(config, true)).toEqual({});
  });

  it('returns {} when all entries have no valid path', () => {
    const config = makeConfig([null, undefined, { to: '/' }]);
    expect(findStaticDirectories(config, true)).toEqual({});
  });
});

// Whether `staticDirs` is found used to depend on the config's *filename*, because it was gated on
// `require()` having failed. These cases write a real project per filename and module format and read
// them through the real `getStorybookMetadata`, since that gate is invisible to any mock — and
// invisible to the v2 harness too, which uses its own wider discovery.
//
// Recorded because the behavior moves under the runtime: on Node < 22 `require()` of an ESM `main.js`
// failed and took the AST branch; on Node >= 22 it succeeds and takes the evaluated-module branch.
// Measured on Node v22.22.3.
const ESM_CONFIG = `export default { staticDirs: ['./static', '../public'] };`;
const CJS_CONFIG = `module.exports = { staticDirs: ['./static', '../public'] };`;

const CONFIG_FORMATS = [
  { file: 'main.ts', format: 'esm', type: undefined, source: ESM_CONFIG },
  { file: 'main.js', format: 'esm', type: 'module', source: ESM_CONFIG },
  { file: 'main.js', format: 'cjs', type: undefined, source: CJS_CONFIG },
  { file: 'main.mjs', format: 'esm', type: undefined, source: ESM_CONFIG },
  { file: 'main.cjs', format: 'cjs', type: undefined, source: CJS_CONFIG },
];

async function writeProject(file: string, type: string | undefined, source: string) {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'chromatic-sb-config-'));
  const configDirectory = path.join(projectDirectory, '.storybook');
  await mkdir(configDirectory);
  // Node decides a `.js` file's module format from the nearest package.json, so the marker is what
  // makes the two `main.js` cases genuinely different files rather than the same one twice.
  const packageJson = JSON.stringify({ name: 'fixture', ...(type && { type }) });
  await writeFile(path.join(projectDirectory, 'package.json'), packageJson);
  await writeFile(path.join(configDirectory, file), source);
  return { projectDirectory, configDirectory };
}

describe('getStorybookMetadata staticDirs discovery', () => {
  for (const { file, format, type, source } of CONFIG_FORMATS) {
    it(`resolves staticDirs from ${file} (${format})`, async () => {
      const { projectDirectory, configDirectory } = await writeProject(file, type, source);

      const metadata = await getStorybookMetadata({
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        options: { storybookConfigDir: configDirectory },
        // Pinned so the viewlayer lookup can't reach into this repo's own node_modules.
        env: { CHROMATIC_STORYBOOK_VERSION: '@storybook/react@8.0.0' },
        packageJson: {},
      } as any);

      // Expectations run through `posix`, which drops the leading separator from the absolute config
      // directory these cases must pass. Production always passes a project-relative one, and the
      // exact join is pinned by the findStaticDirs cases above.
      expect(metadata.staticDir).toEqual([
        `${posix(configDirectory)}/static`,
        `${posix(projectDirectory)}/public`,
      ]);
    });
  }
});

describe('getStorybookMetadata builder discovery', () => {
  // The builder read the same field the same gated way, so an ESM `main.js` — which `require()` now
  // resolves into a `default`-wrapped module — reported no builder at all. Fixed by the same accessor.
  it('detects the builder from an evaluated ESM config module', async () => {
    const { configDirectory } = await writeProject(
      'main.js',
      'module',
      `export default { framework: { name: '@storybook/react-vite' } };`
    );

    const metadata = await getStorybookMetadata({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      options: { storybookConfigDir: configDirectory },
      env: { CHROMATIC_STORYBOOK_VERSION: '@storybook/react@8.0.0' },
      packageJson: {},
    } as any);

    expect(metadata.builder?.name).toBe('@storybook/react-vite');
  });
});
