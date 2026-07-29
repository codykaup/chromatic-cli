import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readStatsFile } from '../../../tasks/readStatsFile';
import { determineChangedFiles } from './api';
import { getBuilderViteFallbackReason } from './builderViteCompatibility';
import { traceChangedFiles } from './index';
import { buildManifest, writeManifest } from './manifest';

vi.mock('../../../tasks/readStatsFile', () => ({
  readStatsFile: vi.fn(),
}));

vi.mock('./builderViteCompatibility', () => ({
  getBuilderViteFallbackReason: vi.fn(),
}));

vi.mock('./manifest', () => ({
  buildManifest: vi.fn(),
  writeManifest: vi.fn(),
}));

vi.mock('./api', () => ({
  determineChangedFiles: vi.fn(),
}));

const input = {
  graphqlClient: {} as any,
  buildId: 'build-id',
  statsPath: '/repo/packages/ui/storybook-static/preview-stats.json',
  manifestOutputDirectory: '/repo/packages/ui/.chromatic',
  projectRoot: '/repo/packages/ui',
  gitRoot: '/repo',
  configDir: '.storybook',
  staticDirs: ['.storybook/static'],
};

beforeEach(() => {
  vi.mocked(readStatsFile).mockResolvedValue({ modules: [] });
  vi.mocked(getBuilderViteFallbackReason).mockReturnValue(undefined);
  vi.mocked(buildManifest).mockResolvedValue({ storybookHash: 'hash' } as any);
});

describe('traceChangedFiles', () => {
  it('falls back before manifest upload when builder-vite stats are known invalid', async () => {
    vi.mocked(getBuilderViteFallbackReason).mockReturnValue(
      '@storybook/builder-vite@10.6.0-alpha.3 is known to drop Vite CJS importer edges'
    );

    const result = await traceChangedFiles(input);

    expect(result).toEqual({
      status: 'fallback',
      reason: '@storybook/builder-vite@10.6.0-alpha.3 is known to drop Vite CJS importer edges',
    });
    expect(buildManifest).not.toHaveBeenCalled();
    expect(determineChangedFiles).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
  });

  it('uploads and writes a manifest when the stats pass compatibility checks', async () => {
    await traceChangedFiles(input);

    expect(buildManifest).toHaveBeenCalledWith(
      { modules: [] },
      {
        projectRoot: '/repo/packages/ui',
        gitRoot: '/repo',
      },
      {
        configDir: '.storybook',
        staticDirs: ['.storybook/static'],
      }
    );
    expect(determineChangedFiles).toHaveBeenCalledWith(input.graphqlClient, 'build-id', {
      storybookHash: 'hash',
    });
    expect(writeManifest).toHaveBeenCalledWith(
      { storybookHash: 'hash' },
      '/repo/packages/ui/.chromatic'
    );
  });
});
