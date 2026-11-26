/** A command of the palette: a name, its shortcut if it has one, and what it does. */
export interface Command {
    readonly id: string;
    readonly name: string;
    readonly kbd?: string;
    readonly kind?: 'file';
    readonly run: () => void;
}

/** A key press: the key as the layout gives it, the physical key, the modifiers (`ctrl` is Ctrl or Command), and
 *  whether this is an Apple platform. */
export interface Chord {
    readonly key: string;
    readonly code: string;
    readonly ctrl: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
    readonly mac: boolean;
}

/** Whether Ctrl+Alt with the key that is `letter` on a US keyboard types a character here instead: on Windows
 *  Ctrl+Alt is AltGr, and layouts put letters there (Polish ś on S, German µ on M). Elsewhere than on Apple platforms
 *  (where Option always changes the key), the key then is another Latin letter or a symbol; a letter of another
 *  script is the layout's plain key, and stays a shortcut. */
function typesWithAlt(k: Chord, letter: string): boolean {
    if (k.mac || !/^.$/u.test(k.key)) return false;
    const key = k.key.toLowerCase();
    if (key === letter) return false;
    return !/^\p{L}$/u.test(key) || /^[\p{Script=Latin}\p{Script=Common}]$/u.test(key);
}

/** The command for a key, as the header's tooltips name them; null for keys that are not ours, among them the
 *  Ctrl+Alt combinations that type a character on the user's keyboard layout. */
export function commandFor(k: Chord): string | null {
    const key = k.key.toLowerCase();
    if (k.key === 'F8' && !k.ctrl && !k.alt) return k.shift ? 'problem-prev' : 'problem-next';
    if (!k.ctrl) return null;
    if (!k.shift && !k.alt && key === 'k') return 'palette';
    if (k.shift && key === 'p') return 'palette';
    if (!k.shift && !k.alt && key === 's') return 'commit';
    if (k.alt && k.code === 'KeyS') return typesWithAlt(k, 's') ? null : 'suggest';
    if (k.alt && k.code === 'KeyM') return typesWithAlt(k, 'm') ? null : 'comment';
    if (!k.shift && key === 'j') return 'jump';
    // Ctrl+W is the browser's own in most of them, which never pass it on; Ctrl+Alt+W always reaches the page.
    if (!k.shift && k.code === 'KeyW') return k.alt && typesWithAlt(k, 'w') ? null : 'close-tab';
    if (k.shift && key === 'o') return 'outline';
    if (k.shift && key === 'e') return 'files';
    if (k.shift && key === 'm') return 'comments';
    if (k.shift && key === 'y') return 'problems';
    if (key === '=' || key === '+') return 'zoomin';
    if (key === '-') return 'zoomout';
    return null;
}
