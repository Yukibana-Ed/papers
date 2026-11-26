import { describe, expect, it } from 'vitest';
import { contentHeaders, contentPolicy } from '#lib/headers.ts';

describe('contentHeaders', () => {
    const headers = contentHeaders('https://papers.yukibana.dev');

    it('is cross-origin isolated and embeddable by another site', () => {
        expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
        expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
        expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    });

    it('is framed by the app alone, with no plugins and no <base>', () => {
        const csp = contentPolicy("script-src 'self' 'wasm-unsafe-eval'; frame-ancestors *; base-uri 'self'", 'https://papers.yukibana.dev');
        expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(csp).toContain('frame-ancestors https://papers.yukibana.dev');
        expect(csp).not.toContain('frame-ancestors *');
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).not.toContain("base-uri 'self'");
        expect(contentPolicy('', 'https://papers.yukibana.dev')).toBe("frame-ancestors https://papers.yukibana.dev; object-src 'none'; base-uri 'none'");
    });
});
