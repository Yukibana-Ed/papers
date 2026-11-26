<script lang="ts">
    import type { Comment, Thread } from '#lib/model/types.ts';
    import Avatar from '#lib/ui/Avatar.svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import CommentBody from './CommentBody.svelte';
    import { plainText } from './markdown.ts';
    import CommentNode from './CommentNode.svelte';
    import Composer from './Composer.svelte';
    import { displayName, type CommentOps } from './ops.ts';

    /** One comment and its replies. Every comment with replies is a level with its own resolved state; the display
     *  indents two levels and keeps deeper replies at the second indent, with who they answer. A GitHub thread is
     *  flat: one level, resolved as a whole. */
    let { c, depth, parent = null, thread, ops, flat }: { c: Comment; depth: number; parent?: Comment | null; thread: Thread; ops: CommentOps; flat: boolean } = $props();

    let replying = $state(false);
    let unfolded = $state(false);
    const users = $derived(ops.session.users);
    const isRoot = $derived(depth === 0);
    const isLevel = $derived(isRoot || c.replies.length > 0 || depth === 1);
    const openReplies = $derived(c.replies.filter((r) => !r.resolved).length);
</script>

{#if c.resolved && !unfolded && !isRoot}
    <div class="cm-node folded d{Math.min(depth, 2)}">
        <button
            type="button"
            class="cm-fold"
            onclick={(e) => {
                e.stopPropagation();
                unfolded = true;
            }}
            {...tip('Show', null, 'resolved')}
        >
            <Icon name="check" size={12} />
            <Avatar user={users[c.author]} size={16} />
            <span class="cm-fold-text">{plainText(c.body)}</span>
            {#if c.replies.length > 0}<span class="cm-fold-n">+{c.replies.length}</span>{/if}
        </button>
    </div>
{:else}
    <div class="cm-node d{Math.min(depth, 2)}" class:is-resolved={c.resolved}>
        <div class="cm-head">
            <Avatar user={users[c.author]} />
            <span class="cm-author">{displayName(users[c.author]?.name)}</span>
            <span class="cm-when">{c.when}</span>
            <span class="grow"></span>
            {#if isRoot && !flat && c.replies.length > 0 && !c.resolved}
                <span class="cm-count" {...tip(`${openReplies} of ${c.replies.length} open`, null, 'replies still unresolved')}>{openReplies}/{c.replies.length}</span>
            {/if}
            {#if flat ? isRoot : isLevel}
                <button
                    type="button"
                    class="yk-icon-btn icon-xs"
                    onclick={(e) => {
                        e.stopPropagation();
                        ops.session.resolve(thread.id, c.id, !c.resolved);
                        unfolded = false;
                    }}
                    {...tip(c.resolved ? 'Reopen' : 'Resolve', null, flat ? 'on GitHub' : isRoot ? 'closes the whole thread' : 'closes this reply and its answers')}
                >
                    <Icon name={c.resolved ? 'undo' : 'check'} size={14} />
                </button>
            {/if}
        </div>
        {#if depth > 2 && parent}
            <div class="cm-replying">↳ {displayName(users[parent.author]?.name)}</div>
        {/if}
        <CommentBody markdown={c.body} />
        {#if c.replacement !== undefined}
            <div class="cm-sugg">
                <span class="sg-del-t">{thread.quote}</span>
                <span class="sg-ins-t">{c.replacement}</span>
                {#if !c.resolved}
                    <button
                        type="button"
                        class="yk-icon-btn icon-xs"
                        onclick={(e) => {
                            e.stopPropagation();
                            ops.acceptReplacement(thread.id, c.id);
                        }}
                        {...tip('Accept', null, 'applies it and resolves this reply')}
                    >
                        <Icon name="check" size={14} />
                    </button>
                {/if}
            </div>
        {/if}
        <!-- The thread's own reply field is at its bottom; here, replying to one reply starts a sub-thread. -->
        {#if !flat && !c.resolved && !isRoot}
            <div class="cm-actions">
                <button
                    type="button"
                    class="cm-link"
                    onclick={(e) => {
                        e.stopPropagation();
                        replying = true;
                    }}
                    {...tip('Reply', null, 'starts a sub-thread')}>Reply</button
                >
            </div>
        {/if}
        {#if replying}
            <Composer
                autofocus
                placeholder="Reply to {displayName(users[c.author]?.name)}"
                onCancel={() => (replying = false)}
                onSend={(t) => {
                    ops.session.reply(thread.id, c.id, t);
                    replying = false;
                }}
            />
        {/if}
        {#each c.replies as r (r.id)}
            <CommentNode c={r} depth={depth + 1} parent={c} {thread} {ops} {flat} />
        {/each}
    </div>
{/if}
