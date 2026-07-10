# POST-MIGRATION report — 1984 Hosting → IncogNET (Bulgaria)

**Date:** 2026-06-28 · **Status:** ✅ LIVE on the new box, secured, certs valid.

## What moved
| Domain | New box (`23.137.251.242`, web.getchama.app) | Cert |
|---|---|---|
| **getchama.app** | static SPA from `/home/satoshi/chama-dist` (file_server + SPA fallback) | LE, valid → Sep 26 2026 |
| **chama.community** | static from `/home/satoshi/chama-landing` | LE |
| **chama.exchange** | neutral hold: `respond "Chama protocol — coming soon." 200` (own LE cert, no redirect; swap to `file_server`+`root` for the future protocol site) | LE |

Caddy **2.11.4**, runs as user `caddy`, config `/etc/caddy/Caddyfile` (= `migration/configs/Caddyfile`).
Headers replicated exactly from OLD (no COOP/COEP, native `application/wasm`, `-Server`). Automatic HTTPS.

## NOT migrated (intentional)
- **satoshimarket.app + subdomains** — legacy non-static Node apps (`:3000` escrow, `:3001` sandbox,
  `:3002` Nostr relay) + a `410` responder. **Still on OLD.** Its DNS was corrected back to OLD-only.
  Source backed up to `migration/backup/satoshimarket-apps/` (with `.git`, no `node_modules`).

## New box hardening (matches OLD "satoshimarket" posture)
- UFW: default-deny in; allow 22/80/443. unattended-upgrades on.
- SSH (`/etc/ssh/sshd_config.d/00-chama-hardening.conf`): `PermitRootLogin no`,
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `UsePAM no`, `AllowUsers satoshi`.
- Access: `ssh -i ~/.ssh/id_chama satoshi@getchama.app` (or `@23.137.251.242`). Root SSH disabled.
  satoshi ∈ `sudo` group, **password sudo only** (the temporary passwordless grant was reverted).

## Caddy config management WITHOUT sudo (set 2026-06-29)
`/etc/caddy/Caddyfile` is `satoshi:caddy 640` — satoshi owns it, so edit or scp-overwrite it directly
(no sudo), then apply with `caddy reload --config /etc/caddy/Caddyfile` (local admin API `localhost:2019`,
no sudo, persistent because that file is the on-disk config). Only a full `systemctl restart caddy`
needs sudo (password). More locked-down than OLD, which kept passwordless root permanently.

## Verification (live, no -k) — all PASS
See `test-results.md`. getchama.app 200 + valid cert + SPA fallback + `application/wasm`; chama.community
200 + valid cert + SPA fallback; chama.exchange 301→getchama.app (path preserved); `:80`→308→https;
`Server` header absent; security headers present.

## ⚠ DEPLOY SCRIPT — needs retargeting (ACTION)
`scripts/release.sh` still pushes the web build to the OLD box:
```
CHAMA_DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-$HOME/.ssh/.id_satoshi_market}"     # line ~122
scp -r -i "$CHAMA_DEPLOY_KEY" dist/* satoshi@satoshimarket.app:~/chama-dist/   # lines ~266, ~321, ~429
```
After OLD is gone, `npm run ship` would scp into a dead host. Change to the new box:
```
CHAMA_DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-$HOME/.ssh/id_chama}"
scp -r -i "$CHAMA_DEPLOY_KEY" dist/* satoshi@getchama.app:~/chama-dist/
```
(The web deploy only feeds getchama.app, which is now on the new box. chama.community/landing is
scp-only and also moves to `satoshi@getchama.app:~/chama-landing/`.) — left for Jetty to apply.

## ROLLBACK (instant)
OLD is untouched and still serves all domains. To revert:
- At Njalla, set **getchama.app** and **chama.community** A records back to **`89.147.108.68`** (OLD).
- (Optional) remove the **chama.exchange** A record (it had none before).
- TTL 300s → reverts within ~5 min. No data on OLD was changed.

## DECOMMISSION OLD — manual, later
Do NOT cancel/wipe OLD yet. Leave 24–48h for stability. OLD is read-only throughout this migration;
nothing was changed or deleted on it. When ready, decommission via the 1984 panel.

## Backups (`migration/backup/`, gitignored)
- `chama-dist/` (255 files), `chama-landing/` (54 files), `caddy/` (Caddyfile + .baks),
  `satoshimarket-apps/` (federated-escrow, sandbox-escrow, sandbox-escrow-old, abraham-mirror, relay).
- `CHECKSUMS` (sha256). Also pushed: chama-dist + chama-landing onto the new box.
