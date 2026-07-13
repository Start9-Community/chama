#!/bin/bash
set -euo pipefail

# One command for the full Chama release lane:
#   1. promote already-pushed origin/main with scripts/release.sh
#   2. deploy the web bundle to the VPS
#   3. build/sign the Android APK and optionally upload GitHub release assets
#
# Usage:
#   ./scripts/release-all.sh --github-release --clobber --gpg-key <key-id>
#   ./scripts/release-all.sh --github-release --repo owner/repo
#   SIGN_WITH=browser ./scripts/release-all.sh --no-web --no-build-apk --zapstore
#   ./scripts/release-all.sh --deploy-live --no-android
#   ./scripts/release-all.sh --no-web --github-release --clobber
#
# Default mode is --current: package.json is already bumped/committed, main is
# already pushed, and this script creates/pushes the version tag if needed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WEB_MODE="current"
RUN_WEB=1
RUN_ANDROID=1
ANDROID_ARGS=()

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
}

append_android_flag() {
  ANDROID_ARGS+=("$1")
}

append_android_option() {
  local flag="$1"
  local value="${2:-}"
  if [ -z "$value" ]; then
    echo "❌ $flag requires a value"
    exit 1
  fi
  ANDROID_ARGS+=("$flag" "$value")
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --current|--deploy-current)
      WEB_MODE="current"
      shift
      ;;
    --deploy-live|--deploy-only)
      WEB_MODE="deploy-live"
      shift
      ;;
    --no-web)
      RUN_WEB=0
      shift
      ;;
    --no-android)
      RUN_ANDROID=0
      shift
      ;;
    --github-release|--upload-github|--clobber|--sign-checksum|--no-sign-checksum|--zapstore|--publish-zapstore|--zapstore-overwrite|--overwrite-zapstore)
      append_android_flag "$1"
      shift
      ;;
    --no-build-apk)
      append_android_flag "--no-build"
      shift
      ;;
    --no-build)
      append_android_flag "$1"
      shift
      ;;
    --tag|--repo|--release-dir|--notes-file|--gpg-key|--pgp-public-key-url|--zapstore-config|--zapstore-notes-file)
      append_android_option "$1" "${2:-}"
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

if [ "$RUN_WEB" = "0" ] && [ "$RUN_ANDROID" = "0" ]; then
  echo "❌ Nothing to do: both --no-web and --no-android were passed."
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "🚀 Chama full release lane for $TAG"

if [ "$RUN_WEB" = "1" ]; then
  if [ "$WEB_MODE" = "deploy-live" ]; then
    ./scripts/release.sh --deploy-live
  else
    ./scripts/release.sh --current
  fi
else
  echo "↷ Skipping web deploy because --no-web was passed."
fi

if [ "$RUN_ANDROID" = "1" ]; then
  if [ "$RUN_WEB" = "1" ]; then
    ANDROID_ARGS=(--skip-web-gate "${ANDROID_ARGS[@]}")
  fi
  ./scripts/android-release.sh "${ANDROID_ARGS[@]}"
else
  echo "↷ Skipping Android release because --no-android was passed."
fi

echo "✅ Chama release lane complete for $TAG"
