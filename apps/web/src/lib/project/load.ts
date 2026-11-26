import { GitHubError, blob, branchNames, repoInfo, tree } from '#lib/github/api.ts';
import { SignInNeeded, dropToken, githubToken } from '#lib/github/token.ts';
import { findRoots, includedFiles } from '#lib/model/tex.ts';

/** A repository's branch, read for editing: the files the editor and the compiler need, and nothing else. */
export interface LoadedProject {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly defaultBranch: string;
    readonly access: 'write' | 'comment';
    /** The head commit the files were read at. */
    readonly commit: string;
    /** Text files: path → text and blob SHA. */
    readonly texts: ReadonlyMap<string, { readonly text: string; readonly blob: string }>;
    /** Build inputs that are not text (images, fonts): path → bytes. */
    readonly assets: ReadonlyMap<string, Uint8Array>;
    /** Every file of the tree, for the file list. */
    readonly order: readonly string[];
    /** The text files and build inputs of the tree that were not read, each with why, as a clause to show. */
    readonly unread: ReadonlyMap<string, string>;
}

const TEXT = /\.(tex|ltx|sty|cls|bib|bst|bbx|cbx|dtx|ins|def|cfg|clo|typ|txt|md|csv|dat|tikz|pgf|latexmkrc|lua)$|(^|\/)(latexmkrc|\.latexmkrc|Makefile|papers\.toml)$/i;
const ASSET = /\.(png|jpe?g|pdf|eps|svg|gif|ttf|otf|woff2?)$/i;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_ASSET = 10 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

/** Why a project did not open: `signin` (the user must sign in again), `missing` (no such repository or branch, or
 *  no access to it), or `failed` (anything else); the message is fit to show. */
export class LoadError extends Error {
    readonly kind: 'signin' | 'missing' | 'failed';
    constructor(kind: 'signin' | 'missing' | 'failed', message: string) {
        super(message);
        this.kind = kind;
    }
}

/** Runs `f` over `items`, `n` at a time. */
async function pool<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                const item = items[i];
                if (item !== undefined) out[i] = await f(item);
            }
        }),
    );
    return out;
}

/** A GitHub call with the page's token, its failures as `LoadError`s. */
async function gh<T>(f: (token: string) => Promise<T>): Promise<T> {
    try {
        return await f(await githubToken());
    } catch (e) {
        if (e instanceof SignInNeeded) throw new LoadError('signin', 'Sign in');
        if (e instanceof GitHubError && e.status === 401) {
            dropToken();
            throw new LoadError('signin', 'Sign in');
        }
        if (e instanceof GitHubError && e.status === 404) throw new LoadError('missing', 'Not found');
        throw new LoadError('failed', e instanceof Error ? e.message : 'GitHub did not answer');
    }
}

/** Reads `branch` (or the default branch) of `owner/repo` from GitHub, from this page: one tree listing, then the
 *  text files and the build inputs, 24 at a time. Large repositories keep to the documents' folders: a file outside
 *  every document's folder is listed but not read. What was not read, and why, is in `unread`: nothing is left out
 *  silently. Throws a `LoadError` when GitHub cut the tree listing short. */
export async function loadProject(owner: string, repo: string, branch: string | null, onProgress: (done: number, total: number) => void): Promise<LoadedProject> {
    const info = await gh(token => repoInfo(token, owner, repo));
    const b = branch ?? info.defaultBranch;
    const t = await gh(token => tree(token, owner, repo, b));
    // GitHub lists at most 100,000 entries in one tree: a project that opened without the rest would look complete.
    if (t.truncated) throw new LoadError('failed', 'Too many files to open');
    const kinds = t.files.filter(f => TEXT.test(f.path) || ASSET.test(f.path));
    const unread = new Map<string, string>();
    const candidates = kinds.filter(f => {
        const max = TEXT.test(f.path) ? MAX_TEXT : MAX_ASSET;
        if (f.size > max) unread.set(f.path, `larger than ${max / (1024 * 1024)} MB`);
        return f.size <= max;
    });
    // Which folders hold documents: a `.tex` at the top of a folder with \documentclass is found after reading, so take
    // the folders of every .tex file first, and read everything under the shallowest of them.
    const texDirs = new Set(candidates.filter(f => f.path.endsWith('.tex')).map(f => f.path.split('/').slice(0, -1).join('/')));
    const roots = [...texDirs].filter(d => ![...texDirs].some(o => o !== d && (o === '' || d.startsWith(`${o}/`))));
    const inScope = (p: string): boolean => roots.some(d => d === '' || p.startsWith(`${d}/`));
    let total = 0;
    // Text before images, and small before large: when the project is over the limit, what is left out is what
    // matters least to a build, not whatever comes last by name.
    const byNeed = candidates.toSorted((x, y) => Number(ASSET.test(x.path) && !TEXT.test(x.path)) - Number(ASSET.test(y.path) && !TEXT.test(y.path)) || x.size - y.size);
    const wanted = byNeed.filter(f => {
        if (!inScope(f.path)) {
            unread.set(f.path, "outside the documents' folders");
            return false;
        }
        if (total + f.size > MAX_TOTAL) {
            unread.set(f.path, `the project is over ${MAX_TOTAL / (1024 * 1024)} MB`);
            return false;
        }
        total += f.size;
        return true;
    });
    let done = 0;
    onProgress(0, wanted.length);
    const fetched = await pool(wanted, 24, async f => {
        const r = await gh(token => blob(token, owner, repo, f.sha));
        const bytes = new Uint8Array(await r.arrayBuffer());
        onProgress(++done, wanted.length);
        return { f, bytes };
    });
    const texts = new Map<string, { text: string; blob: string }>();
    const assets = new Map<string, Uint8Array>();
    const dec = new TextDecoder('utf-8', { fatal: true });
    for (const { f, bytes } of fetched) {
        if (TEXT.test(f.path)) {
            try {
                texts.set(f.path, { text: dec.decode(bytes), blob: f.sha });
            } catch {
                assets.set(f.path, bytes);
            }
        } else assets.set(f.path, bytes);
    }
    const order = t.files.map(f => f.path).toSorted(sortPaths);
    return { owner, repo, branch: b, defaultBranch: info.defaultBranch, access: info.access, commit: t.commit, texts, assets, order, unread };
}

/** Files before folders' contents at each level, then by name: the order of the file list. */
export function sortPaths(a: string, b: string): number {
    const pa = a.split('/');
    const pb = b.split('/');
    for (let i = 0; ; i++) {
        const x = pa[i];
        const y = pb[i];
        if (x === undefined || y === undefined) return pa.length - pb.length;
        if (x !== y) {
            const xFile = i === pa.length - 1;
            const yFile = i === pb.length - 1;
            if (xFile !== yFile) return xFile ? -1 : 1;
            return x.localeCompare(y);
        }
    }
}

/** The documents of a loaded project, and the files the first one reads, for the tabs to open with. */
export function firstDocument(texts: ReadonlyMap<string, { text: string }>, order: readonly string[]): { roots: string[]; files: string[] } {
    const files = Object.fromEntries([...texts].map(([p, v]) => [p, v.text]));
    const roots = findRoots(files, order);
    const first = roots[0];
    return { roots, files: first ? includedFiles(first, files) : [] };
}

/** `rest` (what follows `/p/<owner>/<repo>/` in an address: a branch, then maybe a file in it) split by `branches`:
 *  the longest branch that `rest` is, or starts with followed by `/`; the rest is the file, or null. With no such branch,
 *  the first segment is taken for the branch (and the load then says it is missing). */
export function splitRef(rest: string, branches: readonly string[]): { branch: string; path: string | null } {
    const clean = rest.replace(/^\/+|\/+$/g, '');
    let best: string | null = null;
    for (const b of branches) if ((clean === b || clean.startsWith(`${b}/`)) && (best === null || b.length > best.length)) best = b;
    const branch = best ?? clean.split('/')[0] ?? '';
    const path = clean.length > branch.length ? clean.slice(branch.length + 1) : null;
    return { branch, path: path === '' ? null : path };
}

/** `rest` split against `owner/repo`'s branches, read from GitHub (only when it has a slash: a lone segment is a branch). */
export async function resolveRef(owner: string, repo: string, rest: string): Promise<{ branch: string; path: string | null }> {
    if (!rest.includes('/')) return { branch: rest, path: null };
    const names = await gh(token => branchNames(token, owner, repo));
    return splitRef(rest, names);
}
