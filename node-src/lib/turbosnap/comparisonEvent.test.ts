import { describe, expect, it } from 'vitest';

import { createTurboSnapComparisonEvent } from './comparisonEvent';

describe('createTurboSnapComparisonEvent', () => {
  it('selects one v2 bail reason and omits an absent subreason', () => {
    expect(
      createTurboSnapComparisonEvent({
        schemaVersion: 1,
        buildId: 'build-id',
        mode: 'monitoring',
        onlyStoryFilesSource: 'V1',
        v1: {
          status: 'bailed',
          turboSnap: {
            bailReason: {
              invalidChangedFiles: true,
              bailSubreason: 'networkError',
            },
          },
        },
        v2: {
          status: 'bailed',
          turboSnap: {
            bailReason: {
              changedStorybookVersion: true,
              changedStorybookFiles: ['./.storybook/preview.ts'],
              changedStorybookGlobals: true,
              changedStaticFiles: ['./public/logo.svg'],
            },
          },
        },
      })
    ).toEqual({
      schema_version: 1,
      build_id: 'build-id',
      mode: 'monitoring',
      only_story_files_source: 'V1',
      v1_outcome: 'BAILED',
      v1_reason: 'invalidChangedFiles',
      v1_subreason: 'networkError',
      v2_outcome: 'BAILED',
      v2_reason: 'changedStorybookGlobals',
    });
  });

  it('maps an unavailable skip without inventing a subreason', () => {
    expect(
      createTurboSnapComparisonEvent({
        schemaVersion: 1,
        buildId: 'build-id',
        mode: 'monitoring',
        onlyStoryFilesSource: 'V1',
        v1: { status: 'skipped', turboSnap: { unavailable: true } },
        v2: { status: 'skipped', turboSnap: { unavailable: true } },
      })
    ).toEqual({
      schema_version: 1,
      build_id: 'build-id',
      mode: 'monitoring',
      only_story_files_source: 'V1',
      v1_outcome: 'UNAVAILABLE',
      v1_reason: 'unavailable',
      v2_outcome: 'UNAVAILABLE',
      v2_reason: 'unavailable',
    });
  });

  it('omits reasons for applied results and never leaks story paths', () => {
    const traced = {
      status: 'traced' as const,
      onlyStoryFiles: { button: ['./src/Button.stories.tsx'] },
      turboSnap: {},
      untracedFiles: [{ filepath: './src/ignored.ts', glob: '**/*.ts' }],
    };

    expect(
      createTurboSnapComparisonEvent({
        schemaVersion: 1,
        buildId: 'build-id',
        mode: 'monitoring',
        onlyStoryFilesSource: 'V1',
        v1: traced,
        v2: traced,
      })
    ).toEqual({
      schema_version: 1,
      build_id: 'build-id',
      mode: 'monitoring',
      only_story_files_source: 'V1',
      v1_outcome: 'APPLIED',
      v2_outcome: 'APPLIED',
    });
  });

  it('rejects a bailed result that has no analytics reason', () => {
    expect(() =>
      createTurboSnapComparisonEvent({
        schemaVersion: 1,
        buildId: 'build-id',
        mode: 'monitoring',
        onlyStoryFilesSource: 'V1',
        v1: { status: 'bailed', turboSnap: { bailReason: {} } },
        v2: {
          status: 'traced',
          onlyStoryFiles: {},
          turboSnap: {},
          untracedFiles: [],
        },
      })
    ).toThrow('A BAILED v1 result must have an analytics reason');
  });

  it('does not attach a subreason to a reason family that has none', () => {
    expect(
      createTurboSnapComparisonEvent({
        schemaVersion: 1,
        buildId: 'build-id',
        mode: 'monitoring',
        onlyStoryFilesSource: 'V1',
        v1: {
          status: 'traced',
          onlyStoryFiles: {},
          turboSnap: {},
          untracedFiles: [],
        },
        v2: {
          status: 'bailed',
          turboSnap: {
            bailReason: {
              changedStorybookGlobals: true,
              bailSubreason: 'invalidResponse',
            },
          },
        },
      })
    ).toEqual({
      schema_version: 1,
      build_id: 'build-id',
      mode: 'monitoring',
      only_story_files_source: 'V1',
      v1_outcome: 'APPLIED',
      v2_outcome: 'BAILED',
      v2_reason: 'changedStorybookGlobals',
    });
  });
});
