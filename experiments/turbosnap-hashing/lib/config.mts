/**
 * Target configuration. Defaults reproduce the chromatic-cli run; override via env to point the
 * harness at another repo (e.g. storybookjs/storybook). All paths are absolute.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const env = process.env;

/** Git repo root of the target (where `git ls-files` runs). */
export const REPO_ROOT =
  env.TS_REPO_ROOT ?? execSync('git rev-parse --show-toplevel').toString().trim();

/** Builder-emitted stats file (ground truth). */
export const STATS_PATH = env.TS_STATS ?? path.join(REPO_ROOT, 'storybook-static/preview-stats.json');

/** tsconfig used by the oxc/typescript resolvers. */
export const TSCONFIG = env.TS_TSCONFIG ?? path.join(REPO_ROOT, 'tsconfig.json');

/** Resolver export/import conditions (storybook uses a custom `code` condition → src .ts entries). */
export const CONDITIONS = (env.TS_CONDITIONS ?? '').split(',').filter(Boolean);

/** baseDir passed to getDependentStoryFiles (stats module paths are relative to this dir). */
export const STORY_BASE_DIR = env.TS_BASE_DIR ?? '';

/** Storybook config dir relative to repo root. */
export const CONFIG_DIR = env.TS_CONFIG_DIR ?? '.storybook';

/** Static dirs relative to repo root. */
export const STATIC_DIRS = (env.TS_STATIC_DIRS ?? 'static').split(',').filter(Boolean);

/** Regex (on repo-relative POSIX path) identifying story files. */
export const STORY_RE = new RegExp(
  env.TS_STORY_RE ?? '^node-src/.*\\.(mdx|stories\\.[^/]+)$'
);

/** Regex (on repo-relative POSIX path) selecting the candidate source-file universe. */
export const SOURCE_INCLUDE_RE = new RegExp(env.TS_SOURCE_RE ?? '^(node-src/|isChromatic\\.(js|mjs)$)');

/** Regex of paths to exclude from the universe (tests, dist, etc.). */
export const SOURCE_EXCLUDE_RE = new RegExp(env.TS_EXCLUDE_RE ?? '\\.(test|spec)\\.[jt]sx?$|/__|/dist/');

export const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.mdx'];
