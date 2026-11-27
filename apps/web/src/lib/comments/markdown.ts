import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { Schema, type Node as PMNode, type Mark } from 'prosemirror-model';
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';

/** Comments are stored as Markdown (GitHub's dialect, as far as this schema goes) and edited as a ProseMirror document
 *  of this schema. Nothing else gets in: no raw HTML, no images, no headings, and links only to http, https and mailto. */
export const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
        blockquote: { group: 'block', content: 'block+', parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
        code_block: {
            group: 'block',
            content: 'text*',
            marks: '',
            code: true,
            defining: true,
            attrs: { params: { default: '' } },
            parseDOM: [{ tag: 'pre', preserveWhitespace: 'full', getAttrs: dom => ({ params: dom.getAttribute('data-lang') ?? '' }) }],
            toDOM: node => ['pre', node.attrs['params'] ? { 'data-lang': String(node.attrs['params']) } : {}, ['code', 0]],
        },
        bullet_list: { group: 'block', content: 'list_item+', attrs: { tight: { default: true } }, parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
        ordered_list: {
            group: 'block',
            content: 'list_item+',
            attrs: { order: { default: 1 }, tight: { default: true } },
            parseDOM: [{ tag: 'ol' }],
            toDOM: n => ['ol', Number(n.attrs['order']) === 1 ? {} : { start: String(n.attrs['order']) }, 0],
        },
        list_item: { content: 'paragraph block*', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
        text: { group: 'inline' },
        hard_break: { inline: true, group: 'inline', selectable: false, linebreakReplacement: true, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
        mention: {
            inline: true,
            group: 'inline',
            atom: true,
            attrs: { login: {} },
            parseDOM: [{ tag: 'span[data-mention]', getAttrs: d => ({ login: d.dataset['mention'] ?? '' }) }],
            toDOM: n => ['span', { class: 'cm-mention', 'data-mention': String(n.attrs['login']) }, `@${String(n.attrs['login'])}`],
        },
        math_inline: {
            inline: true,
            group: 'inline',
            atom: true,
            attrs: { tex: {} },
            parseDOM: [{ tag: 'span[data-math]', getAttrs: d => ({ tex: d.dataset['math'] ?? '' }) }],
            toDOM: n => ['span', { class: 'cm-math', 'data-math': String(n.attrs['tex']) }, String(n.attrs['tex'])],
        },
    },
    marks: {
        em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
        strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
        code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0], excludes: '_' },
        link: {
            attrs: { href: {} },
            inclusive: false,
            parseDOM: [{ tag: 'a[href]', getAttrs: d => (safeHref(d.getAttribute('href') ?? '') === null ? false : { href: d.getAttribute('href') }) }],
            toDOM: m => ['a', { href: safeHref(String(m.attrs['href'])) ?? '#', rel: 'noopener noreferrer nofollow', target: '_blank' }, 0],
        },
    },
});

/** `href` if it is an http, https or mailto URL, otherwise null. */
export function safeHref(href: string): string | null {
    try {
        const u = new URL(href);
        return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
    } catch {
        return null;
    }
}

/** markdown-it inline rule: `$…$` on one line, not `$ ` and not after a word character, as inline maths. */
function mathRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x24 /* $ */ || src.charCodeAt(start + 1) === 0x24) return false;
    if (/\s/.test(src[start + 1] ?? ' ')) return false;
    let end = start + 1;
    while (end < state.posMax) {
        const ch = src.charCodeAt(end);
        if (ch === 0x5c /* \ */) end += 2;
        else if (ch === 0x24) break;
        else if (ch === 0x0a) return false;
        else end++;
    }
    if (end >= state.posMax || /\s/.test(src[end - 1] ?? ' ')) return false;
    if (!silent) {
        const token = state.push('math_inline', '', 0);
        token.content = src.slice(start + 1, end);
    }
    state.pos = end + 1;
    return true;
}

/** markdown-it inline rule: `@login` (GitHub's characters) at a word start as a mention. */
function mentionRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x40 /* @ */) return false;
    if (start > 0 && /[\w`]/.test(src[start - 1] ?? '')) return false;
    const m = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/.exec(src.slice(start, state.posMax));
    if (!m) return false;
    if (!silent) {
        const token = state.push('mention', '', 0);
        token.content = m[1] ?? '';
    }
    state.pos += m[0].length;
    return true;
}

const md = new MarkdownIt('commonmark', { html: false, linkify: false });
md.disable(['image', 'heading', 'lheading', 'hr', 'html_block', 'html_inline', 'entity'], true);
md.inline.ruler.before('escape', 'math_inline', mathRule);
md.inline.ruler.push('mention', mentionRule);
md.validateLink = url => safeHref(url) !== null;

const parser = new MarkdownParser(schema, md, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'list_item' },
    bullet_list: { block: 'bullet_list', getAttrs: (_, tokens, i) => ({ tight: tokens[i + 2]?.hidden === true }) },
    ordered_list: { block: 'ordered_list', getAttrs: (tok, tokens, i) => ({ order: Number(tok.attrGet('start') ?? 1), tight: tokens[i + 2]?.hidden === true }) },
    code_block: { block: 'code_block', noCloseToken: true },
    fence: { block: 'code_block', getAttrs: tok => ({ params: tok.info }), noCloseToken: true },
    hardbreak: { node: 'hard_break' },
    em: { mark: 'em' },
    strong: { mark: 'strong' },
    link: { mark: 'link', getAttrs: tok => ({ href: tok.attrGet('href') }) },
    code_inline: { mark: 'code', noCloseToken: true },
    math_inline: { node: 'math_inline', getAttrs: tok => ({ tex: tok.content }), noCloseToken: true },
    mention: { node: 'mention', getAttrs: tok => ({ login: tok.content }), noCloseToken: true },
});

/** The document of a comment's Markdown. Anything outside the schema reads as plain text. */
export function parseMarkdown(text: string): PMNode {
    return parser.parse(text);
}

const nodes = defaultMarkdownSerializer.nodes;
const serializer = new MarkdownSerializer(
    {
        doc: (state, node) => state.renderContent(node),
        paragraph: nodes['paragraph'] ?? ((state, node) => state.renderInline(node)),
        blockquote: nodes['blockquote'] ?? ((state, node) => state.renderContent(node)),
        code_block: nodes['code_block'] ?? ((state, node) => state.text(node.textContent, false)),
        bullet_list: nodes['bullet_list'] ?? ((state, node) => state.renderContent(node)),
        ordered_list: nodes['ordered_list'] ?? ((state, node) => state.renderContent(node)),
        list_item: nodes['list_item'] ?? ((state, node) => state.renderContent(node)),
        text: nodes['text'] ?? ((state, node) => state.text(node.text ?? '')),
        hard_break: nodes['hard_break'] ?? (state => state.write('\\\n')),
        mention: (state, node) => state.write(`@${String(node.attrs['login'])}`),
        math_inline: (state, node) => state.write(`$${String(node.attrs['tex'])}$`),
    },
    {
        em: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
        strong: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
        code: defaultMarkdownSerializer.marks['code'] ?? { open: '`', close: '`', escape: false },
        link: {
            open: '[',
            close: (_state, mark: Mark) => `](${String(mark.attrs['href']).replace(/[()"]/g, '\\$&')})`,
            mixable: false,
        },
    },
);

/** The Markdown of a comment's document. `parseMarkdown(toMarkdown(d))` is `d` for every document of the schema. */
export function toMarkdown(doc: PMNode): string {
    return serializer.serialize(doc, { tightLists: true });
}

/** A comment's text without its markup, for one-line summaries (a folded or resolved comment). */
export function plainText(markdown: string): string {
    const doc = parseMarkdown(markdown);
    const leaf = (n: PMNode): string => (n.type.name === 'mention' ? `@${String(n.attrs['login'])}` : String(n.attrs['tex']));
    return doc.textBetween(0, doc.content.size, ' ', leaf).replace(/\s+/g, ' ').trim();
}
