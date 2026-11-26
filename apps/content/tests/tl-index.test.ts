import { describe, expect, it } from 'vitest';
import { buildShards, cleanName, resolve, shardOf, stemOf, type IndexedFile, type Shard } from '#lib/tl-index.ts';

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
});
