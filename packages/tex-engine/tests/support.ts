import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DirEntry, JobSettings, Kind, Project, Tree } from '../src/index.ts';

/** The engine: the file `PDFTEX_WASM` names, else the one of the installed `@yukibana/pdftex-wasm`; null when neither is
 *  there (the tests that run the engine are then skipped). */
function engineFile(): string | null {
    const named = process.env['PDFTEX_WASM'];
    if (named !== undefined && named !== '') return named;
    try {
        const file = createRequire(import.meta.url).resolve('@yukibana/pdftex-wasm/pdftex.wasm');
        return existsSync(file) ? file : null;
    } catch {
        return null;
    }
}

function compiled(name: string): WebAssembly.Module | null {
    const file = engineFile();
    if (file === null) return null;
    const named = file.replace(/pdftex\.wasm$/, name);
    return existsSync(named) ? new WebAssembly.Module(readFileSync(named)) : null;
}
export const engine: WebAssembly.Module | null = compiled('pdftex.wasm');
/** BibTeX, from beside the engine. */
export const bibtex: WebAssembly.Module | null = compiled('bibtex8.wasm');

/** A tree with nothing in it but the programs' own place and `extra` (by absolute path, in directories of `/`):
 *  IniTeX needs no file but those of the project. */
export function tree(extra: Readonly<Record<string, Uint8Array>> = {}): Tree {
    const files: Readonly<Record<string, Uint8Array>> = {
        '/bin/pdftex': new Uint8Array(0),
        '/bin/bibtex8': new Uint8Array(0),
        // kpathsea's configuration: every kind of file is looked for in the project only.
        '/bin/texmf.cnf': new TextEncoder().encode(
            'TEXINPUTS = .\nTEXFORMATS = .;/fmt\nTFMFONTS = .\nTEXFONTMAPS = .\nTEXPOOL = .\nBSTINPUTS = .\nBIBINPUTS = .\nopenout_any = p\nopenin_any = a\n',
        ),
        ...extra,
    };
    const dirs = new Map<string, DirEntry[]>([['/', []]]);
    for (const path of Object.keys(files).toSorted()) {
        const slash = path.lastIndexOf('/');
        const dir = path.slice(0, slash) || '/';
        if (!dirs.has(dir)) {
            dirs.set(dir, []);
            dirs.get('/')?.push({ name: dir.slice(1), kind: 2 });
        }
        dirs.get(dir)?.push({ name: path.slice(slash + 1), kind: 1 });
    }
    return {
        read: (path: string): Uint8Array | null => files[path] ?? null,
        kind: (path: string): Kind => (dirs.has(path) ? 2 : path in files ? 1 : 0),
        list: (path: string): readonly DirEntry[] => dirs.get(path) ?? [],
        find: (): string | null => null,
    };
}
export const emptyTree: Tree = tree();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A project from texts. */
export function project(files: Readonly<Record<string, string>>): Project {
    return new Map(Object.entries(files).map(([path, contents]) => [path, encoder.encode(contents)]));
}

/** `base` with the file `path` replaced by `text`; the other files keep their arrays. */
export function edited(base: Project, path: string, contents: string): Project {
    return new Map([...base, [path, encoder.encode(contents)]]);
}

export function text(bytes: Uint8Array | undefined): string {
    return bytes === undefined ? '' : decoder.decode(bytes);
}

/** IniTeX on `main.tex` in `/project`, at a fixed time. */
export const job: JobSettings = {
    tree: emptyTree,
    root: '/project',
    cwd: '/project',
    args: ['/bin/pdftex', '-ini', '-interaction=batchmode', 'main.tex'],
    env: {},
    time: 1_700_000_000,
};

/** The set-up every test document starts with: braces and parameters, PDF output without compression, a small page,
 *  and `\pages{n}`, which ships out n pages of one rule each, with some work in between. */
export const PREAMBLE =
    String.raw`\catcode` +
    '`' +
    String.raw`\{=1 \catcode` +
    '`' +
    String.raw`\}=2 \catcode` +
    '`' +
    String.raw`\#=6
\pdfoutput=1 \pdfcompresslevel=0 \pdfobjcompresslevel=0 \pdfmapfile{}
\pdfpagewidth=200pt \pdfpageheight=100pt \hoffset=0pt \voffset=0pt
\countdef\n=10 \countdef\k=11 \countdef\total=12
\def\work{\advance\k by 1 \ifnum\k<300 \expandafter\work\fi}
\def\page{\global\advance\total by 1 \k=0 \work \shipout\vbox{\hrule width\total pt height 10pt}}
\def\pages#1{\n=#1 \more}
\def\more{\ifnum\n>0 \advance\n by -1 \page \expandafter\more\fi}
`;

/** A copy of each output, by its name without the directory. */
export function outputs(of: Map<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...of].map(([path, bytes]) => [path.slice(path.lastIndexOf('/') + 1), bytes.slice()]));
}

/** How many pages a PDF written without compression has. */
export function pdfPages(pdf: Uint8Array | undefined): number {
    return text(pdf).match(/\/Type \/Page\b(?!s)/g)?.length ?? 0;
}
