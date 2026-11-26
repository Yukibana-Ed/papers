/** The Workers runtime's module, as far as the app uses it: its vars and bindings, typed as SvelteKit's
 *  `App.Platform['env']` (src/app.d.ts). */
declare module 'cloudflare:workers' {
    export const env: App.Platform['env'];
}
