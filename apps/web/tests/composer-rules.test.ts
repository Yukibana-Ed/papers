// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createRichEditor } from '#lib/comments/editor.ts';

/** Types `text` one character at a time through the view's text-input hook, as the browser does for keys. */
function typeInto(text: string): { html: () => string; markdown: () => string } {
    const host = document.createElement('div');
    document.body.append(host);
    let md = '';
    const view = createRichEditor(host, { markdown: '', placeholder: 'Comment', onSubmit: () => {}, onCancel: () => {}, onChange: m => (md = m) });
    for (const ch of text) {
        const { from, to } = view.state.selection;
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
});
