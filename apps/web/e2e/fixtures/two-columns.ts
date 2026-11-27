/** A two-column paper: every typeset line has another one level with it in the other column, and a table has cells
 *  level with one another, a column space apart. */

const SENTENCES = [
    'Mail filters read the visible text of a message before they decide what it is.',
    'A sender can hide a payload from them in more ways than one would first think.',
    'We measure nineteen techniques against five extractors and one real renderer.',
    'The extractors disagree with one another more often than their authors expect.',
    'Hidden text that a filter keeps can still tip the verdict of a later classifier.',
    'Visible text that a filter drops is the more dangerous of the two mistakes.',
    'Our corpus has sixty eight client setups, each with a screenshot and a verdict.',
    'Every verdict was labelled twice, and the two labels agree in all but three cases.',
];

const paragraph = (n: number): string =>
    Array.from({ length: 5 }, (_, i) => SENTENCES[(n * 3 + i) % SENTENCES.length] ?? '')
        .map((s, i) => (i === 0 ? `Paragraph ${n + 1}. ${s}` : s))
        .join('\n');

export const TWO_COLUMNS = {
    'main.tex': [
        '\\documentclass[twocolumn]{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        ...Array.from({ length: 6 }, (_, n) => `${paragraph(n)}\n`),
        '\\begin{tabular}{lll}',
        'Baseline & strips tags & keeps comments \\\\',
        'Stalwart & renders styles & drops comments \\\\',
        '\\end{tabular}',
        '',
        ...Array.from({ length: 12 }, (_, n) => `${paragraph(n + 6)}\n`),
        '\\end{document}',
        '',
    ].join('\n'),
} as const;
