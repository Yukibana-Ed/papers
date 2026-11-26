<script lang="ts">
    import { dialogFocus } from '#lib/ui/focus.ts';
    import { keepInView } from '#lib/ui/place.ts';
    import type { Session } from '#lib/session.svelte.ts';
    import Avatar from '#lib/ui/Avatar.svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';

    let { session: s }: { session: Session } = $props();
    let adding = $state(false);
    let name = $state('');
</script>

<div class="popover pop-branch" role="dialog" {@attach keepInView} {@attach dialogFocus} aria-label="Branches">
    {#each s.branchNames as n (n)}
        {@const b = s.branches[n]}
        <button type="button" class="row-btn" class:is-current={n === s.branch} onclick={() => s.switchBranch(n)}>
            <Icon name={n === s.branch ? 'check' : 'branch'} size={14} />
            <span class="mono">{n}</span>
            <span class="grow"></span>
            {#if b?.pr}<span class="muted">#{b.pr.number}</span>{/if}
            <span class="avatars">
                {#each b?.users ?? [] as u (u)}<Avatar user={s.users[u]} size={16} />{/each}
            </span>
        </button>
    {/each}
    <div class="pop-sep"></div>
    {#if adding}
        <!-- svelte-ignore a11y_autofocus -->
        <input
            autofocus
            class="yk-input mono"
            placeholder="branch-name"
            value={name}
            oninput={(e) => (name = e.currentTarget.value.replace(/\s+/g, '-'))}
            onkeydown={(e) => e.key === 'Enter' && s.newBranch(name.trim())}
            aria-label="Branch name"
        />
    {:else}
        <button type="button" class="row-btn" onclick={() => (adding = true)} {...tip('New branch', null, `from ${s.branch}`)}>
            <Icon name="plus" size={14} />
            New branch
        </button>
    {/if}
</div>
