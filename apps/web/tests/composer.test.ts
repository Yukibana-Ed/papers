// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import Composer from '#lib/comments/Composer.svelte';

interface Handle {
    editorView(): EditorView | null;
}

/** Types `text` into the composer's editor one character at a time, as a browser does (text input, then Svelte's
 *  updates), asking the component for its view before every key: a view rebuilt between keys shows up here. */
function type(c: Handle, text: string): void {
    for (const ch of text) {
        const view = c.editorView();
        if (!view) throw new Error('no editor');
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', f => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
        if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
        flushSync();
    }
}

function setup(): { c: Handle; sent: string[]; dispose: () => void } {
    const target = document.createElement('div');
    document.body.append(target);
    const sent: string[] = [];
    const instance = mount(Composer, { target, props: { placeholder: 'Comment', onSend: (m: string) => sent.push(m) } });
    flushSync();
    return { c: instance as unknown as Handle, sent, dispose: () => void unmount(instance) };
}

describe('the comment composer', () => {
    it('keeps the text in typing order with the caret after it', () => {
        const { c, dispose } = setup();
        const first = c.editorView();
        type(c, 'abcd');
        const view = c.editorView();
        expect(view).toBe(first);
        expect(view?.state.doc.textContent).toBe('abcd');
        expect(view?.state.selection.from).toBe(5);
        dispose();
    });

    it('types in order again after the text was cleared from outside (sent)', () => {
        const { c, sent, dispose } = setup();
        type(c, 'ab');
        const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send');
        send?.click();
        flushSync();
        expect(sent).toEqual(['ab']);
        type(c, 'cd');
        expect(c.editorView()?.state.doc.textContent).toBe('cd');
        expect(c.editorView()?.state.selection.from).toBe(3);
        dispose();
    });
});
