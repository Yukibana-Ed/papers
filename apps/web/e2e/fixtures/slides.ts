/** A beamer talk: each frame's body is read ahead as an argument, so SyncTeX knows it only by its `\end{frame}`. */
export const SLIDES = {
    'slides.tex': [
        '\\documentclass{beamer}',
        '\\begin{document}',
        '',
        '\\begin{frame}{The problem}',
        '  \\begin{itemize}',
        '    \\item One idea per slide.',
        '    \\item Few words; the talk carries the rest.',
        '    \\item Reveal points one at a time when it helps.',
        '  \\end{itemize}',
        '\\end{frame}',
        '',
        '\\begin{frame}{Take-away}',
        '  \\begin{block}{In one sentence}',
        '    What should the audience remember tomorrow?',
        '  \\end{block}',
        '\\end{frame}',
        '',
        '\\end{document}',
        '',
    ].join('\n'),
} as const;
