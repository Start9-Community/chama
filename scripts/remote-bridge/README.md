# Remote-bridge "friend wallets" — PoC runbook (2026-07-14 brief)

Run the Rust fedimint bridge as ONE instance per invited friend on a server
Jetty controls; each friend's browser (including iPhone Safari) talks to their
own bridge over HTTPS. "Tauri, but the sidecar is remote." No escrow-engine
changes — this is auth + plumbing only.

## What shipped in code

- **Bridge** (`native/fedimint-bridge`): `serve` gained `--auth-token`
  (env `CHAMA_BRIDGE_AUTH_TOKEN`) — every route incl. `/health` requires
  `Authorization: Bearer <token>` (constant-time compare) — and
  `--allowed-origin` (repeatable; env `CHAMA_BRIDGE_ALLOWED_ORIGINS`
  comma-separated) replacing the permissive CORS `Any` origin. Guard:
  serve **refuses to start on a non-loopback bind without a token**.
  Token unset ⇒ byte-identical localhost behavior (Tauri/Android untouched).
- **Frontend**: `chama_native_fedimint_token` localStorage key, attached as a
  Bearer header at the adapter's single fetch choke point; a bridge URL set in
  localStorage now turns native mode ON by itself (configure once, forget;
  clearing the URL migrates back to the browser SDK); invite links carry
  `#bridge=<url>&token=<t>` in the FRAGMENT — claimed into localStorage and
  stripped at boot (`main.tsx`), never sent to any server; a "Chama node"
  card in Me → Settings → Advanced for manual URL+token entry / disconnect.
- **Ops**: `add-friend.sh` (this dir) — per-friend data-dir + token +
  systemd/nohup runner + Caddy snippet + invite link + the mandatory
  no-token-must-401 smoke check.

## PoC steps (existing getchama.app VPS, before the StartTunnel box)

1. **Build the bridge for linux-x86_64.** Easiest: build ON the VPS
   (`git clone`/rsync the `native/fedimint-bridge` dir, `cargo build
   --release`; rocksdb makes cross-compiling from macOS painful). Place at
   `~/chama-bridges/chama-fedimint-bridge`.
2. **Per friend:** `./add-friend.sh jetty-test 8801 https://getchama.app`
   (ports 88NN, one per friend). The script refuses to clobber an existing
   friend dir and fails hard if the auth smoke check fails.
3. **Caddy:** paste the printed `handle_path /w/<friend>/*` block into the
   getchama.app site config, reload, then run the printed through-the-proxy
   checks (no-token 401; with-token `api_version` = 3). Caddy auto-HTTPS
   already refuses plain HTTP.
4. **Friend config:** send the printed invite link
   (`https://getchama.app/#bridge=...&token=...`) — the app claims it and
   strips the fragment on first open. Manual fallback: Me → Settings →
   Advanced → "Chama node".
5. **Acceptance** (desktop browser AND iPhone Safari): join fed → fund via
   LN invoice → browse → lock → chat → settle → claim → payout lands.
6. **Kill-test:** reload mid-lock in Safari → the #37 drain/resume flow
   should mirror Tauri (it's all client-localStorage + bridge).

Only after green: buy the StartTunnel VPS + package the s9pk (supervisor +
Caddy + dist), keeping this VPS setup as the reference config.

## Constraints to state in the invite (from the brief)

- **Named-human trust:** the friend's fedimint keys live on Jetty's box (like
  using a friend's Alby Hub). Option B keeps exposure transient — wallets
  drain at settlement; "Chama holds nothing between trades."
- **One browser per friend:** crash-safety state (pending-native-locks stash,
  payout journal, per-escrow mutex) is localStorage in ONE browser. v1 rule =
  one browser; journal moves bridge-side later.
- Never serve `/w/*` without the token check — one Caddy misconfig =
  drainable wallet. Re-run the through-the-proxy 401 check after ANY Caddy
  edit.
