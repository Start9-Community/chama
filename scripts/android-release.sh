#!/bin/bash
set -euo pipefail

# Builds a signed Android release APK when android/keystore.properties or the
# CHAMA_ANDROID_* environment variables are configured.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
KEYSTORE_PROPS="$ANDROID_DIR/keystore.properties"
APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

cd "$ROOT_DIR"

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

echo "🔎 Running web predeploy gate..."
npm run predeploy

echo "🔎 Building web bundle..."
npm run build

echo "🔁 Syncing Capacitor Android assets..."
npx cap sync android

if [ -z "${JAVA_HOME:-}" ] && [ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

echo "📦 Building signed release APK..."
(
  cd "$ANDROID_DIR"
  ./gradlew :app:assembleRelease --no-daemon
)

if [ ! -f "$APK_PATH" ]; then
  echo "❌ Expected APK not found: $APK_PATH"
  exit 1
fi

echo "✅ APK: $APK_PATH"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$APK_PATH"
fi
