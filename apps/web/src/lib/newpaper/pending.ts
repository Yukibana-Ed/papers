import type { PlannedFile } from '@yukibana/papers-templates';

/** A paper opened without saving it anywhere ("Open here"): its files, for /try to show in the editor. Kept in this
 *  module's memory, so it lives as long as the page does; a reload starts over. */
export interface PendingPaper {
    readonly name: string;
    readonly files: readonly PlannedFile[];
    readonly root: string;
}

let pending: PendingPaper | null = null;

/** Keeps `p` for /try, replacing any paper kept before. */
export function setPending(p: PendingPaper): void {
    pending = p;
}

/** The paper kept by `setPending`, or null; it stays kept, so going back to /try shows it again. */
export function takePending(): PendingPaper | null {
    return pending;
}
