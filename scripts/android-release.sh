#!/bin/bash
set -euo pipefail

# Builds a signed Android release APK when android/keystore.properties or the
# CHAMA_ANDROID_* environment variables are configured.
#
# Usage:
#   ./scripts/android-release.sh
#   ./scripts/android-release.sh --github-release
#   ./scripts/android-release.sh --github-release --clobber
#   ./scripts/android-release.sh --no-build --release-dir /tmp/chama-v1.0.1-assets
#
# Default mode builds the APK and prepares release assets in /private/tmp.
# --github-release uploads those assets to the matching GitHub tag/release.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
KEYSTORE_PROPS="$ANDROID_DIR/keystore.properties"
APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
UPLOAD_GITHUB=0
BUILD_APK=1
CLOBBER=0
TAG=""
REPO="${GITHUB_REPOSITORY:-}"
RELEASE_DIR=""
NOTES_FILE=""
SIGN_CHECKSUM=0

cd "$ROOT_DIR"

usage() {
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
}

default_repo() {
  local url
  url=$(git config --get remote.origin.url 2>/dev/null || true)
  url="${url%.git}"
  if [[ "$url" == git@github.com:* ]]; then
    echo "${url#git@github.com:}"
  elif [[ "$url" == https://github.com/* ]]; then
    echo "${url#https://github.com/}"
  fi
}

android_sdk_dir() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    echo "$ANDROID_HOME"
  elif [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    echo "$ANDROID_SDK_ROOT"
  elif [ -d "$HOME/Library/Android/sdk" ]; then
    echo "$HOME/Library/Android/sdk"
  fi
}

android_build_tool() {
  local tool="$1"
  local sdk
  sdk=$(android_sdk_dir)
  if [ -z "$sdk" ] || [ ! -d "$sdk/build-tools" ]; then
    return 0
  fi

  find "$sdk/build-tools" -type f -name "$tool" 2>/dev/null | sort | tail -n 1
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  else
    echo "❌ shasum or sha256sum is required to write checksums."
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --github-release|--upload-github)
      UPLOAD_GITHUB=1
      shift
      ;;
    --no-build)
      BUILD_APK=0
      shift
      ;;
    --clobber)
      CLOBBER=1
      shift
      ;;
    --tag)
      TAG="${2:-}"
      if [ -z "$TAG" ]; then
        echo "❌ --tag requires a tag value, for example v1.0.1"
        exit 1
      fi
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      if [ -z "$REPO" ]; then
        echo "❌ --repo requires owner/repo"
        exit 1
      fi
      shift 2
      ;;
    --release-dir)
      RELEASE_DIR="${2:-}"
      if [ -z "$RELEASE_DIR" ]; then
        echo "❌ --release-dir requires a directory path"
        exit 1
      fi
      shift 2
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      if [ -z "$NOTES_FILE" ] || [ ! -f "$NOTES_FILE" ]; then
        echo "❌ --notes-file requires an existing file"
        exit 1
      fi
      shift 2
      ;;
    --sign-checksum)
      SIGN_CHECKSUM=1
      shift
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

if [ ! -f "$KEYSTORE_PROPS" ] && {
  [ -z "${CHAMA_ANDROID_STORE_FILE:-}" ] ||
  [ -z "${CHAMA_ANDROID_STORE_PASSWORD:-}" ] ||
  [ -z "${CHAMA_ANDROID_KEY_ALIAS:-}" ] ||
  [ -z "${CHAMA_ANDROID_KEY_PASSWORD:-}" ]
}; then
  cat <<'EOF'
❌ Android release signing is not configured.

Create android/keystore.properties from android/keystore.properties.example,
or provide these environment variables:
  CHAMA_ANDROID_STORE_FILE
  CHAMA_ANDROID_STORE_PASSWORD
  CHAMA_ANDROID_KEY_ALIAS
  CHAMA_ANDROID_KEY_PASSWORD
EOF
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="${TAG:-v$VERSION}"
REPO="${REPO:-$(default_repo)}"
RELEASE_DIR="${RELEASE_DIR:-/private/tmp/chama-$TAG-release-assets}"
RELEASE_APK="$RELEASE_DIR/app-release.apk"
SHA_FILE="$RELEASE_DIR/app-release.apk.sha256"
ASC_FILE="$SHA_FILE.asc"
SIGNER_FILE="$RELEASE_DIR/app-release.apk.apksigner.txt"

if [ -z "${JAVA_HOME:-}" ] && [ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [ "$BUILD_APK" = "1" ]; then
  echo "🔎 Running web predeploy gate..."
  npm run predeploy

  echo "🔎 Building web bundle..."
  npm run build

  echo "🔁 Syncing Capacitor Android assets..."
  npx cap sync android

  echo "📦 Building signed release APK..."
  (
    cd "$ANDROID_DIR"
    ./gradlew :app:assembleRelease --no-daemon
  )
else
  echo "↷ Skipping APK build because --no-build was passed."
fi

if [ ! -f "$APK_PATH" ]; then
  echo "❌ Expected APK not found: $APK_PATH"
  exit 1
fi

mkdir -p "$RELEASE_DIR"
cp "$APK_PATH" "$RELEASE_APK"
(
  cd "$RELEASE_DIR"
  sha256_file "app-release.apk" > "app-release.apk.sha256"
)

AAPT=$(android_build_tool aapt2)
if [ -n "$AAPT" ]; then
  BADGING=$("$AAPT" dump badging "$RELEASE_APK" 2>/dev/null || true)
  if [ -n "$BADGING" ]; then
    if ! grep -q "versionName='$VERSION'" <<<"$BADGING"; then
      echo "❌ APK versionName does not match package.json version $VERSION."
      echo "$BADGING" | head -n 1
      exit 1
    fi
    echo "✅ APK metadata: $(echo "$BADGING" | head -n 1)"
  fi
else
  echo "⚠️  aapt2 not found; skipping APK metadata verification."
fi

APKSIGNER=$(android_build_tool apksigner)
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$RELEASE_APK" > "$SIGNER_FILE"
  CERT_LINE=$(grep "Signer #1 certificate SHA-256 digest:" "$SIGNER_FILE" || true)
  if [ -n "$CERT_LINE" ]; then
    echo "✅ APK signing: $CERT_LINE"
  else
    echo "✅ APK signing verified."
  fi
else
  echo "⚠️  apksigner not found; skipping APK signing verification."
fi

if [ "$SIGN_CHECKSUM" = "1" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "❌ gpg is required for --sign-checksum."
    exit 1
  fi
  gpg --armor --detach-sign "$SHA_FILE"
fi

echo "✅ Release assets prepared:"
echo "   $RELEASE_APK"
echo "   $SHA_FILE"
if [ -f "$ASC_FILE" ]; then
  echo "   $ASC_FILE"
else
  echo "   $ASC_FILE (optional; add this if signing checksum with Keybase/web signer)"
fi
if [ -f "$SIGNER_FILE" ]; then
  echo "   $SIGNER_FILE"
fi

if [ "$UPLOAD_GITHUB" = "0" ]; then
  echo "↷ Skipping GitHub upload. Pass --github-release to upload assets."
  exit 0
fi

if [ -z "$REPO" ]; then
  echo "❌ Could not infer GitHub repo. Pass --repo owner/repo."
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  cat <<EOF
❌ GitHub CLI is required for --github-release.

Install/auth once:
  brew install gh
  gh auth login

Then run:
  ./scripts/android-release.sh --no-build --github-release --repo $REPO --tag $TAG
EOF
  exit 1
fi

COMMIT_SHA=$(git rev-parse HEAD)
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "❌ Local tag $TAG does not exist. Run ./scripts/release.sh --current first."
  exit 1
fi

TAG_SHA=$(git rev-list -n 1 "$TAG")
if [ "$TAG_SHA" != "$COMMIT_SHA" ]; then
  echo "❌ Local tag $TAG points at $TAG_SHA, not HEAD $COMMIT_SHA."
  exit 1
fi

if ! git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "❌ Remote tag $TAG is missing. Run ./scripts/release.sh --current first."
  exit 1
fi

ASSETS=("$RELEASE_APK" "$SHA_FILE")
if [ -f "$SIGNER_FILE" ]; then
  ASSETS+=("$SIGNER_FILE")
fi
if [ -f "$ASC_FILE" ]; then
  ASSETS+=("$ASC_FILE")
else
  echo "⚠️  No checksum signature found at $ASC_FILE; uploading APK + SHA only."
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "🔁 Uploading assets to existing GitHub Release $TAG..."
else
  echo "🚀 Creating GitHub Release $TAG..."
  if [ -n "$NOTES_FILE" ]; then
    gh release create "$TAG" --repo "$REPO" --target "$COMMIT_SHA" --title "$TAG" --notes-file "$NOTES_FILE"
  else
    gh release create "$TAG" --repo "$REPO" --target "$COMMIT_SHA" --title "$TAG" --notes "Android patch release for Chama $TAG."
  fi
fi

UPLOAD_ARGS=(release upload "$TAG" "${ASSETS[@]}" --repo "$REPO")
if [ "$CLOBBER" = "1" ]; then
  UPLOAD_ARGS+=(--clobber)
fi
gh "${UPLOAD_ARGS[@]}"

echo "✅ GitHub Release $TAG has Android assets."
