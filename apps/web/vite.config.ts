import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';
import type { InlineConfig } from 'vitest/node';

/** The design package's folder, wherever pnpm installed it: the dev server only serves src, node_modules and its own
 *  files, and the fonts the design CSS names live there. */
const design = dirname(fileURLToPath(import.meta.resolve('@yukibana/design/package.json')));

/** Cross-origin isolation on every response, as for the content origin: the threaded WebAssembly builds (texlab, the
 *  TeX engine) need SharedArrayBuffer, and a cross-origin-isolated frame needs an isolated top-level page. */
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

/** One Worker serves the app's pages; the adapter emulates its bindings in development from wrangler.jsonc. SvelteKit 3
 *  takes its configuration here, in the plugin; there is no svelte.config.js. */
export default {
    plugins: [
        sveltekit({
            adapter: adapter({ platformProxy: { configPath: './wrangler.jsonc', persist: true } }),
            // The page holds a GitHub access token in memory: scripts only from here (SvelteKit adds the hashes of its
            // own inline scripts; the hook adds the theme script's), connections only to here (the room's WebSocket
            // included) and GitHub's API. The hook adds the content origin as the only frame source.
            csp: {
                mode: 'hash',
                directives: {
                    'default-src': ['self'],
                    'script-src': ['self'],
                    'style-src': ['self', 'unsafe-inline'],
                    'img-src': ['self', 'data:', 'blob:', 'https://avatars.githubusercontent.com', 'https://raw.githubusercontent.com'],
                    'font-src': ['self', 'data:'],
                    // GitHub's API, and papers serve on this computer for Build on this computer (paired explicitly).
                    'connect-src': [
                        'self',
                        'https://api.github.com',
                        'https://raw.githubusercontent.com',
                        'https://packages.typst.org',
                        'http://127.0.0.1:47115',
                        'ws://127.0.0.1:47115',
                    ],
                    'worker-src': ['self', 'blob:'],
                    'object-src': ['none'],
                    'base-uri': ['self'],
                    'form-action': ['self', 'https://github.com'],
                    'frame-ancestors': ['none'],
                },
            },
        }),
    ],
    // The design package ships its theme helper as TypeScript, which Node does not strip inside node_modules.
    ssr: { noExternal: ['@yukibana/design'] },
    server: { fs: { allow: [design] }, headers: isolation },
    preview: { headers: isolation },
    // Unit tests that mount components (happy-dom) need Svelte's client build, not the server one Node resolves.
    ...(process.env['VITEST'] ? { resolve: { conditions: ['browser'] } } : {}),
    // Unit tests only: the browser tests in e2e/ run under Playwright against the built Workers.
    test: { include: ['tests/**/*.test.ts'] } satisfies InlineConfig,
} satisfies UserConfig & { test: InlineConfig };
