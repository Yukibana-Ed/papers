# Changes from upstream

This is pdfTeX 1.40.29 and bibtex8 (TeX Live 2026, https://tug.org/texlive/), built for WebAssembly by Yukibana
Papers (https://github.com/Yukibana-Ed/papers, `packages/pdftex-wasm`) from the source archive `BUILDINFO.json` of its
release names, with the patches in `patches/` and the files in `src/`. pdfTeX and bibtex8 are under the GNU General
Public License, version 2 or later (`LICENSE`, `LICENSE.bibtex8`); so are these changes.

The purpose: a run of pdfTeX that can pause, be copied, and go on from a copy, so that after an edit the document is
typeset from the last place the edit did not reach, with the same bytes as a run from the start.

- `patches/0001-pause-at-the-main-loop.patch` (pdftex.web, 7 lines). At the head of its main loop, `main_control`
  asks the host whether to pause (`inc_tick`, every 256 turns and after each page), and when it is entered for a
  paused run it goes on at the loop head instead of starting the job. `pdf_ship_out` tells the host the number of each
  page it ships (`inc_page`). Nothing else of the engine is changed: what it typesets and writes is upstream's.
- `patches/0002-kpathsea-asks-the-host.patch` (kpathsea, under `INC_HOST`). Whether a path is a file or a directory
  is asked from the host without the file's size or times (`dir.c`, `readable.c`), so that a run does not depend on
  the length of a file it only looked for. A file that no search path leads to is asked from the host by its format and
  name (`tex-file.c`), so that the host can serve TeX Live from a store of files by name.
- `src/host.c` answers the C library's file system calls from the host's imports; `src/inc.c` is the pause itself
  (a `longjmp` out of the main loop to the host's call) and the calls `inc_main`, `inc_resume` and `inc_finish`;
  `src/plain.c` is the entry of bibtex8, which runs from start to end.
- `src/dirty.mjs` rewrites each linked module so that every instruction that writes memory first marks its 4 KiB page
  in a table: the host then copies and restores only the pages a run wrote.

zlib, libpng and xpdf are the copies in TeX Live's source tree, unchanged. The modules are built with Emscripten as
standalone WebAssembly, without JavaScript of their own.
