import { expect, test, type Page } from '@playwright/test';
import { caretAt, decide, openDemo, select, sessionText, state, suggest } from './helpers.ts';

/** Suggestion mode: suggested text is real text in the editor (marked), struck text stays (struck through), the file as
 *  committed — the session's text — has neither change until a suggestion is accepted, and the caret moves as in
 *  editing. Line 7 of sections/intro.tex is "Feedback that arrives days after a submission is too late to change". */
const FILE = 'sections/intro.tex';
const LINE = 'Feedback that arrives days after a submission is too late to change';
const END = LINE.length + 1;
const ctrl = process.platform === 'darwin' ? 'Meta' : 'Control';
const wordKey = process.platform === 'darwin' ? 'Alt' : 'Control';

/** A suggestion as `state` reports it, whatever its id. */
const sg = (text: string, oldText: string, line: number, col: number): unknown => expect.objectContaining({ text, oldText, line, col });

let original = '';
let originalShown = '';

test.beforeEach(async ({ page }) => {
    await openDemo(page);
    await caretAt(page, FILE, 1, 1);
    original = (await state(page)).text;
    originalShown = (await state(page)).shown;
    await suggest(page);
});

/** Line `n` (from 1) of the model's text: what the editor shows. */
const shownLine = async (page: Page, n: number): Promise<string> => (await state(page)).shown.split('\n')[n - 1] ?? '';

/** The committed text is the file as it was, in the editor and in the session. */
async function unchanged(page: Page): Promise<void> {
    expect((await state(page)).text).toBe(original);
    await expect.poll(() => sessionText(page, FILE)).toBe(original);
}

/** No control character is in the model, and none is drawn (Monaco draws one as a glyph such as "LF"). */
async function noControlCharacters(page: Page): Promise<void> {
    const control = Array.from((await state(page)).shown).filter(ch => {
        const c = ch.charCodeAt(0);
        return (c < 32 && c !== 9 && c !== 10) || c === 127;
    });
    expect(control).toEqual([]);
    await expect(page.locator('.monaco-editor .mtkcontrol')).toHaveCount(0);
}

test('typing a word suggests it as text, and the caret follows the typed text', async ({ page }) => {
    await caretAt(page, FILE, 7, 1);
    await page.keyboard.type('Fast ');
    const s = await state(page);
    expect(s.suggestions).toContainEqual(sg('Fast ', '', 7, 1));
    expect(await shownLine(page, 7)).toBe(`Fast ${LINE}`);
    expect(s.caret).toEqual({ line: 7, column: 6 });
    await expect(page.locator('.monaco-editor .sg-ins', { hasText: 'Fast' })).toHaveCount(1);
    await unchanged(page);
    await page.keyboard.type('x');
    expect((await state(page)).suggestions).toContainEqual(sg('Fast x', '', 7, 1));
    expect((await state(page)).caret).toEqual({ line: 7, column: 7 });
});

test('Backspace takes back a typed character; Ctrl+Backspace a typed word', async ({ page }) => {
    await caretAt(page, FILE, 7, 1);
    await page.keyboard.type('Fast word');
    await page.keyboard.press('Backspace');
    expect((await state(page)).suggestions).toContainEqual(sg('Fast wor', '', 7, 1));
    await page.keyboard.press(`${wordKey}+Backspace`);
    const s = await state(page);
    expect(s.suggestions).toContainEqual(sg('Fast ', '', 7, 1));
    expect(s.caret).toEqual({ line: 7, column: 6 });
    await unchanged(page);
});

test('Ctrl+Backspace strikes the word before the caret, and the caret goes before it', async ({ page }) => {
    await caretAt(page, FILE, 7, 9);
    await page.keyboard.press(`${wordKey}+Backspace`);
    await expect.poll(async () => (await state(page)).caret).toEqual({ line: 7, column: 1 });
    const s = await state(page);
    expect(s.suggestions).toContainEqual(sg('', 'Feedback', 7, 1));
    expect(await shownLine(page, 7)).toBe(LINE);
    await unchanged(page);
});

test('Ctrl+Delete strikes the word after the caret, and the caret goes after it', async ({ page }) => {
    await caretAt(page, FILE, 7, 1);
    await page.keyboard.press(`${wordKey}+Delete`);
    await expect.poll(async () => (await state(page)).suggestions.find(x => x.line === 7)?.oldText).toMatch(/^Feedback\s?$/);
    const s = await state(page);
    expect(s.caret?.line).toBe(7);
    expect(s.caret?.column).toBeGreaterThanOrEqual(9);
    expect(await shownLine(page, 7)).toBe(LINE);
    await unchanged(page);
});

test('Backspace and Delete strike one character each and keep striking', async ({ page }) => {
    await caretAt(page, FILE, 7, 9);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect.poll(async () => (await state(page)).caret).toEqual({ line: 7, column: 7 });
    expect((await state(page)).suggestions).toContainEqual(sg('', 'ck', 7, 7));
    await caretAt(page, FILE, 7, 10);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await state(page)).caret).toEqual({ line: 7, column: 12 });
    expect((await state(page)).suggestions).toContainEqual(sg('', 'th', 7, 10));
    expect(await shownLine(page, 7)).toBe(LINE);
    await unchanged(page);
});

test('typing over a selection suggests the replacement', async ({ page }) => {
    await select(page, FILE, 7, 1, 7, 9);
    await page.keyboard.type('Input');
    const s = await state(page);
    expect(s.suggestions).toContainEqual(sg('Input', 'Feedback', 7, 1));
    expect(s.suggestions.filter(x => x.line === 7)).toHaveLength(1);
    expect(await shownLine(page, 7)).toBe(`FeedbackInput${LINE.slice(8)}`);
    expect(s.caret).toEqual({ line: 7, column: 14 });
    await unchanged(page);
});

test('paste suggests the pasted text, without control characters', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await caretAt(page, FILE, 7, 1);
    await page.evaluate(() => navigator.clipboard.writeText('Pasted\f '));
    await page.keyboard.press(`${ctrl}+V`);
    await expect.poll(async () => (await state(page)).suggestions).toContainEqual(sg('Pasted ', '', 7, 1));
    await noControlCharacters(page);
    await unchanged(page);
});

test('a multi-line paste suggests real lines, with CR LF as LF', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const lines = (await state(page)).lines;
    await caretAt(page, FILE, 7, 1);
    await page.evaluate(() => navigator.clipboard.writeText('one\r\ntwo\r\n'));
    await page.keyboard.press(`${ctrl}+V`);
    await expect.poll(async () => (await state(page)).lines).toBe(lines + 2);
    const s = await state(page);
    expect(s.suggestions).toContainEqual(sg('one\ntwo\n', '', 7, 1));
    expect(await shownLine(page, 7)).toBe('one');
    expect(await shownLine(page, 8)).toBe('two');
    expect(await shownLine(page, 9)).toBe(LINE);
    expect(s.caret).toEqual({ line: 9, column: 1 });
    await expect(page.locator('.monaco-editor .sg-nl-ins')).toHaveCount(2);
    await noControlCharacters(page);
    await unchanged(page);
});

test('undo and redo step through the suggestions', async ({ page }) => {
    await caretAt(page, FILE, 7, 1);
    await page.keyboard.type('Fast ');
    expect((await state(page)).suggestions.filter(x => x.line === 7)).toHaveLength(1);
    await page.keyboard.press(`${ctrl}+Z`);
    expect((await state(page)).suggestions).toContainEqual(sg('Fast', '', 7, 1));
    for (let i = 0; i < 4; i++) await page.keyboard.press(`${ctrl}+Z`);
    expect((await state(page)).suggestions.filter(x => x.line === 7)).toHaveLength(0);
    expect(await shownLine(page, 7)).toBe(LINE);
    for (let i = 0; i < 5; i++) await page.keyboard.press(`${ctrl}+Y`);
    expect((await state(page)).suggestions).toContainEqual(sg('Fast ', '', 7, 1));
    await unchanged(page);
});

// --- line breaks ------------------------------------------------------------------------------------------------------

/** Presses `key` (or fires `inputType` as the browser would) at (7, `col`) and checks the result: one real line break
 *  in the model, marked as suggested text with a mark at the end of its line, and the file as committed unchanged. */
async function breakLine(page: Page, col: number, key: string): Promise<void> {
    const lines = (await state(page)).lines;
    await caretAt(page, FILE, 7, col);
    await page.keyboard.press(key);
    await expect.poll(async () => (await state(page)).lines).toBe(lines + 1);
    const s = await state(page);
    expect(s.suggestions.filter(x => x.line === 7)).toEqual([sg('\n', '', 7, col)]);
    expect(await shownLine(page, 7)).toBe(LINE.slice(0, col - 1));
    expect(await shownLine(page, 8)).toBe(LINE.slice(col - 1));
    expect(s.caret?.line).toBe(8);
    await expect(page.locator('.monaco-editor .sg-nl-ins')).toHaveCount(1);
    await noControlCharacters(page);
    await unchanged(page);
}

for (const key of ['Enter', 'Shift+Enter', 'NumpadEnter'])
    test(`${key} at the end of a line suggests a real line break, marked`, async ({ page }) => {
        await breakLine(page, END, key);
        await page.keyboard.type('More');
        const s = await state(page);
        expect(s.suggestions).toContainEqual(sg('\nMore', '', 7, END));
        expect(s.caret).toEqual({ line: 8, column: 5 });
        await unchanged(page);
    });

test('Enter mid-line suggests a line break there', async ({ page }) => {
    await breakLine(page, 9, 'Enter');
    expect((await state(page)).caret).toEqual({ line: 8, column: 1 });
});

for (const inputType of ['insertParagraph', 'insertLineBreak'] as const)
    test(`a ${inputType} input never breaks the line twice or shows a glyph`, async ({ page }) => {
        const lines = (await state(page)).lines;
        await caretAt(page, FILE, 7, 9);
        await page.evaluate(t => {
            const target = document.activeElement ?? document.body;
            target.dispatchEvent(new InputEvent('beforeinput', { inputType: t, bubbles: true, cancelable: true }));
        }, inputType);
        // Monaco handles line breaks from its keys; an input event of this kind adds at most one, as a suggestion.
        await page.waitForTimeout(200);
        const s = await state(page);
        expect(s.lines - lines).toBeLessThanOrEqual(1);
        if (s.lines > lines) expect(s.suggestions).toContainEqual(sg('\n', '', 7, 9));
        await noControlCharacters(page);
        await unchanged(page);
    });

test('Enter inside my suggested text breaks it there', async ({ page }) => {
    await caretAt(page, FILE, 7, 1);
    await page.keyboard.type('Fast word');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    const s = await state(page);
    expect(s.suggestions.filter(x => x.line === 7)).toEqual([sg('Fast \nword', '', 7, 1)]);
    expect(await shownLine(page, 7)).toBe('Fast ');
    expect(await shownLine(page, 8)).toBe(`word${LINE}`);
    expect(s.caret).toEqual({ line: 8, column: 1 });
    await expect(page.locator('.monaco-editor .sg-nl-ins')).toHaveCount(1);
    await unchanged(page);
});

test('accepting a suggested line break puts it in the file; rejecting one takes it away', async ({ page }) => {
    await breakLine(page, 9, 'Enter');
    const id = (await state(page)).suggestions.find(x => x.line === 7)?.id ?? '';
    await decide(page, id, true);
    const broken = `${original.split('\n').slice(0, 6).join('\n')}\nFeedback\n${original.split('\n').slice(6).join('\n').slice(8)}`;
    await expect.poll(() => sessionText(page, FILE)).toBe(broken);
    expect((await state(page)).text).toBe(broken);
    await expect(page.locator('.monaco-editor .sg-nl-ins')).toHaveCount(0);
});

test('rejecting a suggested line break leaves the file as it was', async ({ page }) => {
    await breakLine(page, 9, 'Enter');
    const id = (await state(page)).suggestions.find(x => x.line === 7)?.id ?? '';
    await decide(page, id, false);
    const s = await state(page);
    expect(s.shown).toBe(originalShown);
    expect(s.suggestions.filter(x => x.line === 7)).toHaveLength(0);
    await expect(page.locator('.monaco-editor .sg-nl-ins')).toHaveCount(0);
    await unchanged(page);
});

test('deleting a line break strikes it: the lines stay apart, marked, until accepted', async ({ page }) => {
    const lines = (await state(page)).lines;
    await caretAt(page, FILE, 7, END);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await state(page)).suggestions).toContainEqual(sg('', '\n', 7, END));
    let s = await state(page);
    expect(s.lines).toBe(lines);
    expect(await shownLine(page, 7)).toBe(LINE);
    await expect(page.locator('.monaco-editor .sg-nl-del')).toHaveCount(1);
    await unchanged(page);
    // Backspace at the start of the next line strikes the same way.
    await decide(page, s.suggestions.find(x => x.oldText === '\n')?.id ?? '', true);
    s = await state(page);
    expect(s.lines).toBe(lines - 1);
    const joined = original.split('\n');
    expect(s.text).toBe([...joined.slice(0, 6), `${joined[6]}${joined[7]}`, ...joined.slice(8)].join('\n'));
    await expect(page.locator('.monaco-editor .sg-nl-del')).toHaveCount(0);
});

test('Backspace at the start of a line strikes the line break, and rejecting it keeps the lines', async ({ page }) => {
    const lines = (await state(page)).lines;
    await caretAt(page, FILE, 8, 1);
    await page.keyboard.press('Backspace');
    await expect.poll(async () => (await state(page)).suggestions).toContainEqual(sg('', '\n', 7, END));
    expect((await state(page)).caret).toEqual({ line: 7, column: END });
    expect((await state(page)).lines).toBe(lines);
    await expect(page.locator('.monaco-editor .sg-nl-del')).toHaveCount(1);
    await decide(page, (await state(page)).suggestions.find(x => x.oldText === '\n')?.id ?? '', false);
    expect((await state(page)).shown).toBe(originalShown);
    await expect(page.locator('.monaco-editor .sg-nl-del')).toHaveCount(0);
    await unchanged(page);
});
