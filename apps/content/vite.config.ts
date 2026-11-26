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

/** Browsers that have CSS's light-dark(), so the build keeps it as it is. Lowered for older browsers, a token like
 *  `light-dark(a, b)` becomes two variables that resolve where the token is defined, on the root, and an element that
 *  sets its own colour scheme (the preview's pages, always light paper) then still gets the root's dark colours. */
const cssTarget = ['chrome123', 'edge123', 'firefox120', 'safari17.5'];

/** The content origin: the frame the app embeds, where user content is compiled, checked and rendered. Nothing here
 *  ever sees a token. */
export default {
    build: { cssTarget },
    plugins: [devAssets(), sveltekit({ adapter: adapter({ platformProxy: { configPath: './wrangler.jsonc', persist: true } }) })],
    // The engine is loaded by the page at run time, from /engine, never bundled.
    optimizeDeps: { exclude: ['texlyre-busytex'] },
    server: { fs: { allow: [design] }, headers: isolation },
    preview: { headers: isolation },
    worker: { format: 'es' },
} satisfies UserConfig;
