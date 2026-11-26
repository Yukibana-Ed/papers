/** Attributes that give an element the page's one tooltip: its name, then optionally its shortcut and at most one short
 *  clause of what it does. The name is also the element's accessible name. */
export function tip(name: string, kbd?: string | null, hint?: string | null, place?: 'below' | 'above' | 'right'): Record<string, string> {
    const a: Record<string, string> = { 'data-tip': name, 'aria-label': name };
    if (kbd) a['data-kbd'] = kbd;
    if (hint) a['data-hint'] = hint;
    if (place) a['data-tip-place'] = place;
    return a;
}
