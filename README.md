# Yukibana Papers

Write papers and slides in LaTeX or Typst, together, in a GitHub repository: live collaborative editing, a preview that
follows the cursor, comments and suggestions that become GitHub reviews, and commits made with the user's own GitHub
identity.

| Part | Where | What |
| --- | --- | --- |
| `apps/web` | papers.yukibana.dev | The app: editor, comments, GitHub. Holds the user's GitHub token. |
| `apps/content` | user-content-papers.yukibana.run | The frame the app embeds: the TeX and Typst engines, the language server and the preview. Never sees a token. |

The two run on different sites on purpose: a document compiled in the frame can run code (TeX is a programming language,
and packages ship JavaScript and Lua), and nothing it does can reach the app's cookies, storage or token.

## Developing

Node.js and pnpm come from `package.json` (`devEngines`, `packageManager`): with pnpm 12 installed, `pnpm install`
downloads the exact Node.js release.

```sh
pnpm install
pnpm --filter @yukibana/papers-content dev   # http://localhost:5185
pnpm --filter @yukibana/papers-web dev       # http://localhost:5180
```

Before a pull request: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. CI runs the same, and
`ci-ok` is the one required check.

## Deploying

Only from CI: every merge to `main` deploys both Workers (`.github/workflows/deploy.yml`), and every pull request from
this repository gets a preview pair once a maintainer approves the `preview` environment
(`.github/workflows/preview.yml`).

## Licence

Apache-2.0 (`LICENSE`). The TeX engine, [texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex), is AGPL-3.0 and is
loaded unmodified, as a separate program, by the content frame.
