<script lang="ts">
    import { BASE, BRANCHES, COMMITS, FILES, FILE_ORDER, ME, PRESENCE, REPO, THREADS, USERS } from '#lib/demo/project.ts';
    import { demoSource } from '#lib/demo/review.ts';
    import { Session } from '#lib/session.svelte.ts';
    import Workbench from '#lib/shell/Workbench.svelte';
    import type { PageProps } from './$types';

    let { data }: PageProps = $props();

    const session = new Session({ repo: REPO, me: ME, users: USERS, files: FILES, order: FILE_ORDER, base: BASE, branches: BRANCHES, branch: 'main', commits: COMMITS, threads: THREADS, presence: PRESENCE });
    session.source = demoSource();
</script>

<svelte:head><title>{REPO.name} · Yukibana Papers</title></svelte:head>

<Workbench {session} contentOrigin={data.contentOrigin} />
