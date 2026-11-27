import { describe, expect, it } from 'vitest';
import { pdfName } from '../src/lib/frame/viewer.ts';

describe('pdfName', () => {
    it('names the file after the last part of the name, ending in .pdf once', () => {
        expect(pdfName('main')).toBe('main.pdf');
        expect(pdfName('paper/thesis')).toBe('thesis.pdf');
        expect(pdfName('talk.PDF')).toBe('talk.pdf');
        expect(pdfName('my paper v2')).toBe('my paper v2.pdf');
    });

    it('leaves out what a file name cannot hold, and falls back when nothing is left', () => {
        expect(pdfName('..\\..\\a<b>:"c|?*')).toBe('abc.pdf');
        expect(pdfName('')).toBe('document.pdf');
        expect(pdfName('dir/')).toBe('document.pdf');
        expect(pdfName(' .. ')).toBe('document.pdf');
    });
});
