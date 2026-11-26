<script lang="ts">
    import NewPaper from '#lib/newpaper/NewPaper.svelte';
    import type { PageProps } from './$types';

    let { data }: PageProps = $props();

    /** `owner/repo/folder` as a repository link the dialog reads; `@preview/…` as it is. */
    function initialOf(t: string | null): string | null {
        if (t === null || t.startsWith('@preview/')) return t;
        const [owner, repo, ...folder] = t.split('/');
        return folder.length ? `github.com/${owner}/${repo}/tree/HEAD/${folder.join('/')}` : `${owner}/${repo}`;
    }
</script>

<svelte:head><title>New paper · Yukibana Papers</title></svelte:head>

<NewPaper initial={initialOf(data.template)} signInConfigured={data.signInConfigured} />
