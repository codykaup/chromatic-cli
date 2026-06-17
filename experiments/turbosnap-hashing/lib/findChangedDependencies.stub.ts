// esbuild alias stub: getDependentStoryFiles only needs this constant; the real module pulls in
// snyk/execa which we don't want in the ground-truth bundle.
export const SUPPORTED_LOCK_FILES = ['yarn.lock', 'pnpm-lock.yaml', 'package-lock.json'];
