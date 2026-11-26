import { expect, test, type Browser, type Page } from '@playwright/test';
import { makeRepo, pushTo, repoState, signedInToFake } from './signed-in.ts';

/** A repository opened from GitHub (a stand-in: e2e/fake-github.ts), with the real room beside the app: its files
 *  open, edits reach the other people in the room as they are typed, and Commit writes them to the branch. */

const MAIN = ['\\documentclass{article}', '\\begin{document}', 'Hello from the repository.', '\\end{document}', ''].join('\n');

/** A repository of its own for the test `title` names and for this run of it, so that tests do not meet in a room
 *  and no room remembers an earlier run (rooms outlive the tests' Workers). */
async function repoFor(title: string, readers: readonly string[] = []): Promise<string> {
    const name = `ada/${title
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .slice(0, 40)}-${Math.random().toString(36).slice(2, 10)}`;
    await makeRepo(name, { 'main.tex': MAIN, 'refs.bib': '@book{knuth, title={The TeXbook}}\n' }, readers);
    return name;
}

/** Opens `repo` as `login` and waits until its source is in the editor and the room has let the user in. */
async function open(page: Page, login: string, repo: string): Promise<void> {
    await signedInToFake(page, login);
    await page.goto(`/p/${repo}`);
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello from the repository.', { timeout: 30_000 });
}

/** A second person's page, in a browser profile of their own. */
async function another(browser: Browser): Promise<Page> {
    const context = await browser.newContext();
    return context.newPage();
}

/** Types `text` at the end of the line that holds `anchor`. */
async function typeAfter(page: Page, anchor: string, text: string): Promise<void> {
    await page.locator('.monaco-editor .view-line', { hasText: anchor }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(text);
}

test('a repository opens with its files, and Commit writes the edits to its branch', async ({ page }, info) => {
    const repo = await repoFor(info.title);
    await open(page, 'ada', repo);
    await expect(page.getByRole('button', { name: 'Commit' })).toBeDisabled();

    await typeAfter(page, 'Hello from the repository.', ' And an edit.');
    await expect(page.locator('.pending')).toBeVisible();
    await page.getByRole('button', { name: 'Commit' }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Say more');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pending')).toBeHidden();

    const state = await repoState(repo);
    expect(state.commits.map(c => `${c.author}: ${c.message}`)).toEqual(['ada: Say more', 'ada: Initial commit']);
    expect(state.files['main.tex']).toBe(MAIN.replace('repository.', 'repository. And an edit.'));
    expect(state.files['refs.bib']).toContain('knuth');

    // A second commit goes on top of the first: the page knows the new head.
    await typeAfter(page, 'And an edit.', ' Twice.');
    await page.getByRole('button', { name: 'Commit' }).click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).commits).toHaveLength(3);
});

test('two people in a branch see each other type, and what one commits is committed for both', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    await open(page, 'ada', repo);
    const bob = await another(browser);
    await open(bob, 'bob', repo);

    await typeAfter(page, 'Hello from the repository.', ' Ada was here.');
    await expect(bob.locator('.monaco-editor .view-lines')).toContainText('Ada was here.');
    await typeAfter(bob, 'Ada was here.', ' So was Bob.');
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('So was Bob.');
    await expect(bob.locator('.pending')).toBeVisible();

    await page.getByRole('button', { name: 'Commit' }).click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.pending')).toBeHidden();
    await expect(bob.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).files['main.tex']).toContain('Ada was here. So was Bob.');

    // Bob's next commit goes on top of Ada's: his page learnt the new head from the room.
    await typeAfter(bob, 'So was Bob.', ' Again.');
    await bob.getByRole('button', { name: 'Commit' }).click();
    await bob.keyboard.press('Enter');
    await expect(bob.locator('.pending')).toBeHidden();
    await expect(page.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).commits.map(c => c.author)).toEqual(['bob', 'ada', 'ada']);

    // Someone who opens the branch later gets the committed text, with nothing pending.
    const carol = await another(browser);
    await open(carol, 'carol', repo);
    await expect(carol.locator('.monaco-editor .view-lines')).toContainText('Ada was here. So was Bob.');
    await expect(carol.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await bob.context().close();
    await carol.context().close();
});

test('uncommitted edits are still there for whoever opens the branch next', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    await open(page, 'ada', repo);
    await typeAfter(page, 'Hello from the repository.', ' Not committed yet.');
    await expect(page.locator('.pending')).toBeVisible();
    await page.close();

    const bob = await another(browser);
    await open(bob, 'bob', repo);
    await expect(bob.locator('.monaco-editor .view-lines')).toContainText('Not committed yet.');
    await expect(bob.locator('.pending')).toBeVisible();
    expect((await repoState(repo)).files['main.tex']).toBe(MAIN);
    await bob.context().close();
});

test('a push from a clone is merged into the session, when the branch is opened and when a commit meets it', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    await open(page, 'ada', repo);
    await typeAfter(page, 'Hello from the repository.', ' Typed in the room.');
    await expect(page.locator('.pending')).toBeVisible();

    // Someone pushes a new first line from a clone. Ada's commit meets it: the push is merged in, and she commits again.
    await pushTo(repo, { 'main.tex': MAIN.replace('\\documentclass{article}', '\\documentclass[a4paper]{article}') });
    await page.getByRole('button', { name: 'Commit' }).click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('a4paper');
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Typed in the room.');
    await expect(page.locator('.pending')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.locator('.pending')).toBeHidden();
    const merged = (await repoState(repo)).files['main.tex'] ?? '';
    expect(merged).toContain('\\documentclass[a4paper]{article}');
    expect(merged).toContain('Hello from the repository. Typed in the room.');

    // Another push, with nobody committing: whoever opens the branch next brings it into the room, for everyone.
    await pushTo(repo, { 'main.tex': merged.replace('a4paper', 'a4paper,11pt'), 'notes.tex': 'A new file.\n' });
    const bob = await another(browser);
    await signedInToFake(bob, 'bob');
    await bob.goto(`/p/${repo}`);
    await expect(bob.locator('.monaco-editor .view-lines')).toContainText('a4paper,11pt', { timeout: 30_000 });
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('a4paper,11pt');
    await expect(bob.locator('.pending')).toBeHidden();
    await expect(page.locator('.pending')).toBeHidden();
    await bob.context().close();
});

test('with read access the source cannot be edited or committed', async ({ page }, info) => {
    const repo = await repoFor(info.title, ['rita']);
    await open(page, 'rita', repo);
    await typeAfter(page, 'Hello from the repository.', ' Nope.');
    await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('Nope.');
    await expect(page.getByRole('button', { name: 'Commit' })).toBeDisabled();
});
