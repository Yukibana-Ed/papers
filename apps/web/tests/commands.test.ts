import { describe, expect, it } from 'vitest';
import { commandFor, type Chord } from '../src/lib/shell/commands.ts';

const chord = (key: string, code: string, mods: Partial<Chord> = {}): Chord => ({ key, code, ctrl: true, shift: false, alt: false, mac: false, ...mods });

describe('commandFor', () => {
    it('names the commands of the plain shortcuts', () => {
        expect(commandFor(chord('k', 'KeyK'))).toBe('palette');
        expect(commandFor(chord('s', 'KeyS'))).toBe('commit');
        expect(commandFor(chord('s', 'KeyS', { alt: true }))).toBe('suggest');
        expect(commandFor(chord('m', 'KeyM', { alt: true }))).toBe('comment');
        expect(commandFor(chord('w', 'KeyW', { alt: true }))).toBe('close-tab');
        expect(commandFor(chord('k', 'KeyK', { ctrl: false }))).toBeNull();
    });

    it('leaves Ctrl+Alt alone where the layout types a character with it', () => {
        // Polish ś, German µ, and a symbol.
        expect(commandFor(chord('ś', 'KeyS', { alt: true }))).toBeNull();
        expect(commandFor(chord('Ś', 'KeyS', { alt: true, shift: true }))).toBeNull();
        expect(commandFor(chord('µ', 'KeyM', { alt: true }))).toBeNull();
        expect(commandFor(chord('€', 'KeyW', { alt: true }))).toBeNull();
    });

    it('keeps the shortcuts on layouts of another script, and on a Mac, where Option changes the key', () => {
        expect(commandFor(chord('ы', 'KeyS', { alt: true }))).toBe('suggest');
        expect(commandFor(chord('ь', 'KeyM', { alt: true }))).toBe('comment');
        expect(commandFor(chord('ß', 'KeyS', { alt: true, mac: true }))).toBe('suggest');
        expect(commandFor(chord('µ', 'KeyM', { alt: true, mac: true }))).toBe('comment');
    });
});
