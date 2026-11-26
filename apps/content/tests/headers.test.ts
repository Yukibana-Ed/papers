import { describe, expect, it } from 'vitest';
import { contentHeaders } from '#lib/headers.ts';

describe('contentHeaders', () => {
    const headers = contentHeaders('https://papers.yukibana.dev');

    it('is cross-origin isolated and embeddable by another site', () => {
        expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
        expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
        expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    });

    it('is framed by the app alone', () => {
        expect(headers['Content-Security-Policy']).toBe('frame-ancestors https://papers.yukibana.dev');
    });
});
