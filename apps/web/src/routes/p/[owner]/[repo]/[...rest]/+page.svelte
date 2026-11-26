<script lang="ts">
    import ProjectPage from '#lib/project/ProjectPage.svelte';
    import type { PageProps } from './$types';

    let { data, params }: PageProps = $props();
</script>

<svelte:head><title>{params.repo} · Yukibana Papers</title></svelte:head>

{#key `${params.owner}/${params.repo}/${data.rest}/${data.branch ?? ''}`}
    <ProjectPage owner={params.owner} repo={params.repo} rest={data.rest} branch={data.branch} contentOrigin={data.contentOrigin} root={data.root} />
{/key}
