#!/bin/bash
set -euo pipefail

# Usage:
#   ./scripts/release.sh [--patch|--minor|--major] "subject line"
#   ./scripts/release.sh [--patch|--minor|--major] -F /tmp/chama-commit.txt
#   ./scripts/release.sh --patch --no-deploy -F /tmp/chama-commit.txt

# ── Parse release options FIRST and shift them off ─────────────────────
BUMP_TYPE="patch"
DEPLOY=1

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --patch)
      BUMP_TYPE="patch"
      shift
      ;;
    --minor)
      BUMP_TYPE="minor"
      shift
      ;;
    --major)
      BUMP_TYPE="major"
      shift
      ;;
    --no-deploy)
      DEPLOY=0
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      if [ "${1:-}" = "-F" ]; then
        break
      fi
      echo "❌ Unknown option: $1"
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

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
  if [[ "$COMMIT_MSG" == --* ]]; then
    echo "❌ Commit message looks like an option: $COMMIT_MSG"
    echo "   Did you mean to pass it before -F, or use -- to end options?"
    exit 1
  fi
else
  echo "❌ Commit message required."
  echo "   Usage: ./scripts/release.sh [--patch|--minor|--major] \"subject line\""
  echo "          ./scripts/release.sh [--patch|--minor|--major] -F /tmp/commit.txt"
  exit 1
fi

# ── Git safety checks ──────────────────────────────────────────────────
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "❌ release.sh must run from main. Current branch: $CURRENT_BRANCH"
  exit 1
fi

echo "🔎 Fetching origin/main and tags..."
git fetch --prune origin main --tags

LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main)
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "❌ Local main is not exactly origin/main."
  echo "   local : $LOCAL_HEAD"
  echo "   remote: $REMOTE_HEAD"
  echo "   Pull/rebase or push existing commits before releasing."
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
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")

if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
  echo "❌ Local tag v$NEW_VERSION already exists."
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/v$NEW_VERSION" >/dev/null 2>&1; then
  echo "❌ Remote tag v$NEW_VERSION already exists on origin."
  exit 1
fi

# ── node_modules drift check ──────────────────────────────────────────
# Verifies installed deps match package-lock.json. v0.4.4 shipped a bundle
# built against the wrong Fedimint version because node_modules drifted
# from package.json after a branch experiment. npm ls --depth=0 catches
# missing/mismatched top-level deps without doing a destructive reinstall.
echo "🔎 Checking node_modules sync with package-lock.json..."
if ! npm ls --depth=0 > /dev/null 2>&1; then
  echo "❌ node_modules is out of sync with package.json / package-lock.json."
  echo "   Run: rm -rf node_modules package-lock.json && npm install"
  echo "   Then re-run release.sh."
  exit 1
fi

# ── Pre-deploy gate (typecheck + tests) ────────────────────────────────
# Refuses to proceed if `tsc --noEmit` or the escrow-engine tests fail.
# Placed BEFORE commit so a failing gate never produces a public artifact.
echo "🔎 Running predeploy gate (typecheck + tests)..."
npm run predeploy

# ── Build gate ─────────────────────────────────────────────────────────
# Build before commit/tag/push so a broken bundle never becomes a public
# release commit. The dist/ output is ignored; this checks the artifact.
echo "🔎 Running production build..."
npm run build

# ── Commit ─────────────────────────────────────────────────────────────
git add -A
if [ -n "$COMMIT_FILE" ]; then
  git commit -F "$COMMIT_FILE"
else
  git commit -m "$COMMIT_MSG"
fi

COMMIT_SHA=$(git rev-parse HEAD)
git tag "v$NEW_VERSION"
git push origin HEAD:main
git push origin "v$NEW_VERSION"

# ── Remote verification ────────────────────────────────────────────────
REMOTE_MAIN_SHA=$(git ls-remote origin refs/heads/main | awk '{print $1}')
REMOTE_TAG_SHA=$(git ls-remote origin "refs/tags/v$NEW_VERSION" | awk '{print $1}')

if [ "$REMOTE_MAIN_SHA" != "$COMMIT_SHA" ]; then
  echo "❌ origin/main did not land on the release commit."
  echo "   expected: $COMMIT_SHA"
  echo "   got     : $REMOTE_MAIN_SHA"
  exit 1
fi

if [ "$REMOTE_TAG_SHA" != "$COMMIT_SHA" ]; then
  echo "❌ origin tag v$NEW_VERSION did not land on the release commit."
  echo "   expected: $COMMIT_SHA"
  echo "   got     : $REMOTE_TAG_SHA"
  exit 1
fi

echo "✅ GitHub has main@$COMMIT_SHA and tag v$NEW_VERSION"

# ── Deploy ─────────────────────────────────────────────────────────────
if [ "$DEPLOY" = "0" ]; then
  echo "↷ Skipping deploy because --no-deploy was passed."
  echo "✅ Released v$NEW_VERSION"
  exit 0
fi

npx cap sync android
scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/

echo "✅ Deployed v$NEW_VERSION"
