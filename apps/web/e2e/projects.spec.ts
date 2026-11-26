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
        body: { repositories: [repo('ada', 'thesis', '2026-11-20T10:00:00Z'), repo('ada', 'notes', '2026-01-01T10:00:00Z', { private: true })] },
    },
    '/user/installations/2/repositories': {
        body: { repositories: [repo('lab', 'feedback-paper', '2026-11-25T10:00:00Z'), repo('lab', 'website', '2026-06-01T10:00:00Z', { permissions: { push: false } })] },
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
