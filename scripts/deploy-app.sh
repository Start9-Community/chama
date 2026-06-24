#!/bin/bash
set -euo pipefail

# Deploy the built web app (dist/) to getchama.app (~/chama-dist/ on the VPS).
# WEB bundle only — NOT a git push, NOT the APK/Zapstore release. Use it to land
# a build on getchama.app (incl. the Fedi mini-app) for testing without cutting a
# full release. For the real versioned release, use scripts/ship.sh.
#
# Usage:
#   ./scripts/deploy-app.sh              delta sync dist/ -> ~/chama-dist/ (additive, safe)
#   ./scripts/deploy-app.sh --prune      ALSO delete server files absent from dist/ (clean, destructive)
#   ./scripts/deploy-app.sh --dry-run    show what would transfer, change nothing
#
# Env:
#   CHAMA_DEPLOY_KEY   SSH key for satoshi@satoshimarket.app (default ~/.ssh/.id_satoshi_market)
#
# NOTE on --prune (rsync --delete): ~/chama-dist/ should hold ONLY the app build.
# --prune keeps it to exactly the current dist/, but it WILL delete anything else
# there — e.g. old pinned fedi-<commit>/ snapshots. Confirm nothing live is served
# from a subdir before pruning. Default (no --prune) is purely additive and can
# never remove a file on the server.

DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-$HOME/.ssh/.id_satoshi_market}"
DEST="satoshi@satoshimarket.app:~/chama-dist/"

RSYNC_OPTS=(-avz)
DRY_LABEL=""
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --prune)   RSYNC_OPTS+=(--delete); shift ;;
    --dry-run) RSYNC_OPTS+=(--dry-run); DRY_LABEL="(dry-run) "; shift ;;
    *) echo "❌ Unknown option: $1"; exit 1 ;;
  esac
done

[ -f "$DEPLOY_KEY" ] || { echo "❌ SSH key not found: $DEPLOY_KEY — set CHAMA_DEPLOY_KEY to your deploy key."; exit 1; }
[ -d dist ] || { echo "❌ no dist/ found — run 'npm run build' first."; exit 1; }

echo "🚀 Deploying dist/ -> $DEST  ${DRY_LABEL}[${RSYNC_OPTS[*]}]"
rsync "${RSYNC_OPTS[@]}" -e "ssh -i $DEPLOY_KEY" dist/ "$DEST"
echo "✅ Web app deployed to getchama.app. This was NOT a release — no git push, no APK, no Zapstore."
