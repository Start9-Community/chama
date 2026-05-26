#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT_DIR/native/fedimint-bridge"
BIN_DIR="$ROOT_DIR/src-tauri/binaries"

TARGET_TRIPLE="$(rustc --print host-tuple 2>/dev/null || rustc -Vv | awk '/host:/ { print $2 }')"
if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "Failed to determine Rust target triple for Tauri sidecar" >&2
  exit 1
fi

EXT=""
if [[ "$TARGET_TRIPLE" == *windows* ]]; then
  EXT=".exe"
fi

mkdir -p "$BIN_DIR"

echo "Building Chama Fedimint bridge sidecar for $TARGET_TRIPLE..."
cargo build --manifest-path "$BRIDGE_DIR/Cargo.toml" --release

SRC="$BRIDGE_DIR/target/release/chama-fedimint-bridge$EXT"
DEST="$BIN_DIR/chama-fedimint-bridge-$TARGET_TRIPLE$EXT"

if [[ ! -x "$SRC" ]]; then
  echo "Expected bridge binary not found at $SRC" >&2
  exit 1
fi

install -m 0755 "$SRC" "$DEST"
echo "Tauri sidecar ready: $DEST"
