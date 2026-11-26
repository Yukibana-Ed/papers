# The Typst compiler the preview runs

The preview compiles Typst with typst.ts's web compiler. To go between a place in the document and the place in the
source to the character, it needs to know what every glyph was typeset from, which upstream's build does not tell
(typst.ts issue 524). So Papers builds the compiler itself: upstream's source at a pinned commit, with the patches here.

- `upstream.json`: the commit of `Myriad-Dreamin/typst.ts` (not a tag: tags move), the Rust toolchain upstream pins, the
  wasm-bindgen CLI and its SHA-256, and `build`, the number of our build of that upstream version.
- `patches/0*.patch`: applied to the source. `patches/glue-csp.patch`: applied to the JavaScript bindings.
- `build.sh`: builds, checks (`smoke.mjs`) and packs the npm package upstream publishes, as
  `typst-ts-web-compiler-<version>-yb.<build>.tgz`, with `MODIFICATIONS.md` and the patches inside.

`.github/workflows/typst-wasm.yml` runs it: twice on every pull request that changes this folder (the two archives must
be identical), and, by hand on main, into a release. The wasm and its bindings must come from the same build (the names
they call each other by are the build's), so the app takes both from the one archive.

## A new build

Change a patch or `upstream.json`, and raise `build` (or set it to 1 for a new upstream version). After the merge, run
the workflow on main with `release`. A release is never replaced.
