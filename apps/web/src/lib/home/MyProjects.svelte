<script lang="ts">
    import { goto } from '$app/navigation';
    import { onMount } from 'svelte';
    import { myProjects, paperKind, type Project } from '#lib/github/projects.ts';
    import { githubToken, SignInNeeded } from '#lib/github/token.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import TooltipLayer from '#lib/ui/TooltipLayer.svelte';
    import { tip } from '#lib/ui/tooltip.ts';

    /** The signed-in start page's list: the repositories the user can open, most recently pushed first, with what each
     *  holds; a search over them that also opens any `owner/repository`; and the App's install page, for more. */
    let { install }: { install: string | null } = $props();

    let projects = $state<Project[] | null>(null);
    let failure = $state<string | null>(null);
    /** The GitHub sign-in ran out (or was revoked): the way forward is signing in again. */
    let signedOut = $state(false);
    let query = $state('');
    let kinds = $state<Record<string, 'papers' | 'latex' | 'typst' | null>>({});

    /** How many repositories, from the top of the list, are looked into for what they hold. */
    const LOOK = 30;

    const visible = $derived(
        (projects ?? []).filter((p) => {
            const q = query.trim().toLowerCase();
            return q === '' || `${p.owner}/${p.name}`.toLowerCase().includes(q);
        }),
    );

    /** `owner/repo`, or a github.com URL of one, as the editor's path; null if it is neither. */
    function target(input: string): string | null {
        const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(input.trim());
        return m ? `/p/${m[1]}/${m[2]}` : null;
    }

    function open(): void {
        const t = target(query) ?? (visible[0] ? `/p/${visible[0].owner}/${visible[0].name}` : null);
        if (t) void goto(t);
    }

    const KIND_LABEL = { papers: 'Papers', latex: 'LaTeX', typst: 'Typst' } as const;

    /** "3 days ago", for when a repository was last pushed to. */
    function ago(ms: number): string {
        if (ms === 0) return '';
        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
        const s = (ms - Date.now()) / 1000;
        for (const [unit, n] of [
            ['year', 31_536_000],
            ['month', 2_592_000],
            ['day', 86_400],
            ['hour', 3600],
            ['minute', 60],
        ] as const)
            if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
        return rtf.format(0, 'minute');
    }

    onMount(() => {
        let cancelled = false;
        void (async () => {
            try {
                const token = await githubToken();
                const list = await myProjects(token);
                if (cancelled) return;
                projects = list;
                // What the most recent ones hold, a few at a time.
                const todo = list.slice(0, LOOK);
                const next = async (): Promise<void> => {
                    for (let p = todo.shift(); p !== undefined; p = todo.shift()) {
                        const kind = await paperKind(token, p.owner, p.name).catch(() => null);
                        if (cancelled) return;
                        kinds[`${p.owner}/${p.name}`] = kind;
                    }
                };
                await Promise.all(Array.from({ length: 6 }, next));
            } catch (e) {
                if (cancelled) return;
                signedOut = e instanceof SignInNeeded;
                failure = e instanceof Error ? e.message : 'GitHub did not answer';
            }
        })();
        return () => {
            cancelled = true;
        };
    });
</script>

<section class="projects" aria-label="Projects">
    <form
        class="find"
        onsubmit={(e) => {
            e.preventDefault();
            open();
        }}
    >
        <input class="yk-input" placeholder="owner/repository" aria-label="Find a repository" bind:value={query} />
        <button class="yk-btn yk-btn--primary" type="submit" disabled={target(query) === null && visible.length === 0}>Open</button>
    </form>
    {#if failure !== null}
        <p class="state" role="alert">
            {#if signedOut}<a class="yk-btn yk-btn--primary" href="/auth/login">Sign in with GitHub</a>{:else}{failure}{/if}
        </p>
    {:else if projects === null}
        <p class="state"><span class="yk-spinner" role="status" aria-label="Loading projects"></span></p>
    {:else if projects.length === 0}
        <p class="state">
            {#if install}<a class="yk-btn yk-btn--secondary" href={install}>Install on GitHub</a>{/if}
        </p>
    {:else}
        <ul class="list">
            {#each visible as p (`${p.owner}/${p.name}`)}
                {@const kind = kinds[`${p.owner}/${p.name}`]}
                <li>
                    <a class="row" href="/p/{p.owner}/{p.name}">
                        <span class="name"><span class="owner">{p.owner}/</span>{p.name}</span>
                        {#if kind}<span class="yk-chip" class:yk-chip--violet={kind === 'typst'} class:yk-chip--blue={kind !== 'typst'}>{KIND_LABEL[kind]}</span>{/if}
                        {#if !p.push}<span class="yk-chip" {...tip('Read only', null, 'you cannot push to it')}>read</span>{/if}
                        {#if p.private}<span class="muted" {...tip('Private')}>private</span>{/if}
                        <span class="grow"></span>
                        <span class="muted when">{ago(p.pushed)}</span>
                    </a>
                </li>
            {/each}
        </ul>
        {#if install}<a class="more yk-btn yk-btn--ghost btn-sm" href={install} {...tip('Add repositories', null, 'install the app on more of them')}><Icon name="plus" size={14} />Add repositories</a>{/if}
    {/if}
</section>
<TooltipLayer />

<style>
    .projects {
        display: grid;
        gap: 10px;
        width: min(560px, 100%);
        text-align: left;
    }
    .find {
        display: flex;
        gap: 8px;
    }
    .find input {
        flex: 1;
        min-width: 0;
    }
    .state {
        display: flex;
        justify-content: center;
        margin: 12px 0;
        color: var(--yk-soft);
    }
    .list {
        display: grid;
        margin: 0;
        padding: 4px;
        list-style: none;
        border: 1px solid var(--yk-line);
        border-radius: var(--yk-radius-md);
        background: var(--yk-surface);
        max-height: min(60vh, 520px);
        overflow: auto;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
        border-radius: var(--yk-radius-sm);
        color: var(--yk-ink);
        text-decoration: none;
    }
    .row:hover,
    .row:focus-visible {
        background: var(--yk-sunken);
    }
    .row:focus-visible {
        outline: var(--yk-focus-width, 2px) solid var(--yk-ink);
        outline-offset: -2px;
    }
    .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: var(--yk-font-weight-semibold);
    }
    .owner {
        color: var(--yk-soft);
        font-weight: var(--yk-font-weight-regular);
    }
    .grow {
        flex: 1;
    }
    .muted {
        color: var(--yk-soft);
        font-size: var(--yk-font-size-xs);
        white-space: nowrap;
    }
    .more {
        justify-self: start;
    }
</style>
