import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** The TeX Live bin folder the tests build with: `PAPERS_TEST_TEXBIN`, else the one pdflatex is found in on the PATH;
 *  null when there is none (the tests that need TeX are skipped). */
export function findTexBin(): string | null {
    const env = process.env['PAPERS_TEST_TEXBIN'];
    if (env) return existsSync(env) ? env : null;
    try {
        const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pdflatex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = out.split(/\r?\n/)[0]?.trim();
        return first ? dirname(first) : null;
    } catch {
        return null;
    }
}
