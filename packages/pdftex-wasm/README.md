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

## What each change costs and buys

Measured on 22 arXiv papers (pdfLaTeX, 6 to 52 pages) in Node 22 on one machine, with engines built from this recipe
with and without each change. A plain run is one pass from start to end with no snapshots, the least of 6 runs per
paper; the ratio is the geometric mean over the papers. A typing session is 16 words typed at two places of each
paper (301 keystrokes that hold at the page in view); the time is from the keystroke to that page being shipped out.
Every session ended with the bytes of a run from the start.

| Change | Plain run | Typing: page shipped, median (90th percentile) |
| --- | --- | --- |
| Upstream pdfTeX, as built here | 1 | no pausing: a run from the start each time, about 1.6 s median |
| + pause at the main loop (0001) | 1.00 (0.91 to 1.08 per paper: noise) | needed for everything below |
| + kpathsea asks without size and time (0002) | 0.98 (noise) | 34 ms (145 ms); without it 1,595 ms (3,326 ms) |
| + write tracking (`dirty.mjs`) | 1.12 (1.04 to 1.17) | 34 ms (145 ms); without it 124 ms (289 ms) |

- Without 0002, kpathsea's `stat` of the main file hands its length to the run before the first line is read, so
  every edit that changes the length makes every snapshot unusable and each keystroke starts the job again.
- Without write tracking the host compares every page of the memory at each snapshot and each resumption: 68 ms a
  snapshot against 4 ms, 21 ms a resumption against 1.4 ms, and a first pass that takes snapshots 3.5 s against
  1.8 s (medians). Its price is the 12% on a pass.
- The local time (`host.c`) changes no timing: without it `\today` is the UTC day.

