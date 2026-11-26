import type { Branch, Commit, Presence, Suggestion, Thread, User } from '#lib/model/types.ts';

/** The demo project: a short paper, slides and a bibliography, with a team in the middle of reviewing it. It stands in
 *  for a GitHub repository and its room until the user opens one of their own. */

export const USERS: Readonly<Record<string, User>> = {
    ambrus: { id: 'ambrus', name: 'Ambrus Tóth', initials: 'AT', hue: 178 },
    lena: { id: 'lena', name: 'Lena Kraus', initials: 'LK', hue: 300 },
    marco: { id: 'marco', name: 'Marco Rossi', initials: 'MR', hue: 355 },
    weber: { id: 'weber', name: 'Prof. Weber', initials: 'PW', hue: 80 },
};
export const ME = 'ambrus';

export const REPO = { owner: 'yukibana-demo', name: 'feedback-paper' } as const;

export const FILES: Readonly<Record<string, string>> = {
    'paper.tex': String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath}
\usepackage{tikz}
\usepackage[margin=1in]{geometry}

\title{Instant Feedback in Introductory Programming}
\author{Ambrus Tóth \and Lena Kraus \and Marco Rossi}

\begin{document}
\maketitle

\begin{abstract}
We study how feedback that arrives within seconds changes the way
first-year students work on programming exercises. In a course of
412 students, instant feedback halved the time to a first passing
submission and reduced the number of abandoned exercises by a third.
\end{abstract}

\input{sections/intro}
\input{sections/method}
\input{sections/results}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`,
    'sections/intro.tex': String.raw`\section{Introduction}
Learning to program is very important for every student of computer
science, yet the first weeks are where most of them struggle.
Students rarely read compiler errors, and when they do, the message
seldom points at the mistake they actually made~\cite{becker2019}.

Feedback that arrives days after a submission is too late to change
how a student works~\cite{hattie2007}. We ask what happens when it
arrives within seconds instead, while the student still holds the
problem in mind.

\subsection{Contributions}
\begin{itemize}
  \item A tool that runs hidden tests in the browser, with no server.
  \item A study with 412 students over one semester.
  \item An analysis of which kinds of feedback students act on.
\end{itemize}
`,
    'sections/method.tex': String.raw`\section{Method}
We ran the study in the winter term of 2025 in a first-year course
on programming in Python. Students solved weekly exercises in the
browser; each submission ran a suite of hidden tests on their machine.

\subsection{Measures}
For every exercise we recorded the time from opening it to the first
passing submission, $t_{\text{pass}}$, and whether it was abandoned.
We compare the two cohorts with a mixed model,
\begin{equation}
  \log t_{\text{pass}} = \beta_0 + \beta_1 \cdot \text{instant} + u_{\text{student}} + \varepsilon,
\end{equation}
with a random intercept per student.

\begin{figure}[t]
  \centering
  \begin{tikzpicture}[x=0.34cm, y=0.05cm]
    \foreach \h [count=\i] in {4,6,9,12,18,25,31,40,52,47,38,29,22,30,44,61,73,66,48,35} {
      \fill[gray!55] (\i,0) rectangle +(0.72,\h);
    }
    \draw[gray] (0.6,0) -- (21,0);
    \node[below, font=\small] at (11,0) {hours before the deadline};
  \end{tikzpicture}
  \caption{Submissions per hour in the week before the deadline.}
\end{figure}
`,
    'sections/results.tex': String.raw`\section{Results}
Instant feedback halved the median time to a first passing submission,
from 41 to 19 minutes ($\beta_1 = -0.71$, $p < 0.001$). The share of
abandoned exercises fell from 18\% to 12\%.

Students in the instant cohort submitted more often, but each
submission changed less code. We read this as a shift from guessing
to testing small hypotheses, as~\cite{edwards2004} predicted.

\subsection{Threats to validity}
The two cohorts took the course in different years. The exercises
were the same, but the teaching assistants were not.
`,
    'slides.tex': String.raw`\documentclass{beamer}
\title{Instant Feedback}
\author{Ambrus Tóth}

\begin{document}
\maketitle

\begin{frame}{Why}
Feedback days later is too late to change how a student works.
\end{frame}

\begin{frame}{What we found}
Median time to a first pass fell from 41 to 19 minutes.
\end{frame}
\end{document}
`,
    'refs.bib': String.raw`@inproceedings{becker2019,
  title     = {Compiler Error Messages Considered Unhelpful},
  author    = {Becker, Brett A. and others},
  booktitle = {ITiCSE Working Group Reports},
  year      = {2019},
}

@article{hattie2007,
  title   = {The Power of Feedback},
  author  = {Hattie, John and Timperley, Helen},
  journal = {Review of Educational Research},
  volume  = {77},
  number  = {1},
  pages   = {81--112},
  year    = {2007},
}

@inproceedings{edwards2004,
  title     = {Using Software Testing to Move Students from Trial-and-Error to Reflection-in-Action},
  author    = {Edwards, Stephen H.},
  booktitle = {SIGCSE Technical Symposium on Computer Science Education},
  pages     = {26--30},
  year      = {2004},
}
`,
};

/** The project's files in the order the file list shows them. */
export const FILE_ORDER: readonly string[] = ['paper.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'slides.tex', 'refs.bib'];

/** What was last committed: the session starts with a few edits on top of it. */
export const BASE: Readonly<Record<string, string>> = {
    ...FILES,
    'sections/intro.tex': (FILES['sections/intro.tex'] ?? '').replace('  \\item An analysis of which kinds of feedback students act on.\n', ''),
    'sections/method.tex': (FILES['sections/method.tex'] ?? '').replace('first-year course\non programming in Python', 'first-year course\nin Python'),
};

export const BRANCHES: Readonly<Record<string, Branch>> = {
    main: { name: 'main', users: ['ambrus', 'lena'], pr: null },
    'related-work': { name: 'related-work', users: ['marco'], pr: { number: 14, title: 'Add related work section', checks: 'passing' } },
};

export const COMMITS: readonly Commit[] = [
    { hash: 'a1b2c3d', author: 'lena', when: '2 h ago', msg: 'Tighten the abstract' },
    { hash: '9f3e2aa', author: 'ambrus', when: 'yesterday', msg: 'Add mixed model to method' },
    { hash: '5c01d7e', author: 'marco', when: '2 days ago', msg: 'Results: first draft' },
    { hash: '0e6b4f1', author: 'ambrus', when: '4 days ago', msg: 'Initial structure' },
];

export const THREADS: readonly Thread[] = [
    {
        id: 't1',
        source: 'team',
        file: 'sections/intro.tex',
        quote: 'Students rarely read compiler errors',
        root: {
            id: 'c1',
            author: 'weber',
            when: '3 h ago',
            resolved: false,
            body: 'Is *rarely* backed by the citation, or by our own data?',
            replies: [
                {
                    id: 'c2',
                    author: 'lena',
                    when: '2 h ago',
                    resolved: false,
                    body: 'Becker says **often**. Soften it?',
                    replacement: 'Students often skip compiler errors',
                    replies: [{ id: 'c3', author: 'marco', when: '1 h ago', resolved: false, body: 'Agree, “often skip” matches the paper.', replies: [] }],
                },
                {
                    id: 'c4',
                    author: 'ambrus',
                    when: '2 h ago',
                    resolved: true,
                    body: 'Added `becker2019` to `refs.bib`.',
                    replies: [{ id: 'c5', author: 'weber', when: '1 h ago', resolved: true, body: 'Thanks.', replies: [] }],
                },
            ],
        },
    },
    {
        id: 't2',
        source: 'team',
        file: 'sections/method.tex',
        quote: 'with a random intercept per student',
        root: { id: 'c6', author: 'marco', when: '40 min ago', resolved: false, body: 'Do we also need one per exercise? Something like $u_{\\text{exercise}}$.', replies: [] },
    },
    {
        id: 't3',
        source: 'team',
        file: 'sections/results.tex',
        quote: 'We read this as a shift from guessing',
        root: { id: 'c7', author: 'weber', when: 'yesterday', resolved: true, body: 'Nice framing.', replies: [] },
    },
    {
        id: 'g1',
        source: 'github',
        branch: 'related-work',
        file: 'sections/results.tex',
        quote: 'The two cohorts took the course in different years.',
        root: {
            id: 'g1c',
            author: 'weber',
            when: '5 h ago',
            resolved: false,
            body: 'Name the years. Reviewers will ask.',
            replies: [{ id: 'g1r', author: 'marco', when: '4 h ago', resolved: false, body: 'Will do in the next push.', replies: [] }],
        },
    },
];

export const SUGGESTIONS: readonly Suggestion[] = [{ id: 's1', author: 'lena', when: '25 min ago', file: 'sections/intro.tex', quote: 'very important', text: 'central' }];

export const PRESENCE: readonly Presence[] = [{ user: 'lena', file: 'sections/method.tex', line: 9 }];
