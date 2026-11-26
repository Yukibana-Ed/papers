import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';
import { devAssets } from './dev-assets.ts';

/** Cross-origin isolation, which the threaded WebAssembly builds need for SharedArrayBuffer. The Worker sets the same
 *  headers on every response it serves (src/hooks.server.ts); these cover the development server's modules. */
const isolation = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
};

/** The design package's folder, wherever pnpm installed it: the dev server serves only src, node_modules and its own
 *  files, and the fonts the design CSS names live there. */
const design = dirname(fileURLToPath(import.meta.resolve('@yukibana/design/package.json')));

/** The content origin: the frame the app embeds, where user content is compiled, checked and rendered. Nothing here
 *  ever sees a token. */
export default {
    plugins: [devAssets(), sveltekit({ adapter: adapter({ platformProxy: { configPath: './wrangler.jsonc', persist: true } }) })],
    // The engine is loaded by the page at run time, from /engine, never bundled.
    optimizeDeps: { exclude: ['texlyre-busytex'] },
    server: { fs: { allow: [design] }, headers: isolation },
    preview: { headers: isolation },
    worker: { format: 'es' },
} satisfies UserConfig;
