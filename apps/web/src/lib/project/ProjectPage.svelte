<script lang="ts">
    import { githubUser } from '#lib/model/user.ts';
    import { onDestroy, onMount } from 'svelte';
    import * as Y from 'yjs';
    import type { Authors, BaseFile } from '@yukibana/papers-room-protocol';
    import { GitHubError, coAuthorTrailer, commit, compare, wipBackup } from '#lib/github/api.ts';
    import { ReviewSource } from '#lib/review/source.svelte.ts';
    import { mergePush, type Theirs } from './pull.ts';
    import { githubToken, session as githubSession, type Viewer } from '#lib/github/token.ts';
    import type { User } from '#lib/model/types.ts';
    import { RoomClient, TicketRefused } from '#lib/room/client.ts';
    import { keepLocal, localKey, readLocal } from '#lib/room/local.ts';
    import { rejoin } from '#lib/room/rejoin.ts';
    import { syncReview } from '#lib/room/sync.svelte.ts';
    import { Session } from '#lib/session.svelte.ts';
    import Workbench from '#lib/shell/Workbench.svelte';
    import { LoadError, loadProject, resolveRef, type LoadedProject } from './load.ts';

    /** A repository's branch in the editor: read it from GitHub, join its room, then show the workbench.
     *
     *  The room is not needed to work: when it cannot be reached, the project opens on documents of this page's own,
     *  from the copy this browser kept of the branch or else from GitHub, and what is done there is brought into the
     *  room when it answers again (`rejoin`). The copy is kept up to date while a session runs, whichever it runs on. */
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
    /** The client the session runs on: the room's, or one of no room while the room cannot be reached. */
    let room: RoomClient | null = null;
    /** The room's client: it keeps trying to connect for as long as the page is open. */
    let live: RoomClient | null = null;
    let stopSync: (() => void) | null = null;
    let stopKeep: (() => void) | null = null;
    let saveCopy: (() => void) | null = null;
    /** Whether the room has everything the session's documents hold: connected, and synced since. */
    let inSync = false;

    /** After this long without the room's welcome, the project opens without it. */
    const WAIT_FOR_ROOM_MS = 5000;

    /** Where a session stands in the repository: a commit and the text files there. */
    interface Stand {
        readonly commit: string;
        readonly texts: ReadonlyMap<string, { readonly text: string; readonly blob: string }>;
    }

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

    /** Ends the running session, keeping its documents: the copy is saved and nothing listens to them any more. */
    function stop(): void {
        stopKeep?.();
        stopKeep = null;
        saveCopy = null;
        reviewSource?.dispose();
        reviewSource = null;
        stopSync?.();
        stopSync = null;
        session = null;
    }

    /** Starts the session on `r`'s documents: `p` is the project as read from GitHub, `at` where the session stands
     *  (its files' committed texts), and `base`, `baseFiles` and `authors` what the room said (for a client of no room:
     *  what the room would say of documents just made from `at`). */
    function start(p: LoadedProject, at: Stand, me: Viewer, r: RoomClient, base: string | null, baseFiles: readonly BaseFile[], authors: Authors): void {
        const files: Record<string, string> = {};
        for (const [path, text] of r.files) files[path] = text.toJSON();
        // With read access the room's files cannot be made from here: until someone who can write opens the branch,
        // the committed files are shown as they are.
        if (p.access !== 'write') for (const [path, v] of at.texts) files[path] ??= v.text;
        const committed: Record<string, string> = Object.fromEntries([...at.texts].map(([path, v]) => [path, v.text]));
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
            commits: [{ hash: (base ?? at.commit).slice(0, 7), author: me.login, when: '', msg: '' }],
            threads: [],
            presence: [],
            assets: Object.fromEntries(p.assets),
            access: p.access,
            unread: Object.fromEntries(p.unread),
            otherFiles: p.order.filter((path) => !(path in files) && !p.unread.has(path)),
        });
        head = base ?? at.commit;
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
        room = r;
        roomState = r;
        session = s;
        s.sync = r === live ? mode : 'offline';
        const kept = keepLocal(localKey(p.owner, p.repo, p.branch), r.text, r.review, () => ({ base: head, committed: { ...s.base }, unsent: r !== live || !inSync }));
        stopKeep = kept.stop;
        saveCopy = kept.save;
        kept.save();
    }

    /** Takes the commits the branch got outside the room (`theirs` is its head now) into the session, merged with
     *  what the session changed: through the room, which applies the merge for everyone, or here when the session
     *  runs without the room. Does nothing unless `theirs` is ahead of the head this page knows. */
    async function pull(branchName: string, theirs: Theirs): Promise<void> {
        const r = room;
        const s = session;
        const from = head;
        if (!r || !s || s.readOnly || from === theirs.commit) return;
        const status = await compare(await githubToken(), owner, repo, from, theirs.commit);
        if (status === 'diverged') s.flash(`${branchName} was rewritten`);
        if (status !== 'ahead') return;
        const merged = mergePush(r.text, s.base, theirs, branchName);
        if (r === live) r.pulled(from, theirs.commit, merged.update, merged.files);
        else {
            Y.applyUpdate(r.text, merged.update);
            head = theirs.commit;
            s.committedElsewhere(theirs.commit, merged.files);
        }
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
                const saved = await readLocal(localKey(p.owner, p.repo, p.branch));
                if (cancelled) return;
                const here: Stand = { commit: p.commit, texts: p.texts };
                /** The stand of documents this browser kept: their commit, and the files as committed there. */
                const standOf = (sha: string, committed: Readonly<Record<string, string>>): Stand => ({
                    commit: sha,
                    texts: new Map(Object.entries(committed).map(([path, text]) => [path, { text, blob: p.texts.get(path)?.text === text ? (p.texts.get(path)?.blob ?? '') : '' }])),
                });
                /** Work the room may lack, from before this page: the copy this browser kept, when it says so. */
                let earlier: { text: Y.Doc; review: Y.Doc; stand: Stand } | null = null;
                if (saved?.unsent) {
                    earlier = { text: new Y.Doc(), review: new Y.Doc(), stand: standOf(saved.base, saved.committed) };
                    Y.applyUpdate(earlier.text, saved.text);
                    Y.applyUpdate(earlier.review, saved.review);
                }

                /** Opens the project without the room: on the copy this browser kept, or else on the files from GitHub. */
                const openAway = (): void => {
                    if (session || joining || cancelled) return;
                    const l = new RoomClient(null, {
                        welcome() {},
                        base() {},
                        opened() {},
                        authors() {},
                        sync() {},
                        synced() {},
                        backupDue() {},
                        connection() {},
                        refused() {},
                        signedOut() {},
                    });
                    away = l;
                    let at = here;
                    if (saved) {
                        Y.applyUpdate(l.text, saved.text);
                        Y.applyUpdate(l.review, saved.review);
                        at = standOf(saved.base, saved.committed);
                    } else l.text.transact(() => {
                        for (const [path, v] of p.texts) l.files.set(path, new Y.Text(v.text));
                    });
                    start(p, at, me, l, at.commit, [...at.texts].map(([path, v]) => ({ path, blob: v.blob, text: v.text, items: '' })), { writers: [], deleted: [] });
                    // The branch moved since the copy was kept.
                    if (at.commit !== p.commit) void pull(p.branch, p).catch(() => session?.flash(`Could not merge ${p.branch}`));
                };

                /** Moves to the room once it has synced: starts the session on its documents (again, when one runs
                 *  without the room), with the work done away from it brought in. */
                const join = async (r: RoomClient, w: { base: string | null; files: readonly BaseFile[]; authors: Authors }): Promise<void> => {
                    const running = session;
                    // Where the files the room lacks come from: where the running session stands, else GitHub now.
                    const at = running ? standOf(head, running.base) : here;
                    const work = away ? { text: away.text, review: away.review, stand: at } : earlier;
                    if (w.base !== null && w.base !== at.commit) {
                        // The room's session started at another commit: work on the room's state, and merge the
                        // branch into it once the session is up (`pull`).
                    } else if (p.access === 'write') {
                        for (const [path, v] of at.texts) if (!r.files.has(path)) r.open(path, v.blob, v.text, at.commit);
                    }
                    // What both the work and the room's text started from, per file: the work's committed texts, or
                    // the room's where the work stands on later commits than the room does.
                    let common: Record<string, string> = work ? Object.fromEntries([...work.stand.texts].map(([path, v]) => [path, v.text])) : {};
                    if (work && w.base !== null && w.base !== work.stand.commit) {
                        const status = await githubToken()
                            .then(token => compare(token, p.owner, p.repo, w.base ?? '', work.stand.commit))
                            .catch(() => 'diverged' as const);
                        if (status === 'ahead') common = { ...common, ...Object.fromEntries(w.files.map(f => [f.path, f.text])) };
                    }
                    if (cancelled) return;
                    // The files appear once the room has created them.
                    const ready = (): boolean => [...at.texts.keys()].every(path => r.files.has(path)) || p.access !== 'write' || (w.base !== null && w.base !== at.commit);
                    const go = (): void => {
                        if (room === r || !ready()) return;
                        r.files.unobserve(go);
                        const view = session ? { tabs: [...session.tabs], active: session.activeFile, cursor: { ...session.cursor } } : null;
                        stop();
                        away?.close();
                        away = null;
                        earlier = null;
                        inSync = true;
                        // Commits made without the room are news to the session that starts now, when the room takes them.
                        mine.clear();
                        start(p, at, me, r, w.base, w.files, w.authors);
                        const s = session;
                        if (work && s) {
                            const conflicts = p.access === 'write' ? rejoin(work, r, common) : [];
                            if (conflicts.length > 0) s.flash(`Merge conflict in ${conflicts.join(', ')}`);
                        }
                        if (view && s) {
                            for (const f of view.tabs) if (f in s.files) s.openFile(f);
                            if (view.active in s.files) {
                                s.activeFile = view.active;
                                s.cursor = view.cursor;
                            }
                        }
                        // The branch moved since the room's session began: a push from outside the room.
                        if (w.base !== null && w.base !== at.commit) void pull(p.branch, { commit: at.commit, texts: at.texts }).catch(() => session?.flash(`Could not merge ${p.branch}`));
                    };
                    r.files.observe(go);
                    go();
                };

                const r = new RoomClient(url, {
                    welcome: (_you, base, files, authors) => {
                        refusals = 0;
                        welcome = { base, files, authors };
                        if (room !== r) return;
                        reviewSource?.setBase(files);
                        reviewSource?.addAuthors(authors);
                        // After a reconnection: what was committed while this page was away is the head now.
                        if (session && base !== null && base !== head && !mine.has(base)) {
                            head = base;
                            session.committedElsewhere(base, files);
                        }
                    },
                    opened: (file) => {
                        if (room === r && reviewSource) reviewSource.setBase([file]);
                        else pendingOpened.push(file);
                    },
                    authors: (a) => {
                        if (room === r && reviewSource) reviewSource.addAuthors(a);
                        else pendingAuthors.push(a);
                    },
                    base: (base, files) => {
                        if (room !== r) return;
                        // The room tells the one who committed too, and that can arrive after a later commit from here:
                        // taken as news it would put the head and the committed files back.
                        if (mine.has(base)) return;
                        // Someone committed: later commits from here go on top of theirs.
                        head = base;
                        session?.committedElsewhere(base, files);
                    },
                    sync: m => {
                        mode = m.mode;
                        if (!session || room !== r) return;
                        // Said once, when it starts: the room refuses every message while paused.
                        if (m.mode === 'paused' && session.sync !== 'paused') session.flash('Live sync paused for today');
                        session.sync = m.mode;
                    },
                    synced: () => {
                        if (!welcome) return;
                        if (room === r) {
                            // A reconnection of the running session: the room has what was done meanwhile.
                            inSync = true;
                            saveCopy?.();
                            return;
                        }
                        if (joining) return;
                        joining = true;
                        void join(r, welcome).finally(() => (joining = false));
                    },
                    backupDue: () => {
                        const s = session;
                        if (!s || room !== r) return;
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
                        if (state === 'closed') inSync = false;
                        if (session && room === r && state !== 'connecting') session.sync = state === 'open' ? mode : 'offline';
                        if (state === 'closed' && room !== r && ++refusals === 2) {
                            // The room keeps refusing: the project opens without it, and says why the room is away.
                            openAway();
                            void whyRefused(url).then((why) => {
                                if (!cancelled && room !== r) session?.flash(why);
                            });
                        }
                    },
                    refused: (reason) => {
                        if (room === r && reason !== 'paused') session?.flash(`Refused: ${reason}`);
                    },
                    signedOut: () => {
                        location.href = `/auth/login?to=${encodeURIComponent(location.pathname + location.search)}`;
                    },
                });
                live = r;
                waiting = setTimeout(() => {
                    if (!welcome) openAway();
                }, WAIT_FOR_ROOM_MS);
            } catch (e) {
                failure = e instanceof LoadError ? e.message : 'Could not open the repository';
                if (e instanceof LoadError && e.kind === 'signin') location.href = `/auth/login?to=${encodeURIComponent(location.pathname + location.search)}`;
            }
        })();
        return () => {
            cancelled = true;
            clearTimeout(waiting);
        };
    });

    /** The branch's head as this page knows it: what the next commit must go on top of. */
    let head = '';
    /** The commits made from this page. */
    const mine = new Set<string>();
    /** Connections to the room that closed, in a row, since the last one the room welcomed. */
    let refusals = 0;
    /** The client of no room the session runs on while the room cannot be reached. */
    let away: RoomClient | null = null;
    /** Whether the move to the room is under way. */
    let joining = false;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    /** The room's sync mode as it last said. */
    let mode: 'live' | 'batched' | 'paused' = 'live';
    let welcome: { base: string | null; files: readonly BaseFile[]; authors: Authors } | null = null;
    /** Where the commit review reads ids and authors, once the session is up; what the room said before that waits. */
    let reviewSource: ReviewSource | null = null;
    const pendingAuthors: Authors[] = [];
    const pendingOpened: BaseFile[] = [];
    let roomState = $state<RoomClient | null>(null);

    onDestroy(() => {
        stop();
        away?.close();
        live?.close();
    });

</script>

{#if session}
    <!-- A session that moves to the room is another session: the workbench starts again on it. -->
    {#key session}
        <Workbench {session} {contentOrigin} room={roomState} />
    {/key}
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
