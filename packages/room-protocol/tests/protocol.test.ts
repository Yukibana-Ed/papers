import { describe, expect, it } from 'vitest';
import { parseClientMessage, validPath } from '../src/index.ts';

describe('room protocol', () => {
    it('accepts well-formed client messages', () => {
        expect(parseClientMessage({ type: 'open', path: 'a.tex', blob: 'b', text: 'x', commit: 'c' })).toEqual({ type: 'open', path: 'a.tex', blob: 'b', text: 'x', commit: 'c' });
        expect(parseClientMessage({ type: 'backed-up', commit: 'w' })).toEqual({ type: 'backed-up', commit: 'w' });
    });

    it('refuses malformed ones and unsafe paths', () => {
        expect(parseClientMessage({ type: 'open', path: '../x', blob: 'b', text: 'x', commit: 'c' })).toBeNull();
        expect(parseClientMessage({ type: 'committed', commit: 'c', files: [{ path: 'a', blob: 1, text: '' }] })).toBeNull();
        expect(parseClientMessage({ type: 'nope' })).toBeNull();
        expect(parseClientMessage(null)).toBeNull();
    });

    it('checks paths as git has them', () => {
        expect(validPath('sections/intro.tex')).toBe(true);
        for (const p of ['', '/a', 'a//b', 'a/./b', 'a/../b']) expect(validPath(p)).toBe(false);
    });
});
