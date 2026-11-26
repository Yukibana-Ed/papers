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

/** Monarch grammar for Typst markup: headings, code expressions, maths, labels and references, comments. The language
 *  server's semantic tokens refine it. */
export const typstLanguage: languages.IMonarchLanguage = {
    tokenizer: {
        root: [
            [/\/\/.*$/, 'comment'],
            [/\/\*/, { token: 'comment', next: '@blockComment' }],
            [/^\s*=+\s.*$/, 'keyword.heading'],
            [/#(?:let|set|show|import|include|if|else|for|in|while|return|context)\b/, 'keyword'],
            [/#[\w.-]+/, 'keyword'],
            [/<[\w.:-]+>/, 'type'],
            [/@[\w.:-]+/, 'type'],
            [/\$/, { token: 'string', next: '@math' }],
            [/"(?:[^"\\]|\\.)*"/, 'string'],
            [/[*_`{}[\]()]/, 'delimiter'],
            [/[^/#<@$"*_`{}[\]()]+/, ''],
            [/./, ''],
        ],
        math: [
            [/\$/, { token: 'string', next: '@pop' }],
            [/[^$]+/, 'string'],
        ],
        blockComment: [
            [/\*\//, { token: 'comment', next: '@pop' }],
            [/[^*]+|\*/, 'comment'],
        ],
    },
};
