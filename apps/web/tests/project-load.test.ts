import { describe, expect, it } from 'vitest';
import { splitRef } from '#lib/project/load.ts';

describe('splitRef', () => {
    const branches = ['main', 'feature/sync', 'feature', 'v1/release/2026'];
    it('takes the longest branch the address starts with, and the rest as the file', () => {
        expect(splitRef('feature/sync/paper/main.tex', branches)).toEqual({ branch: 'feature/sync', path: 'paper/main.tex' });
        expect(splitRef('feature/other.tex', branches)).toEqual({ branch: 'feature', path: 'other.tex' });
        expect(splitRef('v1/release/2026', branches)).toEqual({ branch: 'v1/release/2026', path: null });
        expect(splitRef('main/', branches)).toEqual({ branch: 'main', path: null });
    });
    it('takes the first segment when no branch matches', () => {
        expect(splitRef('gone/main.tex', branches)).toEqual({ branch: 'gone', path: 'main.tex' });
    });
});
