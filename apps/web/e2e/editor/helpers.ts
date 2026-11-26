import { expect, type Page } from '@playwright/test';

/** What the editor reports for tests (`SourceEditor.testState`): `text` is the file as committed (without suggested
 *  text), `shown` the model's text (with it), `lines` the model's line count. */
export interface EditorState {
    text: string;
    shown: string;
    lines: number;
    caret: { line: number; column: number } | null;
    selection: string;
    suggestions: { id: string; text: string; oldText: string; line: number; col: number }[];
}

interface TestHook {
    editor: {
        testState(): EditorState;
        reveal(f: string, l: number, c: number, o?: { select?: unknown }): void;
        acceptSuggestion(id: string): void;
        rejectSuggestion(id: string): void;
        themeIsDark: boolean;
    };
    session: { openFile(f: string): void; files: Record<string, string>; suggestMode: boolean; languageServer: { status: string; detail: string } | null };
}

/** Opens the demo and waits for the editor. */
export async function openDemo(page: Page): Promise<void> {
    await page.goto('/demo');
    await page.waitForFunction(() => Reflect.get(window, '__papersTest') !== undefined, null, { timeout: 30_000 });
}

export async function state(page: Page): Promise<EditorState> {
    return page.evaluate(() => (Reflect.get(window, '__papersTest') as TestHook).editor.testState());
}

/** The session's text of `file`: what the room, the preview and commits get. */
export async function sessionText(page: Page, file: string): Promise<string> {
    return page.evaluate(f => (Reflect.get(window, '__papersTest') as TestHook).session.files[f] ?? '', file);
}

/** Accepts (or rejects) suggestion `id` as its card's buttons do. */
export async function decide(page: Page, id: string, accept: boolean): Promise<void> {
    await page.evaluate(
        ([i, a]) => {
            const e = (Reflect.get(window, '__papersTest') as TestHook).editor;
            if (a) e.acceptSuggestion(i);
            else e.rejectSuggestion(i);
        },
        [id, accept] as const,
    );
}

/** Shows `file` with the caret at (`line`, `column`), focused. */
export async function caretAt(page: Page, file: string, line: number, column: number): Promise<void> {
    await page.evaluate(
        ([f, l, c]) => {
            const t = Reflect.get(window, '__papersTest') as TestHook;
            t.session.openFile(f);
            setTimeout(() => t.editor.reveal(f, l, c), 0);
        },
        [file, line, column] as const,
    );
    await expect.poll(async () => (await state(page)).caret).toEqual({ line, column });
}

/** Selects from (`l1`, `c1`) to (`l2`, `c2`) in `file`. */
export async function select(page: Page, file: string, l1: number, c1: number, l2: number, c2: number): Promise<void> {
    await page.evaluate(
        ([f, a, b, c, d]) => {
            const t = Reflect.get(window, '__papersTest') as TestHook;
            t.session.openFile(f);
            setTimeout(() => t.editor.reveal(f, a, b, { select: { startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d } }), 0);
        },
        [file, l1, c1, l2, c2] as const,
    );
    await expect.poll(async () => (await state(page)).selection.length).toBeGreaterThan(0);
}

/** Turns suggestion mode on with its header button, and gives the editor the focus back. */
export async function suggest(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Suggest', exact: true }).click();
    await expect(page.locator('.dock-after').getByText('Suggesting')).toBeVisible();
}

/** The language server's status as the session has it. */
export async function languageServer(page: Page): Promise<{ status: string; detail: string } | null> {
    return page.evaluate(() => (Reflect.get(window, '__papersTest') as TestHook).session.languageServer);
}

/** Whether Monaco shows its dark theme. */
export async function monacoDark(page: Page): Promise<boolean> {
    return page.evaluate(() => (Reflect.get(window, '__papersTest') as TestHook).editor.themeIsDark);
}
