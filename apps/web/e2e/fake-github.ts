import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** A stand-in for the parts of GitHub's API the app uses to open a repository, join its room and commit, for the
 *  browser tests: repositories in memory, with real git blob hashes. The app's Worker asks it directly (`GITHUB_API`);
 *  the page's calls to api.github.com are sent here by `signedIn`.
 *
 *  Who asks is in the token: `e2e:<login>`. A repository's `readers` may read but not push.
 *
 *  Test control: `PUT /__repos/<owner>/<repo>` with `{ files, readers? }` makes (or replaces) a repository with one
 *  commit on `main`; `POST` there with `{ files, message?, author? }` adds a commit that sets those files, as a push
 *  from a clone would; `GET /__repos/<owner>/<repo>` gives its commits (newest first) and current files.
 *
 *  Run: `node e2e/fake-github.ts [port]` (default 4175). */

interface Commit {
    readonly oid: string;
    readonly message: string;
    readonly author: string;
    readonly files: ReadonlyMap<string, Buffer>;
}

interface Repo {
    readonly readers: readonly string[];
    readonly commits: Commit[];
}

const repos = new Map<string, Repo>();

const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex');
const blobSha = (bytes: Buffer): string => sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
const treeSha = (files: ReadonlyMap<string, Buffer>): string => sha1([...files].map(([p, b]) => `${p}\0${blobSha(b)}`).join('\n'));

async function body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c as Uint8Array));
    return chunks.length === 0 ? null : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
}

function send(res: ServerResponse, status: number, json: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
}

const field = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    if (path === '/') return send(res, 200, { fake: 'GitHub' });
    const control = /^\/__repos\/([^/]+\/[^/]+)$/.exec(path);
    if (control !== null) {
        const name = control[1] ?? '';
        if (req.method === 'PUT') {
            const b = await body(req);
            const files = new Map(Object.entries((field(b, 'files') ?? {}) as Record<string, string>).map(([p, text]) => [p, Buffer.from(text)]));
            const readers = (field(b, 'readers') ?? []) as string[];
            repos.set(name, { readers, commits: [{ oid: sha1(`${name}\0${Math.random()}`), message: 'Initial commit', author: name.split('/')[0] ?? '', files }] });
            return send(res, 200, {});
        }
        const repo = repos.get(name);
        if (repo === undefined) return send(res, 404, { message: 'Not Found' });
        if (req.method === 'POST') {
            const b = await body(req);
            const head = repo.commits.at(-1);
            const files = new Map(head?.files);
            for (const [p, text] of Object.entries((field(b, 'files') ?? {}) as Record<string, string>)) files.set(p, Buffer.from(text));
            const text = (k: string, otherwise: string): string => {
                const v = field(b, k);
                return typeof v === 'string' ? v : otherwise;
            };
            const message = text('message', 'Push');
            repo.commits.push({ oid: sha1(`${head?.oid}\0${treeSha(files)}\0${message}`), message, author: text('author', 'clone'), files });
            return send(res, 200, {});
        }
        return send(res, 200, {
            commits: repo.commits.toReversed().map(c => ({ oid: c.oid, message: c.message, author: c.author })),
            files: Object.fromEntries([...(repo.commits.at(-1)?.files ?? [])].map(([p, b]) => [p, b.toString('utf8')])),
        });
    }

    const login = /^Bearer e2e:([A-Za-z0-9-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (login === undefined) return send(res, 401, { message: 'Bad credentials' });
    if (path === '/user') return send(res, 200, { login, name: null, avatar_url: '' });

    if (path === '/graphql' && req.method === 'POST') {
        const input = field(field(await body(req), 'variables'), 'input');
        const branch = field(input, 'branch');
        const repo = repos.get(String(field(branch, 'repositoryNameWithOwner')));
        const head = repo?.commits.at(-1);
        if (repo === undefined || head === undefined || field(branch, 'branchName') !== 'main')
            return send(res, 200, { errors: [{ message: 'Could not resolve to a Repository' }] });
        if (repo.readers.includes(login)) return send(res, 200, { errors: [{ message: 'Resource not accessible by integration' }] });
        if (field(input, 'expectedHeadOid') !== head.oid)
            return send(res, 200, { errors: [{ message: `Expected branch to point to "${String(field(input, 'expectedHeadOid'))}" but it did not` }] });
        const files = new Map(head.files);
        const changes = field(input, 'fileChanges');
        for (const a of (field(changes, 'additions') ?? []) as { path: string; contents: string }[]) files.set(a.path, Buffer.from(a.contents, 'base64'));
        for (const d of (field(changes, 'deletions') ?? []) as { path: string }[]) files.delete(d.path);
        const message = [field(field(input, 'message'), 'headline'), field(field(input, 'message'), 'body')].filter(Boolean).join('\n\n');
        const oid = sha1(`${head.oid}\0${treeSha(files)}\0${message}`);
        repo.commits.push({ oid, message, author: login, files });
        return send(res, 200, { data: { createCommitOnBranch: { commit: { oid } } } });
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    const name = m?.[1] ?? '';
    const rest = m?.[2] ?? '';
    const repo = repos.get(name);
    const head = repo?.commits.at(-1);
    if (repo === undefined || head === undefined) return send(res, 404, { message: 'Not Found' });
    if (rest === '') return send(res, 200, { full_name: name, default_branch: 'main', private: false, permissions: { pull: true, push: !repo.readers.includes(login) } });
    if (rest === '/branches') return send(res, 200, [{ name: 'main' }]);
    if (rest === '/git/ref/heads/main') return send(res, 200, { ref: 'refs/heads/main', object: { sha: head.oid } });
    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)?.[1];
    if (commit !== undefined) {
        const c = repo.commits.find(x => x.oid === commit);
        return c === undefined ? send(res, 404, { message: 'Not Found' }) : send(res, 200, { sha: c.oid, tree: { sha: treeSha(c.files) } });
    }
    const compared = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);
    if (compared !== null) {
        const base = repo.commits.findIndex(x => x.oid === compared[1]);
        const to = repo.commits.findIndex(x => x.oid === compared[2]);
        if (base < 0 || to < 0) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, { status: to > base ? 'ahead' : to < base ? 'behind' : 'identical' });
    }
    const tree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)?.[1];
    if (tree !== undefined) {
        const c = repo.commits.find(x => treeSha(x.files) === tree);
        if (c === undefined) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, { truncated: false, tree: [...c.files].map(([p, b]) => ({ path: p, type: 'blob', sha: blobSha(b), size: b.length })) });
    }
    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)?.[1];
    if (blob !== undefined) {
        for (const c of repo.commits) {
            for (const b of c.files.values()) {
                if (blobSha(b) !== blob) continue;
                res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw' });
                res.end(b);
                return;
            }
        }
    }
    return send(res, 404, { message: 'Not Found' });
}

const port = Number(process.argv[2] ?? 4175);
createServer((req, res) => {
    handle(req, res).catch((e: unknown) => send(res, 500, { message: String(e) }));
}).listen(port, '127.0.0.1', () => console.log(`fake GitHub on http://127.0.0.1:${port}`));
