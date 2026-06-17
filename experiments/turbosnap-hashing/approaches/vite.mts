/**
 * Approach B: borrow the builder's resolver. Vite dev server in middleware mode (no HTTP, no
 * bundling); resolve via `pluginContainer.resolveId` — the resolution the Vite/Storybook builder
 * uses. Imports extracted with oxc-parser to isolate the resolver's contribution. Aliases mirror
 * .storybook/main.ts viteFinal.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

import { REPO_ROOT, SOURCE_EXTS, type ParseFn, type ResolveFn } from '../lib/common.mts';
import { oxcImports } from './oxc.mts';

export const name = 'vite pluginContainer.resolveId + oxc-parser';
export const notes = ['borrows the real builder resolver', 'heavy startup; needs the builder + its plugin/alias config'];

export async function prepare(): Promise<{ parse: ParseFn; resolve: ResolveFn; dispose: () => Promise<void> }> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: REPO_ROOT,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      extensions: SOURCE_EXTS,
      alias: {
        os: fileURLToPath(import.meta.resolve('os-browserify/browser')),
        path: 'path-browserify',
      },
    },
  });
  const resolve: ResolveFn = async (spec, importerAbs) => {
    const resolved = await server.pluginContainer.resolveId(spec, importerAbs);
    if (!resolved?.id) return null;
    const id = resolved.id.split('?')[0];
    return path.isAbsolute(id) ? id : null;
  };
  return { parse: oxcImports, resolve, dispose: () => server.close() };
}
