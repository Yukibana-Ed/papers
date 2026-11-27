/** A LaTeX paper like the one a selection once lost its place in: two pages of prose before a table whose rows are a
 *  source line each, with cells that come from macros, a `\code` cell and the same few letters in every row. */

const PROSE = [
    'Mail filters read the visible text of a message, and a sender can hide a payload from them in many ways.',
    'We study the values of two borderless form fields, the box after the sign-off, and a parent indented far away.',
    'Each of the techniques is run against five extractors, and each of the verdicts is one of V, H or i.',
    'A hiding technique evades the extractors marked V, and a revealing technique evades those marked H.',
    'The last column gives the client setups in which the technique survived, of those with a verdict.',
].join('\n');

const ROWS: readonly (readonly [string, string, string, string, string])[] = [
    ['T03', 'hiding', 'paragraph with inline \\code{display:none}', 'V & H & i & H & H', 'ZeroThree'],
    ['T04', 'revealing', 'sentence as the values of two borderless form fields', 'H & H & H & H & V', 'ZeroFour'],
    ['T05', 'hiding', '1\\,px inline box after the sign-off, with \\code{mso-hide:all}', 'V & V & V & H & H', 'ZeroFive'],
    ['T06', 'revealing', 'parent indented by $-1000$\\,px, child resets the indent', 'V & H & V & V & V', 'ZeroSix'],
    ['T07', 'hiding', '\\code{<b>} element with inline \\code{display:none}', 'V & H & V & H & H', 'ZeroSeven'],
    ['T08', 'revealing', '\\code{<font size="1">} with a CSS font size of 1\\,em', 'V & V & i & V & V', 'ZeroEight'],
    ['T09', 'hiding', 'the 1\\,px box without \\code{mso-hide}, in a conditional comment that classic Outlook skips', 'V & V & V & V & H', 'ZeroNine'],
];

const macros = ROWS.map(([, , , , n], i) => `\\newcommand{\\StudyT${n}Survives}{${58 + i}}\n\\newcommand{\\StudyT${n}Verdicts}{${67 + (i % 2)}}`).join('\n');

export const TABLE_PAPER = {
    'main.tex': [
        '\\documentclass{article}',
        '\\newcommand{\\code}[1]{\\texttt{\\detokenize{#1}}}',
        macros,
        '\\begin{document}',
        '\\section{Introduction}',
        ...Array.from({ length: 14 }, () => `${PROSE}\n`),
        '\\input{table-set}',
        '\\section{A browser rendering}',
        '\\input{rendering}',
        ...Array.from({ length: 4 }, () => `${PROSE}\n`),
        '\\end{document}',
        '',
    ].join('\n'),
    'table-set.tex': [
        '\\begin{table}[t]',
        '\\caption{The techniques and their results. Columns TS, Rs, SA, St and Re give what each extractor deems the',
        'payload: visible (V), hidden (H), or hidden and kept in the invisible stream (i).}',
        '\\centering\\small',
        '\\begin{tabular}{@{}llp{0.4\\linewidth}cccccr@{}}',
        '\\hline',
        'id & direction & technique & TS & Rs & SA & St & Re & survived in \\\\',
        '\\hline',
        ...ROWS.map(([id, dir, what, verdicts, n]) => `${id} & ${dir} & ${what} & ${verdicts} & \\StudyT${n}Survives{} of \\StudyT${n}Verdicts{} \\\\`),
        '\\hline',
        '\\end{tabular}',
        '\\end{table}',
        '',
    ].join('\n'),
    'rendering.tex': [
        'T03 to T09 do not evade the rendering: it deems hidden every payload that these techniques hide. Three kinds',
        'of difference separate them.',
        '\\begin{itemize}',
        '\\item \\textbf{Engine.} The engine of the client lacks a feature that the renderer has.',
        '\\item \\textbf{Embedding.} The client inserts the message into its own page, so',
        '  the message is not the document.',
        '\\end{itemize}',
        '',
        '\\begin{figure}[t]',
        '\\centering',
        '\\fbox{\\rule{0.9\\linewidth}{1cm}}\\\\[2pt]',
        '\\fbox{\\rule{0.9\\linewidth}{1cm}}\\\\[2pt]',
        '\\fbox{\\rule{0.9\\linewidth}{1cm}}',
        '\\caption{The email of T12 in the confirmatory run as the renderer draws it (top), in Gmail in Chrome (middle) and in classic Outlook (bottom), at the same scale. The rendering does not show the payload sentence; both clients do.}',
        '\\label{fig:t12}',
        '\\end{figure}',
        '',
        '\\paragraph{A rule that applies only where no difference exists.} T11 and T12',
        'use a single style rule. Its selector matches only when the message is the document.',
        '',
    ].join('\n'),
} as const;
