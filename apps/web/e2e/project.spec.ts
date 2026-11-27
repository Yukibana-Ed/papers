import { expect, test, type Browser, type Page } from '@playwright/test';
import { makeRepo, pushTo, repoState, signedInToFake } from './signed-in.ts';

/** A repository opened from GitHub (a stand-in: e2e/fake-github.ts), with the real room beside the app: its files
 *  open, edits reach the other people in the room as they are typed, and Commit writes them to the branch. */

const MAIN = ['\\documentclass{article}', '\\begin{document}', 'Hello from the repository.', '\\end{document}', ''].join('\n');

/** A repository of its own for the test `title` names and for this run of it, so that tests do not meet in a room
 *  and no room remembers an earlier run (rooms outlive the tests' Workers). */
async function repoFor(title: string, readers: readonly string[] = [], refuse?: string): Promise<string> {
    const name = `ada/${title
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .slice(0, 40)}-${Math.random().toString(36).slice(2, 10)}`;
    await makeRepo(name, { 'main.tex': MAIN, 'refs.bib': '@book{knuth, title={The TeXbook}}\n' }, readers, refuse);
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
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).commits).toHaveLength(3);
});

test('someone whose name has letters beyond Latin-1 joins the room', async ({ page }, info) => {
    const repo = await repoFor(info.title);
    await open(page, 'odon', repo);
    await typeAfter(page, 'Hello from the repository.', ' Szia.');
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello from the repository. Szia.');
});

/** Makes `page`'s room unreachable until the returned function is called: every connection is turned away, and the
 *  room says why when asked. */
async function roomDown(page: Page): Promise<() => void> {
    let down = true;
    await page.routeWebSocket(/\/room\//, ws => {
        if (down) void ws.close();
        else ws.connectToServer();
    });
    await page.route(/\/room\/ada\//, route => (down && route.request().method() === 'POST' ? route.fulfill({ status: 503, body: 'Exceeded the daily limit' }) : route.fallback()));
    return () => {
        down = false;
    };
}

const OFFLINE = '.yk-chip:has-text("Offline")';

test('a project whose room cannot be reached opens from GitHub, and what is typed there joins the room once it answers', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    // Bob is in the room, and stays.
    const bob = await another(browser);
    await open(bob, 'bob', repo);

    const up = await roomDown(page);
    await open(page, 'ada', repo);
    await expect(page.locator('.yk-toast')).toHaveText('The room is unavailable (503: Exceeded the daily limit)');
    await expect(page.locator(OFFLINE)).toBeVisible();
    await typeAfter(page, 'Hello from the repository.', ' Ada, without the room.');
    await expect(page.locator('.pending')).toBeVisible();
    await typeAfter(bob, '\\documentclass{article}', '% Bob, in the room.');

    up();
    // Both edits, each once, for both: the two texts were made separately from the same commit.
    for (const p of [page, bob]) {
        const lines = p.locator('.monaco-editor .view-lines');
        await expect(lines).toContainText('Hello from the repository. Ada, without the room.', { timeout: 60_000 });
        await expect(lines).toContainText('\\documentclass{article}% Bob, in the room.');
        await expect(p.locator('.monaco-editor .view-line', { hasText: 'Hello from the repository.' })).toHaveCount(1);
    }
    await expect(page.locator(OFFLINE)).toBeHidden();
    await expect(page.locator('.present-one')).toHaveCount(1);
    await bob.context().close();
});

test('what was typed while the room was away is still there after a reload, and reaches the room afterwards', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    // Ada has been in the room: this browser keeps a copy of the branch.
    await open(page, 'ada', repo);
    await typeAfter(page, 'Hello from the repository.', ' With the room.');
    await page.waitForTimeout(1500);

    const up = await roomDown(page);
    await page.reload();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello from the repository. With the room.', { timeout: 30_000 });
    await expect(page.locator(OFFLINE)).toBeVisible();
    await typeAfter(page, 'With the room.', ' Then without.');
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('With the room. Then without.', { timeout: 30_000 });

    up();
    await expect(page.locator(OFFLINE)).toBeHidden({ timeout: 60_000 });
    const bob = await another(browser);
    await open(bob, 'bob', repo);
    await expect(bob.locator('.monaco-editor .view-lines')).toContainText('Hello from the repository. With the room. Then without.');
    await expect(bob.locator('.monaco-editor .view-line', { hasText: 'Hello from the repository.' })).toHaveCount(1);
    await bob.context().close();
});

test('a commit made while the room was away is the room’s base once it answers, with nothing left pending', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    const bob = await another(browser);
    await open(bob, 'bob', repo);

    const up = await roomDown(page);
    await open(page, 'ada', repo);
    await typeAfter(page, 'Hello from the repository.', ' Committed without the room.');
    await page.getByRole('button', { name: 'Commit' }).click();
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).files['main.tex']).toContain('Committed without the room.');

    up();
    await expect(page.locator(OFFLINE)).toBeHidden({ timeout: 60_000 });
    for (const p of [page, bob]) {
        await expect(p.locator('.monaco-editor .view-lines')).toContainText('Hello from the repository. Committed without the room.');
        await expect(p.locator('.monaco-editor .view-line', { hasText: 'Hello from the repository.' })).toHaveCount(1);
        await expect(p.locator('.pending')).toBeHidden();
    }
    // The next commit, from the room, goes on top of it.
    await typeAfter(bob, 'Committed without the room.', ' And Bob.');
    await bob.getByRole('button', { name: 'Commit' }).click();
    await bob.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(bob.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).commits.map(c => c.author)).toEqual(['bob', 'ada', 'ada']);
    await bob.context().close();
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
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.locator('.pending')).toBeHidden();
    await expect(bob.locator('.pending')).toBeHidden();
    expect((await repoState(repo)).files['main.tex']).toContain('Ada was here. So was Bob.');

    // Bob's next commit goes on top of Ada's: his page learnt the new head from the room.
    await typeAfter(bob, 'So was Bob.', ' Again.');
    await bob.getByRole('button', { name: 'Commit' }).click();
    await bob.getByRole('textbox', { name: 'Message' }).press('Enter');
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

test('the people in a branch are shown at the top right, with their cursor and what they selected', async ({ page, browser }, info) => {
    const repo = await repoFor(info.title);
    await open(page, 'ada', repo);
    // Alone, nobody is listed.
    await expect(page.locator('.present-one')).toHaveCount(0);
    const bob = await another(browser);
    await open(bob, 'bob', repo);
    await expect(page.locator('.present-one')).toHaveCount(1);
    await expect(page.locator('.present-one .avatar')).toHaveAccessibleName('bob');
    await expect(page.locator('.present-one img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/bob?s=64');

    // Bob selects "from the" on the third line: Ada sees that text in his colour, and his caret where it ends.
    await bob.locator('.monaco-editor .view-line', { hasText: 'Hello from the repository.' }).click();
    await bob.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await bob.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await bob.keyboard.press('Shift+ArrowRight');
    const band = page.locator('.monaco-editor .presence-selection.presence-bob');
    const text = page.locator('.monaco-editor .view-line', { hasText: 'Hello from the repository.' }).locator('> span');
    // The editor draws the line again when its decorations change: its box is asked for until there is one.
    let line = await text.first().boundingBox();
    for (let i = 0; line === null && i < 50; i++) {
        await page.waitForTimeout(100);
        line = await text.first().boundingBox();
    }
    if (!line) throw new Error('no line');
    // The line's 26 characters are as wide as its text (the editor's font is monospaced).
    const ch = line.width / 26;
    // Presence is sent a few times a second: the selection arrives in steps, the last one eight characters wide.
    await expect.poll(async () => ((await band.boundingBox())?.width ?? 0) / ch).toBeCloseTo(8, 0);
    const box = await band.boundingBox();
    if (!box) throw new Error('nothing drawn');
    expect((box.x - line.x) / ch).toBeCloseTo(6, 0);
    const caret = await page.locator('.monaco-editor .presence-caret.presence-bob').boundingBox();
    if (!caret) throw new Error('no caret');
    expect(Math.abs(caret.x - (box.x + box.width))).toBeLessThan(ch);

    // Their picture takes Ada to where Bob is.
    await page.locator('.monaco-editor .view-line', { hasText: 'documentclass' }).click();
    await page.locator('.present-one').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.monaco-editor .cursor')?.getBoundingClientRect().top ?? 0)).toBeGreaterThan(line.y - 2);

    // A second window of Ada's own is listed for her too.
    const again = await page.context().newPage();
    await open(again, 'ada', repo);
    await expect(page.locator('.present-one')).toHaveCount(2);
    await expect(again.locator('.present-one')).toHaveCount(2);
    await again.close();
    await expect(page.locator('.present-one')).toHaveCount(1);

    // When Bob leaves, so do his picture and his marks.
    await bob.context().close();
    await expect(page.locator('.present-one')).toHaveCount(0);
    await expect(page.locator('.monaco-editor .presence-bob')).toHaveCount(0);
});

test('a room that slept under open pages still carries edits and presence when someone types again', async ({ page, browser }, info) => {
    test.slow();
    const repo = await repoFor(info.title);
    await open(page, 'ada', repo);
    const bob = await another(browser);
    await open(bob, 'bob', repo);
    await bob.locator('.monaco-editor .view-line', { hasText: 'Hello from the repository.' }).click();
    await expect(page.locator('.monaco-editor .presence-caret.presence-bob')).toHaveCount(1);

    // Nobody does anything: the pages send nothing, and the platform puts the room to sleep after ten seconds.
    await page.waitForTimeout(15_000);

    await typeAfter(page, 'Hello from the repository.', ' Ada after the sleep.');
    await expect(bob.locator('.monaco-editor .view-lines')).toContainText('Ada after the sleep.');
    // Someone who comes now sees both, Bob included, who has not moved since before the sleep.
    const carol = await another(browser);
    await open(carol, 'carol', repo);
    await expect(carol.locator('.monaco-editor .view-lines')).toContainText('Ada after the sleep.');
    await expect(carol.locator('.present-one')).toHaveCount(2);
    await expect(carol.locator('.monaco-editor .presence-caret.presence-bob')).toHaveCount(1);

    await page.waitForTimeout(15_000);
    // A leave that wakes the room is still told.
    await bob.context().close();
    await expect(carol.locator('.present-one')).toHaveCount(1);
    await expect(page.locator('.monaco-editor .presence-bob')).toHaveCount(0);
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
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
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

test("a commit GitHub refuses says why, in GitHub's words, and the edits stay", async ({ page }, info) => {
    const repo = await repoFor(info.title, [], 'Repository rule violations found\n\nChanges must be made through a pull request.');
    await open(page, 'ada', repo);
    await typeAfter(page, 'Hello from the repository.', ' And an edit.');
    await page.getByRole('button', { name: 'Commit' }).click();
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.getByText('GitHub refused the commit: Repository rule violations found')).toBeVisible();
    await expect(page.locator('.pending')).toBeVisible();
    expect((await repoState(repo)).commits).toHaveLength(1);
});
