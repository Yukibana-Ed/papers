<script lang="ts">
    import type { PlacedSuggestion } from '#lib/model/types.ts';
    import Avatar from '#lib/ui/Avatar.svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import { displayName, type CommentOps } from './ops.ts';

    let { s, ops }: { s: PlacedSuggestion; ops: CommentOps } = $props();

    const session = $derived(ops.session);
    const active = $derived(session.activeThread === s.id);
    let card = $state<HTMLDivElement | null>(null);

    $effect(() => {
        if (active) card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
</script>

<div bind:this={card} class="cm-card sg-card" class:is-active={active} role="button" tabindex="-1" onclick={() => ops.focusItem(s.id)} onkeydown={(e) => e.key === 'Enter' && ops.focusItem(s.id)}>
    <div class="cm-head">
        <Avatar user={session.users[s.author]} />
        <span class="cm-author">{s.author === session.me ? 'You' : displayName(session.users[s.author]?.name)}</span>
        <span class="cm-when">{s.when}</span>
        <span class="grow"></span>
        <button
            type="button"
            class="yk-icon-btn icon-xs"
            onclick={(e) => {
                e.stopPropagation();
                ops.acceptSuggestion(s.id);
            }}
            {...tip('Accept', null, 'applies it as an edit')}
        >
            <Icon name="check" size={14} />
        </button>
        <button
            type="button"
            class="yk-icon-btn icon-xs"
            onclick={(e) => {
                e.stopPropagation();
                ops.rejectSuggestion(s.id);
            }}
            {...tip('Reject')}
        >
            <Icon name="x" size={14} />
        </button>
    </div>
    <div class="cm-sugg">
        {#if s.oldText}<span class="sg-del-t">{s.oldText}</span>{/if}
        {#if s.text}<span class="sg-ins-t">{s.text}</span>{/if}
    </div>
</div>
