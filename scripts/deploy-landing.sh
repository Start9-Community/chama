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
#   CHAMA_DEPLOY_KEY   SSH key authorised for satoshi@getchama.app
#                      (default: ~/.ssh/id_chama — the IncogNET box)
#   CHAMA_DEPLOY_HOST  (default: satoshi@getchama.app)
#
# ⚠ 2026-07-10: migrated off satoshimarket.app — that DNS still points at the
#   RETIRED 1984 box (89.147.108.68, host key CHANGED — possibly reassigned).
#   Never deploy there again.

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY=0
case "${1:-}" in
  --dry-run|-n) DRY=1 ;;
  "") : ;;
  *) echo "❌ unknown arg: $1 (use --dry-run or nothing)"; exit 1 ;;
esac

DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-$HOME/.ssh/id_chama}"
DEPLOY_HOST="${CHAMA_DEPLOY_HOST:-satoshi@getchama.app}"
DEST="$DEPLOY_HOST:~/chama-landing/"

[ -f "$DEPLOY_KEY" ] || { echo "❌ SSH key not found: $DEPLOY_KEY — set CHAMA_DEPLOY_KEY to the key for $DEPLOY_HOST."; exit 1; }
[ -f landing/index.html ] || { echo "❌ landing/index.html missing — are you at the repo root, and did you 'git stash pop' the landing back?"; exit 1; }

echo "▶ scp -r -i \"$DEPLOY_KEY\" landing/* $DEST"
if [ "$DRY" = "1" ]; then echo "↷ --dry-run: nothing sent."; exit 0; fi
scp -r -i "$DEPLOY_KEY" landing/* "$DEST"
echo "✅ Landing live → https://chama.community"
