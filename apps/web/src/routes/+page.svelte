<script lang="ts">
    import { goto } from '$app/navigation';
    import type { PageProps } from './$types';

    let { data }: PageProps = $props();
    let repo = $state('');

    /** `owner/repo`, or a github.com URL of one, as the editor's path; null if it is neither. */
    function target(input: string): string | null {
        const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(input.trim());
        return m ? `/p/${m[1]}/${m[2]}` : null;
    }
</script>

<main class="home">
    <img src="/logo.svg" alt="" width="44" height="44" />
    <h1>Yukibana Papers</h1>
    <p class="tagline">LaTeX papers in your GitHub repository, written together.</p>
    <div class="actions">
        {#if data.me}
            <form
                class="open"
                onsubmit={(e) => {
                    e.preventDefault();
                    const t = target(repo);
                    if (t) void goto(t);
                }}
            >
                <input class="yk-input mono" placeholder="owner/repository" aria-label="Repository" bind:value={repo} />
                <button class="yk-btn yk-btn--primary" type="submit" disabled={target(repo) === null}>Open</button>
            </form>
            <a class="yk-btn yk-btn--ghost" href="/demo">Demo</a>
        {:else}
            {#if data.signIn}<a class="yk-btn yk-btn--primary" href="/auth/login">Sign in with GitHub</a>{/if}
            <a class="yk-btn {data.signIn ? 'yk-btn--ghost' : 'yk-btn--primary'}" href="/demo">Open the demo</a>
        {/if}
    </div>
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
    .open {
        display: flex;
        gap: 8px;
    }
    .open input {
        width: min(320px, 70vw);
    }
</style>
