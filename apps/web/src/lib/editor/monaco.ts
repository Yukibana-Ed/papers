/** Monaco, as the editor uses it: the core API and the contributions a writing editor with a language server needs,
 *  without the bundled languages (LaTeX and BibTeX are ours) or the diff editor. Import it only in the browser. */
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/format/browser/formatActions';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/links/browser/links';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/rename/browser/rename';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
// Vite builds `?worker` imports into a worker constructor; the import plugin cannot see that default export.
// oxlint-disable-next-line import/default
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { bibLanguage, latexLanguage, typstLanguage } from './languages.ts';

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls'] });
monaco.languages.setMonarchTokensProvider('latex', latexLanguage);
monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [
        ['{', '}'],
        ['[', ']'],
    ],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '$', close: '$' },
    ],
});
monaco.languages.register({ id: 'bibtex', extensions: ['.bib'] });
monaco.languages.setMonarchTokensProvider('bibtex', bibLanguage);
monaco.languages.register({ id: 'typst', extensions: ['.typ'] });
monaco.languages.setMonarchTokensProvider('typst', typstLanguage);
monaco.languages.setLanguageConfiguration('typst', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
    ],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: '$', close: '$' },
    ],
});

export { monaco };

/** The folder the project's files live in, as URIs: under a folder rather than at `/`, because language servers take
 *  their workspace root from it (tinymist's web build cannot use `/` as one). */
export const PROJECT_ROOT_URI = 'file:///project';

/** The URI of the model of the project file `path`. */
export function modelUri(path: string): ReturnType<typeof monaco.Uri.parse> {
    return monaco.Uri.parse(`${PROJECT_ROOT_URI}/${path}`);
}

/** The language id for a project file. */
export function languageOf(path: string): string {
    if (path.endsWith('.bib')) return 'bibtex';
    if (/\.(tex|sty|cls|ltx|dtx)$/.test(path)) return 'latex';
    if (path.endsWith('.typ')) return 'typst';
    return 'plaintext';
}

/** A colour token of the design system as `#rrggbb`. Monaco takes hex only, and the tokens are oklch inside
 *  light-dark(): the browser resolves the token against the current theme, a canvas turns it into bytes. */
function tokenHex(name: string): string {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const g = canvas.getContext('2d');
    if (!g) return '#000000';
    g.fillStyle = resolved;
    g.fillRect(0, 0, 1, 1);
    const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
    return `#${[r, gr, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether the page shows its dark scheme now: the single source of truth is the page itself, `data-theme` on `<html>`
 *  (set by the design package's theme boot script and by `chooseTheme`), or, when it is absent ("system"), the
 *  system's preference. */
export function pageIsDark(root: HTMLElement = document.documentElement, systemDark = matchMedia('(prefers-color-scheme: dark)').matches): boolean {
    const shown = root.getAttribute('data-theme');
    return shown === 'dark' || (shown !== 'light' && systemDark);
}

/** Keeps Monaco's `yk` theme the page's from now on: applied at once, then on every change of `data-theme` and of the
 *  system's scheme (which matters while the choice is "system"). Returns the function that stops following. */
export function followPageTheme(): () => void {
    const media = matchMedia('(prefers-color-scheme: dark)');
    let shown: boolean | null = null;
    const sync = (): void => {
        const dark = pageIsDark(document.documentElement, media.matches);
        if (dark === shown) return;
        shown = dark;
        applyTheme(dark);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('change', sync);
    return () => {
        observer.disconnect();
        media.removeEventListener('change', sync);
    };
}

/** Defines and applies the `yk` theme from the design tokens as they resolve now. Call after the page's theme
 *  (`data-theme` on `<html>`) changes. */
export function applyTheme(dark: boolean): void {
    const t = (n: string): string => tokenHex(n).slice(1);
    monaco.editor.defineTheme('yk', {
        base: dark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
            { token: '', foreground: t('--yk-code-ink') },
            { token: 'comment', foreground: t('--yk-code-comment'), fontStyle: 'italic' },
            { token: 'keyword', foreground: t('--yk-code-keyword') },
            { token: 'keyword.heading', foreground: t('--yk-code-function'), fontStyle: 'bold' },
            { token: 'type', foreground: t('--yk-code-number') },
            { token: 'string', foreground: t('--yk-code-string') },
            { token: 'delimiter', foreground: t('--yk-code-comment') },
        ],
        colors: {
            'editor.background': tokenHex('--yk-surface'),
            'editor.foreground': tokenHex('--yk-code-ink'),
            'editorLineNumber.foreground': tokenHex('--yk-line-strong'),
            'editorLineNumber.activeForeground': tokenHex('--yk-soft'),
            'editor.lineHighlightBackground': tokenHex('--yk-bg'),
            'editor.lineHighlightBorder': tokenHex('--yk-bg'),
            'editorCursor.foreground': tokenHex('--yk-ink'),
            'editor.selectionBackground': tokenHex('--yk-chip-blue-bg'),
            'editor.inactiveSelectionBackground': tokenHex('--yk-chip-blue-bg') + 'aa',
            'editorIndentGuide.background1': tokenHex('--yk-line'),
            'editorWidget.background': tokenHex('--yk-surface'),
            'editorWidget.border': tokenHex('--yk-line'),
            'editorHoverWidget.background': tokenHex('--yk-surface'),
            'editorHoverWidget.border': tokenHex('--yk-line'),
            'scrollbarSlider.background': `${tokenHex('--yk-line')}99`,
            'scrollbarSlider.hoverBackground': `${tokenHex('--yk-line-strong')}99`,
            'editorGutter.background': tokenHex('--yk-surface'),
        },
    });
    monaco.editor.setTheme('yk');
}

/** Monaco measures character widths once. If JetBrains Mono arrives after that, the widths it measured (the
 *  fallback font's) put clicks and the cursor in the wrong place, so measure again whenever fonts finish loading.
 *  Returns the function that stops listening. */
export function remeasureWhenFontsLoad(): () => void {
    const remeasure = (): void => monaco.editor.remeasureFonts();
    void document.fonts.load("14px 'JetBrains Mono'").then(remeasure);
    void document.fonts.ready.then(remeasure);
    document.fonts.addEventListener('loadingdone', remeasure);
    return () => document.fonts.removeEventListener('loadingdone', remeasure);
}
