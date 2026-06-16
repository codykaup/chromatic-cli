import mockfs from 'mock-fs';
import { afterEach, describe, expect, it } from 'vitest';

import { Stats } from '../node-src/types';
import { computeStoryHashes, diffBaseline } from './hashStoriesModule';

/**
 * Build a stats file from a forward dependency map (importer → its imports). The builder emits the
 * inverse (`reasons` = a module's importers), so we invert here to match the real shape.
 *
 * @param graph A map from a module name to the modules it imports and its content hash.
 *
 * @returns A stats object shaped like the builder's `preview-stats.json`.
 */
function statsFrom(graph: Record<string, { imports?: string[]; contentHash?: string }>): Stats {
  const reasons: Record<string, Set<string>> = {};
  for (const [importer, { imports = [] }] of Object.entries(graph)) {
    for (const imported of imports) {
      (reasons[imported] ??= new Set()).add(importer);
    }
  }
  return {
    modules: Object.entries(graph).map(([name, { contentHash }]) => ({
      id: name,
      name,
      contentHash,
      reasons: [...(reasons[name] ?? [])].map((moduleName) => ({ moduleName })),
    })),
  };
}

const VITE_APP = '/virtual:/@storybook/builder-vite/vite-app.js';

/**
 * A small graph with two independent stories, a shared component, and a preview dependency.
 *
 * @param overrides Per-module content-hash overrides, to simulate edits between builds.
 *
 * @returns A stats object for the graph.
 */
function buildGraph(overrides: Record<string, string> = {}): Stats {
  return statsFrom({
    [VITE_APP]: {
      imports: ['./src/Button.stories.tsx', './src/Other.stories.tsx', './.storybook/preview.ts'],
    },
    './src/Button.stories.tsx': { imports: ['./src/Button.tsx'], contentHash: 'btn-story' },
    './src/Button.tsx': {
      imports: ['./src/theme.ts'],
      contentHash: overrides['./src/Button.tsx'] ?? 'btn',
    },
    './src/theme.ts': { contentHash: overrides['./src/theme.ts'] ?? 'theme' },
    './src/Other.stories.tsx': { imports: ['./src/Other.tsx'], contentHash: 'other-story' },
    './src/Other.tsx': { contentHash: 'other' },
    './.storybook/preview.ts': {
      imports: ['./src/previewDep.ts'],
      contentHash: 'preview',
    },
    './src/previewDep.ts': {
      contentHash: overrides['./src/previewDep.ts'] ?? 'preview-dep',
    },
  });
}

describe('computeStoryHashes', () => {
  it('produces one stable hash per story file', () => {
    const { storyHashes } = computeStoryHashes(buildGraph());
    expect(Object.keys(storyHashes).sort()).toEqual([
      './src/Button.stories.tsx',
      './src/Other.stories.tsx',
    ]);
    // Stable across runs of the same input.
    expect(computeStoryHashes(buildGraph()).storyHashes).toEqual(storyHashes);
  });

  it('busts only the stories that reach a changed module', () => {
    const before = computeStoryHashes(buildGraph()).storyHashes;
    const after = computeStoryHashes(buildGraph({ './src/theme.ts': 'theme-v2' })).storyHashes;

    // Button depends on theme (Button.tsx → theme.ts); Other does not.
    expect(after['./src/Button.stories.tsx']).not.toBe(before['./src/Button.stories.tsx']);
    expect(after['./src/Other.stories.tsx']).toBe(before['./src/Other.stories.tsx']);
  });

  it('busts every story when a shared preview dependency changes', () => {
    const before = computeStoryHashes(buildGraph()).storyHashes;
    const after = computeStoryHashes(
      buildGraph({ './src/previewDep.ts': 'preview-dep-v2' })
    ).storyHashes;

    expect(after['./src/Button.stories.tsx']).not.toBe(before['./src/Button.stories.tsx']);
    expect(after['./src/Other.stories.tsx']).not.toBe(before['./src/Other.stories.tsx']);
  });

  it('folds preview config + its deps into the shared section', () => {
    const { sharedSection } = computeStoryHashes(buildGraph());
    expect(sharedSection.modules).toEqual(['./.storybook/preview.ts', './src/previewDep.ts']);
  });

  it('returns no stories and an empty shared section for an empty graph', () => {
    const { storyHashes, sharedSection } = computeStoryHashes({ modules: [] });
    expect(storyHashes).toEqual({});
    expect(sharedSection.modules).toEqual([]);
  });
});

describe('diffBaseline', () => {
  afterEach(() => mockfs.restore());

  it('reports changed, added, removed, and unchanged stories', () => {
    mockfs({
      './base.json': JSON.stringify({
        storyHashes: {
          './a.stories.tsx': 'h1',
          './b.stories.tsx': 'h2',
          './gone.stories.tsx': 'h3',
        },
      }),
    });

    const diff = diffBaseline('./base.json', {
      './a.stories.tsx': 'h1', // unchanged
      './b.stories.tsx': 'CHANGED', // changed
      './new.stories.tsx': 'h4', // added
      // './gone.stories.tsx' removed
    });

    expect(diff.changed).toEqual(['./b.stories.tsx']);
    expect(diff.added).toEqual(['./new.stories.tsx']);
    expect(diff.removed).toEqual(['./gone.stories.tsx']);
    expect(diff.unchanged).toBe(1);
  });
});
