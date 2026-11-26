import { GitHubError, blob, repoInfo, tree } from '#lib/github/api.ts';
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
}

const TEXT = /\.(tex|ltx|sty|cls|bib|bst|bbx|cbx|dtx|ins|def|cfg|clo|typ|txt|md|csv|dat|tikz|pgf|latexmkrc|lua)$|(^|\/)(latexmkrc|\.latexmkrc|Makefile|papers\.toml)$/i;
const ASSET = /\.(png|jpe?g|pdf|eps|svg|gif|ttf|otf|woff2?)$/i;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_ASSET = 10 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

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
 *  every document's folder is listed but not read. */
export async function loadProject(owner: string, repo: string, branch: string | null, onProgress: (done: number, total: number) => void): Promise<LoadedProject> {
    const info = await gh(token => repoInfo(token, owner, repo));
    const b = branch ?? info.defaultBranch;
    const t = await gh(token => tree(token, owner, repo, b));
    const candidates = t.files.filter(f => (TEXT.test(f.path) && f.size <= MAX_TEXT) || (ASSET.test(f.path) && f.size <= MAX_ASSET));
    // Which folders hold documents: a `.tex` at the top of a folder with \documentclass is found after reading, so take
    // the folders of every .tex file first, and read everything under the shallowest of them.
    const texDirs = new Set(candidates.filter(f => f.path.endsWith('.tex')).map(f => f.path.split('/').slice(0, -1).join('/')));
    const roots = [...texDirs].filter(d => ![...texDirs].some(o => o !== d && (o === '' || d.startsWith(`${o}/`))));
    const inScope = (p: string): boolean => roots.some(d => d === '' || p.startsWith(`${d}/`));
    let total = 0;
    const wanted = candidates.filter(f => {
        if (!inScope(f.path) || total + f.size > MAX_TOTAL) return false;
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
    return { owner, repo, branch: b, defaultBranch: info.defaultBranch, access: info.access, commit: t.commit, texts, assets, order };
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
