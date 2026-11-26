# Changes from upstream

This is `@myriaddreamin/typst-ts-web-compiler` (typst.ts, Apache-2.0, https://github.com/Myriad-Dreamin/typst.ts)
built by Yukibana Papers (https://github.com/Yukibana-Ed/papers, `packages/typst-wasm`) from upstream's source at the
commit `BUILDINFO.json` of its release names, with the patches in `patches/`:

- `0001-glyph-spans.patch` adds `TypstCompileWorld.glyph_spans()`: for every glyph of the compiled document that came
  from a file of the project, its box on the page and the range of the source it was typeset from. The preview uses it
  to go from a place in the document to the place in the source and back, to the character.
- `glue-csp.patch` changes the JavaScript bindings only: the two placeholder functions the compiler builds from text
  are made without evaluating text, so a page that loads the compiler needs no `'unsafe-eval'`.

Nothing else differs. The wasm is not run through `wasm-opt`, which upstream's release is.
