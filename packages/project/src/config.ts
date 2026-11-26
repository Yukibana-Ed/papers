import { parse } from 'smol-toml';

/** The engines a document can be built with. */
export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const;
export type Engine = (typeof ENGINES)[number];

export type BibliographyTool = 'bibtex' | 'biber' | 'none';
export type IndexTool = 'makeindex' | 'xindy' | 'upmendex' | 'none';

/** Where the TeX toolchain comes from.
 *
 *  - `managed`: TeX Live from Yukibana's content-addressed store, the year (and, once locked, the snapshot) the
 *    project names. The default, and the only kind that is reproducible without anything else installed.
 *  - `system`: whatever TeX is on the user's PATH. Explicit only, never guessed: builds are then not reproducible.
 *  - `nix`: a flake output that provides the toolchain (`flake`), e.g. `github:org/repo#paper`.
 *  - `oci`: a container image, pinned by digest (`image`), e.g. `ghcr.io/org/tex@sha256:…`. */
export type Environment =
    | { readonly kind: 'managed'; readonly texlive: string; readonly packages: readonly string[] }
    | { readonly kind: 'system' }
    | { readonly kind: 'nix'; readonly flake: string }
    | { readonly kind: 'oci'; readonly image: string };

/** How one document builds. Fields left out of `papers.toml` are worked out from the source. */
export interface DocumentConfig {
    /** The root file, relative to the project folder, with `/`. */
    readonly root: string;
    readonly engine?: Engine;
    readonly bibliography?: BibliographyTool;
    readonly index?: IndexTool;
    /** `\write18` for programs TeX Live does not list as safe. Off unless the project turns it on. */
    readonly shellEscape: boolean;
}

/** `papers.toml`, at the project's root: the project's explicit declaration of how it builds. */
export interface PapersConfig {
    readonly environment: Environment;
    readonly documents: readonly DocumentConfig[];
}

/** The TeX Live year a project without a declaration builds with. */
export const DEFAULT_TEXLIVE = '2026';

export const DEFAULT_CONFIG: PapersConfig = { environment: { kind: 'managed', texlive: DEFAULT_TEXLIVE, packages: [] }, documents: [] };

/** A problem with `papers.toml`: where (a dotted key) and what. */
export class ConfigError extends Error {
    constructor(
        readonly key: string,
        message: string,
    ) {
        super(`papers.toml: ${key}: ${message}`);
    }
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function str(table: Record<string, unknown>, key: string, where: string): string | undefined {
    const v = table[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v === '') throw new ConfigError(`${where}${key}`, 'must be a non-empty string');
    return v;
}

function oneOf<T extends string>(table: Record<string, unknown>, key: string, where: string, values: readonly T[]): T | undefined {
    const v = str(table, key, where);
    if (v === undefined) return undefined;
    const found = values.find(x => x === v);
    if (found === undefined) throw new ConfigError(`${where}${key}`, `must be one of ${values.join(', ')}`);
    return found;
}

/** A project-relative path as given in the file: no `..`, no absolute path, `/` separators. */
function relPath(p: string, key: string): string {
    const n = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) throw new ConfigError(key, 'must be a path inside the project');
    return n;
}

/** The declaration in `text` (the contents of `papers.toml`).
 *
 *  ```toml
 *  [environment]
 *  kind = "managed"          # managed (default) | system | nix | oci
 *  texlive = "2026"          # managed: the TeX Live year
 *  packages = ["biblatex"]   # managed: packages beyond what the documents are found to use
 *  # flake = "github:org/repo#paper"        (nix)
 *  # image = "ghcr.io/org/tex@sha256:…"      (oci)
 *
 *  [[document]]
 *  root = "paper.tex"
 *  engine = "pdflatex"       # pdflatex | xelatex | lualatex; else worked out from the source
 *  bibliography = "biber"    # bibtex | biber | none; else worked out
 *  index = "makeindex"       # makeindex | xindy | upmendex | none; else worked out
 *  shell-escape = false
 *  ```
 *
 *  Throws `ConfigError` for anything malformed, unknown kinds and engines included, rather than guessing. Unknown keys
 *  are errors too, so a typo cannot silently change a build. */
export function parseConfig(text: string): PapersConfig {
    let raw: unknown;
    try {
        raw = parse(text);
    } catch (e) {
        throw new ConfigError('(file)', e instanceof Error ? e.message : String(e));
    }
    if (!isRecord(raw)) throw new ConfigError('(file)', 'must be a table');
    for (const k of Object.keys(raw)) if (k !== 'environment' && k !== 'document') throw new ConfigError(k, 'unknown key');

    let environment: Environment = DEFAULT_CONFIG.environment;
    const env = raw['environment'];
    if (env !== undefined) {
        if (!isRecord(env)) throw new ConfigError('environment', 'must be a table');
        const allowed: Record<string, readonly string[]> = { managed: ['kind', 'texlive', 'packages'], system: ['kind'], nix: ['kind', 'flake'], oci: ['kind', 'image'] };
        const kind = oneOf(env, 'kind', 'environment.', ['managed', 'system', 'nix', 'oci'] as const) ?? 'managed';
        for (const k of Object.keys(env)) if (!(allowed[kind] ?? []).includes(k)) throw new ConfigError(`environment.${k}`, `not allowed for kind = "${kind}"`);
        if (kind === 'managed') {
            const texlive = str(env, 'texlive', 'environment.') ?? DEFAULT_TEXLIVE;
            if (!/^20\d\d$/.test(texlive)) throw new ConfigError('environment.texlive', 'must be a TeX Live year, such as "2026"');
            const pk = env['packages'] ?? [];
            if (!Array.isArray(pk) || !pk.every((p): p is string => typeof p === 'string' && /^[A-Za-z0-9._-]+$/.test(p)))
                throw new ConfigError('environment.packages', 'must be a list of TeX Live package names');
            environment = { kind, texlive, packages: pk };
        } else if (kind === 'system') environment = { kind };
        else if (kind === 'nix') {
            const flake = str(env, 'flake', 'environment.');
            if (flake === undefined) throw new ConfigError('environment.flake', 'is required for kind = "nix"');
            environment = { kind, flake };
        } else {
            const image = str(env, 'image', 'environment.');
            if (image === undefined || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new ConfigError('environment.image', 'must be an image pinned by digest (…@sha256:…)');
            environment = { kind, image };
        }
    }

    const docs = raw['document'] ?? [];
    if (!Array.isArray(docs)) throw new ConfigError('document', 'must be an array of tables ([[document]])');
    const documents = docs.map((d: unknown, i): DocumentConfig => {
        const at = `document[${i}].`;
        if (!isRecord(d)) throw new ConfigError(`document[${i}]`, 'must be a table');
        for (const k of Object.keys(d)) if (!['root', 'engine', 'bibliography', 'index', 'shell-escape'].includes(k)) throw new ConfigError(`${at}${k}`, 'unknown key');
        const root = str(d, 'root', at);
        if (root === undefined) throw new ConfigError(`${at}root`, 'is required');
        const se = d['shell-escape'] ?? false;
        if (typeof se !== 'boolean') throw new ConfigError(`${at}shell-escape`, 'must be true or false');
        const engine = oneOf(d, 'engine', at, ENGINES);
        const bibliography = oneOf(d, 'bibliography', at, ['bibtex', 'biber', 'none'] as const);
        const index = oneOf(d, 'index', at, ['makeindex', 'xindy', 'upmendex', 'none'] as const);
        const doc: { -readonly [K in keyof DocumentConfig]: DocumentConfig[K] } = { root: relPath(root, `${at}root`), shellEscape: se };
        if (engine) doc.engine = engine;
        if (bibliography) doc.bibliography = bibliography;
        if (index) doc.index = index;
        return doc;
    });
    return { environment, documents };
}

/** `papers.lock`: what `managed` resolved to, so every machine builds with the same files.
 *
 *  `snapshot` names one immutable snapshot of the TeX Live store (the sha256 of its index); a later snapshot of the
 *  same year only adds objects. JSON, written by the tools, never by hand. */
export interface PapersLock {
    readonly version: 1;
    readonly texlive: { readonly year: string; readonly snapshot: string };
}

/** The lock in `text`, or a thrown error naming what is wrong. */
export function parseLock(text: string): PapersLock {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw['version'] !== 1) throw new Error('papers.lock: unsupported version');
    const tl = raw['texlive'];
    if (!isRecord(tl) || typeof tl['year'] !== 'string' || typeof tl['snapshot'] !== 'string' || !/^[0-9a-f]{64}$/.test(tl['snapshot']))
        throw new Error('papers.lock: texlive must have a year and a sha256 snapshot');
    return { version: 1, texlive: { year: tl['year'], snapshot: tl['snapshot'] } };
}

export function formatLock(lock: PapersLock): string {
    return `${JSON.stringify(lock, null, 2)}\n`;
}
