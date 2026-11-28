// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Selection } from 'prosemirror-state';
import { createRichEditor } from '#lib/comments/editor.ts';

const KEYS: Record<string, { key: string; shift?: boolean; ctrl?: boolean }> = {
    '\n': { key: 'Enter' },
    '\r': { key: 'Enter', shift: true },
    '←': { key: 'ArrowLeft' },
    '→': { key: 'ArrowRight' },
    '↑': { key: 'ArrowUp' },
    '↓': { key: 'ArrowDown' },
    '⌫': { key: 'Backspace' },
    '⇥': { key: 'Tab' },
    '⇤': { key: 'Tab', shift: true },
    '⎀': { key: 'a', ctrl: true },
};

/** Types `text` one character at a time through the view's text-input hook, as the browser does for keys; a newline is
 *  Enter, a carriage return is Shift+Enter, an arrow is that arrow key, ⌫ is Backspace, ⇥ and ⇤ are Tab and Shift+Tab,
 *  and ⎀ is Ctrl+A. */
function typeInto(text: string): { html: () => string; markdown: () => string } {
    const host = document.createElement('div');
    document.body.append(host);
    let md = '';
    const view = createRichEditor(host, { markdown: '', placeholder: 'Comment', onSubmit: () => {}, onCancel: () => {}, onChange: m => (md = m) });
    for (const ch of text) {
        const { from, to } = view.state.selection;
        const key = KEYS[ch];
        if (key !== undefined) {
            const event = new KeyboardEvent('keydown', { key: key.key, shiftKey: key.shift ?? false, ctrlKey: key.ctrl ?? false });
            const handled = view.someProp('handleKeyDown', f => f(view, event));
            // What the browser does with a left or right arrow the editor leaves alone: one position over.
            const step = ch === '←' ? -1 : ch === '→' ? 1 : 0;
            const target = from + step;
            if (!handled && step !== 0 && target >= 0 && target <= view.state.doc.content.size) {
                const next = Selection.near(view.state.doc.resolve(target), step);
                // At either end of the comment there is nowhere to go, and the browser changes nothing.
                if (next.from !== from) view.dispatch(view.state.tr.setSelection(next));
            }
            // And with a Backspace that no command took: the character before the caret goes.
            if (!handled && ch === '⌫' && from > 0) view.dispatch(view.state.tr.delete(from - 1, from));
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
        const e = typeInto('hello\r`c++\rint a;\r`');
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

    it('steps out of inline code with the right arrow, and back in with the left', () => {
        expect(typeInto('a `b`c').markdown()).toBe('a `b`c');
        expect(typeInto('a `b`←c').markdown()).toBe('a `bc`');
        expect(typeInto('a `b`→c').markdown()).toBe('a `b`c');
        expect(typeInto('a `b`→←c').markdown()).toBe('a `bc`');
    });

    it('steps out of inline code that starts the comment with the left arrow', () => {
        expect(typeInto('`b`←←←a').markdown()).toBe('a`b`');
        expect(typeInto('`b`←←←→c').markdown()).toBe('`cb`');
    });

    it('leaves a code block that is last or first with the arrows, into a new paragraph', () => {
        expect(typeInto('```\nx↓after').markdown()).toBe('```\nx\n```\n\nafter');
        expect(typeInto('```\nx→after').markdown()).toBe('```\nx\n```\n\nafter');
        expect(typeInto('```\nx↑before').markdown()).toBe('before\n\n```\nx\n```');
        expect(typeInto('```\nx←←before').markdown()).toBe('before\n\n```\nx\n```');
    });

    it('keeps the arrows for moving inside a code block', () => {
        expect(typeInto('```\nx←y').markdown()).toBe('```\nyx\n```');
        expect(typeInto('a\n```\nx↑').html()).toBe('<p>a</p><pre><code>x</code></pre>');
    });

    it('opens a code block on Shift+Enter too, and takes the rest of the paragraph into it', () => {
        expect(typeInto('a\r```c\rx').markdown()).toBe('a\n\n```c\nx\n```');
        expect(typeInto('x\ry←←←```\n').markdown()).toBe('```\nx\ny\n```');
    });

    it('closes a code block with a fence line on Shift+Enter, on its first line, and with a third Enter', () => {
        expect(typeInto('```\nx\r```\ry').markdown()).toBe('```\nx\n```\n\ny');
        expect(typeInto('```c\n```\ny').markdown()).toBe('```c\n\n```\n\ny');
        expect(typeInto('```\nx\n\n\ny').markdown()).toBe('```\nx\n```\n\ny');
        expect(typeInto('```\nx\n\ny').markdown()).toBe('```\nx\n\ny\n```');
    });

    it('keeps the indentation of the line on Enter in a code block, and Tab moves lines in and out', () => {
        expect(typeInto('```\n⇥a\nb').markdown()).toBe('```\n    a\n    b\n```');
        expect(typeInto('```\n⇥a⇤').markdown()).toBe('```\na\n```');
        expect(typeInto('```\na\nb⎀⇥').markdown()).toBe('```\n    a\n    b\n```');
    });

    it('makes a code block a paragraph again with Backspace at its start, lines kept', () => {
        expect(typeInto('```c\n⌫x').html()).toBe('<p>x</p>');
        expect(typeInto('```\na\nb←←←⌫').html()).toBe('<p>a<br>b</p>');
    });

    it('joins a paragraph into the code block before it, and removes it when it is empty', () => {
        expect(typeInto('```\na↓⌫b').markdown()).toBe('```\nab\n```');
        expect(typeInto('```\na↓yz←←⌫').markdown()).toBe('```\nayz\n```');
    });

    it('takes the paragraph an arrow made away again when the caret leaves it empty', () => {
        expect(typeInto('```\na↓←').html()).toBe('<pre><code>a</code></pre>');
        expect(typeInto('```\na↑→').html()).toBe('<pre><code>a</code></pre>');
        expect(typeInto('```\na↓y←←').html()).toBe('<pre><code>a</code></pre><p>y</p>');
    });

    it('selects the code block first with Ctrl+A', () => {
        expect(typeInto('a\n```\nb⎀Q').html()).toBe('<p>a</p><pre><code>Q</code></pre>');
    });

    it('leaves the caret outside inline code after Backspace from outside, and ends the code at a line break', () => {
        expect(typeInto('a `bc`⌫x').markdown()).toBe('a `b`x');
        expect(typeInto('a `bc`←\rx').html()).toBe('<p>a <code>bc</code><br>x</p>');
    });

    it('draws the caret outside inline code when typing would be plain, inside when it would add to the code', () => {
        expect(typeInto('a `b`').html()).toMatch(/<code>b<\/code><span class="cm-caret/);
        expect(typeInto('a `b`←').html()).toMatch(/<code>b<span class="cm-caret[^>]*><\/span><\/code>/);
        expect(typeInto('a `b` c').html()).not.toContain('cm-caret');
    });

    it('stops at both places of each edge of inline code, moving left and moving right', () => {
        // Leftwards from after the code: beside its end, in its end, in its start, beside its start.
        expect(typeInto('a `bc` d←←x').markdown()).toBe('a `bc`x d');
        expect(typeInto('a `bc` d←←←x').markdown()).toBe('a `bcx` d');
        expect(typeInto('a `bc` d←←←←←x').markdown()).toBe('a `xbc` d');
        expect(typeInto('a `bc` d←←←←←←x').markdown()).toBe('a x`bc` d');
        // Rightwards from before it, the same places in the other order.
        expect(typeInto('a `bc` d←←←←←←←→x').markdown()).toBe('a x`bc` d');
        expect(typeInto('a `bc` d←←←←←←←→→x').markdown()).toBe('a `xbc` d');
        expect(typeInto('a `bc` d←←←←←←←→→→→x').markdown()).toBe('a `bcx` d');
        expect(typeInto('a `bc` d←←←←←←←→→→→→x').markdown()).toBe('a `bc`x d');
    });
});
