#!/usr/bin/env bash
# scripts/deploy-landing.sh — push the chama.community landing page to the server.
#
# The marketing landing (landing/ — index.html + icons + img) is a SEPARATE site
# from the app. The app build (dist/) deploys to ~/chama-dist/ and serves
# getchama.app; THIS serves chama.community from ~/chama-landing/. The landing is
# intentionally NOT in the GitHub release — ship.sh's `git add -A` holds it out
# via `git stash push -u -- landing/` — so this hand-scp is how it actually goes
# live. (That's why the command was easy to forget: it only lived in shell history.)
#
# Usage:
#   ./scripts/deploy-landing.sh            # scp landing/* → ~/chama-landing/
#   ./scripts/deploy-landing.sh --dry-run  # print the command, send nothing
#
# Env:
#   CHAMA_DEPLOY_KEY   path to the SSH key used for deployment (required)
#   CHAMA_DEPLOY_HOST  SSH destination in user@host form (required)

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY=0
case "${1:-}" in
  --dry-run|-n) DRY=1 ;;
  "") : ;;
  *) echo "❌ unknown arg: $1 (use --dry-run or nothing)"; exit 1 ;;
esac

DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-}"
DEPLOY_HOST="${CHAMA_DEPLOY_HOST:-}"
DEST="$DEPLOY_HOST:~/chama-landing/"

[ -n "$DEPLOY_HOST" ] || { echo "❌ CHAMA_DEPLOY_HOST is required."; exit 1; }
[ -f "$DEPLOY_KEY" ] || { echo "❌ CHAMA_DEPLOY_KEY must name an existing SSH key."; exit 1; }
[ -f landing/index.html ] || { echo "❌ landing/index.html missing — are you at the repo root, and did you 'git stash pop' the landing back?"; exit 1; }

echo "▶ scp -r -i \"$DEPLOY_KEY\" landing/* $DEST"
if [ "$DRY" = "1" ]; then echo "↷ --dry-run: nothing sent."; exit 0; fi
scp -r -i "$DEPLOY_KEY" landing/* "$DEST"
echo "✅ Landing live → https://chama.community"
