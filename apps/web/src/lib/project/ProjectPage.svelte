<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import type { BaseFile } from '@yukibana/papers-room/protocol';
    import type { User } from '#lib/model/types.ts';
    import { RoomClient } from '#lib/room/client.ts';
    import { syncReview } from '#lib/room/sync.svelte.ts';
    import { Session } from '#lib/session.svelte.ts';
    import Workbench from '#lib/shell/Workbench.svelte';
    import { LoadError, loadProject, type LoadedProject } from './load.ts';

    /** A repository's branch in the editor: read it from GitHub, join its room, then show the workbench. */
    let { owner, repo, branch, me, contentOrigin }: { owner: string; repo: string; branch: string | null; me: { login: string; name: string }; contentOrigin: string } = $props();

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

    function start(p: LoadedProject, r: RoomClient, base: string | null, baseFiles: readonly BaseFile[]): void {
        const files: Record<string, string> = {};
        for (const [path, text] of r.files) files[path] = text.toJSON();
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
        });
        let head = base ?? p.commit;
        s.backend = {
            async commit(message, changes) {
                const res = await fetch(`/api/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/commit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ branch: p.branch, head, message, changes }),
                });
                if (res.status === 409) throw new Error('Someone pushed to this branch: pull first');
                if (!res.ok) throw new Error(`GitHub refused the commit (${res.status})`);
                const { commit } = (await res.json()) as { commit: string };
                head = commit;
                r.committed(commit, changes.filter((c) => c.text !== null).map((c) => ({ path: c.path, blob: '', text: c.text ?? '' })));
                return commit;
            },
        };
        stopSync = syncReview(s, r);
        session = s;
    }

    onMount(() => {
        let cancelled = false;
        void (async () => {
            try {
                const p = await loadProject(owner, repo, branch, (done, total) => (progress = { done, total }));
                if (cancelled) return;
                const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const r = new RoomClient(`${proto}//${location.host}/room/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/${encodeURIComponent(p.branch)}`, {
                    welcome: (_you, base, files) => {
                        welcome = { base, files };
                    },
                    base: () => {},
                    sync: () => {},
                    synced: () => {
                        if (session || !welcome) return;
                        const w = welcome;
                        if (w.base !== null && w.base !== p.commit) {
                            // The room's session started at an older commit and someone pushed since: work on the room's
                            // state; committing asks to pull first.
                        } else if (p.access === 'write') {
                            for (const [path, v] of p.texts) if (!r.files.has(path)) r.open(path, v.blob, v.text, p.commit);
                        }
                        // The files appear once the room has created them.
                        const ready = (): boolean => [...p.texts.keys()].every((path) => r.files.has(path)) || p.access !== 'write' || (w.base !== null && w.base !== p.commit);
                        const go = (): void => {
                            if (!session && ready()) {
                                r.files.unobserve(go);
                                start(p, r, w.base, w.files);
                            }
                        };
                        r.files.observe(go);
                        go();
                    },
                    backupDue: () => {
                        const s = session;
                        if (!s) return;
                        const changes = s.changes.map((c) => ({ path: c.file, text: s.files[c.file] ?? null }));
                        void fetch(`/api/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/wip`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ branch: p.branch, head: welcome?.base ?? p.commit, changes }),
                        })
                            .then(async (res) => (res.ok ? ((await res.json()) as { commit: string }) : null))
                            .then((b) => b && r.backedUp(b.commit));
                    },
                    connection: () => {},
                    refused: (reason) => session?.flash(reason === 'paused' ? 'Live sync paused for today' : `Refused: ${reason}`),
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
