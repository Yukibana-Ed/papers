import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubError, branchHead } from '#lib/github/api.ts';

/** GitHub with the branches `main` and `feat/x`, answering /git/ref/heads/<name>. */
function github(): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
        asked.push(url);
        const name = decodeURIComponent(/\/git\/ref\/heads\/(.*)$/.exec(url)?.[1] ?? '');
        if (name !== 'main' && name !== 'feat/x') return new Response('{"message":"Not Found"}', { status: 404 });
        return Response.json({ ref: `refs/heads/${name}`, object: { sha: `sha-${name}`, type: 'commit' } });
    });
    return asked;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('branchHead', () => {
    it('finds branches that exist', async () => {
        const asked = github();
        expect(await branchHead('t', 'ada', 'paper', 'main')).toBe('sha-main');
        expect(await branchHead('t', 'ada', 'paper', 'feat/x')).toBe('sha-feat/x');
        expect(asked[1]).toBe('https://api.github.com/repos/ada/paper/git/ref/heads/feat/x');
    });

    it('refuses branches that do not', async () => {
        github();
        await expect(branchHead('t', 'ada', 'paper', 'made-up')).rejects.toMatchObject({ status: 404 });
        await expect(branchHead('t', 'ada', 'paper', 'feat')).rejects.toBeInstanceOf(GitHubError);
    });

    it('refuses an answer for another ref', async () => {
        vi.stubGlobal('fetch', async () => Response.json({ ref: 'refs/heads/main', object: { sha: 'x' } }));
        await expect(branchHead('t', 'ada', 'paper', 'other')).rejects.toMatchObject({ status: 404 });
    });
});
