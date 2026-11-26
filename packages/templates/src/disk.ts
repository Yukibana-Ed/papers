import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { planFiles } from './plan.ts';
import { templateFromSpec, zipTemplate } from './sources.ts';
import { TemplateError } from './template.ts';

/** Creates a paper on disk from `spec` (as `templateFromSpec` reads it, or a path to a .zip) in `folder`, which must
 *  not exist or be empty: nothing is overwritten. Returns the root file's path and the files written.
 *  For `papers new` and the MCP tool `create_project`. */
export async function createOnDisk(
    spec: string,
    folder: string,
    o: { title?: string; authors?: string[]; token?: string | null } = {},
): Promise<{ root: string; files: string[]; origin: string }> {
    const dir = resolve(folder);
    if (existsSync(dir) && readdirSync(dir).length > 0) throw new TemplateError(`${dir} is not empty`);
    const t =
        spec.toLowerCase().endsWith('.zip') && existsSync(spec)
            ? await zipTemplate(new Uint8Array(readFileSync(spec)), spec.replace(/^.*[\\/]/, '').replace(/\.zip$/i, ''))
            : await templateFromSpec(spec, o.token ?? null);
    const plan = planFiles(t, { folder: '', ...(o.title ? { title: o.title } : {}), ...(o.authors ? { authors: o.authors } : {}) });
    for (const f of plan.files) {
        const full = join(dir, ...f.path.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, f.bytes);
    }
    return { root: plan.root, files: plan.files.map(f => f.path), origin: t.origin };
}
