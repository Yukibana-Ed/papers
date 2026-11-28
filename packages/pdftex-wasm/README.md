# The pdfTeX the preview runs

The preview keeps a LaTeX document built while it is typed: a run of pdfTeX pauses between two commands of the document,
the host keeps what the engine's memory was there, and after an edit the next run goes on from the last such place
before the edit (`packages/tex-engine`). For that the engine must be a module that can pause and whose every question to
the outside goes through the host, which no published build is. So Papers builds it itself: pdfTeX and BibTeX from TeX
Live's sources, with the patches here.

- `upstream.json`: TeX Live's source archive and its SHA-256, pdfTeX's version, the Emscripten release, and `build`, the
  number of our build of that version.
- `patches/0*.patch`: applied to the sources. `MODIFICATIONS.md` says what each changes and why.
- `src/`: what is added: the pause (`inc.c`, `inc.h`), the host interface in place of the system's files (`host.c`), the
  entry of a program that does not pause (`plain.c`), and the pass that makes a module mark the pages it writes
  (`dirty.mjs`).
- `build.sh`: builds `pdftex.wasm` and `bibtex8.wasm`, checks them with the tests of `packages/tex-engine`, and packs
  them as `pdftex-wasm-<version>-yb.<build>.tgz` with the patches and `src/` inside.

`.github/workflows/pdftex-wasm.yml` runs it: twice on every pull request that changes this folder (the two archives must
be identical), and, by hand on main, into a release.

The modules are TeX Live's programs and stay under their licences (pdfTeX: GPL 2 or later; BibTeX 8-bit: GPL 2 or
later). What this folder adds is under the same terms.

## A new build

Change a patch, `src/` or `upstream.json`, and raise `build` (or set it to 1 for a new upstream version). After the
merge, run the workflow on main with `release`. A release is never replaced.

A format is only good for the engine that made it: whatever dumps the LaTeX format must run the same build.
