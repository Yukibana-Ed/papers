import { describe, expect, it } from 'vitest';
import { appHeaders } from '#lib/headers.ts';

describe('appHeaders', () => {
    const headers = appHeaders('https://user-content-papers.yukibana.run');

    it('isolates the page, so the content frame can be isolated too', () => {
        expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
        expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    });

    it('frames only the content origin, and is framed by nobody', () => {
        const csp = headers['Content-Security-Policy'];
        expect(csp).toContain('frame-src https://user-content-papers.yukibana.run;');
        expect(csp).toContain("frame-ancestors 'none'");
    });
});
