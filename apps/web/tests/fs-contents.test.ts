import { describe, expect, it } from 'vitest';
import { fsContents } from '#lib/lsp/fs-contents.ts';

describe('fsContents', () => {
    it('carries text as the base64 of its UTF-8 bytes', () => {
        const bib = '@article{knuth84, title = {Literate Programming — ő}}';
        const c = fsContents(bib);
        expect(c.type).toBe('ok');
        if (c.type !== 'ok') return;
        expect(new TextDecoder().decode(Uint8Array.from(atob(c.content), ch => ch.charCodeAt(0)))).toBe(bib);
        expect(c.content.startsWith('@')).toBe(false);
    });

    it('carries binary files byte for byte, large ones too', () => {
        const png = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
        const c = fsContents(png);
        if (c.type !== 'ok') throw new Error('not ok');
        expect(Uint8Array.from(atob(c.content), ch => ch.charCodeAt(0))).toEqual(png);
    });

    it('says when the project has no such file', () => {
        expect(fsContents(undefined)).toEqual({ type: 'err', error: 'not in the project' });
    });
});
