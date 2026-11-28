// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { highlight, highlightIn } from '#lib/comments/highlight.ts';

describe('code highlighting', () => {
    it('covers the code exactly, with design-token classes, by language id or alias', async () => {
        const code = 'int main() {\n    return 0; // done\n}';
        for (const info of ['cpp', 'c++', 'C++']) {
            const runs = await highlight(code, info);
            expect(runs).not.toBeNull();
            expect(runs?.reduce((n, r) => n + r.length, 0)).toBe(code.length);
            expect(runs?.some(r => r.classes.includes('hl-keyword'))).toBe(true);
            expect(runs?.some(r => r.classes.includes('hl-comment'))).toBe(true);
        }
    });

    it('leaves unknown and missing languages plain', async () => {
        expect(await highlight('x', '')).toBeNull();
        expect(await highlight('x', 'not-a-language')).toBeNull();
    });

    it('highlights rendered blocks in place with text only', async () => {
        const root = document.createElement('div');
        const pre = document.createElement('pre');
        pre.dataset['lang'] = 'python';
        const code = document.createElement('code');
        code.textContent = 'def f(): return "<b>x</b>"';
        pre.append(code);
        root.append(pre);
        await highlightIn(root);
        expect(code.textContent).toBe('def f(): return "<b>x</b>"');
        expect(code.querySelector('b')).toBeNull();
        expect(code.querySelector('.hl-keyword')?.textContent).toBe('def');
    });
});
