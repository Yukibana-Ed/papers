/** What LaTeX completion offers before it knows the project: the commands and environments of the kernel and of the
 *  packages most papers load, the common package and class names. A command's `args` is its snippet after the name. */

export interface CatalogCommand {
    readonly name: string;
    /** Inserted after the name, as a Monaco snippet (`{$1}`); empty for none. */
    readonly args: string;
    /** The package it comes from; empty for the kernel. */
    readonly from: string;
}

const c = (from: string, list: string): CatalogCommand[] =>
    list
        .trim()
        .split(/\s+/)
        .map(entry => {
            const [name = '', n = '0', opt = ''] = entry.split(':');
            const count = Number(n);
            const args = (opt === 'o' ? '[$1]' : '') + Array.from({ length: count }, (_, i) => `{$${i + 1 + (opt === 'o' ? 1 : 0)}}`).join('');
            return { name, args, from };
        });

/** name[:number of brace arguments[:o for an optional one first]]. */
export const COMMANDS: readonly CatalogCommand[] = [
    ...c(
        '',
        `begin:1 end:1 documentclass:1:o usepackage:1:o input:1 include:1 includeonly:1 title:1 author:1 date:1 maketitle
        section:1 subsection:1 subsubsection:1 paragraph:1 subparagraph:1 chapter:1 part:1 appendix tableofcontents listoffigures listoftables
        label:1 ref:1 pageref:1 cite:1 nocite:1 bibliography:1 bibliographystyle:1 footnote:1 footnotemark footnotetext:1 caption:1 centering
        emph:1 textbf:1 textit:1 texttt:1 textsc:1 textsf:1 textrm:1 textsl:1 textup:1 underline:1 mbox:1 makebox:1 fbox:1 framebox:1 parbox:2 raisebox:2
        newcommand:2 renewcommand:2 providecommand:2 newenvironment:3 renewenvironment:3 newtheorem:2 newcounter:1 setcounter:2 addtocounter:2 stepcounter:1
        setlength:2 addtolength:2 hspace:1 vspace:1 hfill vfill newline linebreak pagebreak newpage clearpage cleardoublepage noindent indent item
        small footnotesize scriptsize tiny normalsize large Large LARGE huge Huge bfseries itshape ttfamily rmfamily sffamily scshape mdseries upshape
        frac:2 sqrt:1 sum prod int oint lim infty partial nabla cdot cdots ldots dots times div pm mp leq geq neq approx equiv sim propto
        alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega
        Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega left right big Big bigg Bigg mathrm:1 mathbf:1 mathit:1 mathcal:1 mathsf:1 mathtt:1
        hat:1 bar:1 vec:1 tilde:1 dot:1 ddot:1 overline:1 underbrace:1 overbrace:1 in notin subset subseteq supset cup cap forall exists neg wedge vee
        rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow mapsto to quad qquad today LaTeX TeX url:1 verb thanks:1 and`,
    ),
    ...c('amsmath', 'text:1 eqref:1 operatorname:1 DeclareMathOperator:2 tag:1 notag nonumber intertext:1 dfrac:2 tfrac:2 binom:2 boldsymbol:1 align'),
    ...c('amssymb', 'mathbb:1 mathfrak:1 varnothing leqslant geqslant'),
    ...c('graphicx', 'includegraphics:1:o graphicspath:1 rotatebox:2 scalebox:2 resizebox:3'),
    ...c('hyperref', 'href:2 autoref:1 hypersetup:1 nameref:1'),
    ...c('cleveref', 'cref:1 Cref:1'),
    ...c('booktabs', 'toprule midrule bottomrule cmidrule:1'),
    ...c('xcolor', 'textcolor:2 color:1 colorbox:2 definecolor:3'),
    ...c('natbib', 'citep:1 citet:1 citeauthor:1 citeyear:1'),
    ...c('biblatex', 'addbibresource:1 printbibliography parencite:1 textcite:1 autocite:1'),
    ...c('siunitx', 'SI:2 si:1 num:1 qty:2 unit:1'),
    ...c('tikz', 'tikz draw node fill coordinate usetikzlibrary:1'),
];

/** Environments: of the kernel and of common packages. */
export const ENVIRONMENTS: readonly string[] = `document abstract itemize enumerate description figure figure* table table* tabular tabular* center flushleft
    flushright quote quotation verse verbatim minipage equation equation* align align* gather gather* multline multline* split cases
    matrix pmatrix bmatrix vmatrix theorem lemma proof definition corollary remark example thebibliography titlepage tikzpicture frame block columns column`
    .trim()
    .split(/\s+/);

/** Package names, for `\usepackage{`. */
export const PACKAGES: readonly string[] = `amsmath amssymb amsthm mathtools graphicx hyperref cleveref xcolor booktabs tabularx longtable multirow
    array geometry fontenc inputenc babel csquotes biblatex natbib siunitx tikz pgfplots listings minted algorithm2e algorithmic caption subcaption
    float enumitem microtype lmodern lipsum url doi todonotes fancyhdr titlesec parskip setspace xspace etoolbox`
    .trim()
    .split(/\s+/);

/** Document classes, for `\documentclass{`. */
export const CLASSES: readonly string[] = 'article report book letter beamer memoir scrartcl scrreprt scrbook amsart IEEEtran acmart llncs revtex4-2'.split(' ');
