import type { languages } from 'monaco-editor/editor/editor.api';

/** Monarch grammar for LaTeX: enough to colour commands, environments, maths and comments. The language server adds
 *  meaning (completion, diagnostics) on top. */
export const latexLanguage: languages.IMonarchLanguage = {
    tokenizer: {
        root: [
            [/%.*$/, 'comment'],
            [/(\\(?:begin|end))(\{)([\w*]+)(\})/, ['keyword', 'delimiter', 'type', 'delimiter']],
            [/\\(part|chapter|section|subsection|subsubsection|paragraph|title|author|caption|input|include|bibliography|frametitle)\b\*?/, 'keyword.heading'],
            [/\\[a-zA-Z@]+/, 'keyword'],
            [/\\./, 'keyword'],
            [/\$\$/, { token: 'string', next: '@displayMath' }],
            [/\$/, { token: 'string', next: '@inlineMath' }],
            [/\\\[/, { token: 'string', next: '@bracketMath' }],
            [/[{}[\]]/, 'delimiter'],
            [/[^\\%${}[\]]+/, ''],
        ],
        inlineMath: [
            [/\$/, { token: 'string', next: '@pop' }],
            [/\\[a-zA-Z]+|\\.|[^$\\]+/, 'string'],
        ],
        displayMath: [
            [/\$\$/, { token: 'string', next: '@pop' }],
            [/\\[a-zA-Z]+|\\.|[^$\\]+|\$/, 'string'],
        ],
        bracketMath: [
            [/\\\]/, { token: 'string', next: '@pop' }],
            [/\\[a-zA-Z]+|\\.|[^\\]+/, 'string'],
        ],
    },
};

/** Monarch grammar for BibTeX. */
export const bibLanguage: languages.IMonarchLanguage = {
    tokenizer: {
        root: [
            [/%.*$/, 'comment'],
            [/@\w+/, 'keyword'],
            [/\w+(?=\s*=)/, 'type'],
            [/\{[^{}]*\}/, 'string'],
            [/"[^"]*"/, 'string'],
        ],
    },
};
