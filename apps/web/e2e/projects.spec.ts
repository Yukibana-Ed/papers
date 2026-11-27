import { expect, test } from '@playwright/test';
import { signedIn } from './signed-in.ts';

/** The signed-in start page lists the user's projects from GitHub (mocked here): those the App is installed on. */

const repo = (owner: string, name: string, pushed: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    owner: { login: owner },
    default_branch: 'main',
    private: false,
    pushed_at: pushed,
    permissions: { push: true },
    ...extra,
});

const API = {
    '/user/installations': { body: { installations: [{ id: 1 }, { id: 2 }] } },
    '/user/installations/1/repositories': {
        body: { total_count: 2, repositories: [repo('ada', 'thesis', '2026-11-20T10:00:00Z'), repo('ada', 'notes', '2026-01-01T10:00:00Z', { private: true })] },
    },
    '/user/installations/2/repositories': {
        body: {
            total_count: 2,
            repositories: [repo('lab', 'feedback-paper', '2026-11-25T10:00:00Z'), repo('lab', 'website', '2026-06-01T10:00:00Z', { permissions: { push: false } })],
        },
    },
    '/repos/ada/thesis/contents/': {
        body: [
            { name: 'main.tex', type: 'file' },
            { name: 'chapters', type: 'dir' },
        ],
    },
    '/repos/lab/feedback-paper/contents/': {
        body: [
            { name: 'papers.toml', type: 'file' },
            { name: 'paper.tex', type: 'file' },
        ],
    },
    '/repos/ada/notes/contents/': { body: [{ name: 'notes.typ', type: 'file' }] },
    '/repos/lab/website/contents/': { body: [{ name: 'index.html', type: 'file' }] },
};

test('my projects: most recently pushed first, with what they hold, searchable, each opening in the editor', async ({ page }) => {
    await signedIn(page, 'ada', API);
    await page.goto('/');
    const rows = page.locator('.projects .row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('lab/feedback-paper');
    await expect(rows.nth(1)).toContainText('ada/thesis');
    await expect(rows.nth(2)).toContainText('lab/website');
    await expect(rows.nth(3)).toContainText('ada/notes');
    await expect(rows.nth(0)).toContainText('Papers');
    await expect(rows.nth(1)).toContainText('LaTeX');
    await expect(rows.nth(3)).toContainText('Typst');
    await expect(rows.nth(3)).toContainText('private');
    await expect(rows.nth(2)).toContainText('read');
    await expect(rows.nth(1)).toHaveAttribute('href', '/p/ada/thesis');
    await expect(page.getByRole('link', { name: 'Add repositories' })).toHaveAttribute('href', 'https://github.com/apps/yukibana-papers/installations/new');

    await page.getByRole('textbox', { name: 'Find a repository' }).fill('thes');
    await expect(rows).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/ada\/thesis$/);
});

test('with the App installed nowhere, the start page offers to install it', async ({ page }) => {
    await signedIn(page, 'ada', { '/user/installations': { body: { installations: [] } } });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Install on GitHub' })).toHaveAttribute('href', /github\.com\/apps\/yukibana-papers\/installations\/new/);
});

test('any owner/repository opens from the search, listed or not', async ({ page }) => {
    await signedIn(page, 'ada', API);
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Find a repository' }).fill('https://github.com/someone/else');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/someone\/else$/);
});

test('signed out on GitHub meanwhile, the start page offers to sign in again', async ({ page }) => {
    await signedIn(page, 'ada', API);
    await page.route('**/auth/token', route => route.fulfill({ status: 401, json: { message: 'Sign in' } }));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/auth/login');
});

test('many repositories: the pages after the first are asked at once, and the next visit shows the list before GitHub answers', async ({ page }) => {
    const many = Array.from({ length: 250 }, (_, i) => repo('big', `r${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString()));
    const pages = Object.fromEntries(
        [1, 2, 3].map(n => [`/user/installations/9/repositories?per_page=100&page=${n}`, { body: { total_count: 250, repositories: many.slice((n - 1) * 100, n * 100) } }]),
    );
    const asked = await signedIn(page, 'ada', { '/user/installations': { body: { installations: [{ id: 9 }] } }, ...pages });
    await page.goto('/');
    const rows = page.locator('.projects .row');
    await expect(rows).toHaveCount(250);
    await expect(rows.nth(0)).toContainText('big/r249');
    expect(asked.filter(a => a.includes('/user/installations/9/repositories'))).toHaveLength(3);

    // GitHub now never answers the list: the kept one shows anyway.
    await page.route('https://api.github.com/user/installations**', () => undefined);
    await page.reload();
    await expect(rows).toHaveCount(250);
    await expect(rows.nth(0)).toContainText('big/r249');
});
