<script lang="ts">
    import '@yukibana/design/tokens.css';
    import '@yukibana/design/fonts.css';
    import '@yukibana/design/base.css';
    import '../app.css';
    import type { Snippet } from 'svelte';
    import { goto } from '$app/navigation';
    import { setPending, type PendingPaper } from '#lib/newpaper/pending.ts';
    import { THEME_SCRIPT } from '#lib/theme-script.ts';

    let { children }: { children: Snippet } = $props();

    // Development only (gone from builds): opens a project from a script, for the preview's sync-accuracy probe
    // (scratch tooling drives it with Playwright against the dev servers).
    if (import.meta.env.DEV && typeof window !== 'undefined')
        Object.assign(window, {
            papersOpen: (p: PendingPaper): void => {
                setPending(p);
                void goto('/try');
            },
        });
</script>

<svelte:head>
    {@html THEME_SCRIPT}
</svelte:head>

{@render children()}
