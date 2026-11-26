/** The headers of every page of the app, which embeds the content origin `contentOrigin`.
 *
 *  - Cross-origin isolation (COOP, COEP): the content frame is cross-origin isolated, and a frame can be only if the
 *    page embedding it is.
 *  - `frame-src` names the content origin alone, and `frame-ancestors 'none'`: nobody frames the app, which holds the
 *    user's GitHub token.
 *
 *  Precondition: `contentOrigin` is an origin (scheme, host and port, no path). */
export function appHeaders(contentOrigin: string): Record<string, string> {
    return {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Content-Security-Policy': `frame-src ${contentOrigin}; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
}
