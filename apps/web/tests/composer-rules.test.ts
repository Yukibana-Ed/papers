// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createRichEditor } from '#lib/comments/editor.ts';

/** Types `text` one character at a time through the view's text-input hook, as the browser does for keys; a newline is
 *  Enter and a carriage return is Shift+Enter. */
function typeInto(text: string): { html: () => string; markdown: () => string } {
    const host = document.createElement('div');
    document.body.append(host);
    let md = '';
    const view = createRichEditor(host, { markdown: '', placeholder: 'Comment', onSubmit: () => {}, onCancel: () => {}, onChange: m => (md = m) });
    for (const ch of text) {
        const { from, to } = view.state.selection;
        if (ch === '\n' || ch === '\r') {
            // '\n' is Enter and '\r' is Shift+Enter.
            const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: ch === '\r' });
            view.someProp('handleKeyDown', f => f(view, event));
            continue;
        }
        const handled = view.someProp('handleTextInput', f => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
        if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
    return { html: () => view.dom.innerHTML, markdown: () => md };
}

describe('the rich editor', () => {
    it('turns typed Markdown into what it renders', () => {
        const e = typeInto('add **a random intercept** per `exercise` and $u_e$ *here* ');
        expect(e.html()).toContain('<strong>a random intercept</strong>');
        expect(e.html()).toContain('<code>exercise</code>');
        expect(e.html()).toContain('<em>here</em>');
        expect(e.markdown()).toBe('add **a random intercept** per `exercise` and $u_e$ *here* ');
    });

    it('keeps line breaks out of inline code', () => {
        const e = typeInto('hello\r```c++\rint a;\r`');
        expect(e.html()).not.toContain('\ufffc');
        expect(e.html()).not.toContain('<code>');
        expect(e.html().match(/<br/g)).toHaveLength(3);
    });

    it('opens a code block from a fence line on Enter, with its language, and closes it on a fence line', () => {
        const e = typeInto('hello\r```c++\nint a;\n```\nafter');
        expect(e.html()).toContain('<p>hello</p><pre data-lang="c++">');
        expect(e.html()).toContain('int a;</code></pre><p>after</p>');
        expect(e.markdown()).toBe('hello\n\n```c++\nint a;\n```\n\nafter');
    });

    it('opens a code block from a fence at the start of a comment, on a space too', () => {
        expect(typeInto('```\nx').markdown()).toBe('```\nx\n```');
        expect(typeInto('```ts x').markdown()).toBe('```ts\nx\n```');
    });

    it('leaves a fence alone until its line ends', () => {
        expect(typeInto('```c').html()).toBe('<p>```c</p>');
        expect(typeInto('a ```b`').html()).not.toContain('<code>');
    });
});
