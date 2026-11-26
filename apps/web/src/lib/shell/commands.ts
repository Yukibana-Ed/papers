/** A command of the palette: a name, its shortcut if it has one, and what it does. */
export interface Command {
    readonly id: string;
    readonly name: string;
    readonly kbd?: string;
    readonly kind?: 'file';
    readonly run: () => void;
}
