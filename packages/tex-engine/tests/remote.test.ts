import { describe, expect, it } from 'vitest';
import { RemoteTree } from '../src/index.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const LSR =
    '% ls-R -- filename database for kpathsea; do not change this line.\n./:\nls-R\ntex\nweb2c\n\n./tex:\nlatex\n\n./tex/latex:\nbase\n\n./tex/latex/base:\narticle.cls\nsize10.clo\n\n./web2c:\ntexmf.cnf\n';

function tree(): { tree: RemoteTree; asked: string[] } {
    const asked: string[] = [];
    const t = new RemoteTree(
        new Map([
            ['/texlive/texmf-dist/ls-R', bytes(LSR)],
            ['/texlive/texmf-dist/web2c/texmf.cnf', bytes('% cnf\n')],
            ['/texlive/bin/x86_64-linux/pdftex', new Uint8Array(0)],
        ]),
        path => {
            asked.push(path);
            return bytes(`contents of ${path}`);
        },
    );
    return { tree: t, asked };
}

describe('a remote tree', () => {
    it('has what its ls-R lists and what it was given, and nothing else', () => {
        const { tree: t, asked } = tree();
        expect(t.kind('/')).toBe(2);
        expect(t.kind('/texlive/texmf-dist/tex/latex')).toBe(2);
        expect(t.kind('/texlive/texmf-dist/tex/latex/base/article.cls')).toBe(1);
        expect(t.kind('/texlive/texmf-dist/tex/latex/base/Article.cls')).toBe(0);
        expect(t.kind('/texlive/texmf-dist/tex/latex/base/book.cls')).toBe(0);
        expect(t.kind('/texlive/texmf-local')).toBe(0);
        expect(t.kind('/texlive/bin/x86_64-linux/pdftex')).toBe(1);
        expect(t.list('/texlive')).toEqual([
            { name: 'bin', kind: 2 },
            { name: 'texmf-dist', kind: 2 },
        ]);
        expect(t.list('/texlive/texmf-dist/tex/latex/base')).toEqual([
            { name: 'article.cls', kind: 1 },
            { name: 'size10.clo', kind: 1 },
        ]);
        // Knowing what there is asks for no file.
        expect(asked).toEqual([]);
    });

    it('fetches a file when it is first read, once', () => {
        const { tree: t, asked } = tree();
        const path = '/texlive/texmf-dist/tex/latex/base/article.cls';
        expect(t.wants(path)).toBe(true);
        expect(new TextDecoder().decode(t.read(path) ?? undefined)).toBe(`contents of ${path}`);
        expect(t.read(path)).toBe(t.read(path));
        expect(t.read('/texlive/texmf-dist/tex/latex/base/book.cls')).toBeNull();
        expect(t.read('/texlive/texmf-dist/tex/latex')).toBeNull();
        expect(new TextDecoder().decode(t.read('/texlive/texmf-dist/web2c/texmf.cnf') ?? undefined)).toBe('% cnf\n');
        expect(asked).toEqual([path]);
        expect([...t.fetched]).toEqual([path]);
    });

    it('takes a file ahead of the run that reads it', () => {
        const { tree: t, asked } = tree();
        const path = '/texlive/texmf-dist/tex/latex/base/size10.clo';
        t.give(path, bytes('given'));
        expect(t.wants(path)).toBe(false);
        expect(new TextDecoder().decode(t.read(path) ?? undefined)).toBe('given');
        expect(asked).toEqual([]);
    });
});
