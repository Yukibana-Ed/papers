`tinymist.js` and `tinymist.d.ts` are the unmodified wasm-bindgen glue of tinymist's official web build: the
`tinymist-web.tar.gz` asset of the [tinymist v0.15.12 release](https://github.com/Myriad-Dreamin/tinymist/releases/tag/v0.15.12)
(`package/pkg/`), Apache-2.0, © Myriad-Dreamin and contributors. The glue must match its `tinymist_bg.wasm`, which the
content origin serves from `/engine/tinymist/` (the R2 bucket in production, `.engine/tinymist/` in development;
`scripts/typst.ts fetch` downloads and checks it). Upgrade both together, with `TINYMIST_VERSION` in
`src/lib/typst-assets.ts`.

No patches.
