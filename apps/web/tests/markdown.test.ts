import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeHref, toMarkdown } from '#lib/comments/markdown.ts';

const roundTrip = (s: string): string => toMarkdown(parseMarkdown(s));

describe('comment markdown', () => {
    it('round-trips the schema', () => {
        for (const s of [
            'Is *rarely* backed by **the** citation?',
            'Added `becker2019` to `refs.bib`.',
            '> quoted\n\nreply',
            '* one\n* two',
            '1. one\n2. two',
            '```\ncode\n```',
            'see [the paper](https://example.org/a)',
            'per $u_{\\text{exercise}}$ term',
            'thanks @lena-k',
        ]) {
            expect(roundTrip(s)).toBe(s);
        }
    });

    it('keeps raw HTML as text', () => {
        const doc = parseMarkdown('<img src=x onerror=alert(1)> <b>x</b>');
        expect(doc.textContent).toContain('<img');
        expect(doc.firstChild?.firstChild?.marks.length).toBe(0);
    });

    it('drops links that are not http, https or mailto', () => {
        const doc = parseMarkdown('[x](javascript:alert(1))');
        let links = 0;
        doc.descendants(n => {
            links += n.marks.filter(m => m.type.name === 'link').length;
        });
        expect(links).toBe(0);
        expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
        expect(safeHref('data:text/html,x')).toBeNull();
    });

    it('reads mentions and maths', () => {
        const doc = parseMarkdown('@weber says $x^2$, not a@b or $ 5');
        const kinds: string[] = [];
        doc.descendants(n => {
            if (n.type.name === 'mention' || n.type.name === 'math_inline') kinds.push(`${n.type.name}:${String(n.attrs['login'] ?? n.attrs['tex'])}`);
        });
        expect(kinds).toEqual(['mention:weber', 'math_inline:x^2']);
    });
});
