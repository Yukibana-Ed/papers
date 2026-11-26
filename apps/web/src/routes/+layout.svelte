<script lang="ts">
    import '@yukibana/design/tokens.css';
    import '@yukibana/design/fonts.css';
    import '@yukibana/design/base.css';
    import '../app.css';
    import type { Snippet } from 'svelte';
    import { THEME_SCRIPT } from '#lib/theme-script.ts';

    let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
    {@html THEME_SCRIPT}
</svelte:head>

{@render children()}
