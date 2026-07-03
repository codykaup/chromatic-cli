import { describe, expect, it } from 'vitest';

import { Stats } from '../../types';
import { buildStoryHashes } from './buildStoryHashes';

// A small synthetic builder graph. Reasons are "who imports me", i.e. incoming edges. The tracer
// inverts these to walk downward from each story to its dependency files.
const stats: Stats = {
  modules: [
    {
      id: './storybook-config-entry.js',
      name: './storybook-config-entry.js',
      reasons: [],
    },
    {
      // The CSF glob container: imported by the entry, imports the story files.
      id: './src lazy',
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
      id: './src/helpers.js',
      name: './src/helpers.js',
      reasons: [{ moduleName: './src/button.js' }],
    },
    {
      id: './src/header.stories.js',
      name: './src/header.stories.js',
      reasons: [{ moduleName: String.raw`./src lazy recursive ^\.\/.*$` }],
    },
    {
      id: './src/header.js',
      name: './src/header.js',
      reasons: [{ moduleName: './src/header.stories.js' }],
    },
    {
      // An external module — cannot be hashed from disk.
      id: 'react',
      name: 'external "react"',
      reasons: [{ moduleName: './src/header.stories.js' }],
    },
    {
      // Shared config: hashed once, folded into every story.
      id: './.storybook/preview.js',
      name: './.storybook/preview.js',
      reasons: [{ moduleName: './storybook-config-entry.js' }],
    },
    {
      id: './.storybook/theme.js',
      name: './.storybook/theme.js',
      reasons: [{ moduleName: './.storybook/preview.js' }],
    },
  ],
};

describe('buildStoryHashes', () => {
  const result = buildStoryHashes(stats, { rootPath: '/repo' });

  it('discovers the CSF glob container', () => {
    expect(result.csfGlobs).toEqual([String.raw`src lazy recursive ^\.\/.*$`]);
  });

  it('finds each story file exactly once', () => {
    expect(result.stories.map((s) => s.storyFile)).toEqual([
      'src/button.stories.js',
      'src/header.stories.js',
    ]);
  });

  it('traces the transitive dependency files of each story (including the story itself)', () => {
    const button = result.stories.find((s) => s.storyFile === 'src/button.stories.js');
    expect(button?.files).toEqual(['src/button.js', 'src/button.stories.js', 'src/helpers.js']);

    const header = result.stories.find((s) => s.storyFile === 'src/header.stories.js');
    expect(header?.files).toEqual(['src/header.js', 'src/header.stories.js']);
  });

  it('does not leak one story into another story via the CSF glob', () => {
    const button = result.stories.find((s) => s.storyFile === 'src/button.stories.js');
    expect(button?.files).not.toContain('src/header.js');
  });

  it('records external modules as unhashable rather than as files', () => {
    const header = result.stories.find((s) => s.storyFile === 'src/header.stories.js');
    expect(header?.unhashable).toEqual([{ path: 'external "react"', reason: 'external' }]);
  });

  it('collects Storybook config files into the shared global section', () => {
    expect(result.globalFiles).toEqual(['.storybook/preview.js', '.storybook/theme.js']);
  });

  it('excludes global files from per-story dependency lists', () => {
    for (const story of result.stories) {
      expect(story.files).not.toContain('.storybook/preview.js');
    }
  });

  it('honors the untraced option', () => {
    const untraced = buildStoryHashes(stats, { rootPath: '/repo', untraced: ['src/helpers.js'] });
    const button = untraced.stories.find((s) => s.storyFile === 'src/button.stories.js');
    expect(button?.files).toEqual(['src/button.js', 'src/button.stories.js']);
  });
});
