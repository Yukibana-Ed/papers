import { describe, expect, it } from 'vitest';
import { sameOriginPath } from '#lib/server/auth.ts';

const ORIGIN = 'https://papers.yukibana.dev';

describe('the path signed-in people return to', () => {
    it('keeps paths on the app', () => {
        expect(sameOriginPath('/p/ada/paper?branch=main', ORIGIN)).toBe('/p/ada/paper?branch=main');
        expect(sameOriginPath('/new#gallery', ORIGIN)).toBe('/new#gallery');
        expect(sameOriginPath('/', ORIGIN)).toBe('/');
    });

    it('never leaves the app, however the other host is spelled', () => {
        for (const evil of [
            '//evil.com',
            '/\\evil.com',
            '/%5Cevil.com',
            '/%5cevil.com',
            '\\\\evil.com',
            '/\t/evil.com',
            '/\n/evil.com',
            '\t//evil.com',
            'https://evil.com',
            'https:evil.com',
            'javascript:alert(1)',
            '//papers.yukibana.dev.evil.com',
            '',
        ])
            expect(sameOriginPath(evil, ORIGIN), JSON.stringify(evil)).toBe('/');
    });
});
