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

    // What the policy blocks is named in the console with where it came from and how it starts: the browser's own
    // message gives only a hash, which does not say whether the script is the app's, the network's or an extension's.
    if (typeof document !== 'undefined')
        document.addEventListener('securitypolicyviolation', (e) => {
            console.warn(`Blocked by the page's policy (${e.effectiveDirective}): ${e.blockedURI} from ${e.sourceFile || 'the page'}:${e.lineNumber}:${e.columnNumber}, starting ${JSON.stringify(e.sample)}`);
        });

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
