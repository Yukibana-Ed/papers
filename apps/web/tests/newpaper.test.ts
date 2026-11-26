import { describe, expect, it } from 'vitest';
import { newRepositoryUrl } from '#lib/newpaper/create.ts';

describe('new repository page', () => {
    it('prefills the documented fields, with a name GitHub accepts', () => {
        const u = new URL(newRepositoryUrl({ kind: 'repository', owner: 'ada', name: 'Feedback Loops: a Study', visibility: 'private' }, 'Feedback Loops: a Study'));
        expect(u.origin + u.pathname).toBe('https://github.com/new');
        expect(Object.fromEntries(u.searchParams)).toEqual({ name: 'Feedback-Loops-a-Study', owner: 'ada', visibility: 'private', description: 'Feedback Loops: a Study' });
    });
});
