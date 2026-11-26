import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPapersServer } from '../src/index.ts';

const project = mkdtempSync(join(tmpdir(), 'papers-mcp-'));
mkdirSync(join(project, 'sections'));
writeFileSync(join(project, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n');
writeFileSync(join(project, 'sections', 'intro.tex'), '\\section{Intro}\nHello.\n');
writeFileSync(join(tmpdir(), 'papers-mcp-outside.txt'), 'outside');

/** The text of a tool's answer. */
function textOf(result: unknown): string {
    if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray(result.content)) throw new Error('no content');
    const first: unknown = result.content[0];
    if (typeof first !== 'object' || first === null || !('text' in first) || typeof first.text !== 'string') throw new Error('no text');
    return first.text;
}

describe('the MCP server', () => {
    const client = new Client({ name: 'test', version: '0' });
    const built: string[] = [];

    beforeAll(async () => {
        const server = createPapersServer({
            projectDir: project,
            build: (_dir, doc) => {
                built.push(doc.root);
                return Promise.resolve({
                    workDir: project,
                    result: {
                        ok: false,
                        pdf: null,
                        synctex: null,
                        log: null,
                        pages: 0,
                        ms: 12,
                        steps: [{ program: 'pdflatex', code: 1, ms: 12 }],
                        diagnostics: [{ file: 'sections/intro.tex', line: 2, severity: 'error', message: 'Undefined control sequence.' }],
                    },
                });
            },
        });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(a);
        await client.connect(b);
    });

    it('lists its tools', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).toSorted()).toEqual([
            'build',
            'create_project',
            'diagnostics',
            'list_files',
            'outline',
            'project_info',
            'read_file',
            'synctex_forward',
            'synctex_inverse',
            'write_file',
        ]);
    });

    it('describes the project and its outline', async () => {
        const info: unknown = JSON.parse(textOf(await client.callTool({ name: 'project_info', arguments: {} })));
        expect(info).toMatchObject({
            declared: false,
            environment: { kind: 'managed' },
            documents: [{ root: 'main.tex', engine: 'pdflatex', inputs: ['main.tex', 'sections/intro.tex'] }],
        });
        const outline: unknown = JSON.parse(textOf(await client.callTool({ name: 'outline', arguments: {} })));
        expect(outline).toEqual([{ level: 'section', title: 'Intro', file: 'sections/intro.tex', line: 1 }]);
        expect(textOf(await client.callTool({ name: 'list_files', arguments: {} }))).toBe('main.tex\nsections/intro.tex');
    });

    it('reads and writes inside the project only', async () => {
        expect(textOf(await client.callTool({ name: 'read_file', arguments: { path: 'sections/intro.tex' } }))).toContain('Hello.');
        const escape = await client.callTool({ name: 'read_file', arguments: { path: '../papers-mcp-outside.txt' } });
        expect(escape.isError).toBe(true);
        expect((await client.callTool({ name: 'write_file', arguments: { path: '.git/config', content: 'x' } })).isError).toBe(true);
        await client.callTool({ name: 'write_file', arguments: { path: 'sections/new.tex', content: 'New.' } });
        expect(readFileSync(join(project, 'sections', 'new.tex'), 'utf8')).toBe('New.');
        expect(existsSync(join(project, '..', 'escaped.tex'))).toBe(false);
    });

    it('builds and keeps the diagnostics', async () => {
        const r: unknown = JSON.parse(textOf(await client.callTool({ name: 'build', arguments: {} })));
        expect(r).toMatchObject({ ok: false, diagnostics: [{ file: 'sections/intro.tex', line: 2 }] });
        expect(built).toEqual(['main.tex']);
        expect(textOf(await client.callTool({ name: 'diagnostics', arguments: { document: 'main.tex' } }))).toContain('Undefined control sequence.');
        expect((await client.callTool({ name: 'synctex_forward', arguments: { file: 'main.tex', line: 1 } })).isError).toBe(true);
    });
});
