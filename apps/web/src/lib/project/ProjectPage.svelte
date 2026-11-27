<script lang="ts">
    import { githubUser } from '#lib/model/user.ts';
    import { onDestroy, onMount } from 'svelte';
    import type { Authors, BaseFile } from '@yukibana/papers-room-protocol';
    import { GitHubError, coAuthorTrailer, commit, compare, wipBackup } from '#lib/github/api.ts';
    import { ReviewSource } from '#lib/review/source.svelte.ts';
    import { mergePush, type Theirs } from './pull.ts';
    import { githubToken, session as githubSession, type Viewer } from '#lib/github/token.ts';
    import type { User } from '#lib/model/types.ts';
    import { RoomClient, TicketRefused } from '#lib/room/client.ts';
    import { syncReview } from '#lib/room/sync.svelte.ts';
    import { Session } from '#lib/session.svelte.ts';
    import Workbench from '#lib/shell/Workbench.svelte';
    import { LoadError, loadProject, resolveRef, type LoadedProject } from './load.ts';

    /** A repository's branch in the editor: read it from GitHub, join its room, then show the workbench. */
    let {
        owner,
        repo,
        rest = '',
        branch,
        contentOrigin,
        root = null,
    }: { owner: string; repo: string; rest?: string; branch: string | null; contentOrigin: string; root?: string | null } = $props();

    let progress = $state<{ done: number; total: number } | null>(null);
    let failure = $state<string | null>(null);
    let session = $state<Session | null>(null);
    let room: RoomClient | null = null;
    let stopSync: (() => void) | null = null;

    /** Why GitHub refused, short enough for one line: the first line of its message, or the status alone. */
    function refusal(e: GitHubError): string {
        const first = e.message.split('\n')[0]?.trim() ?? '';
        return first === '' ? String(e.status) : first.length > 140 ? `${first.slice(0, 139)}…` : first;
    }

    /** Why the room refuses connections, in its own words: `url` gives the room's WebSocket address with a ticket, and
     *  the same address by POST answers with what is wrong (see `hooks.server.ts`). */
    async function whyRefused(url: () => Promise<string>): Promise<string> {
        try {
            const res = await fetch((await url()).replace(/^ws/, 'http'), { method: 'POST' });
            const text = (await res.text()).trim();
            return res.ok ? 'The room refuses the connection' : `The room is unavailable (${res.status}${text === '' ? '' : `: ${text.slice(0, 200)}`})`;
        } catch {
            return 'The room cannot be reached';
        }
    }

    function start(p: LoadedProject, me: Viewer, r: RoomClient, base: string | null, baseFiles: readonly BaseFile[], authors: Authors): void {
        const files: Record<string, string> = {};
        for (const [path, text] of r.files) files[path] = text.toJSON();
        // With read access the room's files cannot be made from here: until someone who can write opens the branch,
        // the committed files are shown as they are.
        if (p.access !== 'write') for (const [path, v] of p.texts) files[path] ??= v.text;
        const committed: Record<string, string> = Object.fromEntries([...p.texts].map(([path, v]) => [path, v.text]));
        for (const f of baseFiles) committed[f.path] = f.text;
        const users: Record<string, User> = { [me.login]: githubUser(me.login, me.name) };
        const s = new Session({
            repo: { owner: p.owner, name: p.repo },
            me: me.login,
            users,
            files,
            order: p.order.filter((path) => path in files),
            base: committed,
            branches: { [p.branch]: { name: p.branch, users: [me.login], pr: null } },
            branch: p.branch,
            commits: [{ hash: (base ?? p.commit).slice(0, 7), author: me.login, when: '', msg: '' }],
            threads: [],
            presence: [],
            assets: Object.fromEntries(p.assets),
            access: p.access,
            unread: Object.fromEntries(p.unread),
            otherFiles: p.order.filter((path) => !(path in files) && !p.unread.has(path)),
        });
        head = base ?? p.commit;
        const source = new ReviewSource(r.text, r.review, me.login);
        source.setBase(baseFiles);
        source.addAuthors(authors);
        for (const a of pendingAuthors) source.addAuthors(a);
        source.setBase(pendingOpened);
        reviewSource = source;
        s.source = source;
        s.backend = {
            async commit(message, commitFiles, coAuthors) {
                let oid: string;
                try {
                    const token = await githubToken();
                    const trailers = await Promise.all(coAuthors.map((login) => coAuthorTrailer(token, login, s.users[login]?.name ?? login)));
                    const full = trailers.length ? `${message}\n\n${trailers.join('\n')}` : message;
                    oid = await commit(token, p.owner, p.repo, p.branch, head, full, commitFiles.map((f) => ({ path: f.path, text: f.text })));
                } catch (e) {
                    if (e instanceof GitHubError && e.status === 409) {
                        // Someone pushed from outside the room: their commits are merged into the session first.
                        const fresh = await loadProject(p.owner, p.repo, p.branch, () => {});
                        await pull(p.branch, fresh);
                        throw new Error(`Merged ${p.branch}: commit again`, { cause: e });
                    }
                    // GitHub's own words say why (a protected branch, the App not installed on the repository, ...).
                    throw new Error(e instanceof GitHubError ? `GitHub refused the commit: ${refusal(e)}` : 'Commit failed', { cause: e });
                }
                head = oid;
                mine.add(oid);
                r.committed(oid, commitFiles.map((f) => ({ path: f.path, blob: '', text: f.text, items: f.items })));
                return oid;
            },
        };
        stopSync = syncReview(s, r);
        // A new paper opens on its root file (the preview builds it at once).
        if (root !== null && root in files) s.openFile(root);
        session = s;
    }

    /** Takes the commits the branch got outside the room (`theirs` is its head now) into the session, merged with
     *  what the session changed. Does nothing unless `theirs` is ahead of the head this page knows. */
    async function pull(branchName: string, theirs: Theirs): Promise<void> {
        const r = room;
        const s = session;
        const from = head;
        if (!r || !s || s.readOnly || from === theirs.commit) return;
        const status = await compare(await githubToken(), owner, repo, from, theirs.commit);
        if (status === 'diverged') s.flash(`${branchName} was rewritten`);
        if (status !== 'ahead') return;
        const merged = mergePush(r.text, s.base, theirs, branchName);
        r.pulled(from, theirs.commit, merged.update, merged.files);
        if (merged.conflicts.length > 0) s.flash(`Merge conflict in ${merged.conflicts.join(', ')}`);
    }

    onMount(() => {
        let cancelled = false;
        void (async () => {
            try {
                // `/p/<owner>/<repo>/<branch>/<file>`: which part is the branch, which the file.
                const ref = rest === '' ? { branch: null, path: null } : await resolveRef(owner, repo, rest);
                if (ref.path !== null) root = ref.path;
                const p = await loadProject(owner, repo, branch ?? ref.branch, (done, total) => (progress = { done, total }));
                const me = (await githubSession()).viewer;
                if (cancelled) return;
                const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const roomPath = `/room/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/${encodeURIComponent(p.branch)}`;
                // A ticket per connection: the page shows its GitHub token to the app's Worker once, and the room gets
                // only the ticket.
                const url = async (): Promise<string> => {
                    const res = await fetch('/room/ticket', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await githubToken()}` },
                        body: JSON.stringify({ owner: p.owner, repo: p.repo, branch: p.branch }),
                    });
                    if (res.status === 401 || res.status === 403) throw new TicketRefused(res.status);
                    if (!res.ok) throw new Error(`No ticket (${res.status})`);
                    const { ticket } = (await res.json()) as { ticket: string };
                    return `${proto}//${location.host}${roomPath}?ticket=${encodeURIComponent(ticket)}`;
                };
                const r = new RoomClient(url, {
                    welcome: (_you, base, files, authors) => {
                        refusals = 0;
                        if (!session) failure = null;
                        welcome = { base, files, authors };
                        reviewSource?.setBase(files);
                        reviewSource?.addAuthors(authors);
                        // After a reconnection: what was committed while this page was away is the head now.
                        if (session && base !== null && base !== head && !mine.has(base)) {
                            head = base;
                            session.committedElsewhere(base, files);
                        }
                    },
                    opened: (file) => {
                        if (reviewSource) reviewSource.setBase([file]);
                        else pendingOpened.push(file);
                    },
                    authors: (a) => {
                        if (reviewSource) reviewSource.addAuthors(a);
                        else pendingAuthors.push(a);
                    },
                    base: (base, files) => {
                        // The room tells the one who committed too, and that can arrive after a later commit from here:
                        // taken as news it would put the head and the committed files back.
                        if (mine.has(base)) return;
                        // Someone committed: later commits from here go on top of theirs.
                        head = base;
                        session?.committedElsewhere(base, files);
                    },
                    sync: m => {
                        mode = m.mode;
                        if (!session) return;
                        // Said once, when it starts: the room refuses every message while paused.
                        if (m.mode === 'paused' && session.sync !== 'paused') session.flash('Live sync paused for today');
                        session.sync = m.mode;
                    },
                    synced: () => {
                        if (session || !welcome) return;
                        const w = welcome;
                        if (w.base !== null && w.base !== p.commit) {
                            // The room's session started at an older commit and someone pushed since: work on the room's
                            // state, and merge the push into it once the session is up (`pull`).
                        } else if (p.access === 'write') {
                            for (const [path, v] of p.texts) if (!r.files.has(path)) r.open(path, v.blob, v.text, p.commit);
                        }
                        // The files appear once the room has created them.
                        const ready = (): boolean => [...p.texts.keys()].every((path) => r.files.has(path)) || p.access !== 'write' || (w.base !== null && w.base !== p.commit);
                        const go = (): void => {
                            if (!session && ready()) {
                                r.files.unobserve(go);
                                start(p, me, r, w.base, w.files, w.authors);
                                // The branch moved since the room's session began: a push from outside the room.
                                if (w.base !== null && w.base !== p.commit) void pull(p.branch, p).catch(() => session?.flash(`Could not merge ${p.branch}`));
                            }
                        };
                        r.files.observe(go);
                        go();
                    },
                    backupDue: () => {
                        const s = session;
                        if (!s) return;
                        const changes = s.changes.map((c) => ({ path: c.file, text: s.files[c.file] ?? null }));
                        void githubToken()
                            .then((token) => wipBackup(token, p.owner, p.repo, p.branch, head, changes))
                            .then(
                                (backup) => r.backedUp(backup),
                                () => {
                                    // The next alarm asks again.
                                },
                            );
                    },
                    connection: (state) => {
                        if (session && state !== 'connecting') session.sync = state === 'open' ? mode : 'offline';
                        if (state === 'closed' && !session && ++refusals === 3) {
                            // The room keeps refusing before the paper could open: ask it why, and say so.
                            void whyRefused(url).then((why) => {
                                if (!session && !cancelled && refusals >= 3) failure = why;
                            });
                        }
                    },
                    refused: (reason) => {
                        if (reason !== 'paused') session?.flash(`Refused: ${reason}`);
                    },
                    signedOut: () => {
                        location.href = `/auth/login?to=${encodeURIComponent(location.pathname + location.search)}`;
                    },
                });
                room = r;
                roomState = r;
            } catch (e) {
                failure = e instanceof LoadError ? e.message : 'Could not open the repository';
                if (e instanceof LoadError && e.kind === 'signin') location.href = `/auth/login?to=${encodeURIComponent(location.pathname + location.search)}`;
            }
        })();
        return () => {
            cancelled = true;
        };
    });

    /** The branch's head as this page knows it: what the next commit must go on top of. */
    let head = '';
    /** The commits made from this page. */
    const mine = new Set<string>();
    /** Connections to the room that closed, in a row, since the last one the room welcomed. */
    let refusals = 0;
    /** The room's sync mode as it last said. */
    let mode: 'live' | 'batched' | 'paused' = 'live';
    let welcome: { base: string | null; files: readonly BaseFile[]; authors: Authors } | null = null;
    /** Where the commit review reads ids and authors, once the session is up; what the room said before that waits. */
    let reviewSource: ReviewSource | null = null;
    const pendingAuthors: Authors[] = [];
    const pendingOpened: BaseFile[] = [];
    let roomState = $state<RoomClient | null>(null);

    onDestroy(() => {
        reviewSource?.dispose();
        stopSync?.();
        room?.close();
    });

</script>

{#if session}
    <Workbench {session} {contentOrigin} room={roomState} />
{:else}
    <main class="loading">
        <img src="/logo.svg" alt="" width="32" height="32" />
        <span class="mono">{owner}/{repo}</span>
        {#if failure}
            <span class="yk-chip yk-chip--pink">{failure}</span>
        {:else}
            <span class="yk-spinner" role="status" aria-label="Opening"></span>
            {#if progress && progress.total > 0}<span class="muted">{progress.done} / {progress.total}</span>{/if}
        {/if}
    </main>
{/if}

<style>
    .loading {
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 12px;
        height: 100%;
        background: var(--yk-bg);
    }
</style>
