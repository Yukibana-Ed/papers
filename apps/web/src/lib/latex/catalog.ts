/** What LaTeX completion offers before it knows the project: the commands and environments of the kernel and of the
 *  packages most papers load, the common package and class names. A command's `args` is its snippet after the name. */

export interface CatalogCommand {
    readonly name: string;
    /** Inserted after the name, as a Monaco snippet (`{$1}`); empty for none. */
    readonly args: string;
    /** The package it comes from; empty for the kernel. */
    readonly from: string;
}

export interface CatalogEnvironment {
    readonly name: string;
    /** The package or class it comes from; empty for the kernel. */
    readonly from: string;
}

interface PackageData {
    /** name[:number of brace arguments[:o for an optional one first]], separated by white space. */
    readonly commands?: string;
    readonly environments?: string;
    /** The packages this one loads itself, whose commands are then available too. */
    readonly loads?: string;
}

/** The kernel under `''`, then packages and classes by name. */
const DATA: Readonly<Record<string, PackageData>> = {
    '': {
        commands: `begin:1 end:1 documentclass:1:o usepackage:1:o input:1 include:1 includeonly:1 title:1 author:1 date:1 maketitle
        section:1 subsection:1 subsubsection:1 paragraph:1 subparagraph:1 chapter:1 part:1 appendix tableofcontents listoffigures listoftables
        label:1 ref:1 pageref:1 cite:1 nocite:1 bibliography:1 bibliographystyle:1 bibitem:1 footnote:1 footnotemark footnotetext:1 caption:1 centering
        emph:1 textbf:1 textit:1 texttt:1 textsc:1 textsf:1 textrm:1 textsl:1 textup:1 textnormal:1 textsuperscript:1 textsubscript:1 underline:1
        mbox:1 makebox:1 fbox:1 framebox:1 parbox:2 raisebox:2 rule:2 hrule hrulefill dotfill marginpar:1 phantom:1 hphantom:1 vphantom:1
        newcommand:2 renewcommand:2 providecommand:2 newenvironment:3 renewenvironment:3 newtheorem:2 newcounter:1 setcounter:2 addtocounter:2 stepcounter:1
        refstepcounter:1 value:1 arabic:1 roman:1 Roman:1 alph:1 Alph:1 thepage thesection thefigure thetable theequation
        newlength:1 setlength:2 addtolength:2 settowidth:2 hspace:1 vspace:1 hfill vfill smallskip medskip bigskip par newline linebreak nolinebreak
        pagebreak nopagebreak newpage clearpage cleardoublepage enlargethispage:1 noindent indent item hline cline:1 multicolumn:3
        textwidth linewidth columnwidth textheight paperwidth paperheight baselineskip parindent parskip tabcolsep arraystretch
        pagestyle:1 thispagestyle:1 pagenumbering:1 addcontentsline:3 frontmatter mainmatter backmatter raggedright raggedleft sloppy protect
        small footnotesize scriptsize tiny normalsize large Large LARGE huge Huge bfseries itshape ttfamily rmfamily sffamily scshape mdseries upshape
        makeatletter makeatother RequirePackage:1:o ProvidesPackage:1 NeedsTeXFormat:1 hyphenation:1 index:1 ensuremath:1
        textbackslash textasciitilde textasciicircum textbar textless textgreater copyright dag ddag pounds
        frac:2 sqrt:1 sum prod coprod int oint lim limsup liminf infty partial nabla cdot cdots ldots vdots ddots dots times div pm mp
        leq geq neq approx equiv sim simeq cong propto ll gg prec succ mid parallel perp models vdash
        alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon
        phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega ell hbar Re Im aleph prime emptyset angle triangle top bot
        left right big Big bigg Bigg langle rangle lfloor rfloor lceil rceil lbrace rbrace limits nolimits displaystyle textstyle scriptstyle nonumber
        mathrm:1 mathbf:1 mathit:1 mathcal:1 mathsf:1 mathtt:1 mathnormal:1 stackrel:2
        hat:1 widehat:1 bar:1 vec:1 tilde:1 widetilde:1 dot:1 ddot:1 check:1 breve:1 acute:1 grave:1 overline:1 overrightarrow:1 underbrace:1 overbrace:1
        in notin ni subset subseteq supset supseteq cup cap bigcup bigcap setminus forall exists neg wedge vee bigwedge bigvee oplus otimes bigoplus bigotimes
        circ bullet star ast rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow longrightarrow longleftarrow Longrightarrow Longleftarrow
        longleftrightarrow iff mapsto to gets hookrightarrow uparrow downarrow updownarrow nearrow searrow
        sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln lg exp min max sup inf arg det dim ker gcd deg hom Pr bmod pmod:1
        quad qquad thinspace enspace today LaTeX TeX verb thanks:1 and`,
        environments: `document abstract itemize enumerate description figure figure* table table* tabular tabular* center flushleft flushright quote
        quotation verse verbatim minipage equation eqnarray array displaymath math picture theorem lemma proof definition corollary remark example
        thebibliography titlepage`,
    },
    amsmath: {
        commands: `text:1 eqref:1 operatorname:1 DeclareMathOperator:2 tag:1 notag intertext:1 dfrac:2 tfrac:2 cfrac:2 binom:2 dbinom:2 tbinom:2
        boldsymbol:1 pmb:1 substack:1 overset:2 underset:2 xrightarrow:1 xleftarrow:1 iint iiint iiiint idotsint dotsc dotsb dotsm dotsi
        lvert rvert lVert rVert numberwithin:2 allowdisplaybreaks displaybreak implies impliedby mod pod:1 sideset:3 hdotsfor:1 shoveleft:1 shoveright:1
        varinjlim varprojlim varliminf varlimsup`,
        environments: `equation* align align* gather gather* multline multline* flalign flalign* alignat alignat* split cases matrix pmatrix bmatrix Bmatrix
        vmatrix Vmatrix smallmatrix aligned gathered alignedat subequations`,
    },
    amssymb: {
        commands: `mathbb:1 mathfrak:1 varnothing leqslant geqslant nleq ngeq lesssim gtrsim lll ggg subsetneq supsetneq nsubseteq nsupseteq nmid nparallel
        therefore because blacksquare square complement triangleq rightsquigarrow twoheadrightarrow upharpoonright nexists checkmark varkappa
        nrightarrow nleftarrow nRightarrow nLeftarrow leftrightarrows rightleftharpoons curvearrowright vDash Vdash nvdash nvDash ltimes rtimes
        smallsetminus backslash`,
    },
    amsthm: { commands: 'theoremstyle:1 newtheoremstyle:9 qedhere qed qedsymbol swapnumbers', environments: 'proof' },
    mathtools: {
        commands: `coloneqq eqqcolon vcentcolon dblcolon mathclap:1 mathllap:1 mathrlap:1 DeclarePairedDelimiter:3 prescript:3 xRightarrow:1 xLeftarrow:1
        xleftrightarrow:1 xhookrightarrow:1 xmapsto:1 underbracket:1 overbracket:1 shortintertext:1 mathtoolsset:1 splitfrac:2 cramped:1 adjustlimits
        smashoperator:1`,
        environments: 'dcases dcases* cases* rcases drcases multlined matrix* pmatrix* bmatrix* vmatrix* psmallmatrix bsmallmatrix',
        loads: 'amsmath',
    },
    bm: { commands: 'bm:1' },
    physics: {
        commands: 'abs:1 norm:1 dv:2 pdv:2 dd bra:1 ket:1 braket:2 expval:1 mel:3 vb:1 grad curl comm:2 order:1 eval:1 tr Tr rank',
        loads: 'amsmath',
    },
    graphicx: { commands: 'includegraphics:1:o graphicspath:1 rotatebox:2 scalebox:2 resizebox:3 reflectbox:1 DeclareGraphicsExtensions:1' },
    url: { commands: 'url:1 urlstyle:1 path:1' },
    hyperref: {
        commands: 'href:2 autoref:1 autopageref:1 nameref:1 hypersetup:1 hyperref:1:o hyperlink:2 hypertarget:2 texorpdfstring:2 phantomsection pdfbookmark:2:o nolinkurl:1',
        loads: 'url',
    },
    cleveref: { commands: 'cref:1 Cref:1 crefrange:2 Crefrange:2 cpageref:1 namecref:1 nameCref:1 labelcref:1 crefname:3 Crefname:3' },
    booktabs: { commands: 'toprule midrule bottomrule cmidrule:1 addlinespace specialrule:3' },
    array: { commands: 'newcolumntype:2 arraybackslash extrarowheight' },
    tabularx: { commands: 'tabularxcolumn', environments: 'tabularx', loads: 'array' },
    longtable: { commands: 'endhead endfirsthead endfoot endlastfoot', environments: 'longtable' },
    multirow: { commands: 'multirow:3' },
    multicol: { commands: 'columnbreak', environments: 'multicols' },
    xcolor: { commands: 'textcolor:2 color:1 colorbox:2 fcolorbox:3 definecolor:3 colorlet:2 pagecolor:1 rowcolors:3' },
    natbib: {
        commands: `citep:1 citet:1 citeauthor:1 citeyear:1 citeyearpar:1 citealp:1 citealt:1 Citet:1 Citep:1 citenum:1 setcitestyle:1 defcitealias:2
        citetalias:1 citepalias:1`,
    },
    biblatex: {
        commands: `addbibresource:1 printbibliography printbibheading parencite:1 textcite:1 autocite:1 footcite:1 fullcite:1 supercite:1 smartcite:1
        Parencite:1 Textcite:1 Autocite:1 citeauthor:1 citeyear:1 citetitle:1 citeurl:1 DeclareFieldFormat:2 ExecuteBibliographyOptions:1 defbibheading:2`,
    },
    siunitx: {
        commands: 'qty:2 unit:1 num:1 ang:1 qtyrange:3 numrange:2 qtylist:2 numlist:1 SI:2 si:1 SIrange:3 sisetup:1 DeclareSIUnit:2 tablenum:1',
    },
    tikz: {
        commands: 'tikz draw node fill filldraw path coordinate shade shadedraw clip foreach pic tikzset:1 usetikzlibrary:1',
        environments: 'tikzpicture scope',
        loads: 'graphicx xcolor',
    },
    pgfplots: {
        commands: 'pgfplotsset:1 addplot addlegendentry:1 legend:1 usepgfplotslibrary:1',
        environments: 'axis semilogxaxis semilogyaxis loglogaxis',
        loads: 'tikz',
    },
    geometry: { commands: 'geometry:1 newgeometry:1 restoregeometry' },
    enumitem: { commands: 'setlist:1:o newlist:3 setlistdepth:1' },
    caption: { commands: 'captionsetup:1:o captionof:2' },
    subcaption: { commands: 'subcaption:1 subcaptionbox:2 subref:1', environments: 'subfigure subtable', loads: 'caption' },
    float: { commands: 'floatstyle:1 newfloat:3 restylefloat:1 floatname:2' },
    listings: { commands: 'lstinline lstinputlisting:1:o lstset:1 lstdefinestyle:2 lstdefinelanguage:2 lstlistoflistings', environments: 'lstlisting' },
    minted: { commands: 'mint:1 mintinline:2 inputminted:2 usemintedstyle:1 setminted:1', environments: 'minted' },
    algorithm: { commands: 'listofalgorithms', environments: 'algorithm' },
    algpseudocode: {
        commands: `State Require Ensure If:1 ElsIf:1 Else EndIf For:1 ForAll:1 EndFor While:1 EndWhile Repeat Until:1 Loop EndLoop Function:2 EndFunction
        Procedure:2 EndProcedure Return Call:2 Comment:1`,
        environments: 'algorithmic',
    },
    algorithm2e: {
        commands: `KwIn:1 KwOut:1 KwData:1 KwResult:1 KwRet:1 If:2 ElseIf:2 Else:1 eIf:3 For:2 ForEach:2 While:2 Return:1 SetKwFunction:2 SetKwInOut:2
        SetAlgoLined DontPrintSemicolon`,
        environments: 'algorithm algorithm*',
    },
    fancyhdr: { commands: 'fancyhf:1 fancyhead:1:o fancyfoot:1:o fancypagestyle:2 headrulewidth footrulewidth lhead:1 chead:1 rhead:1 lfoot:1 cfoot:1 rfoot:1' },
    titlesec: { commands: 'titleformat:5 titlespacing:4 titlelabel:1' },
    setspace: { commands: 'singlespacing onehalfspacing doublespacing setstretch:1', environments: 'spacing' },
    todonotes: { commands: 'todo:1:o missingfigure:1 listoftodos', loads: 'tikz' },
    csquotes: { commands: 'enquote:1 textquote:1 blockquote:1 foreignquote:2 MakeOuterQuote:1', environments: 'displayquote' },
    babel: { commands: 'selectlanguage:1 foreignlanguage:2 babelhyphenation:1', environments: 'otherlanguage' },
    glossaries: {
        commands: 'gls:1 Gls:1 glspl:1 Glspl:1 newglossaryentry:2 newacronym:3 makeglossaries printglossary printglossaries acrshort:1 acrlong:1 acrfull:1',
    },
    fontspec: { commands: 'setmainfont:1 setsansfont:1 setmonofont:1 newfontfamily:2 fontspec:1 defaultfontfeatures:1' },
    'unicode-math': { commands: 'setmathfont:1 symbf:1 symbb:1 symcal:1 symup:1 symit:1', loads: 'fontspec' },
    microtype: { commands: 'microtypesetup:1 textls:1' },
    etoolbox: { commands: 'AtBeginEnvironment:2 AtEndEnvironment:2 patchcmd:5 apptocmd:4 pretocmd:4 newtoggle:1 toggletrue:1 togglefalse:1 iftoggle:3 ifstrequal:4' },
    lipsum: { commands: 'lipsum' },
    xspace: { commands: 'xspace' },
    beamer: {
        commands: `frametitle:1 framesubtitle:1 pause only:1 uncover:1 visible:1 onslide alert:1 structure:1 usetheme:1 usecolortheme:1 usefonttheme:1
        useinnertheme:1 useoutertheme:1 setbeamertemplate:2 setbeamercolor:2 setbeamerfont:2 titlepage institute:1 subtitle:1 titlegraphic:1 logo:1
        insertframenumber inserttotalframenumber AtBeginSection:1 note:1 beamertemplatenavigationsymbolsempty`,
        environments: 'frame block alertblock exampleblock columns column overprint onlyenv',
        loads: 'xcolor hyperref graphicx amsmath amsthm amssymb',
    },
    amsart: { commands: 'address:1 email:1 keywords:1 subjclass:1 dedicatory:1', loads: 'amsmath amsthm' },
    IEEEtran: {
        commands: 'IEEEauthorblockN:1 IEEEauthorblockA:1 IEEEPARstart:2 IEEEpeerreviewmaketitle',
        environments: 'IEEEkeywords IEEEeqnarray IEEEbiography',
    },
    acmart: {
        commands: 'affiliation:1 institution:1 city:1 country:1 email:1 orcid:1 ccsdesc:1:o keywords:1 setcopyright:1 acmDOI:1 acmYear:1 acmConference:4:o',
        environments: 'CCSXML teaserfigure acks',
        loads: 'amsmath amsthm hyperref graphicx booktabs xcolor natbib',
    },
    llncs: { commands: 'institute:1 titlerunning:1 authorrunning:1 inst:1 orcidID:1 keywords:1 email:1' },
};

const words = (list: string | undefined): string[] => (list ?? '').trim().split(/\s+/).filter(Boolean);

const command = (from: string, entry: string): CatalogCommand => {
    const [name = '', n = '0', opt = ''] = entry.split(':');
    const shift = opt === 'o' ? 1 : 0;
    return { name, args: (shift === 1 ? '[$1]' : '') + Array.from({ length: Number(n) }, (_, i) => `{$${i + 1 + shift}}`).join(''), from };
};

/** Every command of the catalogue: the kernel's first, then each package's and class's. */
export const COMMANDS: readonly CatalogCommand[] = Object.entries(DATA).flatMap(([from, d]) => words(d.commands).map(e => command(from, e)));

/** Every environment of the catalogue, in the same order. */
export const ENVIRONMENTS: readonly CatalogEnvironment[] = Object.entries(DATA).flatMap(([from, d]) => words(d.environments).map(name => ({ name, from })));

/** `names` (packages and classes a project loads) with the packages those load themselves. */
export function withLoaded(names: Iterable<string>): Set<string> {
    const all = new Set<string>();
    const todo = [...names];
    for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
        if (all.has(n)) continue;
        all.add(n);
        todo.push(...words(DATA[n]?.loads));
    }
    return all;
}

/** What goes between `\begin{name}` and `\end{name}` for the environments that have a usual shape, as a Monaco snippet:
 *  the arguments, then the body. The others get an empty indented line. */
const BODIES: Readonly<Record<string, string>> = {
    itemize: '\n\t\\item $0\n',
    enumerate: '\n\t\\item $0\n',
    description: '\n\t\\item[$1] $0\n',
    figure: '[${1:htbp}]\n\t\\centering\n\t\\includegraphics[width=${2:\\linewidth}]{$3}\n\t\\caption{$4}\n\t\\label{fig:$5}\n',
    'figure*': '[${1:htbp}]\n\t\\centering\n\t\\includegraphics[width=${2:\\linewidth}]{$3}\n\t\\caption{$4}\n\t\\label{fig:$5}\n',
    table: '[${1:htbp}]\n\t\\centering\n\t\\caption{$2}\n\t\\label{tab:$3}\n\t\\begin{tabular}{${4:lcr}}\n\t\t$0\n\t\\end{tabular}\n',
    'table*': '[${1:htbp}]\n\t\\centering\n\t\\caption{$2}\n\t\\label{tab:$3}\n\t\\begin{tabular}{${4:lcr}}\n\t\t$0\n\t\\end{tabular}\n',
    tabular: '{${1:lcr}}\n\t$0\n',
    'tabular*': '{${1:\\linewidth}}{${2:lcr}}\n\t$0\n',
    minipage: '{${1:0.5\\linewidth}}\n\t$0\n',
    thebibliography: '{${1:99}}\n\t\\bibitem{$2} $0\n',
    frame: '{$1}\n\t$0\n',
    block: '{$1}\n\t$0\n',
    column: '{${1:0.5\\textwidth}}\n\t$0\n',
    alertblock: '{$1}\n\t$0\n',
    exampleblock: '{$1}\n\t$0\n',
    array: '{${1:lcr}}\n\t$0\n',
    alignat: '{${1:2}}\n\t$0\n',
    'alignat*': '{${1:2}}\n\t$0\n',
    tabularx: '{${1:\\linewidth}}{${2:lXr}}\n\t$0\n',
    longtable: '{${1:lcr}}\n\t$0\n',
    multicols: '{${1:2}}\n\t$0\n',
    minted: '{${1:python}}\n\t$0\n',
    spacing: '{${1:1.5}}\n\t$0\n',
    subfigure: '{${1:0.5\\linewidth}}\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{$2}\n\t\\caption{$3}\n',
    cases: '\n\t$1 & $2 \\\\\\\\\n\t$0\n',
};

/** The snippet for a whole environment from just after `\begin{`: the name, its closing brace, its usual arguments
 *  and body, and its `\end`. */
export function environmentSnippet(name: string): string {
    return `${name}}${BODIES[name] ?? '\n\t$0\n'}\\end{${name}}`;
}

/** Document classes, for `\documentclass{`. */
export const CLASSES: readonly string[] = 'article report book letter beamer memoir scrartcl scrreprt scrbook amsart IEEEtran acmart llncs revtex4-2'.split(' ');

/** Package names, for `\usepackage{`: the catalogue's, and common ones that define nothing to complete. */
export const PACKAGES: readonly string[] = [
    ...new Set([...Object.keys(DATA).filter(n => n !== '' && !CLASSES.includes(n)), ...words('fontenc inputenc lmodern parskip doi algorithmic')]),
];
