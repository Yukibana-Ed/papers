import { ASSETS } from '#lib/asset-path.ts';
import type { Diagnostic, FileContents } from '@yukibana/papers-frame-protocol';
import type { TypstCompiler, TypstWorld } from '@myriaddreamin/typst.ts/compiler';
import { FetchPackageRegistry, MemoryAccessModel, createTypstCompiler, initOptions } from '@myriaddreamin/typst.ts';
import { TYPST_ASSETS } from '#lib/typst-assets.ts';
import { readSpans, type GlyphSpans } from '#lib/typst-spans.ts';

/** A Typst package a build used, for papers.lock: its spec and the SHA-256 of its archive. */
export interface UsedPackage {
    readonly namespace: string;
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
}

export interface TypstBuild {
    readonly ok: boolean;
    readonly pdf: Uint8Array | null;
    readonly diagnostics: Diagnostic[];
    /** Where each glyph of `pdf` came from in `files`, by project path; null without a document, or when the compiler
     *  gave none (the document is then synced by its words). */
    readonly spans: GlyphSpans | null;
    readonly ms: number;
    /** Set when the compiler itself could not start (its files did not load): not a problem with the document. */
    readonly failure?: string;
}

/** Packages come from the content origin (`/typst-packages/...`), which reads them through from Typst Universe once and
 *  keeps them: the frame makes no request to another site. The archive bytes are kept to hash them for the lock. */
class OriginPackageRegistry extends FetchPackageRegistry {
    readonly archives = new Map<string, Uint8Array>();

    override resolvePath(spec: { namespace: string; name: string; version: string }): string {
        return `${location.origin}${ASSETS}/typst-packages/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;
    }

    override pullPackageData(spec: { namespace: string; name: string; version: string }): Uint8Array | undefined {
        const data = super.pullPackageData(spec);
        if (data !== undefined) this.archives.set(`${spec.namespace}/${spec.name}/${spec.version}`, data);
        return data;
    }
}

/** A `l:c-l:c` range's first line, 1-based (typst.ts reports 0-based lines in the `long` format). */
export function rangeLine(range: string): number {
    const m = /^(\d+):(\d+)/.exec(range);
    return m ? Number(m[1]) + 1 : 1;
}

/** Typst in the frame: typst.ts's web compiler with Typst's default text fonts from the content origin, packages from
 *  the origin's cache, and the project's files as an in-memory world. One compiler for the frame's lifetime; the files
 *  are replaced before each build, so a build sees exactly the project's current files. */
export class TypstEngine {
    #compiler: Promise<TypstCompiler> | null = null;
    // The registry unpacks packages into this access model, which the compiler reads them from.
    readonly #access = new MemoryAccessModel();
    readonly #registry = new OriginPackageRegistry(this.#access);

    #init(): Promise<TypstCompiler> {
        this.#compiler ??= (async () => {
            const c = createTypstCompiler();
            const fonts = TYPST_ASSETS.fonts.files.map(f => `${TYPST_ASSETS.fonts.path}${f}`);
            await c.init({
                getModule: () => `${TYPST_ASSETS.compiler.path}typst_ts_web_compiler_bg.wasm`,
                beforeBuild: [addFonts(fonts), initOptions.withAccessModel(this.#access), initOptions.withPackageRegistry(this.#registry)],
            });
            return c;
        })();
        // A failed start is retried on the next build.
        this.#compiler.catch(() => {
            this.#compiler = null;
        });
        return this.#compiler;
    }

    /** Builds `root` from `files` to PDF. Diagnostics name project files by their project paths. */
    async build(files: ReadonlyMap<string, FileContents>, root: string): Promise<TypstBuild> {
        let c: TypstCompiler;
        try {
            c = await this.#init();
        } catch (e) {
            return { ok: false, pdf: null, diagnostics: [], spans: null, ms: 0, failure: e instanceof Error ? e.message : String(e) };
        }
        const t0 = performance.now();
        c.resetShadow();
        for (const [path, contents] of files) {
            if (typeof contents === 'string') c.addSource(`/${path}`, contents);
            else c.mapShadow(`/${path}`, contents);
        }
        const { r, spans } = await c.runWithWorld({ mainFilePath: `/${root}` }, async world => {
            const made = await world.pdf({ diagnostics: 'full' });
            return { r: made, spans: made.result instanceof Uint8Array ? glyphSpans(world) : null };
        });
        const diagnostics: Diagnostic[] = (r.diagnostics ?? []).map(d => ({
            file: d.path.replace(/^\//, '') || root,
            line: rangeLine(d.range),
            severity: d.severity.toLowerCase() === 'warning' ? 'warning' : 'error',
            message: d.message,
        }));
        const pdf = r.result instanceof Uint8Array ? r.result : null;
        return { ok: pdf !== null && !diagnostics.some(d => d.severity === 'error'), pdf, diagnostics, spans: pdf === null ? null : spans, ms: performance.now() - t0 };
    }

    /** The packages builds have used so far, hashed, for the lock file. */
    async packages(): Promise<UsedPackage[]> {
        const out: UsedPackage[] = [];
        for (const [id, bytes] of this.#registry.archives) {
            const [namespace = '', name = '', version = ''] = id.split('/');
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
            out.push({ namespace, name, version, sha256: [...digest].map(b => b.toString(16).padStart(2, '0')).join('') });
        }
        return out;
    }
}

const hasGlyphSpans = (v: unknown): v is { glyph_spans(): unknown } => typeof v === 'object' && v !== null && 'glyph_spans' in v && typeof v.glyph_spans === 'function';

/** The glyph spans of the document `world` has compiled, files by project path; null when the compiler has none to
 *  give. `glyph_spans` is our build's addition (packages/typst-wasm), on the compiler's own world object, which
 *  typst.ts keeps under a symbol of its wrapper. */
function glyphSpans(world: TypstWorld): GlyphSpans | null {
    for (const key of Object.getOwnPropertySymbols(world)) {
        const raw: unknown = Reflect.get(world, key);
        if (!hasGlyphSpans(raw)) continue;
        const out = raw.glyph_spans();
        if (typeof out !== 'object' || out === null || !('files' in out) || !('pages' in out) || !Array.isArray(out.files) || !Array.isArray(out.pages)) return null;
        const files = out.files.filter((f): f is string => typeof f === 'string').map(f => f.replace(/^\//, ''));
        const pages = out.pages.filter((p): p is Uint8Array => p instanceof Uint8Array);
        return files.length === out.files.length && pages.length === out.pages.length ? readSpans({ files, pages }) : null;
    }
    return null;
}

/** A build step that adds the fonts at `urls` to the compiler, fetched in parallel. In place of typst.ts's `loadFonts`,
 *  which builds a function from text (`new Function`, for a Node import it never needs here) and so would need the
 *  content origin's script policy to allow 'unsafe-eval'. The compiler's own functions from text are made without it
 *  in our build of it (packages/typst-wasm, glue-csp.patch). */
function addFonts(urls: readonly string[]): (_: unknown, ctx: { builder: { add_raw_font(font: Uint8Array): Promise<void> } }) => Promise<void> {
    const step = async (_: unknown, { builder }: { builder: { add_raw_font(font: Uint8Array): Promise<void> } }): Promise<void> => {
        const fonts = await Promise.all(
            urls.map(async url => {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
                return new Uint8Array(await res.arrayBuffer());
            }),
        );
        for (const font of fonts) await builder.add_raw_font(font);
    };
    // The marks typst.ts looks for: this is the font loader, and the default font assets are not wanted (otherwise it
    // adds its own loader, the one this replaces).
    return Object.assign(step, { _kind: 'fontLoader', _preloadRemoteFontOptions: { assets: false } });
}
