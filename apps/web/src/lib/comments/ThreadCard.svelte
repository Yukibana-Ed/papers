<script lang="ts">
    import type { Thread } from '#lib/model/types.ts';
    import Avatar from '#lib/ui/Avatar.svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import CommentNode from './CommentNode.svelte';
    import Composer from './Composer.svelte';
    import ReplyField from './ReplyField.svelte';
    import { plainText } from './markdown.ts';
    import type { CommentOps } from './ops.ts';

    let { t, ops }: { t: Thread; ops: CommentOps } = $props();

    const session = $derived(ops.session);
    const active = $derived(session.activeThread === t.id);
    const flat = $derived(t.source === 'github');
    // svelte-ignore state_referenced_locally
    let target = $state<'team' | 'github'>(session.pr ? 'github' : 'team');
    let card = $state<HTMLDivElement | null>(null);

    $effect(() => {
        if (active) card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    function focus(): void {
        ops.focusItem(t.id);
    }
</script>

{#if t.draft}
    <div bind:this={card} class="cm-card is-active">
        <div class="cm-quote"><span>{t.quote}</span></div>
        <Composer autofocus placeholder="Comment" allowTarget={session.pr !== null} bind:target onCancel={() => session.cancelDraft(t.id)} onSend={(text) => session.post(t.id, text, target)} />
    </div>
{:else if t.root.resolved}
    <div bind:this={card} class="cm-card is-resolved" class:is-active={active} role="button" tabindex="-1" onclick={focus} onkeydown={(e) => e.key === 'Enter' && focus()}>
        <div class="cm-resolved-row">
            <Icon name="check" size={12} />
            <Avatar user={session.users[t.root.author]} size={16} />
            <span class="cm-fold-text">{plainText(t.root.body)}</span>
            <button
                type="button"
                class="yk-icon-btn icon-xs"
                onclick={(e) => {
                    e.stopPropagation();
                    session.resolve(t.id, t.root.id, false);
                }}
                {...tip('Reopen')}
            >
                <Icon name="undo" size={14} />
            </button>
        </div>
    </div>
{:else}
    <div bind:this={card} class="cm-card" class:is-active={active} class:is-gh={flat} role="button" tabindex="-1" onclick={focus} onkeydown={(e) => e.key === 'Enter' && e.target === card && focus()}>
        <div class="cm-quote">
            {#if flat}<span class="gh-badge" {...tip('GitHub review thread', null, 'flat, resolved as a whole')}><Icon name="github" size={11} /></span>{/if}
            <span>{t.quote}</span>
        </div>
        <CommentNode c={t.root} depth={0} thread={t} {ops} {flat} />
        <ReplyField placeholder={flat ? 'Reply on GitHub' : 'Reply'} onSend={(text) => session.reply(t.id, t.root.id, text)} />
    </div>
{/if}
