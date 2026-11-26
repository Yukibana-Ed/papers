/** The headers of every response of the content origin, for an app at `appOrigin`.
 *
 *  - Cross-origin isolation (COOP, COEP), for SharedArrayBuffer in the engines' threads; CORP `cross-origin`, since the
 *    app, a different site, embeds this frame under its own COEP.
 *  - `frame-ancestors` names the app alone: no other page can frame a document compiled here.
 *
 *  Precondition: `appOrigin` is an origin (scheme, host and port, no path). */
export function contentHeaders(appOrigin: string): Record<string, string> {
    return {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Security-Policy': `frame-ancestors ${appOrigin}`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    };
}
