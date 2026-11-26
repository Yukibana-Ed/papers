# Working in this repository

- pnpm workspace: `apps/web` (the app, papers.yukibana.dev) and `apps/content` (the content frame,
  user-content-papers.yukibana.run); libraries go in `packages/*`.
- Every dependency version is in `pnpm-workspace.yaml`'s catalog (`catalogMode: strict`); packages say `catalog:`. The
  SvelteKit apps take TypeScript from `catalog:ts6` (svelte-check). Nothing younger than 14 days installs.
- Format with oxfmt (4 spaces, single quotes, 180 columns), lint with oxlint (type-aware, warnings fail), typecheck with
  svelte-check. Strong types; no `any`.
- SvelteKit 3: configuration in `vite.config.ts` (no `svelte.config.js`); `#lib/…` subpath imports, not `$lib`; hook types
  from `@sveltejs/kit/hooks`.
- Document public functions with their contract: what it returns or does, its preconditions, and what it promises.
- No licence or SPDX headers in files: the licence is `LICENSE`.
- Security: user content (documents, packages, build output) is handled only by `apps/content`, which never sees a GitHub
  token. The app frames only the content origin, and the content origin is framed only by the app.
- UI: `@yukibana/design` tokens only, no explanatory text in the interface, tooltips as "name · shortcut · one clause",
  git's own terms, no left accent bars.
- Deploys only from CI. Pull requests are squash-merged.
