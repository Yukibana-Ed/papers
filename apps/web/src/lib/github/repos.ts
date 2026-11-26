import { GitHubError, repoPath } from './api.ts';

/** The GitHub calls of creating a paper: finding repositories, the first commit of an empty one, the app's
 *  installation. The page makes them with the user's token, like the rest of `api.ts`. */

const API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function json<T>(r: Response): Promise<T> {
    if (!r.ok) throw new GitHubError(r.status, `GitHub answered ${r.status}`);
    return (await r.json()) as T;
}

function base64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** The head commit of `branch`, or null when there is no such branch (an empty repository has none). */
export async function branchHead(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
    const r = await fetch(`${API}/repos/${repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}`, { headers: headers(token) });
    if (r.status === 404 || r.status === 409) return null;
    return (await json<{ commit: { sha: string } }>(r)).commit.sha;
}

/** Writes one file through the contents API. Unlike createCommitOnBranch and the git data API (both refuse an empty
 *  repository: "Branch not found", 409 "Git Repository is empty"), it works in an empty repository and makes the
 *  branch. Returns the new commit. */
export async function putFile(token: string, owner: string, repo: string, branch: string, path: string, bytes: Uint8Array, message: string): Promise<string> {
    const r = await json<{ commit: { sha: string } }>(
        await fetch(`${API}/repos/${repoPath(owner, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
            method: 'PUT',
            headers: { ...headers(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, content: base64(bytes), branch }),
        }),
    );
    return r.commit.sha;
}

export interface RepoSummary {
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
    readonly private: boolean;
}

/** The repositories the user can push to and the app can see, most recently pushed first (100 at most). */
export async function writableRepos(token: string): Promise<RepoSummary[]> {
    const list = await json<{ name: string; owner: { login: string }; default_branch: string; private: boolean; permissions?: { push?: boolean } }[]>(
        await fetch(`${API}/user/repos?sort=pushed&per_page=100`, { headers: headers(token) }),
    );
    return list.filter(r => r.permissions?.push).map(r => ({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch, private: r.private }));
}

/** The repository if the user and the app can see it, with whether it has no commits yet; else null. */
export async function findRepo(token: string, owner: string, repo: string): Promise<{ defaultBranch: string; empty: boolean } | null> {
    const r = await fetch(`${API}/repos/${repoPath(owner, repo)}`, { headers: headers(token) });
    if (r.status === 404 || r.status === 403) return null;
    const j = await json<{ default_branch: string }>(r);
    return { defaultBranch: j.default_branch, empty: (await branchHead(token, owner, repo, j.default_branch)) === null };
}

/** This app's installation on the user's own account, for the link that gives it a new repository when it was installed
 *  on selected repositories only; null when there is none (or the call is not allowed). */
export async function ownInstallation(token: string, login: string): Promise<{ id: number; selected: boolean } | null> {
    const r = await fetch(`${API}/user/installations`, { headers: headers(token) });
    if (!r.ok) return null;
    const j = (await r.json()) as { installations?: { id: number; account: { login: string } | null; repository_selection: string }[] };
    const i = j.installations?.find(x => x.account?.login.toLowerCase() === login.toLowerCase());
    return i ? { id: i.id, selected: i.repository_selection === 'selected' } : null;
}
