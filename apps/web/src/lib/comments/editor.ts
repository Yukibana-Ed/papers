import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, type Command, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
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

/** Typing Markdown in the rich editor makes what it would render: `**b**`, `*i*`, `` `c` ``, `> `, `- `, `1. `, ```` ``` ````,
 *  `$x$`. */
function rules(): Plugin {
    const items = [
        markRule(/\*\*([^*\s][^*]*[^*\s]|[^*\s])\*\*$/, M['strong']),
        markRule(/(?<![*\w])\*([^*\s][^*]*[^*\s]|[^*\s])\*$/, M['em']),
        markRule(/(?<![_\w])_([^_\s][^_]*[^_\s]|[^_\s])_$/, M['em']),
        markRule(/`([^`]+)`$/, M['code']),
        new InputRule(/(?<![\w$\\])\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
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
        textblockTypeInputRule(/^```$/, S['code_block']),
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
                Enter: splitListItem(S['list_item']),
                'Shift-Enter': chainCommands(exitCode, (st, dispatch) => {
                    dispatch?.(st.tr.replaceSelectionWith(S['hard_break'].create()).scrollIntoView());
                    return true;
                }),
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
