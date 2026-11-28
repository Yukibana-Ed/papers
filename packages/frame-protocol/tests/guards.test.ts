import { describe, expect, it } from 'vitest';
import { HELLO, isAppMessage, isFrameMessage, isHello } from '../src/index.ts';

describe('guards', () => {
    it('accept well-formed messages', () => {
        expect(isAppMessage({ type: 'zoom', zoom: 1 })).toBe(true);
        expect(isAppMessage({ type: 'print' })).toBe(true);
        expect(isAppMessage({ type: 'download', name: 'main.pdf' })).toBe(true);
        expect(isAppMessage({ type: 'download' })).toBe(false);
        expect(
            isAppMessage({
                type: 'files',
                changes: [
                    { path: 'a.tex', contents: 'x' },
                    { path: 'b.png', contents: new Uint8Array(1) },
                    { path: 'c', contents: null },
                ],
            }),
        ).toBe(true);
        expect(isFrameMessage({ type: 'built', ok: true, pages: 2, ms: 10, diagnostics: [{ file: 'a.tex', line: 3, severity: 'error', message: 'x' }] })).toBe(true);
        expect(isFrameMessage({ type: 'jump', at: { file: 'a.tex', line: 1 }, word: null })).toBe(true);
        expect(isFrameMessage({ type: 'selection', lines: null, text: '' })).toBe(true);
        expect(isAppMessage({ type: 'lsp-start', server: 'tinymist' })).toBe(true);
        for (const mode of ['follow', 'jump', 'stay']) expect(isAppMessage({ type: 'reveal', at: { file: 'a.tex', line: 1 }, mode })).toBe(true);
        expect(isAppMessage({ type: 'reveal', at: { file: 'a.tex', line: 1 }, mode: 'leap' })).toBe(false);
        expect(isAppMessage({ type: 'lsp-stop', server: 'tinymist' })).toBe(true);
    });

    it('reject shapes that only have the right type', () => {
        expect(isFrameMessage({ type: 'built', ok: true })).toBe(false);
        expect(isFrameMessage({ type: 'built', ok: true, pages: 1, ms: 1, diagnostics: [{ file: 'a', line: 'x', severity: 'error', message: '' }] })).toBe(false);
        expect(isFrameMessage({ type: 'jump', at: { file: 'a.tex' }, word: null })).toBe(false);
        expect(isFrameMessage({ type: 'selection', lines: { file: 'a', startLine: 5, endLine: 2 }, text: '' })).toBe(false);
        expect(isFrameMessage({ type: 'scale', scale: Number.NaN })).toBe(false);
        expect(isFrameMessage({ type: 'scale', scale: -1 })).toBe(false);
        expect(isFrameMessage({ type: 'zoomed', zoom: 1.37 })).toBe(true);
        expect(isFrameMessage({ type: 'zoomed', zoom: 9 })).toBe(false);
        expect(isFrameMessage({ type: 'zoomed', zoom: Number.NaN })).toBe(false);
        expect(isFrameMessage({ type: 'key', key: 'k', code: 'KeyK', ctrl: 'yes', shift: false, alt: false })).toBe(false);
        expect(isFrameMessage({ type: 'lsp-status', server: 'texlab', status: 'ready' })).toBe(false);
        expect(isAppMessage({ type: 'built' })).toBe(false);
        expect(isAppMessage({ type: 'lsp-stop', server: 'texlab' })).toBe(false);
        expect(isAppMessage({ type: 'root', root: 'a.tex', engine: 'troff' })).toBe(false);
        expect(isAppMessage({ type: 'files', changes: [{ path: 'a', contents: 3 }] })).toBe(false);
        expect(isFrameMessage(null)).toBe(false);
    });

    it('recognise the handshake', () => {
        expect(isHello({ kind: HELLO, version: 1 })).toBe(true);
        expect(isHello({ kind: HELLO })).toBe(false);
    });
});
