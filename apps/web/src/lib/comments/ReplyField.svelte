<script lang="ts">
    import Composer from './Composer.svelte';

    /** The reply affordance at the bottom of every open thread and suggestion: always visible (never hover-only, so it
     *  works on touch and with the keyboard), a one-line field until it is used, then the composer. */
    let { placeholder, onSend }: { placeholder: string; onSend: (markdown: string) => void } = $props();
    let open = $state(false);
</script>

{#if open}
    <Composer
        autofocus
        {placeholder}
        onCancel={() => (open = false)}
        onSend={(text) => {
            onSend(text);
            open = false;
        }}
    />
{:else}
    <button
        type="button"
        class="cm-reply-field"
        onclick={(e) => {
            e.stopPropagation();
            open = true;
        }}
    >
        {placeholder}
    </button>
{/if}
