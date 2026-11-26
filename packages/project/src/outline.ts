import { posix } from 'node:path';
import type { ProjectDocument, ProjectFiles } from './project.ts';
import { stripComments } from './source.ts';

/** A sectioning command of a document. */
export interface Heading {
    readonly level: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection';
    readonly title: string;
    readonly file: string;
    readonly line: number;
}

const LEVELS = ['part', 'chapter', 'section', 'subsection', 'subsubsection'] as const;

/** Text of a heading's argument with simple markup removed. */
export function plainTitle(arg: string): string {
    return arg
        .replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, '$1')
        .replace(/\\([%&#_$])/g, '$1')
        .replace(/\\[a-zA-Z]+\*?/g, '')
        .replace(/[{}$]/g, '')
        .replace(/~/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The headings of `doc` in reading order: an included file's headings come where it is included. */
export function outline(files: ProjectFiles, doc: ProjectDocument): Heading[] {
    const base = posix.dirname(doc.root) === '.' ? '' : posix.dirname(doc.root);
    const out: Heading[] = [];
    const seen = new Set<string>();
    const walk = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        stripComments(files.read(file) ?? '')
            .split('\n')
            .forEach((text, i) => {
                const inc = /\\(?:input|include|subfile)\{([^}]*)\}/.exec(text);
                if (inc) {
                    const name = posix.normalize(posix.join(base, (inc[1] ?? '').trim()));
                    const target = doc.inputs.find(f => f === name || f === `${name}.tex`);
                    if (target) walk(target);
                    return;
                }
                const m = /\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{(.*)\}/.exec(text);
                const level = LEVELS.find(l => l === m?.[1]);
                if (m && level) out.push({ level, title: plainTitle(m[2] ?? ''), file, line: i + 1 });
            });
    };
    walk(doc.root);
    return out;
}
