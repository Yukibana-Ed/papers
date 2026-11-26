<script lang="ts">
    import { goto } from '$app/navigation';
    import { asText } from '@yukibana/papers-templates';
    import { takePending, type PendingPaper } from '#lib/newpaper/pending.ts';
    import { Session } from '#lib/session.svelte.ts';
    import Workbench from '#lib/shell/Workbench.svelte';
    import type { PageProps } from './$types';

    /** A new paper opened without saving it ("Open here"): the editor on its files, nothing committed anywhere. */
    let { data }: PageProps = $props();

    function sessionOf(p: PendingPaper): Session {
        const files: Record<string, string> = {};
        const assets: Record<string, Uint8Array> = {};
        for (const f of p.files) {
            const text = asText(f.bytes);
            if (text === null) assets[f.path] = f.bytes;
            else files[f.path] = text;
        }
        const me = { id: 'you', name: 'You', initials: 'Y', hue: 178 };
        const order = Object.keys(files).toSorted((a, b) => (a === p.root ? -1 : b === p.root ? 1 : a.localeCompare(b)));
        const s = new Session({
            repo: { owner: 'unsaved', name: p.name },
            me: me.id,
            users: { you: me },
            files,
            order,
            base: files,
            branches: { main: { name: 'main', users: ['you'], pr: null } },
            branch: 'main',
            commits: [{ hash: '0000000', author: 'you', when: '', msg: '' }],
            threads: [],
            presence: [],
            assets,
        });
        s.openFile(p.root);
        return s;
    }

    const pending = takePending();
    const session = pending ? sessionOf(pending) : null;
    if (!pending) void goto('/new');
</script>

<svelte:head><title>{pending?.name ?? 'New paper'} · Yukibana Papers</title></svelte:head>

{#if session}
    <Workbench {session} contentOrigin={data.contentOrigin} />
{/if}
