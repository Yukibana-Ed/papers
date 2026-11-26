import { planFiles, repositoryName, type PlannedFile, type Template } from '@yukibana/papers-templates';
import { commit } from '#lib/github/api.ts';
import { branchHead, findRepo, putFile } from '#lib/github/repos.ts';

/** Where a new paper goes. */
export type Destination =
    /** A folder of a repository the user can write to: one commit, no extra permission. */
    | { readonly kind: 'folder'; readonly owner: string; readonly repo: string; readonly branch: string; readonly folder: string }
    /** A new repository, which the user creates on GitHub's own page (the app does not ask for the permission to create
     *  repositories); the paper is then its first commit. */
    | { readonly kind: 'repository'; readonly owner: string; readonly name: string; readonly visibility: 'public' | 'private' };

/** Where the editor opens after creating. */
export interface Created {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly root: string;
    readonly commit: string;
}

export interface CreateOptions {
    readonly title: string;
    readonly authors: readonly string[];
}

/** GitHub's new-repository page with the name, owner, visibility and description filled in (the documented query
 *  parameters; anything invalid is ignored there). */
export function newRepositoryUrl(d: Extract<Destination, { kind: 'repository' }>, description: string): string {
    const u = new URL('https://github.com/new');
    u.searchParams.set('name', repositoryName(d.name));
    u.searchParams.set('owner', d.owner);
    u.searchParams.set('visibility', d.visibility);
    if (description) u.searchParams.set('description', description);
    return u.href;
}

/** Waits until the new repository is visible to the app (the user created it on GitHub, and the app can read it), or
 *  `signal` aborts. Polls every two seconds. */
export async function waitForRepository(token: () => Promise<string>, owner: string, name: string, signal: AbortSignal): Promise<{ defaultBranch: string; empty: boolean }> {
    for (;;) {
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        const r = await findRepo(await token(), owner, repositoryName(name));
        if (r) return r;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

/** Commits `files` as the first commit (or a commit on top) of `branch`: in an empty repository the contents API makes
 *  the branch with the first file and createCommitOnBranch adds the rest, one commit each; otherwise one
 *  createCommitOnBranch. Returns the last commit. */
export async function commitPaper(token: string, owner: string, repo: string, branch: string, files: readonly PlannedFile[], message: string): Promise<string> {
    let head = await branchHead(token, owner, repo, branch);
    let rest = files;
    if (head === null) {
        // The declaration first: it is small, and it makes the branch.
        const first = files.find(f => f.path.endsWith('papers.toml')) ?? files[0];
        if (!first) throw new Error('Nothing to commit');
        head = await putFile(token, owner, repo, branch, first.path, first.bytes, message);
        rest = files.filter(f => f !== first);
        if (rest.length === 0) return head;
    }
    return commit(
        token,
        owner,
        repo,
        branch,
        head,
        message,
        rest.map(f => ({ path: f.path, text: null, bytes: f.bytes })),
    );
}

/** Creates the paper at a destination that exists: a folder of a repository, or a new repository once the user made
 *  it on GitHub (`branch` is its default branch). */
export async function createPaper(token: string, template: Template, d: { owner: string; repo: string; branch: string; folder: string }, o: CreateOptions): Promise<Created> {
    const plan = planFiles(template, { folder: d.folder, title: o.title, authors: o.authors });
    const message = `Start ${o.title || 'a paper'} from ${template.origin}`;
    const sha = await commitPaper(token, d.owner, d.repo, d.branch, plan.files, message);
    return { owner: d.owner, repo: d.repo, branch: d.branch, root: plan.root, commit: sha };
}
