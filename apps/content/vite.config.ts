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
    plugins: [
        devAssets(),
        sveltekit({
            adapter: adapter({ platformProxy: { configPath: './wrangler.jsonc', persist: true } }),
            // The frame runs untrusted documents' output through pdf.js, the TeX engine and the Typst compiler: scripts
            // only from here (SvelteKit hashes its own inline ones), WebAssembly allowed, workers from here or blobs,
            // connections only to here (the engine, TeX Live and Typst packages are all served by this origin), no
            // plugins, no <base>. frame-ancestors is added by the hook, as it names the app's origin.
            csp: {
                mode: 'hash',
                directives: {
                    'default-src': ['self'],
                    // 'unsafe-eval': typst.ts's compiler builds functions with `new Function` from inside its WebAssembly
                    // (wasm-bindgen's Function::new), unguarded, so Typst does not compile without it.
                    'script-src': ['self', 'wasm-unsafe-eval', 'unsafe-eval', 'blob:'],
                    'worker-src': ['self', 'blob:'],
                    'connect-src': ['self', 'blob:', 'data:'],
                    'img-src': ['self', 'data:', 'blob:'],
                    'font-src': ['self', 'data:', 'blob:'],
                    'style-src': ['self', 'unsafe-inline'],
                    'object-src': ['none'],
                    'base-uri': ['none'],
                    'form-action': ['none'],
                },
            },
        }),
    ],
    // The engine is loaded by the page at run time, from /engine, never bundled.
    optimizeDeps: { exclude: ['texlyre-busytex'] },
    server: { fs: { allow: [design] }, headers: isolation },
    preview: { headers: isolation },
    worker: { format: 'es' },
} satisfies UserConfig;
