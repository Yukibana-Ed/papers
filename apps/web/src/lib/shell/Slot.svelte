<script lang="ts" generics="T">
    import type { Snippet } from 'svelte';

    /** Renders `part` with `arg`: what `mount` puts in an element made outside a component (a dock panel, a tab), so
     *  the part stays written, and reactive, where the rest of the component is. */
    let { part, arg }: { part: Snippet<[T]>; arg: T } = $props();
</script>

{@render part(arg)}
