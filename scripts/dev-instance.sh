#!/usr/bin/env bash
# scripts/dev-instance.sh — launch a Chama Tauri DEV instance on a FIXED port.
#
# WHY THIS EXISTS
#   A WebView's localStorage (your session / nsec / the trade) is keyed by
#   ORIGIN — http://localhost:<port>. The default `npm run tauri:dev` lets vite
#   grab a random free port whenever :3000 is busy, so every relaunch lands on a
#   NEW origin = a brand-new session, and parallel instances collide / refuse to
#   reopen. Pinning a fixed port per instance gives each a stable, distinct
#   origin → separate sessions that PERSIST across close/reopen.
#   (This is a dev-only quirk; the packaged release build serves from a stable
#   origin and persists fine — your real users never hit it.)
#
# ONE-TIME, before the first instance (so the 3 don't race rebuilding the
# native bridge):
#   npm run tauri:sidecar
#
# THEN run one per terminal:
#   ./scripts/dev-instance.sh 3001 seller
#   ./scripts/dev-instance.sh 3002 buyer
#   ./scripts/dev-instance.sh 3003 arbiter
#
# Quit FULLY with Cmd+Q (not just close the window) so the port frees; relaunch
# the SAME command and the session is exactly where you left it.

set -euo pipefail
PORT="${1:?usage: ./scripts/dev-instance.sh <port> <label>   e.g. 3001 seller}"
LABEL="${2:-inst}"

# NOTE: the window label MUST stay "main". src-tauri/capabilities/default.json
# scopes the http (BTC price / FX fetch), shell-spawn, and notification
# permissions to windows:["main"]. A custom label here = those plugins are
# DENIED in this window and the price silently dies as "waiting for sources"
# (trades still work — the bridge is spawned by Rust main.rs, not the window).
# Per-instance identity lives in the TITLE + CHAMA_TAURI_INSTANCE_ID, not the label.
CONFIG=$(cat <<JSON
{
  "build": {
    "beforeDevCommand": "vite --port ${PORT} --strictPort",
    "devUrl": "http://localhost:${PORT}"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Chama · ${LABEL} (:${PORT})",
        "width": 430, "height": 860,
        "minWidth": 390, "minHeight": 700,
        "resizable": true
      }
    ]
  }
}
JSON
)

# CHAMA_TAURI_INSTANCE_ID keys the SESSION DATA DIR (a *stable* id = the label →
# the session survives close/reopen). The app's Cmd+Shift+N clones use generated,
# throwaway ids — which is why those never persisted.
export CHAMA_TAURI_INSTANCE_ID="${LABEL}"

# Pin a FIXED bridge port per instance. Keep dev clones away from 8787, which is
# the packaged/browser default and may already be occupied by another Chama
# bridge. Deterministic per-instance ports (3001→18001, 3002→18002,
# 3003→18003) keep the bridge stable + unique across relaunches.
if [ -z "${CHAMA_TAURI_BRIDGE_PORT:-}" ]; then
  CHAMA_TAURI_BRIDGE_PORT=$(( PORT + 15000 ))
fi
if [ "$CHAMA_TAURI_BRIDGE_PORT" -gt 65535 ]; then
  echo "❌ Derived bridge port is invalid: $CHAMA_TAURI_BRIDGE_PORT"
  echo "   Set CHAMA_TAURI_BRIDGE_PORT manually, e.g. 18001."
  exit 1
fi
export CHAMA_TAURI_BRIDGE_PORT

# Pre-flight cleanup: free THIS instance's OWN ports if a previous run left them
# held — a crash (the bridge AddrInUse panic), or closing the window without
# Cmd+Q. Tauri's `beforeDevCommand` vite child also orphans on a Rust-side panic.
# We only ever touch this instance's vite + bridge ports, never another
# instance's, so it's safe to run all three windows in parallel.
for p in "$PORT" "$CHAMA_TAURI_BRIDGE_PORT"; do
  pids=$(lsof -ti "tcp:$p" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  ⟲ freeing stale port :$p (was held by pid $pids)"
    kill $pids 2>/dev/null || true
    sleep 0.4
    pids=$(lsof -ti "tcp:$p" 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
done

echo "▶ Chama [${LABEL}] → http://localhost:${PORT} · bridge :${CHAMA_TAURI_BRIDGE_PORT} · session '${LABEL}'  (persistent, fixed ports)"
exec npm run tauri:dev -- --config "${CONFIG}"
