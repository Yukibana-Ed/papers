import { parse } from 'smol-toml';
import { safePath } from './paths.ts';

export type Format = 'latex' | 'typst';

/** Text in a template that the paper's own value replaces: the title, the authors. Plain text, no templating
 *  language: the template builds as it is, and replacing `text` everywhere it occurs makes it the user's. */
export interface Field {
    readonly text: string;
    /** How a list (authors) is joined in this template's language, e.g. ` \and `. */
    readonly join?: string;
}

/** What a template is, from its `template.toml` (or worked out from its files when it has none). */
export interface TemplateInfo {
    readonly name: string;
    readonly description: string;
    readonly category: string;
    readonly format: Format;
    /** `pdflatex`, `xelatex`, `lualatex` or `typst`. */
    readonly engine: string;
    /** The root file, relative to the template's folder. */
    readonly root: string;
    readonly licence: string;
    readonly fields: Readonly<Record<string, Field>>;
    readonly seeAlso: readonly { readonly name: string; readonly url: string }[];
}

/** A template ready to copy: what it is and its files (relative to its folder), bytes as they are. */
export interface Template {
    readonly info: TemplateInfo;
    readonly files: ReadonlyMap<string, Uint8Array>;
    /** Where it came from, for the first commit's message: `Yukibana-Ed/papers-templates/latex-article@<sha>`. */
    readonly origin: string;
}

/** An entry of the curated gallery's `index.json`. */
export interface GalleryEntry extends TemplateInfo {
    readonly id: string;
    readonly thumbnail: string;
    readonly files: readonly string[];
}

export class TemplateError extends Error {}

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'typst'];

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function text(x: unknown, what: string): string {
    if (typeof x !== 'string' || x === '') throw new TemplateError(`${what} must be a non-empty string`);
    return x;
}

function fieldsOf(x: unknown): Record<string, Field> {
    if (x === undefined) return {};
    if (!isRecord(x)) throw new TemplateError('fields must be a table');
    const out: Record<string, Field> = {};
    for (const [k, v] of Object.entries(x)) {
        if (!isRecord(v)) throw new TemplateError(`fields.${k} must be { text = "…" }`);
        const join = v['join'];
        out[k] = { text: text(v['text'], `fields.${k}.text`), ...(typeof join === 'string' ? { join } : {}) };
    }
    return out;
}

function seeAlsoOf(x: unknown): { name: string; url: string }[] {
    if (x === undefined) return [];
    if (!Array.isArray(x)) throw new TemplateError('see-also must be a list');
    return x.map((e: unknown, i) => {
        if (!isRecord(e)) throw new TemplateError(`see-also[${i}] must be a table`);
        const url = text(e['url'], `see-also[${i}].url`);
        if (!url.startsWith('https://')) throw new TemplateError(`see-also[${i}].url must be https`);
        return { name: text(e['name'], `see-also[${i}].name`), url };
    });
}

/** A manifest's fields, checked: from `template.toml` (TOML) or an `index.json` entry (already parsed). */
export function infoFrom(raw: Record<string, unknown>): TemplateInfo {
    const format = raw['format'];
    if (format !== 'latex' && format !== 'typst') throw new TemplateError('format must be "latex" or "typst"');
    const engine = text(raw['engine'], 'engine');
    if (!ENGINES.includes(engine)) throw new TemplateError(`engine must be one of ${ENGINES.join(', ')}`);
    const root = safePath(text(raw['root'], 'root'));
    if (root === null) throw new TemplateError('root must be a path inside the template');
    return {
        name: text(raw['name'], 'name'),
        description: typeof raw['description'] === 'string' ? raw['description'] : '',
        category: typeof raw['category'] === 'string' ? raw['category'] : 'paper',
        format,
        engine,
        root,
        licence: typeof raw['licence'] === 'string' ? raw['licence'] : 'unknown',
        fields: fieldsOf(raw['fields']),
        seeAlso: seeAlsoOf(raw['see-also'] ?? raw['seeAlso']),
    };
}

/** `template.toml`'s contents as a manifest. Throws `TemplateError` naming the problem. */
export function parseTemplateToml(source: string): TemplateInfo {
    let raw: unknown;
    try {
        raw = parse(source);
    } catch (e) {
        throw new TemplateError(`template.toml: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (!isRecord(raw)) throw new TemplateError('template.toml must be a table');
    return infoFrom(raw);
}

/** The curated gallery's `index.json`: every template's manifest, thumbnail and file list. Entries that do not check
 *  are left out rather than breaking the gallery. */
export function parseIndex(json: unknown): GalleryEntry[] {
    if (!isRecord(json) || json['version'] !== 1 || !Array.isArray(json['templates'])) throw new TemplateError('index.json: unsupported version');
    const out: GalleryEntry[] = [];
    for (const t of json['templates'] as unknown[]) {
        if (!isRecord(t)) continue;
        try {
            const id = safePath(text(t['id'], 'id'));
            const thumbnail = safePath(text(t['thumbnail'], 'thumbnail'));
            const files = t['files'];
            if (id === null || id.includes('/') || thumbnail === null || !Array.isArray(files)) continue;
            const paths = files.map((f: unknown) => (typeof f === 'string' ? safePath(f) : null));
            if (paths.some(p => p === null)) continue;
            out.push({ ...infoFrom(t), id, thumbnail, files: paths as string[] });
        } catch {
            // A broken entry is skipped; the others still show.
        }
    }
    return out;
}
