<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import type { BaseFile } from '@yukibana/papers-room-protocol';
    import { GitHubError, commit, compare, wipBackup } from '#lib/github/api.ts';
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

    /** A user as the app draws them, from their login alone: the hue is stable per login. */
    function userOf(login: string, name = login): User {
        let h = 0;
        for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) % 360;
        const parts = name.split(/\s+/).filter(Boolean);
        const initials = ((parts[0]?.[0] ?? login[0] ?? '?') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
        return { id: login, name, initials, hue: h };
    }

    function start(p: LoadedProject, me: Viewer, r: RoomClient, base: string | null, baseFiles: readonly BaseFile[]): void {
        const files: Record<string, string> = {};
        for (const [path, text] of r.files) files[path] = text.toJSON();
        // With read access the room's files cannot be made from here: until someone who can write opens the branch,
        // the committed files are shown as they are.
        if (p.access !== 'write') for (const [path, v] of p.texts) files[path] ??= v.text;
        const committed: Record<string, string> = Object.fromEntries([...p.texts].map(([path, v]) => [path, v.text]));
        for (const f of baseFiles) committed[f.path] = f.text;
        const users: Record<string, User> = { [me.login]: userOf(me.login, me.name) };
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
        });
        head = base ?? p.commit;
        s.backend = {
            async commit(message, changes) {
                let oid: string;
                try {
                    oid = await commit(await githubToken(), p.owner, p.repo, p.branch, head, message, changes);
                } catch (e) {
                    if (e instanceof GitHubError && e.status === 409) {
                        // Someone pushed from outside the room: their commits are merged into the session first.
                        const fresh = await loadProject(p.owner, p.repo, p.branch, () => {});
                        await pull(p.branch, fresh);
                        throw new Error(`Merged ${p.branch}: commit again`, { cause: e });
                    }
                    throw new Error(e instanceof GitHubError ? `GitHub refused the commit (${e.status})` : 'Commit failed', { cause: e });
                }
                head = oid;
                mine.add(oid);
                r.committed(oid, changes.filter((c) => c.text !== null).map((c) => ({ path: c.path, blob: '', text: c.text ?? '' })));
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
                    welcome: (_you, base, files) => {
                        welcome = { base, files };
                    },
                    base: (base, files) => {
                        // The room tells the one who committed too, and that can arrive after a later commit from here:
                        // taken as news it would put the head and the committed files back.
                        if (mine.has(base)) return;
                        // Someone committed: later commits from here go on top of theirs.
                        head = base;
                        session?.committedElsewhere(base, Object.fromEntries(files.map((f) => [f.path, f.text])));
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
                                start(p, me, r, w.base, w.files);
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
                            .then((token) => wipBackup(token, p.owner, p.repo, p.branch, welcome?.base ?? p.commit, changes))
                            .then(
                                (backup) => r.backedUp(backup),
                                () => {
                                    // The next alarm asks again.
                                },
                            );
                    },
                    connection: state => {
                        if (session && state !== 'connecting') session.sync = state === 'open' ? mode : 'offline';
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
    /** The room's sync mode as it last said. */
    let mode: 'live' | 'batched' | 'paused' = 'live';
    let welcome: { base: string | null; files: readonly BaseFile[] } | null = null;
    let roomState = $state<RoomClient | null>(null);

    onDestroy(() => {
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
