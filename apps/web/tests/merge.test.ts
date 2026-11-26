import { describe, expect, it } from 'vitest';
import { merge3 } from '#lib/model/merge.ts';

const lines = (...l: string[]): string => l.join('\n');

describe('merge3', () => {
    const base = lines('\\section{Intro}', 'One.', 'Two.', 'Three.', '');

    it('takes the side that changed when the other did not', () => {
        const theirs = base.replace('Two.', 'Two, revised.');
        expect(merge3(base, base, theirs)).toEqual({ text: theirs, conflicts: 0 });
        expect(merge3(base, theirs, base)).toEqual({ text: theirs, conflicts: 0 });
    });

    it('keeps both sides when they changed different places', () => {
        const ours = base.replace('One.', 'One, ours.');
        const theirs = base.replace('Three.', 'Three, theirs.');
        expect(merge3(base, ours, theirs)).toEqual({ text: lines('\\section{Intro}', 'One, ours.', 'Two.', 'Three, theirs.', ''), conflicts: 0 });
    });

    it('merges lines added and removed at different places', () => {
        const ours = lines('\\section{Intro}', 'Zero.', 'One.', 'Two.', 'Three.', '');
        const theirs = lines('\\section{Intro}', 'One.', 'Three.', 'Four.', '');
        expect(merge3(base, ours, theirs)).toEqual({ text: lines('\\section{Intro}', 'Zero.', 'One.', 'Three.', 'Four.', ''), conflicts: 0 });
    });

    it('takes once what both sides changed the same way', () => {
        const both = base.replace('Two.', 'Two!');
        expect(merge3(base, both, both)).toEqual({ text: both, conflicts: 0 });
        const ours = both.replace('One.', 'One?');
        expect(merge3(base, ours, both)).toEqual({ text: ours, conflicts: 0 });
    });

    it('marks a place both sides changed differently, as git does', () => {
        const ours = base.replace('Two.', 'Two, ours.');
        const theirs = base.replace('Two.', 'Two, theirs.');
        expect(merge3(base, ours, theirs, 'session', 'main')).toEqual({
            text: lines('\\section{Intro}', 'One.', '<<<<<<< session', 'Two, ours.', '=======', 'Two, theirs.', '>>>>>>> main', 'Three.', ''),
            conflicts: 1,
        });
    });

    it('takes neighbouring lines each side edited, and marks only the lines both did', () => {
        const ours = lines('\\section{Intro}', 'One, ours.', 'Two, ours.', 'Three.', '');
        const theirs = lines('\\section{Intro}', 'One.', 'Two, theirs.', 'Three, theirs.', '');
        expect(merge3(base, ours, theirs)).toEqual({
            text: lines('\\section{Intro}', 'One, ours.', '<<<<<<< ours', 'Two, ours.', '=======', 'Two, theirs.', '>>>>>>> theirs', 'Three, theirs.', ''),
            conflicts: 1,
        });
    });

    it('marks an edit against a deletion', () => {
        const ours = base.replace('Two.', 'Two, ours.');
        const theirs = lines('\\section{Intro}', 'One.', 'Three.', '');
        const m = merge3(base, ours, theirs);
        expect(m.conflicts).toBe(1);
        expect(m.text).toContain('Two, ours.');
    });

    it('merges into an empty base', () => {
        expect(merge3('', 'a', '')).toEqual({ text: 'a', conflicts: 0 });
        expect(merge3('', 'a', 'b').conflicts).toBe(1);
    });
});
