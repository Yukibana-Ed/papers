<script lang="ts">
    import type { Session } from '#lib/session.svelte.ts';
    import Avatar from '#lib/ui/Avatar.svelte';
    import Icon from '#lib/ui/Icon.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import BranchMenu from './BranchMenu.svelte';

    /** The one thin row at the top: project, branch, head commit, what is uncommitted, the pull request, and the
     *  actions: Suggest, Commit, Commands. */
    let { session: s, onOpenFile, onPalette, onShowReview }: { session: Session; onOpenFile: (f: string) => void; onPalette: () => void; onShowReview: () => void } = $props();
</script>

<header class="bar">
    <a class="brand" href="/" {...tip('Projects', null, 'back to all papers')}>
        <img src="/logo.svg" alt="" width="18" height="18" />
    </a>
    <span class="proj" {...tip(s.repo.name, null, `${s.repo.owner}/${s.repo.name}`)}>{s.repo.name}</span>

    {#if s.branchNames.length > 1}
        <span class="anchor">
            <button type="button" class="chip-btn" class:is-open={s.popover === 'branch'} data-popover-anchor onclick={() => s.togglePopover('branch')} {...tip('Branch', null, `switches session · git switch ${s.branch}`)}>
                <Icon name="branch" size={14} />
                <span>{s.branch}</span>
                {#if s.others.length > 0}
                    <span class="avatars">
                        {#each s.others as u (u)}<Avatar user={s.users[u]} size={16} />{/each}
                    </span>
                {/if}
                <Icon name="chevron" size={12} />
            </button>
            {#if s.popover === 'branch'}<BranchMenu session={s} />{/if}
        </span>
    {/if}
    <span class="anchor">
        <button type="button" class="chip-btn mono" class:is-open={s.popover === 'log'} data-popover-anchor onclick={() => s.togglePopover('log')} {...tip(`Head ${s.head.hash}`, null, 'on GitHub · git pull to get it')}>
            <Icon name="commit" size={14} />
            {s.head.hash}
        </button>
        {#if s.popover === 'log'}
            <div class="popover pop-log" role="dialog" aria-label="Log">
                {#each s.commits.slice(0, 8) as c, i (c.hash + i)}
                    <div class="log-row">
                        <span class="mono hash">{c.hash}</span>
                        <span class="log-msg">{c.msg}</span>
                        <Avatar user={s.users[c.author]} size={16} />
                        <span class="muted">{c.when}</span>
                    </div>
                {/each}
            </div>
        {/if}
    </span>
    {#if s.uncommitted > 0}
        <span class="yk-chip yk-chip--yellow pending" {...tip(`${s.uncommitted} uncommitted`, null, 'session edits your clone cannot see')}>+{s.uncommitted}</span>
    {/if}
    {#if s.incoming > 0}
        <span class="yk-chip yk-chip--blue incoming" {...tip(`${s.incoming} incoming`, null, 'pushed outside the session, merged')}>
            <Icon name="down" />
            {s.incoming} incoming
        </span>
    {/if}
    {#if s.pr}
        <button type="button" class="chip-btn" onclick={onShowReview} {...tip(`PR #${s.pr.number}`, null, s.pr.title)}>
            <Icon name="pr" size={14} />#{s.pr.number}
            <span class="pr-ok"><Icon name="check" size={11} /></span>
        </button>
    {/if}

    <span class="grow"></span>

    <div class="yk-segmented seg-xs narrow-only" role="group" aria-label="Pane">
        <button type="button" aria-pressed={s.narrowPane === 'source'} onclick={() => (s.narrowPane = 'source')} {...tip('Source', 'Ctrl+J')}>Source</button>
        <button type="button" aria-pressed={s.narrowPane === 'preview'} onclick={() => (s.narrowPane = 'preview')} {...tip('Preview', 'Ctrl+J')}>Preview</button>
    </div>

    <button type="button" class="yk-btn yk-btn--ghost btn-sm" aria-pressed={s.suggestMode} onclick={() => (s.suggestMode = !s.suggestMode)} {...tip(s.suggestMode ? 'Suggesting' : 'Suggest', 'Ctrl+Alt+S', 'edits become suggestions')}>
        <Icon name="suggest" size={14} />
        <span class="hide-sm">{s.suggestMode ? 'Suggesting' : 'Suggest'}</span>
    </button>
    <button
        type="button"
        class="yk-btn yk-btn--primary btn-sm"
        data-popover-anchor
        data-done={s.justCommitted ? '' : undefined}
        disabled={!s.uncommitted && !s.justCommitted}
        onclick={() => s.togglePopover('commit')}
        {...tip('Commit', 'Ctrl+S', `push session changes to ${s.branch}`)}
    >
        {s.justCommitted ? '✓ Committed' : 'Commit'}
    </button>
    <button type="button" class="yk-icon-btn" onclick={onPalette} {...tip('Commands', 'Ctrl+K')}>
        <Icon name="command" />
    </button>

    {#if s.popover === 'commit'}
        <div class="popover pop-commit" role="dialog" aria-label="Commit">
            <!-- svelte-ignore a11y_autofocus -->
            <input autofocus class="yk-input" placeholder={s.defaultCommitMessage} bind:value={s.commitMessage} onkeydown={(e) => e.key === 'Enter' && s.commit()} aria-label="Message" />
            <ul class="changes">
                {#each s.changes as c (c.file)}
                    <li>
                        <button
                            type="button"
                            class="row-btn"
                            onclick={() => {
                                onOpenFile(c.file);
                                s.popover = null;
                            }}
                            {...tip(c.file, null, 'open')}
                        >
                            <span class="mono">{c.file}</span>
                            <span class="grow"></span>
                            {#if c.add > 0}<span class="add">+{c.add}</span>{/if}
                            {#if c.del > 0}<span class="del">−{c.del}</span>{/if}
                        </button>
                    </li>
                {/each}
            </ul>
            <div class="pop-row">
                <span class="muted mono">{s.branch}</span>
                <span class="grow"></span>
                <button type="button" class="yk-btn yk-btn--primary btn-sm" onclick={() => s.commit()} {...tip('Commit and push', 'Enter')}>Commit</button>
            </div>
        </div>
    {/if}
</header>
