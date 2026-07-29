import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Stats } from '../../../types';
import { getBuilderViteFallbackReason } from './builderViteCompatibility';

vi.mock('module', () => ({
  createRequire: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

const mockCreateRequire = vi.mocked(
  createRequire as (filename: string) => { resolve: (request: string) => string }
);
const mockReadFileSync = vi.mocked(readFileSync as (path: string) => string);
const mockResolve = vi.fn();

const projectRoot = '/repo/packages/ui';

function viteStats(): Stats {
  return {
    modules: [
      {
        id: 1,
        name: '/virtual:/@storybook/builder-vite/storybook-stories.js',
        reasons: [],
      },
    ],
  };
}

function webpackStats(): Stats {
  return {
    modules: [
      {
        id: 1,
        name: './storybook-stories.js',
        reasons: [],
      },
    ],
  };
}

beforeEach(() => {
  mockCreateRequire.mockReturnValue({ resolve: mockResolve });
  mockResolve.mockReturnValue('/repo/node_modules/@storybook/builder-vite/package.json');
  mockReadFileSync.mockReturnValue(JSON.stringify({ version: '10.6.0-alpha.3' }));
});

describe('getBuilderViteFallbackReason', () => {
  it('does not fall back for non-Vite stats', () => {
    expect(getBuilderViteFallbackReason(webpackStats(), projectRoot)).toBeUndefined();
  });

  it('falls back for known-invalid builder-vite versions', () => {
    expect(getBuilderViteFallbackReason(viteStats(), projectRoot)).toContain(
      '@storybook/builder-vite@10.6.0-alpha.3'
    );
  });

  it('resolves builder-vite from the Storybook project root', () => {
    getBuilderViteFallbackReason(viteStats(), projectRoot);

    expect(mockCreateRequire).toHaveBeenCalledWith('/repo/packages/ui/package.json');
    expect(mockResolve).toHaveBeenCalledWith('@storybook/builder-vite/package.json');
  });

  it('does not fall back once the stats are from a known-fixed builder-vite', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '10.6.0-alpha.4' }));

    expect(getBuilderViteFallbackReason(viteStats(), projectRoot)).toBeUndefined();
  });

  it('falls back when Vite stats are detected but builder-vite cannot be resolved', () => {
    mockResolve.mockImplementation(() => {
      throw new Error('Cannot find module');
    });

    expect(getBuilderViteFallbackReason(viteStats(), projectRoot)).toContain(
      'could not resolve @storybook/builder-vite'
    );
  });
});
