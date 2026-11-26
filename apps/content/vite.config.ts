import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import type { UserConfig } from 'vite';

/** Cross-origin isolation, which the threaded WebAssembly builds need for SharedArrayBuffer. The Worker sets the same
 *  headers on every response it serves (src/hooks.server.ts); these cover the development server's modules. */
const isolation = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
};

/** The content origin: the frame the app embeds, where user content is compiled, checked and rendered. Nothing here
 *  ever sees a token. */
export default {
    plugins: [sveltekit({ adapter: adapter({ platformProxy: { configPath: './wrangler.jsonc', persist: true } }) })],
    server: { headers: isolation },
    preview: { headers: isolation },
} satisfies UserConfig;
