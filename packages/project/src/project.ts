import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
    ConfigError,
    DEFAULT_CONFIG,
    parseConfig,
    parseLock,
    type BibliographyTool,
    type DocumentConfig,
    type Engine,
    type Environment,
    type IndexTool,
    type PapersConfig,
    type PapersLock,
} from './config.ts';
import { graphicsPaths, guessBibliography, guessEngine, guessIndex, isRoot, references } from './source.ts';

/** A project's files, read-only: paths relative to the project's root, with `/`. */
export interface ProjectFiles {
    /** Every file, sorted. */
    list(): readonly string[];
    /** A text file's contents, or null if there is no such file. */
    read(path: string): string | null;
}

/** Folders that are never part of a project's sources. */
const SKIP = new Set(['.git', 'node_modules', '.papers', '.svelte-kit', '.wrangler']);

/** The files under `dir`, skipping version control and tool folders. Reads lazily; a file read is cached. */
export function folderFiles(dir: string): ProjectFiles {
    const out: string[] = [];
    const walk = (rel: string): void => {
        for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
            if (SKIP.has(e.name)) continue;
            const p = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) out.push(p);
        }
    };
    walk('');
    const sorted = out.toSorted();
    const cache = new Map<string, string | null>();
    return {
        list: () => sorted,
        read(path) {
            if (!cache.has(path)) {
                let text: string | null = null;
                try {
                    if (statSync(join(dir, path)).isFile()) text = readFileSync(join(dir, path), 'utf8');
                } catch {
                    text = null;
                }
                cache.set(path, text);
            }
            return cache.get(path) ?? null;
        },
    };
}

/** Files held in memory (a test, or what the web app sent). */
export function memoryFiles(files: Readonly<Record<string, string>>): ProjectFiles {
    const list = Object.keys(files).toSorted();
    return { list: () => list, read: p => files[p] ?? null };
}

/** One document of the project, with every choice made: what the declaration says, the rest worked out. */
export interface ProjectDocument {
    readonly root: string;
    readonly engine: Engine;
    readonly bibliography: BibliographyTool;
    readonly index: IndexTool;
    readonly shellEscape: boolean;
    /** The project files the document reads, root first; each once. */
    readonly inputs: readonly string[];
    /** Files the document names that the project does not have (a typo, or a generated file). */
    readonly missing: readonly string[];
}

export interface Project {
    readonly files: ProjectFiles;
    readonly config: PapersConfig;
    /** Whether `config` came from a `papers.toml`; otherwise it is the default. */
    readonly declared: boolean;
    readonly lock: PapersLock | null;
    readonly environment: Environment;
    /** The project's latexmkrc (`latexmkrc` or `.latexmkrc` at the root), if it has one. */
    readonly latexmkrc: string | null;
    readonly documents: readonly ProjectDocument[];
}

const GRAPHIC_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'];

/** The project file a reference names, as TeX would find it from `base` (the root's folder), or null. */
function resolve(files: ProjectFiles, base: string, kind: 'tex' | 'bib' | 'graphic', name: string, gpaths: readonly string[]): string | null {
    const has = (p: string): boolean => files.read(p) !== null || files.list().includes(p);
    const dirs = kind === 'graphic' ? ['', ...gpaths] : [''];
    const exts = kind === 'tex' ? ['', '.tex'] : kind === 'bib' ? (name.endsWith('.bib') ? [''] : ['.bib']) : ['', ...GRAPHIC_EXTENSIONS];
    for (const d of dirs)
        for (const e of exts) {
            const p = posix.normalize(posix.join(base, d, name + e));
            if (!p.startsWith('..') && has(p)) return p;
        }
    return null;
}

/** The documents of `files` with `config` applied: every document the declaration names, or, without one, every
 *  root file found. */
export function resolveDocuments(files: ProjectFiles, config: PapersConfig): ProjectDocument[] {
    const declared =
        config.documents.length > 0
            ? config.documents
            : files
                  .list()
                  .filter(f => f.endsWith('.tex') && isRoot(files.read(f) ?? ''))
                  .map((root): DocumentConfig => ({ root, shellEscape: false }));
    return declared.map(d => {
        const base = posix.dirname(d.root) === '.' ? '' : posix.dirname(d.root);
        const inputs: string[] = [];
        const missing: string[] = [];
        const rootSource = files.read(d.root) ?? '';
        const gpaths = graphicsPaths(rootSource);
        const visit = (file: string): void => {
            if (inputs.includes(file)) return;
            inputs.push(file);
            if (!file.endsWith('.tex')) return;
            for (const r of references(files.read(file) ?? '')) {
                const p = resolve(files, base, r.kind, r.name, gpaths);
                if (p === null) {
                    if (!missing.includes(r.name)) missing.push(r.name);
                } else visit(p);
            }
        };
        if (files.read(d.root) === null) missing.push(d.root);
        else visit(d.root);
        const sources = inputs.filter(f => f.endsWith('.tex')).map(f => files.read(f) ?? '');
        return {
            root: d.root,
            engine: d.engine ?? guessEngine(sources),
            bibliography: d.bibliography ?? guessBibliography(sources),
            index: d.index ?? guessIndex(sources),
            shellEscape: d.shellEscape,
            inputs,
            missing,
        };
    });
}

/** The project in `files`: its declaration (`papers.toml`, else the default), its lock, and its documents.
 *  Throws `ConfigError` when `papers.toml` is malformed, and an error when `papers.lock` is. */
export function readProject(files: ProjectFiles): Project {
    const toml = files.read('papers.toml');
    const config = toml === null ? DEFAULT_CONFIG : parseConfig(toml);
    const lockText = files.read('papers.lock');
    const lock = lockText === null ? null : parseLock(lockText);
    if (lock && config.environment.kind === 'managed' && lock.texlive.year !== config.environment.texlive)
        throw new ConfigError('environment.texlive', `is ${config.environment.texlive} but papers.lock pins ${lock.texlive.year}`);
    return {
        files,
        config,
        declared: toml !== null,
        lock,
        environment: config.environment,
        latexmkrc: files.read('latexmkrc') ?? files.read('.latexmkrc'),
        documents: resolveDocuments(files, config),
    };
}

/** `readProject` of a folder on disk. */
export function openProject(dir: string): Project {
    return readProject(folderFiles(dir));
}
