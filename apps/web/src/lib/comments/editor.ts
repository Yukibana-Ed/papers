import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { InputRule, inputRules, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node as PMNode, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, Plugin, TextSelection, type Command, type Transaction } from 'prosemirror-state';
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

/** The line the caret ends: its text and where it starts, when the selection is a caret at the end of a `type` block.
 *  In a paragraph a line starts after a line break, in a code block after a newline. */
function lineAtEnd(state: EditorState, type: NodeType): { text: string; from: number; first: boolean } | null {
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.type !== type || $from.parentOffset !== $from.parent.content.size) return null;
    const all = $from.parent.textBetween(0, $from.parentOffset, undefined, BREAK);
    const cut = Math.max(all.lastIndexOf(BREAK), all.lastIndexOf('\n')) + 1;
    return { text: all.slice(cut), from: $from.start() + cut, first: cut === 0 };
}

/** Starts a code block from the line that ends at the caret, when that line is ```` ``` ```` and an optional language.
 *  The lines before it stay a paragraph of their own. Returns null for any other line. */
function openFence(state: EditorState): Transaction | null {
    const line = lineAtEnd(state, S['paragraph']);
    const m = line && /^```([^\s`]*)$/.exec(line.text);
    if (!line || !m) return null;
    const end = state.selection.from;
    const tr = state.tr;
    if (line.first) return tr.delete(line.from, end).setBlockType(line.from, line.from, S['code_block'], { params: m[1] });
    // The line break before the fence goes with it, and the paragraph ends there.
    tr.delete(line.from - 1, end).split(line.from - 1);
    return tr.setBlockType(line.from + 1, line.from + 1, S['code_block'], { params: m[1] });
}

/** Enter on a ```` ``` ```` line: opens a code block from a paragraph, or closes the code block the caret is in. */
const fenceOnEnter: Command = (state, dispatch) => {
    const opened = openFence(state);
    if (opened) {
        dispatch?.(opened.scrollIntoView());
        return true;
    }
    const line = lineAtEnd(state, S['code_block']);
    if (!line || line.text !== '```' || line.first) return false;
    if (dispatch) {
        const { $from } = state.selection;
        const tr = state.tr.delete(line.from - 1, $from.pos);
        const after = tr.mapping.map($from.after());
        tr.insert(after, S['paragraph'].create());
        dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
    }
    return true;
};

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

/** Marks the inline code that typing would add to (class `cm-code-on`), so that the two sides of its edge look different. */
function codeCaret(): Plugin {
    const code = M['code'];
    return new Plugin({
        props: {
            decorations(state) {
                const { $from, empty } = state.selection;
                if (!empty || !$from.parent.inlineContent || code.isInSet(state.storedMarks ?? $from.marks()) === undefined) return null;
                // The run of code that touches the caret.
                const at = $from.parentOffset;
                let from = -1;
                let run: { from: number; to: number } | null = null;
                $from.parent.forEach((child, offset) => {
                    const isCode = code.isInSet(child.marks) !== undefined;
                    if (isCode && from < 0) from = offset;
                    const end = isCode ? offset + child.nodeSize : offset;
                    if (from >= 0 && (!isCode || end === $from.parent.content.size)) {
                        if (from <= at && at <= end) run = { from, to: end };
                        from = -1;
                    }
                });
                const found = run as { from: number; to: number } | null;
                if (found === null) return null;
                const start = $from.start();
                return DecorationSet.create(state.doc, [Decoration.inline(start + found.from, start + found.to, { class: 'cm-code-on' })]);
            },
        },
    });
}

/** An arrow key that would leave a code block where nothing is next to it puts an empty paragraph there and the caret
 *  in it. `dir` is -1 for up and left, 1 for down and right; `axis` says which pair. Up and down act on the block's first
 *  and last line, left and right at its very start and end. */
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
            dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
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
                Enter: chainCommands(fenceOnEnter, splitListItem(S['list_item'])),
                'Shift-Enter': chainCommands(exitCode, (st, dispatch) => {
                    dispatch?.(st.tr.replaceSelectionWith(S['hard_break'].create()).scrollIntoView());
                    return true;
                }),
                ArrowLeft: chainCommands(crossCodeEdge(-1), leaveCodeBlock(-1, 'char')),
                ArrowRight: chainCommands(crossCodeEdge(1), leaveCodeBlock(1, 'char')),
                ArrowUp: leaveCodeBlock(-1, 'line'),
                ArrowDown: leaveCodeBlock(1, 'line'),
                Tab: sinkListItem(S['list_item']),
                'Shift-Tab': liftListItem(S['list_item']),
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
