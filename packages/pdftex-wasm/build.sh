#!/usr/bin/env bash
# Builds pdfTeX as a WebAssembly module whose run can pause and go on, from TeX Live's sources (the archive
# upstream.json pins) with patches/ applied and src/ added, and packs it as an npm package.
#
#   build.sh <work> <out>
#
# <work> is a directory for the sources, the tools and the build (kept between runs: a step whose result is there is
# not repeated); <out> receives pdftex-wasm-<version>-yb.<build>.tgz and BUILDINFO.json. Needs a C compiler and make
# (TeX Live's own build turns pdftex.web into C natively), git, node, python3 (emsdk), curl, patch and xz. Linux only.
# Run by .github/workflows/pdftex-wasm.yml.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mkdir -p "$1" && cd "$1" && pwd)"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
field() { node -e 'const u = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(process.argv[2].split(".").reduce((o, k) => o[k], u))' "$here/upstream.json" "$1"; }

version="$(field version)"
build="$(field build)"
export SOURCE_DATE_EPOCH="$(field time)"
name="pdftex-wasm-$version-yb.$build"
jobs="$(nproc)"

# The sources: TeX Live's release archive, checked, with our patches and our two files.
archive="$work/$(basename "$(field source.url)")"
if [ ! -f "$archive" ]; then
    curl -fsSL --retry 3 -o "$archive.part" "$(field source.url)"
    mv "$archive.part" "$archive"
fi
echo "$(field source.sha256)  $archive" | sha256sum -c -
S="$work/$(field source.directory)"
if [ ! -f "$S/.patched" ]; then
    rm -rf "$S"
    tar -xJf "$archive" -C "$work"
    for p in "$here"/patches/0*.patch; do
        patch -d "$S" -p1 --no-backup-if-mismatch <"$p"
    done
    cp "$here/src/inc.h" "$S/texk/web2c/pdftexdir/inc.h"
    cat "$here"/patches/0*.patch "$here/src/inc.h" | sha256sum >"$S/.patched"
fi
if [ "$(cat "$here"/patches/0*.patch "$here/src/inc.h" | sha256sum)" != "$(cat "$S/.patched")" ]; then
    echo "the patches changed since $S was made: remove it" >&2
    exit 1
fi

# TeX Live's own build, natively, as far as the C of pdfTeX and the headers its configure writes: tangle and web2c
# are programs of the build, so they run here, not in WebAssembly.
B="$work/native"
if [ ! -f "$B/texk/web2c/pdftex0.c" ]; then
    mkdir -p "$B"
    (
        cd "$B"
        "$S/configure" --disable-all-pkgs --enable-pdftex --disable-native-texlive-build --without-x --disable-shared --enable-static >configure.log 2>&1
        make -j"$jobs" >make.log 2>&1
        for d in libs/zlib libs/libpng libs/xpdf texk/kpathsea; do make -C "$d" -j"$jobs" >>make.log 2>&1; done
        make -C texk/web2c -j"$jobs" pdftexd.h pdftex-pool.c >>make.log 2>&1
    ) || {
        tail -n 40 "$B/make.log" >&2
        exit 1
    }
fi

# Emscripten, at the pinned version.
emsdk="$work/emsdk"
emscripten="$(field emscripten)"
if [ ! -f "$emsdk/upstream/emscripten/emscripten-version.txt" ] || [ "$(tr -d '"\n' <"$emsdk/upstream/emscripten/emscripten-version.txt")" != "$emscripten" ]; then
    rm -rf "$emsdk"
    git clone -q --depth 1 --branch "$emscripten" https://github.com/emscripten-core/emsdk.git "$emsdk"
    "$emsdk/emsdk" install "$emscripten" >/dev/null
    "$emsdk/emsdk" activate "$emscripten" >/dev/null
fi
# shellcheck disable=SC1091
source "$emsdk/emsdk_env.sh" >/dev/null 2>&1

# The objects. Paths of this machine are kept out of them.
O="$work/wasm"
rm -rf "$O"
mkdir -p "$O/o" "$O/inc/kpathsea"
W="$B/texk/web2c"
T="$S/texk/web2c"
# What configure found for this machine, with the sizes of wasm32.
sed 's/#define SIZEOF_LONG 8/#define SIZEOF_LONG 4/' "$B/texk/kpathsea/c-auto.h" >"$O/inc/kpathsea/c-auto.h"
cp "$B/texk/kpathsea/paths.h" "$B/texk/kpathsea/kpathsea.h" "$O/inc/kpathsea/"
echo '#define SYNCTEX_ENGINE_H "synctex-pdftex.h"' >"$O/inc/synctex-engine.h"

opt="-O2 -w -sSUPPORT_LONGJMP=wasm -ffile-prefix-map=$work=."
zlib="-I$B/libs/zlib/include"
png="-I$B/libs/libpng/include"
kpse="-I$O/inc -I$O/inc/kpathsea -I$B/texk/kpathsea -I$S/texk/kpathsea -I$B/texk -I$S/texk"
xpdf="-I$B/libs/xpdf -I$B/libs/xpdf/goo -I$B/libs/xpdf/fofi -I$B/libs/xpdf/splash -I$B/libs/xpdf/xpdf -I$S/libs/xpdf/xpdf-src/goo -I$S/libs/xpdf/xpdf-src/fofi -I$S/libs/xpdf/xpdf-src/xpdf"
common="$opt -DHAVE_CONFIG_H -DINC_HOST $zlib $png"
web2c="$common -I$W -I$T -I$W/w2c $kpse -DNO_DEBUG -DPDF_PARSER_ONLY $xpdf -I$T/libmd5 -I$T/pdftexdir -I$T/synctexdir"
engine="$web2c -D__SyncTeX__ -include $O/inc/synctex-engine.h -Dmain=tex_main"

: >"$O/commands"
cc() { # cc <object name> <source> <flags...>
    local o="$O/o/$1.o" src="$2"
    shift 2
    [ -f "$src" ] || {
        echo "no source $src" >&2
        exit 1
    }
    echo "emcc $* -c -o $o $src" >>"$O/commands"
}
for f in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil; do
    cc "z-$f" "$S/libs/zlib/zlib-src/$f.c" $opt -DHAVE_UNISTD_H $zlib
done
for f in png pngerror pngget pngmem pngpread pngread pngrio pngrtran pngrutil pngset pngtrans pngwio pngwrite pngwtran pngwutil; do
    cc "png-$f" "$S/libs/libpng/libpng-src/$f.c" $opt $zlib $png
done
for f in tex-file absolute atou cnf concat concat3 concatn db debug dir elt-dirs expand extend-fname file-p find-suffix fn fontmap hash kdefault kpathsea line magstep make-suffix path-elt pathsearch proginit progname readable rm-suffix str-list str-llist tex-glyph tex-hush tex-make tilde uppercasify variable version xbasename xcalloc xdirname xfopen xfseek xftell xgetcwd xmalloc xopendir xputenv xrealloc xstat xstrdup getopt getopt1 xfseeko xftello; do
    cc "k-$f" "$S/texk/kpathsea/$f.c" $common $kpse -DMAKE_KPSE_DLL
done
for o in $(ar t "$B/libs/xpdf/libxpdf.a"); do
    n="${o%.o}"
    src=""
    for candidate in "$S"/libs/xpdf/xpdf-src/{goo,fofi,xpdf}/"$n".{cc,c}; do
        if [ -f "$candidate" ]; then src="$candidate"; fi
    done
    cc "x-$n" "$src" $common -DPDF_PARSER_ONLY $xpdf $([ "${src##*.}" = cc ] && echo -std=c++14)
done
for f in basechsuffix chartostring coredump eofeoln fprintreal inputint input2int openclose printversion setupvar uexit usage version zround; do
    cc "l-$f" "$T/lib/$f.c" $web2c
done
cc md5-md5 "$T/libmd5/md5.c" $web2c
for f in avl avlstuff epdf mapfile pkin subfont tounicode utils vfpacket writeenc writefont writeimg writejbig2 writejpg writepng writet1 writet3 writettf writezip; do
    cc "p-$f" "$T/pdftexdir/$f.c" $web2c
done
cc p-pdftoepdf "$T/pdftexdir/pdftoepdf.cc" $web2c -std=c++14
cc e-extra "$T/pdftexdir/pdftexextra.c" $engine
cc e-synctex "$T/synctexdir/synctex.c" $engine
cc e-ini "$W/pdftexini.c" $engine
cc e-0 "$W/pdftex0.c" $engine
cc e-pool "$W/pdftex-pool.c" $engine
cc e-inc "$here/src/inc.c" $engine
cc h-host "$here/src/host.c" $opt
# BibTeX (bibtex8, the 8-bit BibTeX of texk/bibtex-x): a program that runs from start to end.
# What its configure would define: the versions its banner prints, read from the sources.
mkdir -p "$O/inc/bibtex-x"
{
    echo "#define PACKAGE_VERSION \"$(sed -n 's/^AC_INIT(\[[^]]*\], \[\([^]]*\)\].*/\1/p' "$S/texk/bibtex-x/configure.ac")\""
    echo "#define PACKAGE_BUGREPORT \"$(sed -n 's/^AC_INIT(\[[^]]*\], \[[^]]*\], \[\([^]]*\)\].*/\1/p' "$S/texk/bibtex-x/configure.ac")\""
    echo "#define TL_VERSION \"TeX Live $(sed -n 's/^m4_define(\[tex_live_version\], \[\([^]]*\)\].*/\1/p' "$S/version.ac")\""
} >"$O/inc/bibtex-x/config.h"
grep -q 'PACKAGE_VERSION "[0-9.]*"' "$O/inc/bibtex-x/config.h" && grep -q 'TL_VERSION "TeX Live [0-9]' "$O/inc/bibtex-x/config.h"
for f in bibtex bibtex-1 bibtex-2 bibtex-3 bibtex-4 utils; do
    cc "b-$f" "$S/texk/bibtex-x/$f.c" -I"$O/inc/bibtex-x" $common $kpse -DKPATHSEA -DSUPPORT_8BIT -DUNIX -Dmain=program_main
done
cc b-plain "$here/src/plain.c" $opt
xargs -P "$jobs" -d '\n' -n 1 bash -c <"$O/commands" 2>"$O/errors" || {
    grep -m 40 -B2 -A6 'error' "$O/errors" >&2
    exit 1
}

# Modules with no JavaScript of their own: the host gives each its imports (src/host.c and src/inc.c say which). The
# memory starts small and grows with the document; the stack is the engine's recursion (nested macros, boxes). Then
# write tracking, so that the host copies only the pages a run wrote.
link() { # link <name> <object prefixes...>
    local name="$1" objects=()
    shift
    for prefix in "$@"; do
        while IFS= read -r o; do objects+=("$o"); done < <(ls "$O"/o/"$prefix"-*.o | LC_ALL=C sort)
    done
    em++ -O2 -o "$O/$name.untracked.wasm" "${objects[@]}" -sSTANDALONE_WASM --no-entry -sSUPPORT_LONGJMP=wasm \
        -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=1GB -sSTACK_SIZE=8MB \
        -sEXPORTED_FUNCTIONS=_emscripten_stack_get_current,__emscripten_stack_restore -Wl,--export=inc_dirty
    node "$here/src/dirty.mjs" "$O/$name.untracked.wasm" "$O/$name.wasm"
}
link pdftex z png k x l md5 p e h
link bibtex8 k b h

# The check: the host library's tests on what was built (runs, snapshots, a format dumped and loaded, BibTeX).
PDFTEX_WASM="$O/pdftex.wasm" pnpm --dir "$here/../tex-engine" exec vitest run

# The package.
stage="$work/package"
rm -rf "$stage"
mkdir -p "$stage/patches" "$stage/src"
cp "$O/pdftex.wasm" "$O/bibtex8.wasm" "$stage/"
cp "$here"/patches/0*.patch "$stage/patches/"
cp "$here"/src/*.c "$here"/src/*.h "$here/src/dirty.mjs" "$stage/src/"
cp "$here/MODIFICATIONS.md" "$stage/MODIFICATIONS.md"
cp "$S/texk/web2c/pdftexdir/COPYINGv2" "$stage/LICENSE"
cp "$S/texk/bibtex-x/COPYING" "$stage/LICENSE.bibtex8"
node -e '
const fs = require("fs");
const [to, version] = process.argv.slice(1);
fs.writeFileSync(to, JSON.stringify({ name: "@yukibana/pdftex-wasm", version, description: "pdfTeX as a WebAssembly module whose run can pause and go on, and BibTeX beside it", license: "GPL-2.0-or-later", repository: "https://github.com/Yukibana-Ed/papers", type: "module", exports: { "./pdftex.wasm": "./pdftex.wasm", "./bibtex8.wasm": "./bibtex8.wasm", "./package.json": "./package.json" }, files: ["pdftex.wasm", "bibtex8.wasm", "LICENSE", "LICENSE.bibtex8", "MODIFICATIONS.md", "patches", "src"] }, null, 2) + "\n");
' "$stage/package.json" "$version-yb.$build"

# One archive, the same bytes from the same input: sorted, dated by the sources, owned by nobody.
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --transform 's,^\./,package/,' -cf - -C "$stage" . | gzip -n -9 >"$out/$name.tgz"
node -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const [here, stage, tgz, to] = process.argv.slice(1);
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
fs.writeFileSync(to, JSON.stringify({ upstream: JSON.parse(fs.readFileSync(path.join(here, "upstream.json"), "utf8")), archive: { name: path.basename(tgz), sha256: sha(tgz) }, files: { "pdftex.wasm": sha(path.join(stage, "pdftex.wasm")), "bibtex8.wasm": sha(path.join(stage, "bibtex8.wasm")) } }, null, 2) + "\n");
' "$here" "$stage" "$out/$name.tgz" "$out/BUILDINFO.json"
cat "$out/BUILDINFO.json"
