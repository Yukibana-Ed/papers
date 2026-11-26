import { safeFolder } from './paths.ts';
import type { Format, Template, TemplateInfo } from './template.ts';
import { TemplateError } from './template.ts';

/** The TeX Live year and the Typst version new papers are locked to. */
export const TEXLIVE_YEAR = '2026';
export const TYPST_VERSION = '0.14.2';

const dec = new TextDecoder('utf-8', { fatal: true });
const enc = new TextEncoder();

/** The text of `bytes` if they are UTF-8 text, else null (an image, a font). */
export function asText(bytes: Uint8Array): string | null {
    if (bytes.includes(0)) return null;
    try {
        return dec.decode(bytes);
    } catch {
        return null;
    }
}

function stripComments(tex: string): string {
    return tex.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** What a folder of files is when it has no `template.toml`: its format, its root and engine. A `papers.toml` that names
 *  a document wins; else a Typst file (`main.typ` first), else the LaTeX file with `\documentclass` nearest the top
 *  (`main.tex`, `paper.tex`, `thesis.tex` first among equals). Throws when there is no document at all. */
export function detect(files: ReadonlyMap<string, Uint8Array>): { format: Format; root: string; engine: string } {
    const toml = files.get('papers.toml');
    const tomlText = toml ? asText(toml) : null;
    const declared = tomlText ? /^\s*root\s*=\s*"([^"]+)"/m.exec(tomlText)?.[1] : undefined;
    const declaredEngine = tomlText ? /^\s*engine\s*=\s*"([^"]+)"/m.exec(tomlText)?.[1] : undefined;
    if (declared && files.has(declared)) {
        const typst = declared.endsWith('.typ');
        return { format: typst ? 'typst' : 'latex', root: declared, engine: declaredEngine ?? (typst ? 'typst' : 'pdflatex') };
    }
    const depth = (p: string): number => p.split('/').length;
    const preferred = (p: string): number => (/(^|\/)(main|paper|thesis|article|slides)\.(tex|typ)$/.test(p) ? 0 : 1);
    const order = (a: string, b: string): number => depth(a) - depth(b) || preferred(a) - preferred(b) || a.localeCompare(b);
    const tex = [...files.keys()].filter(p => p.endsWith('.tex')).filter(p => /^\s*\\documentclass\b/m.test(stripComments(asText(files.get(p) ?? new Uint8Array()) ?? '')));
    const typ = [...files.keys()].filter(p => p.endsWith('.typ'));
    if (tex.length) {
        const root = tex.toSorted(order)[0] ?? '';
        const src = asText(files.get(root) ?? new Uint8Array()) ?? '';
        const engine = /\\usepackage(\[[^\]]*\])?\{(fontspec|unicode-math|polyglossia)\}/.test(src) ? 'xelatex' : 'pdflatex';
        return { format: 'latex', root, engine };
    }
    if (typ.length) return { format: 'typst', root: typ.toSorted(order)[0] ?? '', engine: 'typst' };
    throw new TemplateError('No document here: no .tex file with \\documentclass and no .typ file');
}

/** A `papers.toml` declaring how the paper builds and locking its environment: TeX Live's year or Typst's version. */
export function papersToml(info: Pick<TemplateInfo, 'format' | 'engine' | 'root'>, bibliography?: string): string {
    if (info.format === 'typst') return `[environment]\nkind = "managed"\ntypst = "${TYPST_VERSION}"\n\n[[document]]\nroot = "${info.root}"\nengine = "typst"\n`;
    return `[environment]\nkind = "managed"\ntexlive = "${TEXLIVE_YEAR}"\n\n[[document]]\nroot = "${info.root}"\nengine = "${info.engine}"\n${bibliography ? `bibliography = "${bibliography}"\n` : ''}`;
}

export interface PlanOptions {
    /** Where in the repository the paper goes: `''` for its root. */
    readonly folder: string;
    /** The paper's title, replacing the template's `title` field. */
    readonly title?: string;
    /** The authors, joined as the template's `authors` field says. */
    readonly authors?: readonly string[];
}

export interface PlannedFile {
    readonly path: string;
    readonly bytes: Uint8Array;
}

/** The files to commit for a new paper from `t`: under `folder`, with the title and authors put in, without the
 *  template's own `template.toml` and gallery thumbnail, and with a `papers.toml` (the template's, or a new one) so the
 *  environment is declared. Returns the files and the root file's path in the repository. */
export function planFiles(t: Template, o: PlanOptions): { files: PlannedFile[]; root: string } {
    const folder = safeFolder(o.folder);
    if (folder === null) throw new TemplateError('The folder must be a path inside the repository');
    const prefix = folder === '' ? '' : `${folder}/`;
    const replace = (s: string): string => {
        let out = s;
        const title = t.info.fields['title'];
        if (title && o.title) out = out.replaceAll(title.text, escapeFor(t.info.format, o.title));
        const authors = t.info.fields['authors'];
        if (authors && o.authors?.length) out = out.replaceAll(authors.text, o.authors.map(a => escapeFor(t.info.format, a)).join(authors.join ?? ', '));
        return out;
    };
    const files: PlannedFile[] = [];
    for (const [path, bytes] of t.files) {
        if (path === 'template.toml' || path === 'thumbnail.png') continue;
        const s = asText(bytes);
        files.push({ path: `${prefix}${path}`, bytes: s === null || !/\.(tex|typ|bib|toml|md|txt|sty|cls)$/.test(path) ? bytes : enc.encode(replace(s)) });
    }
    if (!t.files.has('papers.toml')) {
        const bib = [...t.files.keys()].some(p => p.endsWith('.bib')) && t.info.format === 'latex' ? 'bibtex' : undefined;
        files.push({ path: `${prefix}papers.toml`, bytes: enc.encode(papersToml(t.info, bib)) });
    }
    return { files: files.toSorted((a, b) => a.path.localeCompare(b.path)), root: `${prefix}${t.info.root}` };
}

/** A title or a name as it may stand in the template's source: LaTeX's special characters escaped; Typst's markup
 *  characters escaped. */
export function escapeFor(format: Format, s: string): string {
    if (format === 'typst') return s.replace(/[\\#*_`$<>@[\]]/g, c => `\\${c}`);
    return s.replace(/[\\{}$&#^_%~]/g, c => (c === '\\' ? '\\textbackslash{}' : c === '~' ? '\\textasciitilde{}' : c === '^' ? '\\textasciicircum{}' : `\\${c}`));
}
