/** The GitHub calls of the app, with a user's short-lived access token. The page makes them directly against
 *  api.github.com (our servers are not on the data path); the Worker makes only `viewer`, `repoInfo` and `branchHead`,
 *  once, to check who joins which room. Every function takes the token as an argument and keeps nothing. Those three
 *  take the API's address too, for the browser tests' stand-in GitHub (`githubApi` in server/auth.ts). */

const API = 'https://api.github.com';
const UA = 'yukibana-papers';

/** A GitHub answer that was not a success, with its HTTP status (400 for a repository name refused before asking). */
export class GitHubError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function headers(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: accept, 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' };
}

/** How many times a GitHub call is made at most, and the longest wait between two that is worth making. */
const ATTEMPTS = 3;
const MAX_WAIT_MS = 20_000;

/** How long to wait before trying `r` again (the `attempt`th try failed, from 0), or null when it is not worth it.
 *  GitHub's rate limits (429, or 403 with `Retry-After` or no requests left) say when: that is honoured, unless it is
 *  longer than `MAX_WAIT_MS`. A 502/503/504 of an idempotent `method` waits 0.5 s, then 1 s, each jittered down by up
 *  to half. Anything else is the answer. */
export function retryDelay(r: Response, method: string, attempt: number, now = Date.now()): number | null {
    const after = r.headers.get('Retry-After');
    const left = r.headers.get('X-RateLimit-Remaining');
    const reset = r.headers.get('X-RateLimit-Reset');
    const limited = r.status === 429 || (r.status === 403 && (after !== null || left === '0'));
    if (limited) {
        const wait = after !== null && /^\d+$/.test(after) ? Number(after) * 1000 : reset !== null && /^\d+$/.test(reset) ? Number(reset) * 1000 - now : 1000 * 2 ** attempt;
        return wait <= MAX_WAIT_MS ? Math.max(0, wait) : null;
    }
    if ((r.status === 502 || r.status === 503 || r.status === 504) && (method === 'GET' || method === 'HEAD')) return 500 * 2 ** attempt * (0.5 + Math.random() / 2);
    return null;
}

/** `fetch`, tried again up to `ATTEMPTS` times in all as `retryDelay` says, and once more after a network failure of
 *  an idempotent request. Returns the last response; throws the network error when every try failed that way. A
 *  rate-limited request was not carried out, so trying it again is safe whatever its method. */
export async function githubFetch(url: string, init: RequestInit = {}, sleep: (ms: number) => Promise<void> = ms => new Promise(res => setTimeout(res, ms))): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    for (let attempt = 0; ; attempt++) {
        let r: Response;
        try {
            r = await fetch(url, init);
        } catch (e) {
            if (attempt + 1 >= ATTEMPTS || (method !== 'GET' && method !== 'HEAD')) throw e;
            await sleep(500 * 2 ** attempt * (0.5 + Math.random() / 2));
            continue;
        }
        const wait = attempt + 1 < ATTEMPTS ? retryDelay(r, method, attempt) : null;
        if (wait === null) return r;
        await sleep(wait);
    }
}

async function json<T>(r: Response): Promise<T> {
    if (!r.ok) throw new GitHubError(r.status, `GitHub answered ${r.status}`);
    return (await r.json()) as T;
}

/** Path segments of a repository, checked: GitHub's owner and repository name characters only. */
export function repoPath(owner: string, repo: string): string {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') throw new GitHubError(400, 'Invalid repository');
    return `${owner}/${repo}`;
}

export interface Viewer {
    readonly login: string;
    readonly name: string;
    readonly avatar: string;
}

/** The signed-in user of `token`: login, display name (the login when none is set) and avatar URL. Throws a
 *  `GitHubError` for any answer but a success. */
export async function viewer(token: string, api = API): Promise<Viewer> {
    const u = await json<{ login: string; name: string | null; avatar_url: string }>(await githubFetch(`${api}/user`, { headers: headers(token) }));
    return { login: u.login, name: u.name ?? u.login, avatar: u.avatar_url };
}

/** What the user may do in a repository, from their GitHub permission: write (push and above) or comment (read). */
export type Access = 'write' | 'comment';

export interface RepoInfo {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly private: boolean;
    readonly access: Access;
}

/** The repository as the user sees it. The one place access is derived: change it here and nowhere else. */
export async function repoInfo(token: string, owner: string, repo: string, api = API): Promise<RepoInfo> {
    const r = await json<{ full_name: string; default_branch: string; private: boolean; permissions?: { push?: boolean; pull?: boolean } }>(
        await githubFetch(`${api}/repos/${repoPath(owner, repo)}`, { headers: headers(token) }),
    );
    if (!r.permissions?.pull) throw new GitHubError(404, 'Not found');
    return { fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, access: r.permissions.push ? 'write' : 'comment' };
}

/** The head commit of `branch`. Throws a GitHubError 404 when the repository has no branch of exactly that name (a
 *  branch whose name only starts with it does not count). */
export async function branchHead(token: string, owner: string, repo: string, branch: string, api = API): Promise<string> {
    const name = branch.split('/').map(encodeURIComponent).join('/');
    const r = await json<{ ref?: unknown; object?: { sha?: unknown } }>(await fetch(`${api}/repos/${repoPath(owner, repo)}/git/ref/heads/${name}`, { headers: headers(token) }));
    if (r.ref !== `refs/heads/${branch}` || typeof r.object?.sha !== 'string') throw new GitHubError(404, 'No such branch');
    return r.object.sha;
}

/** The names of `owner/repo`'s branches (the first 300). */
export async function branchNames(token: string, owner: string, repo: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 3; page++) {
        const list = await json<{ name: string }[]>(await githubFetch(`${API}/repos/${repoPath(owner, repo)}/branches?per_page=100&page=${page}`, { headers: headers(token) }));
        out.push(...list.map(b => b.name));
        if (list.length < 100) break;
    }
    return out;
}

/** How `head` stands to `base` in `owner/repo`'s history: `ahead` when it has commits on top of `base` and lacks
 *  none of its, `behind` the other way round, `diverged` when each has commits the other lacks (a rewritten branch). */
export async function compare(token: string, owner: string, repo: string, base: string, head: string): Promise<'ahead' | 'behind' | 'identical' | 'diverged'> {
    if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) throw new GitHubError(400, 'Invalid commit');
    const r = await json<{ status: 'ahead' | 'behind' | 'identical' | 'diverged' }>(
        await githubFetch(`${API}/repos/${repoPath(owner, repo)}/compare/${base}...${head}?per_page=1`, { headers: headers(token) }),
    );
    return r.status;
}

export interface TreeEntry {
    readonly path: string;
    readonly sha: string;
    readonly size: number;
}

/** The head commit of `branch` and the files of its tree, recursively, in one call. `truncated` when GitHub cut the
 *  list (above 100 000 entries or 7 MB): the caller then lists the document's folder instead. */
export async function tree(token: string, owner: string, repo: string, branch: string): Promise<{ commit: string; files: TreeEntry[]; truncated: boolean }> {
    const p = repoPath(owner, repo);
    const ref = await json<{ object: { sha: string } }>(await githubFetch(`${API}/repos/${p}/git/ref/heads/${encodeURIComponent(branch)}`, { headers: headers(token) }));
    const head = ref.object.sha;
    const c = await json<{ tree: { sha: string } }>(await githubFetch(`${API}/repos/${p}/git/commits/${head}`, { headers: headers(token) }));
    const t = await json<{ tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean }>(
        await githubFetch(`${API}/repos/${p}/git/trees/${c.tree.sha}?recursive=1`, { headers: headers(token) }),
    );
    return { commit: head, truncated: t.truncated, files: t.tree.filter(e => e.type === 'blob').map(e => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })) };
}

/** A blob's bytes. Blobs are immutable, so callers may cache them by `sha` forever. */
export async function blob(token: string, owner: string, repo: string, sha: string): Promise<Response> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError(400, 'Invalid blob');
    const r = await githubFetch(`${API}/repos/${repoPath(owner, repo)}/git/blobs/${sha}`, { headers: headers(token, 'application/vnd.github.raw') });
    if (!r.ok) throw new GitHubError(r.status, `GitHub answered ${r.status}`);
    return r;
}

/** A `Co-authored-by` trailer for GitHub user `login` (`name` shown), with the noreply address GitHub links to the
 *  account: `<id>+<login>@users.noreply.github.com`, the id read from GitHub. Without the id (the lookup failed) the
 *  older `<login>@users.noreply.github.com`, which GitHub still links for most accounts. */
export async function coAuthorTrailer(token: string, login: string, name: string, api = API): Promise<string> {
    let email = `${login}@users.noreply.github.com`;
    try {
        const r = await githubFetch(`${api}/users/${encodeURIComponent(login)}`, { headers: headers(token) });
        if (r.ok) {
            const id: unknown = Reflect.get((await r.json()) as object, 'id');
            if (typeof id === 'number' && Number.isInteger(id)) email = `${id}+${login}@users.noreply.github.com`;
        }
    } catch {
        // The older address still credits most accounts.
    }
    return `Co-authored-by: ${name.replace(/[<>\n]/g, '')} <${email}>`;
}

export interface FileChange {
    readonly path: string;
    /** The new text; null deletes the file (unless `bytes` is given). */
    readonly text: string | null;
    /** The new contents as bytes (images, fonts): used instead of `text` when given. */
    readonly bytes?: Uint8Array;
}

function base64(text: string): string {
    return base64Bytes(new TextEncoder().encode(text));
}

function base64Bytes(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** Commits `changes` on `branch` as the user, if the branch is still at `expectedHead` (GitHub refuses otherwise:
 *  someone pushed meanwhile, and the room merges that first). GraphQL `createCommitOnBranch`: one call, signed by
 *  GitHub as the user. Text and binary files (base64; checked byte for byte), at most 45 MB per call.
 *  Returns the new commit's SHA. */
export async function commit(token: string, owner: string, repo: string, branch: string, expectedHead: string, message: string, changes: readonly FileChange[]): Promise<string> {
    const query = `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`;
    const input = {
        branch: { repositoryNameWithOwner: repoPath(owner, repo), branchName: branch },
        expectedHeadOid: expectedHead,
        message: { headline: message.split('\n')[0] ?? message, body: message.split('\n').slice(1).join('\n').trim() || undefined },
        fileChanges: {
            additions: changes.filter(c => c.text !== null || c.bytes).map(c => ({ path: c.path, contents: c.bytes ? base64Bytes(c.bytes) : base64(c.text ?? '') })),
            deletions: changes.filter(c => c.text === null && !c.bytes).map(c => ({ path: c.path })),
        },
    };
    const r = await json<{ data?: { createCommitOnBranch?: { commit?: { oid: string } } }; errors?: { message: string; type?: string }[] }>(
        await githubFetch(`${API}/graphql`, {
            method: 'POST',
            headers: { ...headers(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: { input } }),
        }),
    );
    const oid = r.data?.createCommitOnBranch?.commit?.oid;
    if (!oid) throw new GitHubError(r.errors?.some(e => /expected/i.test(e.message)) ? 409 : 422, r.errors?.[0]?.message ?? 'Commit failed');
    return oid;
}

/** Pushes the session's state as a commit on top of `head` to `refs/yukibana/wip/<branch>`, forced: a backup of
 *  uncommitted work that survives the room, invisible in GitHub's branch list. Returns the backup commit. */
export async function wipBackup(token: string, owner: string, repo: string, branch: string, head: string, changes: readonly FileChange[]): Promise<string> {
    const p = repoPath(owner, repo);
    const h = headers(token);
    const parent = await json<{ tree: { sha: string } }>(await githubFetch(`${API}/repos/${p}/git/commits/${head}`, { headers: h }));
    const newTree = await json<{ sha: string }>(
        await githubFetch(`${API}/repos/${p}/git/trees`, {
            method: 'POST',
            headers: h,
            body: JSON.stringify({
                base_tree: parent.tree.sha,
                tree: changes.map(c => ({ path: c.path, mode: '100644', type: 'blob', ...(c.text === null ? { sha: null } : { content: c.text }) })),
            }),
        }),
    );
    const c = await json<{ sha: string }>(
        await githubFetch(`${API}/repos/${p}/git/commits`, {
            method: 'POST',
            headers: h,
            body: JSON.stringify({ message: `WIP of ${branch}`, tree: newTree.sha, parents: [head] }),
        }),
    );
    const ref = `yukibana/wip/${branch}`;
    const update = await githubFetch(`${API}/repos/${p}/git/refs/${ref}`, { method: 'PATCH', headers: h, body: JSON.stringify({ sha: c.sha, force: true }) });
    if (update.status === 422 || update.status === 404)
        await json(await githubFetch(`${API}/repos/${p}/git/refs`, { method: 'POST', headers: h, body: JSON.stringify({ ref: `refs/${ref}`, sha: c.sha }) }));
    else await json(update);
    return c.sha;
}
