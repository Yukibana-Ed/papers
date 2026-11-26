/** How comments are written: `rich`, a live editor where Markdown typed turns into what it renders, or `markdown`,
 *  the Markdown source itself. Both store the same Markdown. Kept per browser. */
export type ComposeMode = 'rich' | 'markdown';

const KEY = 'yk-papers.compose-mode';

function load(): ComposeMode {
    try {
        return localStorage.getItem(KEY) === 'markdown' ? 'markdown' : 'rich';
    } catch {
        return 'rich';
    }
}

class CommentSettings {
    mode = $state<ComposeMode>(typeof localStorage === 'undefined' ? 'rich' : load());

    toggle(): void {
        this.mode = this.mode === 'rich' ? 'markdown' : 'rich';
        try {
            localStorage.setItem(KEY, this.mode);
        } catch {
            // Storage may be off; the choice then lasts for this page.
        }
    }
}

export const commentSettings = new CommentSettings();
