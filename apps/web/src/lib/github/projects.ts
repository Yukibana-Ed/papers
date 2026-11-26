import { GitHubError, githubFetch, repoPath } from './api.ts';

/** The repositories a signed-in user can open: those the GitHub App is installed on that the user can also see, as
 *  GitHub's "repositories accessible to the user access token" lists them. Only Contents and Metadata access is
 *  needed (the App asks for no more). */

const API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function json<T>(r: Response): Promise<T> {
    if (!r.ok) throw new GitHubError(r.status, `GitHub answered ${r.status}`);
    return (await r.json()) as T;
}

export interface Project {
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
    readonly private: boolean;
    /** Whether the user can push (commit) to it. */
    readonly push: boolean;
    /** When it was last pushed to, epoch ms (0 when never). */
    readonly pushed: number;
}

interface RepoJson {
    name: string;
    owner: { login: string };
    default_branch: string;
    private: boolean;
    pushed_at: string | null;
    permissions?: { push?: boolean };
}

/** How many pages of 100 repositories each installation is read to, at most. */
const PAGES = 5;

/** The user's projects, most recently pushed first; the App's installations on their accounts and organisations, and
 *  the repositories of each that the user may see. Empty when the App is installed nowhere they can see. */
export async function myProjects(token: string): Promise<Project[]> {
    const { installations } = await json<{ installations: { id: number }[] }>(await githubFetch(`${API}/user/installations?per_page=100`, { headers: headers(token) }));
    const lists = await Promise.all(
        installations.map(async i => {
            const out: RepoJson[] = [];
            for (let page = 1; page <= PAGES; page++) {
                const r = await json<{ repositories: RepoJson[] }>(
                    await githubFetch(`${API}/user/installations/${i.id}/repositories?per_page=100&page=${page}`, { headers: headers(token) }),
                );
                out.push(...r.repositories);
                if (r.repositories.length < 100) break;
            }
            return out;
        }),
    );
    const seen = new Set<string>();
    const out: Project[] = [];
    for (const r of lists.flat()) {
        const id = `${r.owner.login}/${r.name}`.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            owner: r.owner.login,
            name: r.name,
            defaultBranch: r.default_branch,
            private: r.private,
            push: r.permissions?.push === true,
            pushed: r.pushed_at === null ? 0 : Date.parse(r.pushed_at),
        });
    }
    return out.toSorted((a, b) => b.pushed - a.pushed);
}

/** What a repository's top level says it holds: a paper set up for Yukibana Papers (`papers.toml`), a LaTeX or a Typst
 *  document, or none of these (null). One listing of its default branch's top folder. */
export async function paperKind(token: string, owner: string, repo: string): Promise<'papers' | 'latex' | 'typst' | null> {
    const r = await githubFetch(`${API}/repos/${repoPath(owner, repo)}/contents/`, { headers: headers(token) });
    if (!r.ok) return null;
    const list = (await r.json()) as { name: string; type: string }[];
    if (!Array.isArray(list)) return null;
    const names = list.filter(e => e.type === 'file').map(e => e.name.toLowerCase());
    if (names.includes('papers.toml')) return 'papers';
    if (names.some(n => n.endsWith('.typ'))) return 'typst';
    if (names.some(n => n.endsWith('.tex'))) return 'latex';
    return null;
}
