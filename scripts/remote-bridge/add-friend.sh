#!/usr/bin/env bash
# Chama remote-bridge "friend wallet" — per-friend instance setup (run ON the VPS).
#
# Usage:  ./add-friend.sh <friend-name> <port> [app-origin]
#   e.g.  ./add-friend.sh brian 8801 https://getchama.app
#
# Creates an isolated bridge instance for one friend:
#   - data dir     ~/chama-bridges/<friend>/data     (own fedimint client DB = own keys)
#   - token file   ~/chama-bridges/<friend>/token    (chmod 600)
#   - run script   ~/chama-bridges/<friend>/run.sh
#   - systemd user unit (if systemd available), else prints a nohup fallback
# Then prints the Caddy route block, the invite link, and runs the auth smoke
# check (a no-token request MUST 401 — one Caddy misconfig = drainable wallet).
#
# Prereq: the linux bridge binary at ~/chama-bridges/chama-fedimint-bridge
# (build on this box: cargo build --release in native/fedimint-bridge, or scp
# a linux-x86_64 build).

set -euo pipefail

FRIEND="${1:?usage: add-friend.sh <friend-name> <port> [app-origin]}"
PORT="${2:?usage: add-friend.sh <friend-name> <port> [app-origin]}"
APP_ORIGIN="${3:-https://getchama.app}"

if ! [[ "$FRIEND" =~ ^[a-z0-9-]+$ ]]; then
  echo "friend name must be lowercase alnum/dash (it becomes a URL path + unit name)" >&2
  exit 1
fi

BASE="$HOME/chama-bridges"
DIR="$BASE/$FRIEND"
BIN="$BASE/chama-fedimint-bridge"
NODE_ORIGIN="$(echo "$APP_ORIGIN" | sed -E 's#^(https?://[^/]+).*#\1#')"

[ -x "$BIN" ] || { echo "bridge binary missing at $BIN — build/scp it first" >&2; exit 1; }
if [ -e "$DIR/token" ]; then
  echo "$DIR already exists — refusing to overwrite an existing friend's token/wallet" >&2
  exit 1
fi

mkdir -p "$DIR/data"
TOKEN="$(openssl rand -hex 32)"
umask 077
printf '%s' "$TOKEN" > "$DIR/token"
umask 022

cat > "$DIR/run.sh" <<RUN
#!/usr/bin/env bash
exec "$BIN" \
  --data-dir "$DIR/data" \
  serve \
  --bind "127.0.0.1:$PORT" \
  --auth-token "\$(cat "$DIR/token")" \
  --allowed-origin "$APP_ORIGIN" \
  --allowed-origin "$NODE_ORIGIN"
RUN
chmod +x "$DIR/run.sh"

STARTED=""
if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/chama-bridge-$FRIEND.service" <<UNIT
[Unit]
Description=Chama fedimint bridge — $FRIEND

[Service]
ExecStart=$DIR/run.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "chama-bridge-$FRIEND.service"
  STARTED="systemd"
  echo "✓ systemd user unit chama-bridge-$FRIEND started (loginctl enable-linger \$USER to survive logout)"
else
  nohup "$DIR/run.sh" >> "$DIR/bridge.log" 2>&1 &
  STARTED="nohup"
  echo "✓ started via nohup (pid $!) — no systemd user session found"
fi

sleep 2

echo
echo "── Caddy route (add inside the $NODE_ORIGIN site block, then reload caddy) ──"
cat <<CADDY
	handle_path /w/$FRIEND/* {
		reverse_proxy 127.0.0.1:$PORT
	}
CADDY

echo
echo "── Smoke check (auth gate) ──"
NO_TOKEN_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)"
WITH_TOKEN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" || true)"
echo "no-token  /health → $NO_TOKEN_CODE (must be 401)"
echo "with-token /health → $WITH_TOKEN_CODE (must be 200)"
if [ "$NO_TOKEN_CODE" != "401" ] || [ "$WITH_TOKEN_CODE" != "200" ]; then
  echo "✗ AUTH SMOKE FAILED — do NOT expose this instance" >&2
  exit 1
fi
echo "✓ auth gate verified"
echo
echo "AFTER adding the Caddy route, re-verify THROUGH the proxy:"
echo "  curl -s -o /dev/null -w '%{http_code}\n' $NODE_ORIGIN/w/$FRIEND/health          # must be 401"
echo "  curl -s -H \"Authorization: Bearer \$(cat $DIR/token)\" $NODE_ORIGIN/w/$FRIEND/health | jq .api_version   # must be 3"
echo
echo "── Invite link for $FRIEND (fragment never reaches any server; app claims + strips it) ──"
echo "$APP_ORIGIN/#bridge=$NODE_ORIGIN/w/$FRIEND&token=$TOKEN"
