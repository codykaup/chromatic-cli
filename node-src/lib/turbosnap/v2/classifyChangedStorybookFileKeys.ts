import type { TurboSnapBailReason } from '../../../types';
import { STATIC_FILES_KEY, STORYBOOK_CONFIG_KEY } from './outOfGraphFiles';
import { STORYBOOK_GLOBALS_KEY } from './storybookFiles';

const STORYBOOK_VERSION_KEY = '<storybookVersion>';
const KNOWN_SYNTHETIC_KEYS = new Set([
  STORYBOOK_GLOBALS_KEY,
  STATIC_FILES_KEY,
  STORYBOOK_CONFIG_KEY,
  STORYBOOK_VERSION_KEY,
]);

const isSyntheticKey = (key: string) => key.startsWith('<') && key.endsWith('>');

/** Selects the single V2 bail reason represented by changed Storybook-wide manifest keys. */
export function classifyChangedStorybookFileKeys(keys: string[]): TurboSnapBailReason | undefined {
  if (keys.some((key) => isSyntheticKey(key) && !KNOWN_SYNTHETIC_KEYS.has(key))) {
    return { indexContractViolation: true, bailSubreason: 'invalidResponse' };
  }
  if (keys.includes(STORYBOOK_GLOBALS_KEY)) return { changedStorybookGlobals: true };
  if (keys.includes(STATIC_FILES_KEY)) return { changedStaticFiles: [STATIC_FILES_KEY] };

  const changedStorybookFiles = keys.filter(
    (key) => key === STORYBOOK_CONFIG_KEY || !isSyntheticKey(key)
  );
  if (changedStorybookFiles.length > 0) return { changedStorybookFiles };
  if (keys.includes(STORYBOOK_VERSION_KEY)) return { changedStorybookVersion: true };
  return undefined;
}
