/** How this browser builds the preview of a LaTeX document: `incremental`, each build goes on from where the last one
 *  was still the same (our pdfTeX, which keeps what it needs for that in memory); otherwise every build starts again,
 *  with the engine that keeps nothing between builds. Kept per browser. */

const KEY = 'yk-papers.incremental-build';

function load(): boolean {
    try {
        return localStorage.getItem(KEY) === 'on';
    } catch {
        return false;
    }
}

class BuildSettings {
    incremental = $state(typeof localStorage === 'undefined' ? false : load());

    toggle(): void {
        this.incremental = !this.incremental;
        try {
            localStorage.setItem(KEY, this.incremental ? 'on' : 'off');
        } catch {
            // Storage may be off; the choice then lasts for this page.
        }
    }
}

export const buildSettings = new BuildSettings();
