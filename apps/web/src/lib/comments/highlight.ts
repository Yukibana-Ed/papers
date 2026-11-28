import type { HighlighterCore } from 'shiki/core';

/** A stretch of highlighted code: how many characters it covers and the classes that colour it (`hl-keyword`,
 *  `hl-string`, …, `hl-i`, `hl-b`), none for plain text. The colours come from the design system's code tokens. */
export interface Run {
    readonly length: number;
    readonly classes: string;
}

const THEME = 'yk';
const ITALIC = 1;
const BOLD = 2;
let highlighter: Promise<HighlighterCore> | null = null;

/** The one highlighter, made on first use: Shiki with its JavaScript regex engine (no WebAssembly) and a theme whose
 *  colours are CSS variables, which `hl-*` classes map to design tokens. Languages are added as they are asked for. */
function load(): Promise<HighlighterCore> {
    highlighter ??= (async () => {
        const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
        const theme = createCssVariablesTheme({ name: THEME, variablePrefix: '--hl-', fontStyle: true });
        return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    })();
    return highlighter;
}

/** The Shiki language a fence's info string names (its first word, by id or alias, any case), or null for none. */
async function languageFor(info: string): Promise<{ id: string; load: () => Promise<unknown> } | null> {
    const name = info.trim().split(/\s/)[0]?.toLowerCase() ?? '';
    if (name === '') return null;
    const { bundledLanguagesInfo } = await import('shiki/langs');
    const found = bundledLanguagesInfo.find(l => l.id === name || (l.aliases ?? []).includes(name));
    return found === undefined ? null : { id: found.id, load: found.import };
}

/** Highlights `code` as the language that the fence info `info` names. Resolves to runs that cover `code` exactly, in
 *  order, a newline being a plain run of its own; or to null when the language is unknown or fails to load. The first
 *  call loads Shiki and each language loads on its first use. */
export async function highlight(code: string, info: string): Promise<Run[] | null> {
    const lang = await languageFor(info);
    if (lang === null) return null;
    try {
        const hl = await load();
        if (!hl.getLoadedLanguages().includes(lang.id)) await hl.loadLanguage((await lang.load()) as Parameters<HighlighterCore['loadLanguage']>[0]);
        // No time limit: the first call compiles the grammar, which can pass Shiki's 500 ms and leave the line plain.
        // Long lines stay plain instead, so a comment cannot stall the page.
        const lines = hl.codeToTokensBase(code, { lang: lang.id, theme: THEME, tokenizeTimeLimit: 0, tokenizeMaxLineLength: 1000 });
        const runs: Run[] = [];
        lines.forEach((line, i) => {
            if (i > 0) runs.push({ length: 1, classes: '' });
            for (const token of line) {
                const kind = /--hl-token-([a-z-]+)/.exec(token.color ?? '')?.[1];
                const style = token.fontStyle ?? 0;
                const classes = [kind === undefined ? '' : `hl-${kind}`, style & ITALIC ? 'hl-i' : '', style & BOLD ? 'hl-b' : ''].filter(c => c !== '').join(' ');
                runs.push({ length: token.content.length, classes });
            }
        });
        return runs;
    } catch {
        return null;
    }
}

/** Highlights every code block with a language under `root` (a rendered comment), in place: the block's text is
 *  replaced by spans of the same text. Text only, never HTML. A block whose text changed meanwhile is left alone. */
export async function highlightIn(root: HTMLElement): Promise<void> {
    const blocks = [...root.querySelectorAll<HTMLElement>('pre[data-lang] > code')];
    await Promise.all(
        blocks.map(async code => {
            const text = code.textContent ?? '';
            const runs = await highlight(text, code.parentElement?.dataset['lang'] ?? '');
            if (runs === null || code.textContent !== text) return;
            let at = 0;
            const spans = runs.map(run => {
                const part = text.slice(at, (at += run.length));
                if (run.classes === '') return document.createTextNode(part);
                const span = document.createElement('span');
                span.className = run.classes;
                span.textContent = part;
                return span;
            });
            code.replaceChildren(...spans);
        }),
    );
}
