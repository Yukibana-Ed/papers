<script lang="ts">
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import type { CommentOps } from './ops.ts';
    import SuggestionCard from './SuggestionCard.svelte';
    import ThreadCard from './ThreadCard.svelte';

    /** The comments panel: threads and suggestions in document order, with a file heading where the file changes.
     *  Loaded only when first opened, with the comment editor and the Markdown reader it uses. */
    let { ops }: { ops: CommentOps } = $props();
    const s = $derived(ops.session);
    const short = (f: string): string => f.split('/').pop() ?? f;
</script>

<div class="panel-head">
    {#if s.pr}
        <div class="yk-segmented seg-xs" role="group" aria-label="Show">
            <button type="button" aria-pressed={s.commentFilter === 'all'} onclick={() => (s.commentFilter = 'all')} {...tip('All')}>All</button>
            <button type="button" aria-pressed={s.commentFilter === 'team'} onclick={() => (s.commentFilter = 'team')} {...tip('Team', null, 'notes in Yukibana')}>Team</button>
            <button type="button" aria-pressed={s.commentFilter === 'github'} onclick={() => (s.commentFilter = 'github')} {...tip('GitHub', null, `review of #${s.pr.number}`)}>GitHub</button>
        </div>
    {:else}
        <span>Comments</span>
    {/if}
    <span class="grow"></span>
    {#if s.resolvedCount > 0}
        <button type="button" class="yk-btn yk-btn--ghost btn-xs" aria-pressed={s.showResolved} onclick={() => (s.showResolved = !s.showResolved)} {...tip(s.showResolved ? 'Hide resolved' : 'Show resolved')}>
            <Icon name="check" size={12} />
            {s.resolvedCount}
        </button>
    {/if}
    <button type="button" class="yk-icon-btn icon-xs" onclick={() => ops.newComment()} {...tip('Comment', 'Ctrl+Alt+M', 'on the selection')}>
        <Icon name="plus" size={14} />
    </button>
</div>
<div class="cm-list">
    {#if s.items.length === 0}
        <div class="empty-mini">No comments</div>
    {/if}
    {#each s.items as it, i (it.id)}
        <div>
            {#if i === 0 || s.items[i - 1]?.file !== it.file}
                <div class="cm-file mono">{short(it.file)}</div>
            {/if}
            {#if it.kind === 'thread'}
                <ThreadCard t={it.thread} {ops} />
            {:else}
                <SuggestionCard s={it.suggestion} {ops} />
            {/if}
        </div>
    {/each}
</div>
