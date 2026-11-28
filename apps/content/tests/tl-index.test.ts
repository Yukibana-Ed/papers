import { describe, expect, it } from 'vitest';
import { RemoteTree } from '@yukibana/papers-tex-engine';
import { buildPathShards, buildShards, cleanName, lsR, parsePathShard, pathShardOf, resolve, shardOf, stemOf, type IndexedFile, type Shard } from '#lib/tl-index.ts';

const files: IndexedFile[] = [
    ['a1', 10, 'article.cls'],
    ['b2', 20, 'article.sty'],
    ['c3', 30, 'pgfmath.code.tex'],
    ['d4', 40, 'cmr10.tfm'],
    ['e5', 50, 'cmr10.pfb'],
    ['f6', 60, 'Makefile'],
];

describe('tl-index', () => {
    const shards = buildShards(files);
    const lookup = (format: number, name: string): IndexedFile | null => {
        const s: Shard = shards.get(shardOf(name)) ?? { n: {}, s: {} };
        return resolve(s, format, name);
    };

    it('hashes to two hex digits, case-insensitively', () => {
        expect(shardOf('Article.CLS')).toBe(shardOf('article.cls'));
        expect(shardOf('x')).toMatch(/^[0-9a-f]{2}$/);
    });

    it("resolves exact names, and stems by the format's extension order", () => {
        expect(lookup(26, 'article.cls')?.[0]).toBe('a1');
        // .sty comes before .cls in format 26's list, as kpathsea tries them.
        expect(lookup(26, 'article')?.[0]).toBe('b2');
        expect(lookup(26, 'pgfmath.code')?.[0]).toBe('c3');
        expect(lookup(3, 'cmr10')?.[0]).toBe('d4');
        expect(lookup(32, 'cmr10')?.[0]).toBe('e5');
        expect(lookup(26, 'makefile')?.[2]).toBe('Makefile');
        expect(lookup(26, 'nosuch')).toBeNull();
    });

    it('cleans names and finds stems', () => {
        expect(cleanName('../etc/passwd')).toBe('..etcpasswd');
        expect(stemOf('a.b.c')).toBe('a.b');
        expect(stemOf('.hidden')).toBe('.hidden');
    });

    it('finds a file by its path, in the shard of the path', () => {
        const byPath = buildPathShards([
            ['texmf-dist/tex/latex/base/article.cls', 'a1', 10],
            ['texmf-var/fonts/map/pdftex/updmap/pdftex.map', 'f6', 60],
        ]);
        const path = 'texmf-dist/tex/latex/base/article.cls';
        expect(pathShardOf(path)).toMatch(/^[0-9a-f]{3}$/);
        const shard = parsePathShard(JSON.stringify(byPath.get(pathShardOf(path))));
        expect(shard?.[path]).toEqual(['a1', 10]);
        expect(parsePathShard('[]')).toBeNull();
    });

    it('writes a file database that lists exactly the files given, as the engine reads it', () => {
        const database = lsR(['tex/latex/base/article.cls', 'tex/latex/base/size10.clo', 'web2c/texmf.cnf']);
        expect(database).toBe(
            '% ls-R -- filename database for kpathsea; do not change this line.\n./:\nls-R\ntex\nweb2c\n\n./tex:\nlatex\n\n./tex/latex:\nbase\n\n./tex/latex/base:\narticle.cls\nsize10.clo\n\n./web2c:\ntexmf.cnf\n\n',
        );
        const tree = new RemoteTree(new Map([['/texlive/texmf-dist/ls-R', new TextEncoder().encode(database)]]), () => new Uint8Array(0));
        expect(tree.kind('/texlive/texmf-dist/tex/latex/base/article.cls')).toBe(1);
        expect(tree.kind('/texlive/texmf-dist/tex/latex/base')).toBe(2);
        expect(tree.kind('/texlive/texmf-dist/tex/latex/base/book.cls')).toBe(0);
        expect(tree.list('/texlive/texmf-dist').map(e => e.name)).toEqual(['ls-R', 'tex', 'web2c']);
    });
});
