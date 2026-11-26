import type { PlannedFile } from '@yukibana/papers-templates';

/** A paper opened without saving it anywhere ("Open here"): its files, for /try to show in the editor. Kept in this
 *  module's memory, so it lives as long as the page does; a reload starts over. */
export interface PendingPaper {
    readonly name: string;
    readonly files: readonly PlannedFile[];
    readonly root: string;
}

let pending: PendingPaper | null = null;

export function setPending(p: PendingPaper): void {
    pending = p;
}

export function takePending(): PendingPaper | null {
    return pending;
}
