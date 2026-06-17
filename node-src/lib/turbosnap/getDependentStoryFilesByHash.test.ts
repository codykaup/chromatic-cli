import { describe, expect, it } from 'vitest';

import { Context, Module, Stats } from '../../types';
import {
  compareStoryHashes,
  getDependentStoryFilesByHash,
  hasContentHashes,
} from './getDependentStoryFilesByHash';

const ENTRY = '/virtual:/@storybook/builder-vite/vite-app.js';
const STORIES = '/virtual:/@storybook/builder-vite/storybook-stories.js';
const PROJECT_ANNOTATIONS = '/virtual:/@storybook/builder-vite/project-annotations.js';

const options = {
  normalize: (p: string) => p,
  storiesEntryFiles: [ENTRY],
  isStorybookFile: (name: string) => name.startsWith('.storybook/'),
};

// A small graph that mirrors the real Vite shape:
//   vite-app -> storybook-stories -> a/b/c/d.stories   (d imports a)
//   a,b -> shared.ts
//   vite-app -> project-annotations -> preview.ts -> ansi-html   (preview subgraph)
const baseModules = (): Module[] => [
  { id: ENTRY, name: ENTRY, reasons: [{ moduleName: './iframe.html' }], contentHash: 'app0' },
  { id: STORIES, name: STORIES, reasons: [{ moduleName: ENTRY }], contentHash: 'glob0' },
  {
    id: PROJECT_ANNOTATIONS,
    name: PROJECT_ANNOTATIONS,
    reasons: [{ moduleName: ENTRY }],
    contentHash: 'pa0',
  },
  {
    id: '.storybook/preview.ts',
    name: '.storybook/preview.ts',
    reasons: [{ moduleName: PROJECT_ANNOTATIONS }],
    contentHash: 'prev0',
  },
  {
    id: 'node_modules/ansi-html/index.js',
    name: 'node_modules/ansi-html/index.js',
    reasons: [{ moduleName: '.storybook/preview.ts' }],
    contentHash: 'ansi0',
  },
  {
    id: 'src/a.stories.ts',
    name: 'src/a.stories.ts',
    reasons: [{ moduleName: STORIES }, { moduleName: 'src/d.stories.ts' }],
    contentHash: 'a0',
  },
  {
    id: 'src/b.stories.ts',
    name: 'src/b.stories.ts',
    reasons: [{ moduleName: STORIES }],
    contentHash: 'b0',
  },
  {
    id: 'src/c.stories.ts',
    name: 'src/c.stories.ts',
    reasons: [{ moduleName: STORIES }],
    contentHash: 'c0',
  },
  {
    id: 'src/d.stories.ts',
    name: 'src/d.stories.ts',
    reasons: [{ moduleName: STORIES }],
    contentHash: 'd0',
  },
  {
    id: 'src/shared.ts',
    name: 'src/shared.ts',
    reasons: [{ moduleName: 'src/a.stories.ts' }, { moduleName: 'src/b.stories.ts' }],
    contentHash: 'shared0',
  },
];

const stats = (modules: Module[]): Stats => ({ modules });
const clone = (): Module[] =>
  baseModules().map((m) => ({ ...m, reasons: m.reasons?.map((r) => ({ ...r })) }));
const setHash = (modules: Module[], name: string, hash?: string) => {
  const m = modules.find((x) => x.name === name);
  if (m) m.contentHash = hash;
  return modules;
};
const compare = (head: Module[]) => {
  const r = compareStoryHashes(stats(baseModules()), stats(head), options);
  return {
    changed: r.changed.sort(),
    added: r.added.sort(),
    removed: r.removed.sort(),
    previewChanged: r.previewChanged,
  };
};

describe('hasContentHashes', () => {
  it('detects content hashes in the build output', () => {
    expect(hasContentHashes(stats(baseModules()))).toBe(true);
    expect(hasContentHashes({ modules: [{ id: 'x', name: 'x' }] })).toBe(false);
  });
});

describe('compareStoryHashes', () => {
  it('reports no changes for an identical rebuild (determinism)', () => {
    expect(compare(clone())).toEqual({
      changed: [],
      added: [],
      removed: [],
      previewChanged: false,
    });
  });

  it('does not classify preview modules as story files', () => {
    // preview.ts and ansi-html are in the preview subgraph; changing only a story leaves them out
    const head = setHash(clone(), 'src/c.stories.ts', 'c1');
    const r = compare(head);
    expect(r.changed).toEqual(['src/c.stories.ts']);
    expect(r.changed).not.toContain('.storybook/preview.ts');
  });

  it('marks a changed story file and the stories that import it', () => {
    // d imports a, so changing a rolls up into both a and d
    expect(compare(setHash(clone(), 'src/a.stories.ts', 'a1')).changed).toEqual([
      'src/a.stories.ts',
      'src/d.stories.ts',
    ]);
  });

  it('marks every story that reaches a changed shared dependency', () => {
    // shared is reached by a, b, and (via a) d
    expect(compare(setHash(clone(), 'src/shared.ts', 'shared1')).changed).toEqual([
      'src/a.stories.ts',
      'src/b.stories.ts',
      'src/d.stories.ts',
    ]);
  });

  it('reports no change when a hash is unchanged (comment-only edit)', () => {
    // The builder emits an identical contentHash for comment-only edits, so nothing rolls up.
    expect(compare(clone())).toEqual({
      changed: [],
      added: [],
      removed: [],
      previewChanged: false,
    });
  });

  it('globalizes when a preview config file changes', () => {
    const r = compare(setHash(clone(), '.storybook/preview.ts', 'prev1'));
    expect(r.previewChanged).toBe(true);
    expect(r.changed.sort()).toEqual(
      ['src/a.stories.ts', 'src/b.stories.ts', 'src/c.stories.ts', 'src/d.stories.ts'].sort()
    );
  });

  it('globalizes when a preview-only dependency changes', () => {
    const r = compare(setHash(clone(), 'node_modules/ansi-html/index.js', 'ansi1'));
    expect(r.previewChanged).toBe(true);
    expect(r.changed.length).toBe(4);
  });

  it('detects added story files', () => {
    const head = clone();
    head.push({
      id: 'src/e.stories.ts',
      name: 'src/e.stories.ts',
      reasons: [{ moduleName: STORIES }],
      contentHash: 'e0',
    });
    expect(compare(head)).toEqual({
      changed: [],
      added: ['src/e.stories.ts'],
      removed: [],
      previewChanged: false,
    });
  });

  it('detects removed story files', () => {
    const head = clone().filter((m) => m.name !== 'src/c.stories.ts');
    expect(compare(head)).toEqual({
      changed: [],
      added: [],
      removed: ['src/c.stories.ts'],
      previewChanged: false,
    });
  });

  it('ignores dependencies that relocated but kept identical content', () => {
    // Rename a shared dep's path (e.g. a global package cache) without changing its content.
    const head = clone();
    const shared = head.find((m) => m.name === 'src/shared.ts');
    if (shared) shared.name = shared.id = 'cache/shared.ts';
    for (const m of head) {
      for (const reason of m.reasons ?? []) {
        if (reason.moduleName === 'src/shared.ts') reason.moduleName = 'cache/shared.ts';
      }
    }
    expect(compare(head)).toEqual({ changed: [], added: [], removed: [], previewChanged: false });
  });
});

describe('getDependentStoryFilesByHash', () => {
  it('returns affected story files keyed by module id', () => {
    const ctx = { turboSnap: {} } as unknown as Context;
    const result = getDependentStoryFilesByHash(
      ctx,
      stats(baseModules()),
      stats(setHash(clone(), 'src/c.stories.ts', 'c1')),
      options
    );
    expect(result).toEqual({ 'src/c.stories.ts': ['src/c.stories.ts'] });
    expect(ctx.turboSnap?.bailReason).toBeUndefined();
  });

  it('bails (returns undefined) and records a reason on a preview change', () => {
    const ctx = { turboSnap: {} } as unknown as Context;
    const result = getDependentStoryFilesByHash(
      ctx,
      stats(baseModules()),
      stats(setHash(clone(), '.storybook/preview.ts', 'prev1')),
      options
    );
    expect(result).toBeUndefined();
    expect(ctx.turboSnap?.bailReason).toEqual({
      changedStorybookFiles: ['.storybook/preview.ts'],
    });
  });
});
