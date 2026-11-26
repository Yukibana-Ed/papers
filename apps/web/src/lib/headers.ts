/** The headers of every page of the app besides the Content-Security-Policy, which SvelteKit writes (see
 *  `vite.config.ts`) and `withContentOrigin` completes.
 *
 *  Cross-origin isolation (COOP, COEP): the content frame is cross-origin isolated, and a frame can be only if the page
 *  embedding it is. */
export function appHeaders(): Record<string, string> {
    return {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
}

/** `csp`, SvelteKit's policy (see vite.config.ts), with the content origin as the only frame source and the hashes
 *  of inline scripts that are not SvelteKit's own allowed.
 *
 *  Precondition: `contentOrigin` is an origin (scheme, host and port, no path). */
export function withContentOrigin(csp: string, contentOrigin: string, scriptHashes: readonly string[] = []): string {
    const parts = csp
        .split(';')
        .map(d => d.trim())
        .filter(d => d && !d.startsWith('frame-src'));
    parts.push(`frame-src ${contentOrigin}`);
    return parts
        .map(d => {
            if (d.startsWith('script-src')) return [d, ...scriptHashes.map(h => `'${h}'`)].join(' ');
            return d;
        })
        .join('; ');
}

/** The CSP source of an inline script's text: `sha256-<base64>`. */
export async function scriptHash(text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    return `sha256-${btoa(bin)}`;
}
