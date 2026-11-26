import { problemText, type Problem } from './model.ts';

/** Where a problem's menu opens, in viewport pixels, and for which problem. */
export interface MenuAt {
    readonly problem: Problem;
    readonly x: number;
    readonly y: number;
}

/** Whether some text inside `row` is selected. */
function hasSelection(row: HTMLElement): boolean {
    const sel = getSelection();
    return sel !== null && !sel.isCollapsed && sel.anchorNode !== null && row.contains(sel.anchorNode);
}

/** Puts a problem on the clipboard: its message, or with `location` everything about it (see `problemText`). */
export function copyProblem(p: Problem, location: boolean): void {
    void navigator.clipboard.writeText(problemText(p, location));
}

/** The attributes and handlers of a problem's row, whose text can be selected like any other text:
 *  a click or Enter calls `open`, unless the click ended a drag that selected text in the row; Ctrl+C with nothing
 *  selected copies the message; a right click (or the menu key) calls `menu` with where to open it, unless text in the
 *  row is selected, which keeps the browser's own menu for copying it. */
export function problemRow(
    p: Problem,
    open: (p: Problem) => void,
    menu: (at: MenuAt) => void,
): {
    role: 'button';
    tabindex: 0;
    onclick: (e: MouseEvent & { currentTarget: HTMLElement }) => void;
    onkeydown: (e: KeyboardEvent & { currentTarget: HTMLElement }) => void;
    oncontextmenu: (e: MouseEvent & { currentTarget: HTMLElement }) => void;
} {
    return {
        role: 'button',
        tabindex: 0,
        onclick: e => {
            if (!hasSelection(e.currentTarget)) open(p);
        },
        onkeydown: e => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open(p);
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !hasSelection(e.currentTarget)) {
                e.preventDefault();
                copyProblem(p, false);
            }
        },
        oncontextmenu: e => {
            if (hasSelection(e.currentTarget)) return;
            e.preventDefault();
            // From the keyboard there is no pointer: open under the row's start.
            const r = e.currentTarget.getBoundingClientRect();
            const pointed = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && e.button === 2;
            menu(pointed ? { problem: p, x: e.clientX, y: e.clientY } : { problem: p, x: r.left + 16, y: r.bottom });
        },
    };
}
