#!/usr/bin/env bash
# Builds typst.ts's web compiler from upstream's source at the commit upstream.json pins, with patches/ applied, and
# packs it as the npm package upstream publishes (@myriaddreamin/typst-ts-web-compiler): the wasm and the JavaScript
# that binds it come from the same build, as they must.
#
#   build.sh <work> <out>
#
# <work> is an empty or missing directory for the checkout and the build; <out> receives
# typst-ts-web-compiler-<version>-yb.<build>.tgz and BUILDINFO.json. Needs git, rustup (or the pinned Rust with the
# wasm32-unknown-unknown target), node, curl and patch. Linux x86-64 only: the wasm-bindgen CLI is the pinned release
# binary. Run by .github/workflows/typst-wasm.yml.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mkdir -p "$1" && cd "$1" && pwd)"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
field() { node -e 'const u = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(process.argv[2].split(".").reduce((o, k) => o[k], u))' "$here/upstream.json" "$1"; }

version="$(field version)"
commit="$(field commit)"
build="$(field build)"
rust="$(field rust)"
export SOURCE_DATE_EPOCH="$(field commitTime)"
name="typst-ts-web-compiler-$version-yb.$build"

# The source: upstream at the pinned commit (a tag can move), with our patches.
src="$work/typst.ts"
if [ ! -d "$src/.git" ]; then
    git init -q "$src"
    git -C "$src" remote add origin "$(field repository)"
fi
git -C "$src" fetch -q --depth 1 origin "$commit"
git -C "$src" checkout -q --force FETCH_HEAD
git -C "$src" clean -q -fd -e target
for p in "$here"/patches/0*.patch; do
    git -C "$src" apply --check "$p"
    git -C "$src" apply "$p"
done

# The wasm-bindgen CLI of the version the crate is locked to, checked.
tools="$work/tools"
mkdir -p "$tools"
if [ ! -x "$tools/wasm-bindgen" ]; then
    curl -fsSL --retry 3 -o "$tools/wasm-bindgen.tar.gz" "$(field wasmBindgen.url)"
    echo "$(field wasmBindgen.sha256)  $tools/wasm-bindgen.tar.gz" | sha256sum -c -
    tar -xzf "$tools/wasm-bindgen.tar.gz" -C "$tools" --strip-components 1 --wildcards '*/wasm-bindgen'
fi

# The compiler, with upstream's features. Paths of this machine are kept out of the binary.
rustup toolchain install "$rust" --profile minimal --target wasm32-unknown-unknown >/dev/null
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
(
    cd "$src"
    CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo"$'\x1f'"--remap-path-prefix=$src=/src" \
        cargo "+$rust" build --locked --release -p typst-ts-web-compiler --target wasm32-unknown-unknown --no-default-features --features web,misc
)

# The bindings, then upstream's own step that makes the package's module of them.
pkg="$src/packages/compiler/pkg"
rm -rf "$pkg"
"$tools/wasm-bindgen" --target web --out-dir "$pkg" "$src/target/wasm32-unknown-unknown/release/typst_ts_web_compiler.wasm"
(cd "$src/packages/compiler" && node ../tools/wasm-debundle.mjs >/dev/null)
# The bindings build two placeholder functions from text; ours do not, so a page's script policy needs no 'unsafe-eval'.
(cd "$src/packages/compiler" && patch -p1 --no-backup-if-mismatch <"$here/patches/glue-csp.patch")

# It compiles a document and says where its glyphs came from.
node "$here/smoke.mjs" "$pkg"

# The package: what upstream's lists, and what says how this one differs.
stage="$work/package"
rm -rf "$stage"
mkdir -p "$stage/pkg" "$stage/patches"
for f in wasm-pack-shim.mjs typst_ts_web_compiler_bg.wasm typst_ts_web_compiler_bg.wasm.d.ts typst_ts_web_compiler.mjs typst_ts_web_compiler.d.ts; do
    cp "$pkg/$f" "$stage/pkg/$f"
done
cp "$src/LICENSE" "$stage/LICENSE"
cp "$here"/patches/*.patch "$stage/patches/"
cp "$here/MODIFICATIONS.md" "$stage/MODIFICATIONS.md"
node -e '
const fs = require("fs");
const [from, to, version] = process.argv.slice(1);
const p = JSON.parse(fs.readFileSync(from, "utf8"));
delete p.scripts;
delete p.devDependencies;
p.version = version;
p.files = [...p.files, "MODIFICATIONS.md", "patches"];
fs.writeFileSync(to, JSON.stringify(p, null, 2) + "\n");
' "$src/packages/compiler/package.json" "$stage/package.json" "$version-yb.$build"

# One archive, the same bytes from the same input: sorted, dated by upstream's commit, owned by nobody.
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --transform 's,^\./,package/,' -cf - -C "$stage" . | gzip -n -9 >"$out/$name.tgz"
node -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const [here, stage, tgz, to] = process.argv.slice(1);
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const files = {};
for (const f of fs.readdirSync(path.join(stage, "pkg")).sort()) files["pkg/" + f] = sha(path.join(stage, "pkg", f));
fs.writeFileSync(to, JSON.stringify({ upstream: JSON.parse(fs.readFileSync(path.join(here, "upstream.json"), "utf8")), archive: { name: path.basename(tgz), sha256: sha(tgz) }, files }, null, 2) + "\n");
' "$here" "$stage" "$out/$name.tgz" "$out/BUILDINFO.json"
cat "$out/BUILDINFO.json"
