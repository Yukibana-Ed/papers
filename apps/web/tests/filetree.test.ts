import { describe, expect, it } from 'vitest';
import { allFolders, foldersOf, treeRows } from '#lib/model/filetree.ts';
import { sortPaths } from '#lib/project/load.ts';

const PATHS = ['paper.tex', 'refs.bib', 'docs/README.md', 'docs/notes/a.md', 'docs/notes/b.md', 'sections/intro.tex', 'sections/deep/er/x.tex'].toSorted(sortPaths);
const show = (closed: string[]): string[] =>
    treeRows(PATHS, new Set(closed)).map(r => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `${r.name}/${r.open ? '' : ' …'}` : r.name}`);

describe('the file list', () => {
    it('shows each folder as a row before what it holds', () => {
        expect(show([])).toEqual([
            'docs/',
            '  notes/',
            '    a.md',
            '    b.md',
            '  README.md',
            'sections/',
            '  deep/',
            '    er/',
            '      x.tex',
            '  intro.tex',
            'paper.tex',
            'refs.bib',
        ]);
    });

    it('shows nothing of a closed folder but its row, whatever is open inside it', () => {
        expect(show(['docs'])).toEqual(['docs/ …', 'sections/', '  deep/', '    er/', '      x.tex', '  intro.tex', 'paper.tex', 'refs.bib']);
        expect(show(['docs/notes', 'sections/deep'])).toEqual(['docs/', '  notes/ …', '  README.md', 'sections/', '  deep/ …', '  intro.tex', 'paper.tex', 'refs.bib']);
        expect(show([...allFolders(PATHS)])).toEqual(['docs/ …', 'sections/ …', 'paper.tex', 'refs.bib']);
    });

    it('names the folders a file is in, outermost first', () => {
        expect(foldersOf('a/b/c.tex')).toEqual(['a', 'a/b']);
        expect(foldersOf('c.tex')).toEqual([]);
        expect([...allFolders(PATHS)].toSorted()).toEqual(['docs', 'docs/notes', 'sections', 'sections/deep', 'sections/deep/er']);
    });
});
