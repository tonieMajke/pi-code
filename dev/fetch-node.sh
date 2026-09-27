#!/bin/sh
# Node for the AppImage (vendor/node/bin/node), so a machine without Node can run Pi Code.
# The sidecar needs Node >= 22.19 (MIN_NODE in src-tauri/src/lib.rs); src-tauri/tauri.node.conf.json
# bundles this directory as resources/node, and node_program() tries it before the system node.
#
#   dev/fetch-node.sh              # NODE_VERSION=22.22.0 by default
#
# Official linux-x64 build, checked against the release's SHASUMS256.txt. Only bin/node is kept:
# the sidecar needs no npm.
set -eu

VERSION="${NODE_VERSION:-22.22.0}"
NAME="node-v${VERSION}-linux-x64"
BASE="https://nodejs.org/dist/v${VERSION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/node"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$BASE/$NAME.tar.xz" -o "$TMP/$NAME.tar.xz"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
(cd "$TMP" && grep " $NAME.tar.xz\$" SHASUMS256.txt | sha256sum -c -)

tar -xJf "$TMP/$NAME.tar.xz" -C "$TMP" "$NAME/bin/node" "$NAME/LICENSE"
rm -rf "$OUT"
mkdir -p "$OUT/bin"
mv "$TMP/$NAME/bin/node" "$OUT/bin/node"
mv "$TMP/$NAME/LICENSE" "$OUT/LICENSE"
"$OUT/bin/node" --version
