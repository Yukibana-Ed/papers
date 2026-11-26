import { monaco } from '#lib/editor/monaco.ts';
import type { LanguageClient, ServerProfile } from './client.ts';

type Contents = { type: 'ok'; content: string } | { type: 'err'; error: string };

/** tinymist as the editor runs it:
 *  - the project's root is the workspace folder (`PROJECT_ROOT_URI`), so `../refs.bib` from a subfolder is inside it
 *    (setting `rootPath` instead fails in the web build: `Path::is_absolute` is false on wasm32-unknown-unknown);
 *  - files the server watches (bibliographies, data, files not open on it) are answered from the editor's models, and
 *    sent again when they change;
 *  - font diagnostics are left out: the web build has no fonts, and the compiler in the frame (typst.ts, with Typst's
 *    fonts) is the authority on them. */
export function tinymistProfile(): ServerProfile {
    const watched = new Set<string>();
    const contents = (uri: string): Contents => {
        const model = monaco.editor.getModel(monaco.Uri.parse(uri));
        return model ? { type: 'ok', content: model.getValue() } : { type: 'err', error: 'not in the project' };
    };
    let listening = false;
    const listen = (client: LanguageClient): void => {
        if (listening) return;
        listening = true;
        const follow = (model: { uri: { toString(): string }; onDidChangeContent(f: () => void): unknown }): void => {
            model.onDidChangeContent(() => {
                const uri = model.uri.toString();
                if (watched.has(uri)) void client.request('tinymist/fsChange', { inserts: [{ uri, content: contents(uri) }], removes: [], isSync: false });
            });
        };
        for (const m of monaco.editor.getModels()) follow(m);
        monaco.editor.onDidCreateModel(follow);
    };
    return {
        ignoreDiagnostic: message => /no font could be found|unknown font family/i.test(message),
        requests: {
            'tinymist/fs/watch': (params: unknown, client: LanguageClient): null => {
                const p = params as { inserts?: string[]; removes?: string[] };
                for (const u of p.removes ?? []) watched.delete(u);
                const inserts = (p.inserts ?? []).map(uri => {
                    watched.add(uri);
                    return { uri, content: contents(uri) };
                });
                listen(client);
                if (inserts.length) void client.request('tinymist/fsChange', { inserts, removes: [], isSync: true });
                return null;
            },
        },
    };
}
