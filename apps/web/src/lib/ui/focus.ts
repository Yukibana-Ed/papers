const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** An attachment for a popover dialog: when it opens, focus moves into it (to what has `autofocus`, else its first
 *  control, else the dialog itself); when it closes, focus goes back to what had it before, if focus was still in the
 *  dialog (or nowhere) and that element is still on the page. */
export function dialogFocus(el: HTMLElement): () => void {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const enter = requestAnimationFrame(() => {
        if (el.contains(document.activeElement)) return;
        const target = el.querySelector<HTMLElement>('[autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
        if (target) target.focus();
        else {
            if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
            el.focus();
        }
    });
    return () => {
        cancelAnimationFrame(enter);
        const now = document.activeElement;
        const lost = now === null || now === document.body || el.contains(now);
        if (lost && before?.isConnected) before.focus();
    };
}
