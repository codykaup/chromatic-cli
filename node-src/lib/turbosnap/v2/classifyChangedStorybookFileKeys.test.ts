import { describe, expect, it } from 'vitest';

import { classifyChangedStorybookFileKeys } from './classifyChangedStorybookFileKeys';

describe('classifyChangedStorybookFileKeys', () => {
  it('selects one reason when several Storybook-wide inputs changed', () => {
    expect(
      classifyChangedStorybookFileKeys([
        '<storybookVersion>',
        './.storybook/preview.ts',
        '<staticFiles>',
        '<storybookGlobals>',
      ])
    ).toEqual({ changedStorybookGlobals: true });
  });

  it.each([
    [['<storybookGlobals>'], { changedStorybookGlobals: true }],
    [['<staticFiles>'], { changedStaticFiles: ['<staticFiles>'] }],
    [['<storybookConfig>'], { changedStorybookFiles: ['<storybookConfig>'] }],
    [['./.storybook/preview.ts'], { changedStorybookFiles: ['./.storybook/preview.ts'] }],
    [['<storybookVersion>'], { changedStorybookVersion: true }],
    [[], undefined],
  ])('classifies %j', (keys, expected) => {
    expect(classifyChangedStorybookFileKeys(keys as string[])).toEqual(expected);
  });

  it('treats an unknown synthetic key as an invalid response', () => {
    expect(classifyChangedStorybookFileKeys(['<futureBucket>'])).toEqual({
      indexContractViolation: true,
      bailSubreason: 'invalidResponse',
    });
  });
});
