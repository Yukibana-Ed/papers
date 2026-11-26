/** Moving a selection's end by a word over text in reading order, as an editor's Ctrl+Shift+Left/Right do. The
 *  preview's text is not editable, and a browser's own step by a word differs by platform (on Windows it stops after
 *  the space that follows a word), so the preview steps by these rules instead.
 *
 *  `text` is the text in reading order, with a line feed wherever one run of text does not continue the one before
 *  it (a new line, a gap). Positions are between characters: 0 to `text.length`.
 *
 *  A word is a longest stretch of letters, digits and combining marks. A word hyphenated across a line break
 *  ("ta-", line feed, "ble") is one word. */

const WORD = /[\p{L}\p{N}\p{M}]/u;

const letter = (text: string, i: number): boolean => i >= 0 && i < text.length && WORD.test(text.charAt(i));

/** Whether the character after position `i` is part of a word: a letter, digit or mark, or the hyphen or the line
 *  feed of a word broken across lines. False outside the text. */
export function isWordChar(text: string, i: number): boolean {
    if (letter(text, i)) return true;
    const c = text.charAt(i);
    if (c === '-') return text.charAt(i + 1) === '\n' && letter(text, i - 1) && letter(text, i + 2);
    if (c === '\n') return text.charAt(i - 1) === '-' && letter(text, i - 2) && letter(text, i + 1);
    return false;
}

/** The end of the first word that ends after position `i`; `i` itself when no word ends after it.
 *  Precondition: 0 ≤ i ≤ text.length. */
export function nextWordEnd(text: string, i: number): number {
    let j = i;
    while (j < text.length && !isWordChar(text, j)) j++;
    if (j === text.length) return i;
    while (j < text.length && isWordChar(text, j)) j++;
    return j;
}

/** The start of the last word that starts before position `i`; `i` itself when no word starts before it.
 *  Precondition: 0 ≤ i ≤ text.length. */
export function prevWordStart(text: string, i: number): number {
    let j = i;
    while (j > 0 && !isWordChar(text, j - 1)) j--;
    if (j === 0) return i;
    while (j > 0 && isWordChar(text, j - 1)) j--;
    return j;
}

/** Where the moving end (`focus`) of a selection goes when it is extended by a word, `forward` or backward; the other
 *  end (`anchor`) stays. Beyond the anchor it grows to the next word's far side. Coming back toward the anchor it
 *  gives up one word and stops at the near side of the word before, so the selection stays tight on its words (an
 *  editor would keep the space between). It never lands on the anchor: with one word left it goes over to the word on
 *  the anchor's other side, since an empty selection shows nothing here and takes no more keys. Returns `focus` when
 *  there is no word further that way.
 *  Precondition: 0 ≤ anchor, focus ≤ text.length. */
export function extendByWord(text: string, anchor: number, focus: number, forward: boolean): number {
    if (forward) {
        const end = nextWordEnd(text, focus);
        if (end === focus) return focus;
        if (end > anchor) return end;
        let start = end;
        while (start < anchor && !isWordChar(text, start)) start++;
        if (start < anchor) return start;
        const over = nextWordEnd(text, anchor);
        return over === anchor ? focus : over;
    }
    const start = prevWordStart(text, focus);
    if (start === focus) return focus;
    if (start < anchor) return start;
    let end = start;
    while (end > anchor && !isWordChar(text, end - 1)) end--;
    if (end > anchor) return end;
    const over = prevWordStart(text, anchor);
    return over === anchor ? focus : over;
}

/** The word after the selection from `start` to `end` (`forward`), or the one before it: what Ctrl+Left/Right select
 *  here in place of moving a caret. From an end inside a word, that word does not count: the next one is meant.
 *  Returns the selection unchanged when there is no such word.
 *  Precondition: 0 ≤ start ≤ end ≤ text.length. */
export function wordBeside(text: string, start: number, end: number, forward: boolean): { start: number; end: number } {
    if (forward) {
        let from = end;
        // Inside a word: past it first.
        if (from > 0 && isWordChar(text, from - 1) && isWordChar(text, from)) from = nextWordEnd(text, from);
        const to = nextWordEnd(text, from);
        return to === from ? { start, end } : { start: prevWordStart(text, to), end: to };
    }
    let from = start;
    if (from > 0 && isWordChar(text, from - 1) && isWordChar(text, from)) from = prevWordStart(text, from);
    const to = prevWordStart(text, from);
    return to === from ? { start, end } : { start: to, end: nextWordEnd(text, to) };
}
