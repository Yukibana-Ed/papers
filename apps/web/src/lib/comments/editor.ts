import { baseKeymap, chainCommands, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { InputRule, inputRules, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, Plugin, PluginKey, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { parseMarkdown, safeHref, schema, toMarkdown } from './markdown.ts';

const S = schema.nodes;
const M = schema.marks;

/** An input rule that turns `open text close` into `text` with `mark`, as Markdown would. */
function markRule(pattern: RegExp, mark: MarkType): InputRule {
    return new InputRule(pattern, (state, match, start, end) => {
        const text = match[1];
        if (text === undefined) return null;
        const tr = state.tr.replaceWith(start, end, schema.text(text, [mark.create()]));
        return tr.removeStoredMark(mark);
    });
}

/** What an input rule sees in place of a line break (or any other inline node) in the text before the caret. */
const BREAK = '￼';

/** Starts a code block from the line the caret ends, when that line is ```` ``` ```` and an optional language. The
 *  lines before it stay a paragraph of their own; what follows the caret in the paragraph becomes the block's text, its
 *  line breaks as newlines. Returns null for any other line, when something other than text follows the caret, and
 *  where a code block may not stand (first in a list item). */
function openFence(state: EditorState): Transaction | null {
    const { $from, empty } = state.selection;
    const para = $from.parent;
    if (!empty || para.type !== S['paragraph']) return null;
    const before = para.textBetween(0, $from.parentOffset, undefined, BREAK);
    const cut = before.lastIndexOf(BREAK) + 1;
    const m = /^```([^\s`]*)$/.exec(before.slice(cut));
    if (!m) return null;
    let plain = true;
    para.slice($from.parentOffset).content.forEach(child => {
        if (!child.isText && child.type !== S['hard_break']) plain = false;
    });
    if (!plain) return null;
    const first = cut === 0;
    if (first && !$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), S['code_block'])) return null;
    const lineFrom = $from.start() + cut;
    const tr = state.tr;
    // After a line break, the break goes with the fence and the paragraph ends there.
    if (first) tr.delete(lineFrom, $from.pos);
    else tr.delete(lineFrom - 1, $from.pos).split(lineFrom - 1);
    const at = first ? lineFrom : lineFrom + 1;
    tr.setBlockType(at, at, S['code_block'], { params: m[1] });
    return tr.setSelection(TextSelection.create(tr.doc, at));
}

/** The caret's place in a code block: the block's text, the caret's offset in it, and where the caret's line starts.
 *  Null when the selection is not a caret in a code block. */
function inCode(state: EditorState): { text: string; at: number; lineStart: number } | null {
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.type !== S['code_block']) return null;
    const text = $from.parent.textContent;
    const at = $from.parentOffset;
    return { text, at, lineStart: text.lastIndexOf('\n', at - 1) + 1 };
}

/** Removes `back` characters before the caret, which ends a code block, and puts the caret in a new paragraph after the
 *  block. */
function leaveBelow(state: EditorState, back: number): Transaction {
    const { $from } = state.selection;
    const tr = state.tr.delete($from.pos - back, $from.pos);
    const after = tr.mapping.map($from.after());
    tr.insert(after, S['paragraph'].create());
    return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
}

/** Enter and Shift+Enter around a code block. A ```` ``` ```` line in a paragraph opens one. In a block, a ```` ``` ````
 *  line at its end closes it, as does a third Enter after two empty lines; either leaves the caret in a paragraph below
 *  and takes the fence or the empty lines away. Any other Enter in a block is a new line with the indentation of the
 *  line it leaves. */
const enterCode: Command = (state, dispatch) => {
    const opened = openFence(state);
    if (opened) {
        dispatch?.(opened.scrollIntoView());
        return true;
    }
    const code = inCode(state);
    if (code === null) return false;
    const atEnd = code.at === code.text.length;
    const line = code.text.slice(code.lineStart, code.at);
    if (atEnd && line === '```') dispatch?.(leaveBelow(state, code.lineStart === 0 ? 3 : 4));
    else if (atEnd && code.text.endsWith('\n\n')) dispatch?.(leaveBelow(state, 2));
    else dispatch?.(state.tr.insertText('\n' + (/^[ \t]*/.exec(line)?.[0] ?? '')).scrollIntoView());
    return true;
};

/** Shift+Enter in a paragraph: a line break. It is never part of inline code: the code ends before it. */
const lineBreak: Command = (state, dispatch) => {
    if (!state.selection.$from.parent.type.contentMatch.matchType(S['hard_break'])) return false;
    if (dispatch) {
        const tr = state.tr.replaceSelectionWith(S['hard_break'].create(), false);
        dispatch(tr.setStoredMarks(M['code'].removeFromSet(tr.selection.$from.marks())).scrollIntoView());
    }
    return true;
};

/** Backspace at the very start of a code block makes it a paragraph again, its lines kept as line breaks. */
const unwrapCode: Command = (state, dispatch) => {
    const code = inCode(state);
    if (code === null || code.at !== 0) return false;
    const { $from } = state.selection;
    dispatch?.(state.tr.setBlockType($from.pos, $from.pos, S['paragraph']).scrollIntoView());
    return true;
};

/** Backspace beside inline code, with the caret outside its right edge, deletes the code's last character and leaves the
 *  caret outside: what is typed next is plain text. */
const backspaceBesideCode: Command = (state, dispatch) => {
    const code = M['code'];
    const { $from, empty } = state.selection;
    const before = $from.nodeBefore;
    if (!empty || before === null || before.text === undefined || code.isInSet(before.marks) === undefined) return false;
    if (code.isInSet(state.storedMarks ?? $from.marks()) !== undefined) return false;
    if (dispatch) {
        const last = [...new Intl.Segmenter().segment(before.text)].at(-1)?.segment.length ?? 1;
        const tr = state.tr.delete($from.pos - last, $from.pos);
        dispatch(tr.setStoredMarks(code.removeFromSet(tr.selection.$from.marks())).scrollIntoView());
    }
    return true;
};

/** Ctrl+A in a code block selects the block's text first; with that selected already, the whole comment. */
const selectCode: Command = (state, dispatch) => {
    const { $from, $to } = state.selection;
    const block = $from.parent;
    if (block.type !== S['code_block'] || !$from.sameParent($to) || block.content.size === 0) return false;
    if ($from.parentOffset === 0 && $to.parentOffset === block.content.size) return false;
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, $from.start(), $from.end())));
    return true;
};

const INDENT = '    ';

/** Tab and Shift+Tab in a code block: a caret gets four spaces, a selection has its lines moved in, and Shift+Tab moves
 *  the lines out by up to four spaces or a tab. `dir` is 1 for in and -1 for out. */
function indentCode(dir: -1 | 1): Command {
    return (state, dispatch) => {
        const { $from, $to, empty } = state.selection;
        if ($from.parent.type !== S['code_block'] || !$from.sameParent($to)) return false;
        if (!dispatch) return true;
        if (dir === 1 && empty) {
            dispatch(state.tr.insertText(INDENT).scrollIntoView());
            return true;
        }
        const text = $from.parent.textContent;
        const start = $from.start();
        const tr = state.tr;
        let line = text.lastIndexOf('\n', $from.parentOffset - 1) + 1;
        while (line <= $to.parentOffset) {
            const pos = tr.mapping.map(start + line, -1);
            const lead = /^(?: {1,4}|\t)/.exec(text.slice(line))?.[0].length ?? 0;
            if (dir === 1) tr.insertText(INDENT, pos);
            else if (lead > 0) tr.delete(pos, pos + lead);
            const next = text.indexOf('\n', line);
            if (next < 0) break;
            line = next + 1;
        }
        dispatch(tr.scrollIntoView());
        return true;
    };
}

/** Left or right at an edge of inline code steps over the edge without moving the caret: the caret is either in the
 *  code, where typing adds to it, or beside it, where typing is plain text. `dir` is -1 for left and 1 for right. */
function crossCodeEdge(dir: -1 | 1): Command {
    const code = M['code'];
    return (state, dispatch) => {
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.inlineContent || $from.parent.type.spec.code) return false;
        const before = $from.nodeBefore !== null && code.isInSet($from.nodeBefore.marks) !== undefined;
        const after = $from.nodeAfter !== null && code.isInSet($from.nodeAfter.marks) !== undefined;
        if (before === after) return false;
        const inside = code.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
        // The code lies to the left of its right edge and to the right of its left edge.
        const towardsCode = before ? dir === -1 : dir === 1;
        if (inside === towardsCode) return false;
        dispatch?.(inside ? state.tr.removeStoredMark(code) : state.tr.addStoredMark(code.create()));
        return true;
    };
}

/** Left or right one character, onto an edge of inline code: the caret stops on the side of the edge it came from, in
 *  the code when it moved through code and beside it when it did not. The next press then crosses the edge
 *  (`crossCodeEdge`), so both places at every edge are reached from either direction. Returns false, leaving the move
 *  to the browser, when the character passed over is not text or the place reached is not an edge. */
function stepOntoCodeEdge(dir: -1 | 1): Command {
    const code = M['code'];
    return (state, dispatch) => {
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.inlineContent || $from.parent.type.spec.code) return false;
        const passed = dir === -1 ? $from.nodeBefore : $from.nodeAfter;
        if (passed === null || passed.text === undefined) return false;
        const chars = [...new Intl.Segmenter().segment(passed.text)];
        const length = (dir === -1 ? chars.at(-1) : chars[0])?.segment.length ?? 1;
        const $to = state.doc.resolve($from.pos + dir * length);
        const before = $to.nodeBefore !== null && code.isInSet($to.nodeBefore.marks) !== undefined;
        const after = $to.nodeAfter !== null && code.isInSet($to.nodeAfter.marks) !== undefined;
        if (before === after) return false;
        if (dispatch) {
            const inside = code.isInSet(passed.marks) !== undefined;
            const tr = state.tr.setSelection(TextSelection.create(state.doc, $to.pos));
            const marks = code.removeFromSet($to.marks());
            dispatch(tr.setStoredMarks(inside ? code.create().addToSet(marks) : marks).scrollIntoView());
        }
        return true;
    };
}

/** Draws the caret at an edge of inline code, where the browser's own caret looks the same on both sides: inside the
 *  code when typing would add to it, outside when it would not. While it is drawn the editor has the class
 *  `cm-own-caret`, which hides the browser's caret. */
function codeCaret(): Plugin {
    const code = M['code'];
    /** Whether the selection is a caret at an edge of inline code, and if so whether it is in the code. */
    const atEdge = (state: EditorState): { inside: boolean } | null => {
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.inlineContent || $from.parent.type.spec.code) return null;
        const before = $from.nodeBefore !== null && code.isInSet($from.nodeBefore.marks) !== undefined;
        const after = $from.nodeAfter !== null && code.isInSet($from.nodeAfter.marks) !== undefined;
        if (before === after) return null;
        return { inside: code.isInSet(state.storedMarks ?? $from.marks()) !== undefined };
    };
    return new Plugin({
        props: {
            attributes: (state): Record<string, string> => (atEdge(state) === null ? {} : { class: 'cm-own-caret' }),
            decorations(state) {
                const edge = atEdge(state);
                if (edge === null) return null;
                const caret = (): HTMLElement => {
                    const el = document.createElement('span');
                    el.className = 'cm-caret';
                    return el;
                };
                const pos = state.selection.from;
                // The widget's marks decide which side of the code's edge it is drawn on.
                const spec = { key: edge.inside ? 'caret-in' : 'caret-out', marks: edge.inside ? [code.create()] : [], ignoreSelection: true };
                return DecorationSet.create(state.doc, [Decoration.widget(pos, caret, spec)]);
            },
        },
    });
}

/** Where the paragraph is that an arrow key made beside a code block, while it is still empty; null otherwise. */
const madeBeside = new PluginKey<number | null>('madeBeside');

/** Takes the paragraph an arrow key made beside a code block away again when the caret leaves it empty, so that moving
 *  through a comment leaves nothing behind. */
function tidyMadeParagraph(): Plugin<number | null> {
    return new Plugin<number | null>({
        key: madeBeside,
        state: {
            init: () => null,
            apply(tr, value) {
                const set = tr.getMeta(madeBeside) as number | null | undefined;
                if (set !== undefined) return set;
                if (value === null) return null;
                const mapped = tr.mapping.mapResult(value);
                return mapped.deleted ? null : mapped.pos;
            },
        },
        appendTransaction(_trs, _old, state) {
            const pos = madeBeside.getState(state) ?? null;
            if (pos === null) return null;
            const node = state.doc.nodeAt(pos);
            if (node === null || node.type !== S['paragraph'] || node.content.size > 0) return state.tr.setMeta(madeBeside, null);
            if (state.selection.from === pos + 1 && state.selection.empty) return null;
            return state.tr.delete(pos, pos + node.nodeSize).setMeta(madeBeside, null);
        },
    });
}

/** An arrow key that would leave a code block where nothing is next to it puts an empty paragraph there and the caret
 *  in it; the paragraph goes again when the caret leaves it empty. `dir` is -1 for up and left, 1 for down and right;
 *  `axis` says which pair. Up and down act on the block's first and last line, left and right at its very start and
 *  end. */
function leaveCodeBlock(dir: -1 | 1, axis: 'line' | 'char'): Command {
    return (state, dispatch) => {
        const { $from, empty } = state.selection;
        const block = $from.parent;
        if (!empty || block.type !== S['code_block']) return false;
        const text = block.textContent;
        const rest = dir === -1 ? text.slice(0, $from.parentOffset) : text.slice($from.parentOffset);
        if (axis === 'char' ? rest !== '' : rest.includes('\n')) return false;
        const index = $from.index($from.depth - 1);
        const hasNeighbour = dir === -1 ? index > 0 : index < $from.node($from.depth - 1).childCount - 1;
        if (hasNeighbour) return false;
        if (dispatch) {
            const at = dir === -1 ? $from.before() : $from.after();
            const tr = state.tr.insert(at, S['paragraph'].create());
            dispatch(
                tr
                    .setSelection(TextSelection.create(tr.doc, at + 1))
                    .setMeta(madeBeside, at)
                    .scrollIntoView(),
            );
        }
        return true;
    };
}

/** Typing Markdown in the rich editor makes what it would render: `**b**`, `*i*`, `` `c` ``, `> `, `- `, `1. `, `$x$`, and
 *  ```` ```lang ```` followed by a space (Enter does the same, through the keymap). Emphasis, code and math stay within a
 *  line: a line break is never part of what a rule replaces. */
function rules(): Plugin {
    const items = [
        markRule(/\*\*([^*\s￼][^*￼]*[^*\s￼]|[^*\s￼])\*\*$/, M['strong']),
        markRule(/(?<![*\w])\*([^*\s￼][^*￼]*[^*\s￼]|[^*\s￼])\*$/, M['em']),
        markRule(/(?<![_\w])_([^_\s￼][^_￼]*[^_\s￼]|[^_\s￼])_$/, M['em']),
        markRule(/(?<!`)`([^`￼]+)`$/, M['code']),
        new InputRule(/(?<![\w$\\])\$([^$\s￼](?:[^$￼]*[^$\s￼])?)\$$/, (state, match, start, end) => {
            const tex = match[1];
            return tex === undefined ? null : state.tr.replaceWith(start, end, S['math_inline'].create({ tex }));
        }),
        wrappingInputRule(/^\s*>\s$/, S['blockquote']),
        wrappingInputRule(/^\s*([-+*])\s$/, S['bullet_list']),
        wrappingInputRule(
            /^(\d+)\.\s$/,
            S['ordered_list'],
            m => ({ order: Number(m[1]) }),
            (m, node) => node.childCount + Number(node.attrs['order']) === Number(m[1]),
        ),
        new InputRule(/```[^\s`]*\s$/, state => openFence(state)),
    ];
    return inputRules({ rules: items });
}

/** Asks for a URL and links the selection to it; nothing happens for a URL that is not http, https or mailto. */
export const linkCommand: Command = (state, dispatch) => {
    const link = M['link'];
    if (state.selection.empty) return false;
    const { from, to } = state.selection;
    if (state.doc.rangeHasMark(from, to, link)) {
        dispatch?.(state.tr.removeMark(from, to, link));
        return true;
    }
    if (!dispatch) return true;
    const href = safeHref(window.prompt('Link', 'https://') ?? '');
    if (href === null) return false;
    dispatch(state.tr.addMark(from, to, link.create({ href })));
    return true;
};

export const commands = {
    bold: toggleMark(M['strong']),
    italic: toggleMark(M['em']),
    code: toggleMark(M['code']),
    link: linkCommand,
    bullets: wrapInList(S['bullet_list']),
    quote: wrapIn(S['blockquote']),
    codeBlock: setBlockType(S['code_block']),
} satisfies Record<string, Command>;

export type CommandName = keyof typeof commands;

/** Whether the command's mark is on at the selection, for the toolbar's pressed state. */
export function isActive(state: EditorState, name: CommandName): boolean {
    const marks: Partial<Record<CommandName, MarkType>> = { bold: M['strong'], italic: M['em'], code: M['code'], link: M['link'] };
    const mark = marks[name];
    if (mark) {
        const { from, $from, to, empty } = state.selection;
        return empty ? mark.isInSet(state.storedMarks ?? $from.marks()) !== undefined : state.doc.rangeHasMark(from, to, mark);
    }
    return false;
}

export interface RichEditorOptions {
    /** The Markdown to start from. */
    readonly markdown: string;
    readonly placeholder: string;
    /** Ctrl+Enter. */
    readonly onSubmit: () => void;
    /** Escape. */
    readonly onCancel: () => void;
    /** After every change, with the document's Markdown. */
    readonly onChange: (markdown: string) => void;
}

/** A ProseMirror editor for one comment, in `host`. Returns the view; destroy it with `view.destroy()`. */
export function createRichEditor(host: HTMLElement, o: RichEditorOptions): EditorView {
    const submit: Command = () => {
        o.onSubmit();
        return true;
    };
    const cancel: Command = () => {
        o.onCancel();
        return true;
    };
    const state = EditorState.create({
        doc: parseMarkdown(o.markdown),
        plugins: [
            rules(),
            codeCaret(),
            tidyMadeParagraph(),
            history(),
            keymap({
                'Mod-z': undo,
                'Shift-Mod-z': redo,
                'Mod-y': redo,
                'Mod-b': commands.bold,
                'Mod-i': commands.italic,
                'Mod-e': commands.code,
                'Mod-k': commands.link,
                'Mod-Enter': submit,
                Escape: cancel,
                'Mod-a': selectCode,
                Enter: chainCommands(enterCode, splitListItem(S['list_item'])),
                'Shift-Enter': chainCommands(enterCode, lineBreak),
                Backspace: chainCommands(unwrapCode, backspaceBesideCode),
                ArrowLeft: chainCommands(crossCodeEdge(-1), stepOntoCodeEdge(-1), leaveCodeBlock(-1, 'char')),
                ArrowRight: chainCommands(crossCodeEdge(1), stepOntoCodeEdge(1), leaveCodeBlock(1, 'char')),
                ArrowUp: leaveCodeBlock(-1, 'line'),
                ArrowDown: leaveCodeBlock(1, 'line'),
                Tab: chainCommands(indentCode(1), sinkListItem(S['list_item'])),
                'Shift-Tab': chainCommands(indentCode(-1), liftListItem(S['list_item'])),
            }),
            keymap(baseKeymap),
        ],
    });
    const view: EditorView = new EditorView(host, {
        state,
        attributes: { class: 'cm-rich', 'aria-label': o.placeholder, 'data-placeholder': o.placeholder, role: 'textbox', 'aria-multiline': 'true' },
        dispatchTransaction(tr) {
            const next = view.state.apply(tr);
            view.updateState(next);
            host.classList.toggle('is-empty', isEmptyDoc(next.doc));
            if (tr.docChanged) o.onChange(toMarkdown(next.doc));
        },
    });
    host.classList.toggle('is-empty', isEmptyDoc(state.doc));
    return view;
}

function isEmptyDoc(doc: PMNode): boolean {
    return doc.childCount === 1 && doc.firstChild?.type === S['paragraph'] && doc.firstChild.childCount === 0;
}
