import { describe, expect, it } from 'vitest';
import { appHeaders, scriptHash, withContentOrigin } from '#lib/headers.ts';

describe('app headers', () => {
    it('isolate the page, so the content frame can be isolated too', () => {
        expect(appHeaders()['Cross-Origin-Opener-Policy']).toBe('same-origin');
        expect(appHeaders()['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    });

    it('frame only the content origin and allow the extra script hashes', () => {
        const csp = withContentOrigin("default-src 'self'; script-src 'self' 'sha256-kit'; frame-src *; frame-ancestors 'none'", 'https://user-content-papers.yukibana.run', [
            'sha256-theme',
        ]);
        expect(csp).toContain('frame-src https://user-content-papers.yukibana.run');
        expect(csp).not.toContain('frame-src *');
        expect(csp).toContain("script-src 'self' 'sha256-kit' 'sha256-theme'");
        expect(csp).toContain("frame-ancestors 'none'");
    });

    it('hash scripts as CSP does', async () => {
        // echo -n "alert(1)" | openssl dgst -sha256 -binary | base64
        expect(await scriptHash('alert(1)')).toBe('sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=');
    });
});
