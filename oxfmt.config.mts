import type { OxfmtConfig } from 'oxfmt';

export default {
    tabWidth: 4,
    singleQuote: true,
    jsxSingleQuote: true,
    printWidth: 180,
    arrowParens: 'avoid',
    // LF everywhere, as Git checks text files out (see .gitattributes): with CRLF on Windows, oxfmt added a carriage
    // return inside template literals on every run, and the demo's TeX sources are template literals.
    endOfLine: 'lf',
    sortPackageJson: false,
    ignorePatterns: ['**/*.md', '.claude/**', '**/vendor/**'],
    overrides: [
        {
            files: ['*.json', '*.yml', '*.yaml'],
            options: { tabWidth: 2 },
        },
    ],
} satisfies OxfmtConfig;
