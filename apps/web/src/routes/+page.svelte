<script lang="ts">
    import MyProjects from '#lib/home/MyProjects.svelte';
    import type { PageProps } from './$types';

    let { data }: PageProps = $props();
</script>

<main class="home">
    <img src="/logo.svg" alt="" width="44" height="44" />
    <h1>Yukibana Papers</h1>
    <p class="tagline">LaTeX and Typst papers in your GitHub repository, written together.</p>
    {#if data.me}
        <MyProjects install={data.install} />
        <div class="actions">
            <a class="yk-btn yk-btn--secondary" href="/new">New paper</a>
            <a class="yk-btn yk-btn--ghost" href="/demo">Demo</a>
        </div>
    {:else}
        <div class="actions">
            {#if data.signIn}<a class="yk-btn yk-btn--primary" href="/auth/login">Sign in with GitHub</a>{/if}
            <a class="yk-btn {data.signIn ? 'yk-btn--secondary' : 'yk-btn--primary'}" href="/new">New paper</a>
            <a class="yk-btn yk-btn--ghost" href="/demo">Open the demo</a>
        </div>
    {/if}
</main>

<style>
    .home {
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 12px;
        height: 100%;
        padding: 16px;
        background: var(--yk-bg);
        text-align: center;
    }
    h1 {
        margin: 4px 0 0;
        font-family: var(--yk-font-family-heading);
        font-size: 28px;
        letter-spacing: -0.02em;
    }
    .tagline {
        margin: 0;
        color: var(--yk-soft);
    }
    .actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        margin-top: 12px;
    }
</style>
