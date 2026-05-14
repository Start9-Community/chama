#!/bin/bash
set -euo pipefail

# Usage:
#   ./scripts/release.sh "subject line"                       # short message
#   ./scripts/release.sh -F /tmp/chama-pr-a-commit.txt        # long message from file

# ── Detect bump type FIRST and shift it off ──────────────────────────
BUMP_TYPE="patch"
if [ "${1:-}" = "--minor" ]; then
  BUMP_TYPE="minor"
  shift
elif [ "${1:-}" = "--major" ]; then
  BUMP_TYPE="major"
  shift
fi

# ── NOW parse remaining args ─────────────────────────────────────────
COMMIT_MSG=""
COMMIT_FILE=""

if [ "${1:-}" = "-F" ]; then
  if [ -z "${2:-}" ]; then
    echo "❌ -F requires a file path"
    exit 1
  fi
  COMMIT_FILE="$2"
  if [ ! -f "$COMMIT_FILE" ]; then
    echo "❌ File not found: $COMMIT_FILE"
    exit 1
  fi
elif [ -n "${1:-}" ]; then
  COMMIT_MSG="$1"
else
  echo "❌ Commit message required."
  echo "   Usage: ./scripts/release.sh \"subject line\""
  echo "          ./scripts/release.sh -F /tmp/commit.txt"
  exit 1
fi

# ── Sanity: package.json in sync with last tag ─────────────────────────
CURRENT_PKG_VERSION=$(node -p "require('./package.json').version")
LAST_TAG_VERSION=$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "")

if [ -n "$LAST_TAG_VERSION" ] && [ "$CURRENT_PKG_VERSION" != "$LAST_TAG_VERSION" ]; then
  echo "⚠️  package.json ($CURRENT_PKG_VERSION) doesn't match last tag (v$LAST_TAG_VERSION)."
  echo "   This usually means a previous release.sh run errored mid-way."
  echo "   Either reset package.json to $LAST_TAG_VERSION, or confirm to continue:"
  read -p "   Continue and bump from $CURRENT_PKG_VERSION? [y/N] " confirm
  if [ "$confirm" != "y" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── Bump version (no git tag yet — we'll do it after commit) ──────────
git add -A
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")

# ── Pre-deploy gate (typecheck + tests) ────────────────────────────────
# Refuses to proceed if `tsc --noEmit` or the escrow-engine tests fail.
# Placed BEFORE commit so a failing gate never produces a public artifact.
echo "🔎 Running predeploy gate (typecheck + tests)..."
npm run predeploy

# ── Commit ─────────────────────────────────────────────────────────────
if [ -n "$COMMIT_FILE" ]; then
  git commit -F "$COMMIT_FILE"
else
  git commit -m "$COMMIT_MSG"
fi

git tag "v$NEW_VERSION"
git push origin main
git push origin "v$NEW_VERSION"

# ── Build + deploy ────────────────────────────────────────────────────
npm run build
npx cap sync android
scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/

echo "✅ Deployed v$NEW_VERSION"
