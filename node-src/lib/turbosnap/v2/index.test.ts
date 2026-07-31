import * as Sentry from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readStatsFile } from '../../../tasks/readStatsFile';
import { captureBailException } from '../v1/captureBailException';
import { determineChangedFiles } from './api';
import { getUntrustedBuilderStatsReason } from './builderViteCompatibility';
import { traceChangedFiles } from './index';
import { buildManifest, writeManifest } from './manifest';

vi.mock('../../../tasks/readStatsFile', () => ({
  readStatsFile: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

vi.mock('../v1/captureBailException', () => ({
  captureBailException: vi.fn(() => 'sentry-event-id'),
}));

vi.mock('./builderViteCompatibility', () => ({
  getUntrustedBuilderStatsReason: vi.fn(),
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
  configDir: '.storybook',
  staticDirs: ['.storybook/static'],
};

const manifest = {
  storybookHash: 'hash',
  storyFileHashes: new Map([['./src/Button.stories.tsx', 'story-hash']]),
};

beforeEach(() => {
  vi.mocked(readStatsFile).mockResolvedValue({ modules: [] });
  vi.mocked(getUntrustedBuilderStatsReason).mockReturnValue(undefined);
  vi.mocked(buildManifest).mockResolvedValue(manifest as any);
});

describe('traceChangedFiles', () => {
  it('preserves the terminal missing or unreadable stats behavior', async () => {
    const error = new Error('stats file is unreadable');
    vi.mocked(readStatsFile).mockRejectedValue(error);

    await expect(traceChangedFiles(input)).rejects.toBe(error);
    expect(getUntrustedBuilderStatsReason).not.toHaveBeenCalled();
    expect(captureBailException).not.toHaveBeenCalled();
  });

  it('bails before manifest upload when builder-vite stats are known invalid', async () => {
    vi.mocked(getUntrustedBuilderStatsReason).mockReturnValue({
      reason: 'untrustedBuilderStats',
      subreason: 'unsupportedVersion',
      builderName: '@storybook/builder-vite',
      builderVersion: '10.6.0-alpha.3',
    });

    const result = await traceChangedFiles(input);

    expect(result).toEqual({
      status: 'bailed',
      turboSnap: {
        bailReason: {
          untrustedBuilderStats: true,
          bailSubreason: 'unsupportedVersion',
          builderName: '@storybook/builder-vite',
          builderVersion: '10.6.0-alpha.3',
        },
      },
    });
    expect(buildManifest).not.toHaveBeenCalled();
    expect(determineChangedFiles).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
  });

  it('bails with a Sentry ID when the builder compatibility check fails unexpectedly', async () => {
    const error = new Error('package metadata is unreadable');
    vi.mocked(getUntrustedBuilderStatsReason).mockImplementation(() => {
      throw error;
    });

    await expect(traceChangedFiles(input)).resolves.toEqual({
      status: 'bailed',
      turboSnap: {
        bailReason: {
          internalError: true,
          bailSubreason: 'builderCompatibilityCheckFailed',
          sentryEventId: 'sentry-event-id',
        },
      },
    });
    expect(captureBailException).toHaveBeenCalledWith(error, {
      bailSubreason: 'builderCompatibilityCheckFailed',
      bailPath: 'getUntrustedBuilderStatsReason',
    });
    expect(buildManifest).not.toHaveBeenCalled();
  });

  it('uploads and writes a manifest when the stats pass compatibility checks', async () => {
    await traceChangedFiles(input);

    expect(buildManifest).toHaveBeenCalledWith({ modules: [] }, '/repo/packages/ui', {
      configDir: '.storybook',
      staticDirs: ['.storybook/static'],
    });
    expect(determineChangedFiles).toHaveBeenCalledWith(input.graphqlClient, 'build-id', manifest);
    expect(writeManifest).toHaveBeenCalledWith(manifest, '/repo/packages/ui/.chromatic');
  });

  it('bails with indexUnavailable when the Index request times out', async () => {
    vi.mocked(determineChangedFiles).mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })
    );

    await expect(traceChangedFiles(input)).resolves.toEqual({
      status: 'bailed',
      turboSnap: {
        bailReason: {
          indexUnavailable: true,
          bailSubreason: 'networkError',
        },
      },
    });
    expect(writeManifest).toHaveBeenCalledWith(manifest, '/repo/packages/ui/.chromatic');
    expect(captureBailException).not.toHaveBeenCalled();
  });

  it('leaves the indexUnavailable subreason absent when the request error is unclassified', async () => {
    vi.mocked(determineChangedFiles).mockRejectedValue(new Error('request failed unexpectedly'));

    await expect(traceChangedFiles(input)).resolves.toEqual({
      status: 'bailed',
      turboSnap: { bailReason: { indexUnavailable: true } },
    });
  });

  it('bails with a Sentry ID when manifest construction fails', async () => {
    const error = new Error('hashing failed');
    vi.mocked(buildManifest).mockRejectedValue(error);

    await expect(traceChangedFiles(input)).resolves.toEqual({
      status: 'bailed',
      turboSnap: {
        bailReason: {
          internalError: true,
          bailSubreason: 'manifestBuildFailed',
          sentryEventId: 'sentry-event-id',
        },
      },
    });
    expect(captureBailException).toHaveBeenCalledWith(error, {
      bailSubreason: 'manifestBuildFailed',
      bailPath: 'buildManifest',
    });
    expect(determineChangedFiles).not.toHaveBeenCalled();
  });

  it('bails without uploading when the graph contains no story files', async () => {
    const storyless = { storybookHash: 'hash', storyFileHashes: new Map() };
    vi.mocked(buildManifest).mockResolvedValue(storyless as any);

    const result = await traceChangedFiles(input);

    expect(result).toEqual({
      status: 'bailed',
      turboSnap: {
        bailReason: {
          noStoryFiles: true,
        },
      },
    });
    expect(determineChangedFiles).not.toHaveBeenCalled();
    expect(writeManifest).toHaveBeenCalledWith(storyless, '/repo/packages/ui/.chromatic');
  });

  it('preserves the no-story bail when writing its diagnostic manifest fails', async () => {
    const storyless = { storybookHash: 'hash', storyFileHashes: new Map() };
    const error = new Error('disk is read-only');
    vi.mocked(buildManifest).mockResolvedValue(storyless as any);
    vi.mocked(writeManifest).mockImplementation(() => {
      throw error;
    });

    await expect(traceChangedFiles(input)).resolves.toEqual({
      status: 'bailed',
      turboSnap: { bailReason: { noStoryFiles: true } },
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { turbo_snap_v2_diagnostic: 'writeManifest' },
    });
  });
});
