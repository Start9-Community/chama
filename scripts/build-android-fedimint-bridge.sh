#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/native/fedimint-bridge/Cargo.toml"
TARGET="${CHAMA_ANDROID_RUST_TARGET:-aarch64-linux-android}"
ABI="${CHAMA_ANDROID_ABI:-arm64-v8a}"
ANDROID_API="${CHAMA_ANDROID_API:-23}"
OUTPUT_DIR="$ROOT_DIR/android/app/build/generated/jniLibs/chamaFedimintBridge"

usage() {
  cat <<'EOF'
Usage:
  scripts/build-android-fedimint-bridge.sh [--output-dir DIR]

Builds the Chama Fedimint Rust bridge for Android arm64 and writes it as:
  DIR/arm64-v8a/libchama_fedimint_bridge.so
  DIR/arm64-v8a/libc++_shared.so

Required:
  Android NDK side-by-side install, or ANDROID_NDK_HOME/ANDROID_NDK_ROOT.
EOF
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --output-dir)
      OUTPUT_DIR="${2:-}"
      if [ -z "$OUTPUT_DIR" ]; then
        echo "❌ --output-dir requires a path"
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

android_sdk_dir() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    echo "$ANDROID_HOME"
  elif [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    echo "$ANDROID_SDK_ROOT"
  elif [ -d "$HOME/Library/Android/sdk" ]; then
    echo "$HOME/Library/Android/sdk"
  fi
}

android_ndk_dir() {
  if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then
    echo "$ANDROID_NDK_HOME"
    return
  fi
  if [ -n "${ANDROID_NDK_ROOT:-}" ] && [ -d "$ANDROID_NDK_ROOT" ]; then
    echo "$ANDROID_NDK_ROOT"
    return
  fi

  local sdk
  sdk="$(android_sdk_dir)"
  if [ -n "$sdk" ] && [ -d "$sdk/ndk" ]; then
    find "$sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
  fi
}

NDK_DIR="$(android_ndk_dir)"
if [ -z "$NDK_DIR" ] || [ ! -d "$NDK_DIR/toolchains/llvm/prebuilt" ]; then
  cat <<'EOF'
❌ Android NDK is required to build the native Fedimint bridge.

Install "NDK (Side by side)" in Android Studio's SDK Manager, or set
ANDROID_NDK_HOME to an existing NDK path. Release APK builds intentionally
fail here so Zapstore builds cannot silently fall back to the browser SDK.
EOF
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) NDK_HOST="darwin-arm64" ;;
  Darwin-x86_64) NDK_HOST="darwin-x86_64" ;;
  Linux-x86_64) NDK_HOST="linux-x86_64" ;;
  Linux-aarch64) NDK_HOST="linux-x86_64" ;;
  *)
    echo "❌ Unsupported host for Android NDK lookup: $(uname -s)-$(uname -m)"
    exit 1
    ;;
esac

if [ ! -d "$NDK_DIR/toolchains/llvm/prebuilt/$NDK_HOST" ] &&
  [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] &&
  [ -d "$NDK_DIR/toolchains/llvm/prebuilt/darwin-x86_64" ]; then
  NDK_HOST="darwin-x86_64"
fi

TOOLCHAIN="$NDK_DIR/toolchains/llvm/prebuilt/$NDK_HOST/bin"
SYSROOT="$NDK_DIR/toolchains/llvm/prebuilt/$NDK_HOST/sysroot"
CLANG="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang"
CLANGXX="$TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang++"
AR="$TOOLCHAIN/llvm-ar"

if [ ! -x "$CLANG" ] || [ ! -x "$CLANGXX" ] || [ ! -x "$AR" ]; then
  echo "❌ Android NDK toolchain is incomplete under $TOOLCHAIN"
  exit 1
fi

if [ -x "/opt/homebrew/opt/rustup/bin/cargo" ]; then
  CARGO_BIN="/opt/homebrew/opt/rustup/bin/cargo"
  RUSTUP_BIN="/opt/homebrew/opt/rustup/bin/rustup"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
  RUSTUP_BIN="$HOME/.cargo/bin/rustup"
else
  CARGO_BIN="cargo"
  RUSTUP_BIN=""
fi

if ! command -v "$CARGO_BIN" >/dev/null 2>&1; then
  echo "❌ cargo is required to build the native Fedimint bridge."
  exit 1
fi

if [ -n "$RUSTUP_BIN" ] && [ -x "$RUSTUP_BIN" ]; then
  "$RUSTUP_BIN" target add "$TARGET" >/dev/null
fi

TARGET_ENV="$(echo "$TARGET" | tr '[:lower:]-' '[:upper:]_')"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/native/fedimint-bridge/target}"

echo "🦀 Building Fedimint bridge for $TARGET ($ABI)..."
env \
  "PATH=$(dirname "$CARGO_BIN"):$PATH" \
  "ANDROID_NDK_HOME=$NDK_DIR" \
  "ANDROID_NDK_ROOT=$NDK_DIR" \
  "CMAKE_TOOLCHAIN_FILE=$NDK_DIR/build/cmake/android.toolchain.cmake" \
  "BINDGEN_EXTRA_CLANG_ARGS=--sysroot=$SYSROOT -I$SYSROOT/usr/include -I$SYSROOT/usr/include/aarch64-linux-android" \
  "CC_${TARGET//-/_}=$CLANG" \
  "CXX_${TARGET//-/_}=$CLANGXX" \
  "AR_${TARGET//-/_}=$AR" \
  "CARGO_TARGET_${TARGET_ENV}_LINKER=$CLANG" \
  "CARGO_TARGET_${TARGET_ENV}_AR=$AR" \
  "PKG_CONFIG_ALLOW_CROSS=1" \
  "CARGO_TARGET_DIR=$TARGET_DIR" \
  "$CARGO_BIN" build \
    --manifest-path "$MANIFEST_PATH" \
    --release \
    --target "$TARGET"

SOURCE_BIN="$TARGET_DIR/$TARGET/release/chama-fedimint-bridge"
DEST_DIR="$OUTPUT_DIR/$ABI"
DEST_BIN="$DEST_DIR/libchama_fedimint_bridge.so"
SOURCE_LIBCXX="$SYSROOT/usr/lib/$TARGET/libc++_shared.so"
DEST_LIBCXX="$DEST_DIR/libc++_shared.so"

if [ ! -f "$SOURCE_BIN" ]; then
  echo "❌ Expected bridge binary not found: $SOURCE_BIN"
  exit 1
fi
if [ ! -f "$SOURCE_LIBCXX" ]; then
  echo "❌ Expected Android C++ runtime not found: $SOURCE_LIBCXX"
  echo "   The bridge binary links against libc++_shared.so, so the APK must package it."
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SOURCE_BIN" "$DEST_BIN"
cp "$SOURCE_LIBCXX" "$DEST_LIBCXX"
chmod 755 "$DEST_BIN"
chmod 755 "$DEST_LIBCXX"

echo "✅ Android Fedimint bridge packaged: $DEST_BIN"
echo "✅ Android C++ runtime packaged: $DEST_LIBCXX"
