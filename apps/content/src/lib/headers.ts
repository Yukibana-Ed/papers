/** `csp` (SvelteKit's policy, from vite.config.ts; empty for responses it did not write one for) with
 *  `frame-ancestors` naming the app alone (no other page can frame a document compiled here), and
 *  `object-src 'none'; base-uri 'none'` whatever else it says.
 *
 *  Precondition: `appOrigin` is an origin (scheme, host and port, no path). */
export function contentPolicy(csp: string, appOrigin: string): string {
    const parts = csp
        .split(';')
        .map(d => d.trim())
        .filter(d => d && !/^(frame-ancestors|object-src|base-uri)(\s|$)/.test(d));
    parts.push(`frame-ancestors ${appOrigin}`, "object-src 'none'", "base-uri 'none'");
    return parts.join('; ');
}

/** The headers of every response of the content origin besides its policy (`contentPolicy`): cross-origin isolation
 *  (COOP, COEP), for SharedArrayBuffer in the engines' threads; CORP `cross-origin`, since the app, a different site,
 *  embeds this frame under its own COEP. */
export function contentHeaders(): Record<string, string> {
    return {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    };
}
