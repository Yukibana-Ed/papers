<script lang="ts">
    import { goto } from '$app/navigation';
    import {
        galleryTemplate,
        galleryUrl,
        loadGallery,
        planFiles,
        repoTemplate,
        repositoryName,
        safeFolder,
        universeTemplate,
        zipTemplate,
        type GalleryEntry,
        type Template,
    } from '@yukibana/papers-templates';
    import { onMount } from 'svelte';
    import { githubToken, session as githubSession, SignInNeeded, type Viewer } from '#lib/github/token.ts';
    import { ownInstallation, writableRepos, type RepoSummary } from '#lib/github/repos.ts';
    import Icon from '#lib/ui/Icon.svelte';
    import TooltipLayer from '#lib/ui/TooltipLayer.svelte';
    import { tip } from '#lib/ui/tooltip.ts';
    import { createPaper, newRepositoryUrl, waitForRepository } from './create.ts';
    import { setPending } from './pending.ts';

    /** New paper: pick a template (the gallery, a repository, a Typst Universe package or a .zip), name it, choose where
     *  it goes, Create. `initial` preselects a source: `owner/repo/folder` or `@preview/name:version`. */
    let { initial = null, signInConfigured }: { initial?: string | null; signInConfigured: boolean } = $props();

    type SourceKind = 'gallery' | 'repository' | 'universe' | 'import';
    // svelte-ignore state_referenced_locally
    let source = $state<SourceKind>(initial?.startsWith('@preview/') ? 'universe' : initial ? 'repository' : 'gallery');
    let gallery = $state<{ commit: string; templates: GalleryEntry[] } | null>(null);
    let formatFilter = $state<'all' | 'latex' | 'typst'>('all');
    let selectedId = $state<string | null>(null);
    // svelte-ignore state_referenced_locally
    let link = $state(initial && !initial.startsWith('@preview/') ? initial : '');
    // svelte-ignore state_referenced_locally
    let spec = $state(initial?.startsWith('@preview/') ? initial : '');
    let loaded = $state<Template | null>(null);
    let loading = $state(false);
    let failure = $state<string | null>(null);

    let title = $state('');
    let me = $state<Viewer | null>(null);
    let repos = $state<RepoSummary[]>([]);
    let target = $state<'repository' | 'folder' | 'here'>('here');
    let visibility = $state<'private' | 'public'>('private');
    let repoChoice = $state('');
    let folder = $state('');
    let folderTouched = $state(false);
    let busy = $state<string | null>(null);
    let waiting = $state<{ url: string; access: string | null } | null>(null);
    let abort: AbortController | null = null;

    const visible = $derived(gallery?.templates.filter((t) => formatFilter === 'all' || t.format === formatFilter) ?? []);
    const selected = $derived(source === 'gallery' ? (gallery?.templates.find((t) => t.id === selectedId) ?? null) : null);
    const chosen = $derived(source === 'gallery' ? selected : loaded);
    const slug = $derived(repositoryName(title || 'paper').toLowerCase());
    const repo = $derived(repos.find((r) => `${r.owner}/${r.name}` === repoChoice) ?? null);
    const ready = $derived(chosen !== null && title.trim() !== '' && busy === null && (target !== 'folder' || (repo !== null && safeFolder(folder) !== null)));

    $effect(() => {
        if (!folderTouched) folder = slug;
    });

    onMount(() => {
        void loadGallery().then(
            (g) => {
                gallery = g;
                selectedId ??= g.templates[0]?.id ?? null;
            },
            () => (failure = 'The gallery did not load'),
        );
        void githubSession().then(
            async (s) => {
                me = s.viewer;
                target = 'repository';
                repos = await writableRepos(s.token).catch(() => []);
                repoChoice = repos[0] ? `${repos[0].owner}/${repos[0].name}` : '';
            },
            (e: unknown) => {
                if (!(e instanceof SignInNeeded)) failure = 'GitHub did not answer';
            },
        );
        if (initial) void load();
    });

    async function load(file?: File): Promise<void> {
        loading = true;
        failure = null;
        loaded = null;
        try {
            if (source === 'repository') loaded = await repoTemplate(link, me ? await githubToken() : null);
            else if (source === 'universe') loaded = await universeTemplate(spec);
            else if (source === 'import' && file) loaded = await zipTemplate(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.zip$/i, ''));
            if (loaded && !title) title = loaded.info.name;
        } catch (e) {
            failure = e instanceof Error ? e.message : 'Could not read the template';
        } finally {
            loading = false;
        }
    }

    async function template(): Promise<Template> {
        if (source !== 'gallery') {
            if (!loaded) throw new Error('No template');
            return loaded;
        }
        if (!selected || !gallery) throw new Error('No template');
        return galleryTemplate(selected, gallery.commit);
    }

    async function create(): Promise<void> {
        failure = null;
        const authors = me ? [me.name] : [];
        try {
            busy = 'template';
            const t = await template();
            if (target === 'here') {
                const plan = planFiles(t, { folder: '', title, authors });
                setPending({ name: title, files: plan.files, root: plan.root });
                await goto('/try');
                return;
            }
            if (!me) throw new Error('Sign in');
            if (target === 'folder') {
                if (!repo) throw new Error('Pick a repository');
                busy = 'commit';
                const c = await createPaper(await githubToken(), t, { owner: repo.owner, repo: repo.name, branch: repo.defaultBranch, folder }, { title, authors });
                await goto(`/p/${c.owner}/${c.repo}?branch=${encodeURIComponent(c.branch)}&root=${encodeURIComponent(c.root)}`);
                return;
            }
            // A new repository: GitHub's own page creates it; this page waits for it, then commits the paper.
            const d = { kind: 'repository' as const, owner: me.login, name: slug, visibility };
            const url = newRepositoryUrl(d, title);
            window.open(url, '_blank', 'noopener');
            const install = await ownInstallation(await githubToken(), me.login);
            waiting = { url, access: install?.selected ? `https://github.com/settings/installations/${install.id}` : null };
            busy = 'repository';
            abort = new AbortController();
            const r = await waitForRepository(githubToken, me.login, slug, abort.signal);
            busy = 'commit';
            const c = await createPaper(await githubToken(), t, { owner: me.login, repo: slug, branch: r.defaultBranch, folder: '' }, { title, authors });
            waiting = null;
            await goto(`/p/${c.owner}/${c.repo}?branch=${encodeURIComponent(c.branch)}&root=${encodeURIComponent(c.root)}`);
        } catch (e) {
            if (!(e instanceof DOMException && e.name === 'AbortError')) failure = e instanceof Error ? e.message : 'Could not create the paper';
            waiting = null;
        } finally {
            busy = null;
        }
    }

    function cancelWait(): void {
        abort?.abort();
        waiting = null;
        busy = null;
    }

    const formatName = (f: string): string => (f === 'typst' ? 'Typst' : 'LaTeX');
</script>

<div class="np">
    <header class="np-bar">
        <a class="brand" href="/" {...tip('Projects', null, 'back to all papers')}><img src="/logo.svg" alt="" width="18" height="18" /></a>
        <h1 class="np-title">New paper</h1>
        <span class="grow"></span>
        <div class="yk-segmented seg-xs" role="group" aria-label="Template from">
            <button type="button" aria-pressed={source === 'gallery'} onclick={() => (source = 'gallery')} {...tip('Gallery', null, 'templates that build as they are')}>Gallery</button>
            <button type="button" aria-pressed={source === 'repository'} onclick={() => (source = 'repository')} {...tip('Repository', null, 'any GitHub repository or folder')}>Repository</button>
            <button type="button" aria-pressed={source === 'universe'} onclick={() => (source = 'universe')} {...tip('Typst Universe', null, 'a template package')}>Typst Universe</button>
            <button type="button" aria-pressed={source === 'import'} onclick={() => (source = 'import')} {...tip('Import', null, 'a .zip, such as an Overleaf export')}>Import</button>
        </div>
    </header>

    <main class="np-body">
        {#if source === 'gallery'}
            <div class="np-filter">
                <div class="yk-segmented seg-xs" role="group" aria-label="Format">
                    <button type="button" aria-pressed={formatFilter === 'all'} onclick={() => (formatFilter = 'all')} {...tip('All')}>All</button>
                    <button type="button" aria-pressed={formatFilter === 'latex'} onclick={() => (formatFilter = 'latex')} {...tip('LaTeX')}>LaTeX</button>
                    <button type="button" aria-pressed={formatFilter === 'typst'} onclick={() => (formatFilter = 'typst')} {...tip('Typst')}>Typst</button>
                </div>
            </div>
            {#if !gallery}
                <div class="np-empty"><span class="yk-spinner" role="status" aria-label="Loading"></span></div>
            {:else}
                <ul class="np-grid" aria-label="Templates">
                    {#each visible as t (t.id)}
                        <li>
                            <button
                                type="button"
                                class="np-card"
                                aria-pressed={t.id === selectedId}
                                onclick={() => {
                                    selectedId = t.id;
                                }}
                                ondblclick={() => void create()}
                                {...tip(t.name, null, t.licence === '0BSD' ? 'free to use, no notice' : t.licence)}
                            >
                                <span class="np-thumb" class:wide={t.category === 'slides'}><img src={galleryUrl(gallery.commit, `${t.id}/${t.thumbnail}`)} alt="" crossorigin="anonymous" loading="lazy" /></span>
                                <span class="np-card-row">
                                    <span class="np-card-name">{t.name}</span>
                                    <span class="yk-chip {t.format === 'typst' ? 'yk-chip--teal' : 'yk-chip--blue'}">{formatName(t.format)}</span>
                                </span>
                                <span class="np-card-desc">{t.description}</span>
                            </button>
                        </li>
                    {/each}
                </ul>
                {#if selected?.seeAlso.length}
                    <div class="np-see">
                        {#each selected.seeAlso as s (s.url)}
                            <a href={s.url} target="_blank" rel="noopener noreferrer" {...tip(s.name, null, 'the publisher’s own template')}>{s.name} <Icon name="link" size={12} /></a>
                        {/each}
                    </div>
                {/if}
            {/if}
        {:else}
            <form
                class="np-source"
                onsubmit={(e) => {
                    e.preventDefault();
                    void load();
                }}
            >
                {#if source === 'repository'}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input autofocus class="yk-input mono" placeholder="github.com/owner/repository/tree/main/folder" aria-label="Repository" bind:value={link} spellcheck="false" />
                    <button type="submit" class="yk-btn yk-btn--secondary" disabled={loading || !link.trim()} {...tip('Read', 'Enter')}>Read</button>
                {:else if source === 'universe'}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input autofocus class="yk-input mono" placeholder="@preview/charged-ieee:0.1.4" aria-label="Typst package" bind:value={spec} spellcheck="false" />
                    <button type="submit" class="yk-btn yk-btn--secondary" disabled={loading || !spec.trim()} {...tip('Read', 'Enter')}>Read</button>
                {:else}
                    <label class="np-drop" {...tip('Choose a .zip', null, 'an Overleaf export or a source archive')}>
                        <Icon name="files" size={18} />
                        <span>.zip</span>
                        <input
                            type="file"
                            accept=".zip,application/zip"
                            onchange={(e) => {
                                const f = e.currentTarget.files?.[0];
                                if (f) void load(f);
                            }}
                        />
                    </label>
                {/if}
            </form>
            {#if loading}
                <div class="np-empty"><span class="yk-spinner" role="status" aria-label="Reading"></span></div>
            {:else if loaded}
                <div class="np-loaded">
                    <Icon name="doc" size={18} />
                    <span class="np-card-name">{loaded.info.name}</span>
                    <span class="yk-chip {loaded.info.format === 'typst' ? 'yk-chip--teal' : 'yk-chip--blue'}">{formatName(loaded.info.format)}</span>
                    <span class="mono muted">{loaded.info.root}</span>
                    <span class="grow"></span>
                    <span class="muted">{loaded.files.size} files</span>
                </div>
            {/if}
        {/if}
    </main>

    <footer class="np-foot">
        <input class="yk-input np-name" placeholder="Title" aria-label="Title" bind:value={title} {...tip('Title', null, 'goes into the paper')} />
        <div class="yk-segmented" role="group" aria-label="Create in">
            <button type="button" aria-pressed={target === 'repository'} disabled={!me} onclick={() => (target = 'repository')} {...tip('New repository', null, me ? 'on GitHub, yours' : 'sign in first')}>
                New repository
            </button>
            <button type="button" aria-pressed={target === 'folder'} disabled={!me} onclick={() => (target = 'folder')} {...tip('Folder', null, me ? 'in a repository you can push to' : 'sign in first')}>Folder</button>
            <button type="button" aria-pressed={target === 'here'} onclick={() => (target = 'here')} {...tip('Open here', null, 'try it without saving')}>Open here</button>
        </div>
        {#if target === 'repository'}
            <span class="mono muted np-where">{me?.login}/{slug}</span>
            <div class="yk-segmented seg-xs" role="group" aria-label="Visibility">
                <button type="button" aria-pressed={visibility === 'private'} onclick={() => (visibility = 'private')} {...tip('Private')}>Private</button>
                <button type="button" aria-pressed={visibility === 'public'} onclick={() => (visibility = 'public')} {...tip('Public')}>Public</button>
            </div>
        {:else if target === 'folder'}
            <select class="yk-input np-repo" aria-label="Repository" bind:value={repoChoice} {...tip('Repository')}>
                {#each repos as r (`${r.owner}/${r.name}`)}<option value="{r.owner}/{r.name}">{r.owner}/{r.name}</option>{/each}
            </select>
            <input class="yk-input mono np-folder" aria-label="Folder" bind:value={folder} oninput={() => (folderTouched = true)} spellcheck="false" {...tip('Folder', null, repo ? `on ${repo.defaultBranch}` : null)} />
        {/if}
        <span class="grow"></span>
        {#if failure}<span class="np-failure" role="alert">{failure}</span>{/if}
        {#if !me && signInConfigured}<a class="yk-btn yk-btn--ghost" href="/auth/login?to=/new" {...tip('Sign in', null, 'with GitHub')}>Sign in</a>{/if}
        <button type="button" class="yk-btn yk-btn--primary" disabled={!ready} onclick={() => void create()} {...tip('Create', 'Enter')}>
            {#if busy}<span class="yk-spinner np-spin" role="status" aria-label="Creating"></span>{/if}
            {target === 'here' ? 'Open' : 'Create'}
        </button>
    </footer>

    {#if waiting}
        <div class="np-wait" role="dialog" aria-label="Waiting for the repository">
            <span class="yk-spinner" role="status" aria-label="Waiting"></span>
            <span class="mono">{me?.login}/{slug}</span>
            <a class="yk-btn yk-btn--ghost btn-sm" href={waiting.url} target="_blank" rel="noopener" {...tip('Open GitHub again', null, 'create the repository there')}>GitHub</a>
            {#if waiting.access}
                <a class="yk-btn yk-btn--ghost btn-sm" href={waiting.access} target="_blank" rel="noopener" {...tip('Give access', null, 'add the new repository to the app')}>Access</a>
            {/if}
            <button type="button" class="yk-btn yk-btn--ghost btn-sm" onclick={cancelWait} {...tip('Cancel', 'Esc')}>Cancel</button>
        </div>
    {/if}
    <TooltipLayer />
</div>

<svelte:window
    onkeydown={(e) => {
        if (e.key === 'Escape' && waiting) cancelWait();
        else if (e.key === 'Enter' && ready && !(e.target instanceof HTMLInputElement && e.target.type === 'file') && source === 'gallery') void create();
    }}
/>

<style>
    .np {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        height: 100%;
        background: var(--yk-bg);
    }
    .np-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 12px 0 13px;
        min-height: 40px;
        background: var(--yk-surface);
        border-bottom: 1px solid var(--yk-line);
    }
    .np-title {
        margin: 0;
        font-family: var(--yk-font-family-heading);
        font-size: 14px;
        font-weight: 650;
    }
    .np-body {
        overflow: auto;
        padding: 16px 20px 24px;
    }
    .np-filter {
        display: flex;
        justify-content: center;
        margin-bottom: 14px;
    }
    .np-grid {
        list-style: none;
        margin: 0 auto;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
        gap: 16px;
        max-width: 1100px;
    }
    .np-card {
        display: grid;
        gap: 6px;
        width: 100%;
        padding: 8px;
        border: 1px solid var(--yk-line);
        border-radius: var(--yk-radius-md);
        background: var(--yk-surface);
        color: var(--yk-ink);
        text-align: left;
        cursor: pointer;
        transition:
            box-shadow var(--yk-motion-fast) var(--yk-motion-ease),
            border-color var(--yk-motion-fast) var(--yk-motion-ease);
    }
    .np-card:hover {
        border-color: var(--yk-line-strong);
    }
    .np-card[aria-pressed='true'] {
        border-color: var(--yk-ink);
        box-shadow: 0 0 0 1px var(--yk-ink);
    }
    .np-thumb {
        display: grid;
        place-items: center;
        aspect-ratio: 4 / 3;
        overflow: hidden;
        border-radius: var(--yk-radius-sm);
        background: var(--yk-sunken);
    }
    /* The page's top, where the title is, filling the card: a whole A4 page at this size is unreadable. */
    .np-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top;
        background: #fff;
    }
    .np-thumb.wide img {
        height: auto;
        object-fit: contain;
        box-shadow: 0 1px 3px oklch(0% 0 0 / 0.15);
    }
    .np-card-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .np-card-name {
        font-weight: var(--yk-font-weight-semibold);
        font-size: var(--yk-font-size-sm);
        flex: 1;
    }
    .np-card-desc {
        color: var(--yk-soft);
        font-size: var(--yk-font-size-xs);
        line-height: 1.35;
    }
    .np-see {
        display: flex;
        justify-content: center;
        gap: 14px;
        margin-top: 16px;
        font-size: var(--yk-font-size-xs);
    }
    .np-see a {
        color: var(--yk-soft);
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }
    .np-source {
        display: flex;
        gap: 8px;
        max-width: 640px;
        margin: 24px auto 16px;
    }
    .np-source .yk-input {
        flex: 1;
    }
    .np-drop {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        min-height: 120px;
        border: 1px dashed var(--yk-line-strong);
        border-radius: var(--yk-radius-md);
        color: var(--yk-soft);
        cursor: pointer;
    }
    .np-drop:hover {
        border-color: var(--yk-ink);
        color: var(--yk-ink);
    }
    .np-drop input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
    }
    .np-loaded {
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: 640px;
        margin: 0 auto;
        padding: 10px 12px;
        border: 1px solid var(--yk-line);
        border-radius: var(--yk-radius-md);
        background: var(--yk-surface);
    }
    .np-loaded .np-card-name {
        flex: none;
    }
    .np-empty {
        display: grid;
        place-items: center;
        min-height: 160px;
    }
    .np-foot {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: var(--yk-surface);
        border-top: 1px solid var(--yk-line);
    }
    .np-name {
        width: min(320px, 100%);
    }
    .np-repo {
        width: 220px;
    }
    .np-folder {
        width: 160px;
    }
    .np-where {
        font-size: 12px;
    }
    .np-failure {
        color: var(--yk-danger);
        font-size: var(--yk-font-size-sm);
    }
    .np-spin {
        width: 12px;
        height: 12px;
        margin-right: 6px;
    }
    .np-wait {
        position: fixed;
        left: 50%;
        bottom: 72px;
        translate: -50% 0;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: var(--yk-surface);
        border: 1px solid var(--yk-line);
        border-radius: var(--yk-radius-lg);
        box-shadow: 0 16px 40px -20px oklch(0% 0 0 / 0.45);
    }
    @media (max-width: 640px) {
        .np-bar .yk-segmented button {
            padding: 3px 6px;
        }
        .np-repo,
        .np-folder {
            width: 100%;
        }
    }
</style>
