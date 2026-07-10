# Chama community relay — Stage 0 findings (read-only recon)

**Date:** 2026-07-01 · **Box:** IncogNET `web.getchama.app` = `23.137.251.242` · **Access:** `ssh -i ~/.ssh/id_chama satoshi@getchama.app`
**Method:** read-only only (no changes made). sudo is password-gated → could not inspect root-only detail, but listening-port and unit-file enumeration is complete without it.

## TL;DR
- **There is NO relay on the new box** — not running, not installed, not a stopped unit. The NIP-46 relay you were thinking of was the legacy `~/nostr-relay.mjs` on the **OLD 1984 box** (`relay.satoshimarket.app:3002`), which was **not migrated** and is being decommissioned. Nothing to reuse here → **fresh install.**
- The box is **tiny (426 MB RAM)** with **no build toolchain and no sudo-without-password**. That rules out "compile strfry on the box" and shapes the recommendation below.
- Caddy is the reverse proxy and is **satoshi-editable without sudo** — the TLS front-end is the easy part.
- **No `relay.*` DNS record exists** — you'll need to add one at Njalla.

## What's on the box
| Thing | State |
|---|---|
| OS | Debian 13 (trixie), x86_64, uptime 3 days (≈ the 06-28 migration) |
| Running services | `caddy`, `ssh`, + stock systemd units. **Nothing else.** |
| Listening ports | `22` (ssh), `80` + `443` (Caddy, incl. UDP/443 QUIC), `127.0.0.1:2019` (Caddy admin). **No relay port.** |
| Docker | **not installed** |
| Relay software | strfry / khatru / nostr-rs-relay / nak / any bunker — **all absent**; no matching systemd unit in any state; no relay processes |
| Toolchain | **node/npm/go/cargo/git/wget/xcaddy/jq/make/gcc/g++/cmake — ALL absent.** Present: `curl`, `python3 3.13.5`, `caddy 2.11.4` |
| RAM | **426 MB total**, ~297 MB available, 511 MB swap. Load ~0. |
| Disk | 14 GB, 13 GB free (LMDB/SQLite growth is fine) |
| Privilege | `satoshi` ∈ `sudo` + `users`, **NOT `docker`**; **`sudo` requires a password** (can't run privileged steps non-interactively) |
| UFW | 22/80/443 only (per migration notes) — relay binds localhost so **no firewall change needed** |

## Reverse proxy (Caddy)
- `/etc/caddy/Caddyfile` is `satoshi:caddy 640` → **I can edit + reload it without sudo** (`caddy reload --config /etc/caddy/Caddyfile` via the local admin API on `:2019`).
- Vhosts: `getchama.app` (chama-dist SPA), `chama.community` (landing), `chama.exchange` (coming-soon 200). Automatic HTTPS (LE, ACME email `5its9hrp@addy.io`).
- Adding a `relay.<domain>` vhost that `reverse_proxy` → `127.0.0.1:<relayport>` is a **satoshi-editable, no-sudo** change. Caddy 2.11 proxies WebSockets transparently (no extra config). **Must NOT disturb** the three existing blocks or their certs.

## DNS
| Name | Resolves to |
|---|---|
| `relay.getchama.app` / `relay.chama.community` / `relay.chama.exchange` | **(no record — must be created)** |
| `relay.satoshimarket.app` | `89.147.108.68` (OLD box, legacy `.mjs` relay, dying) |
| getchama.app / chama.community / chama.exchange | `23.137.251.242` (this box) ✓ |

## The two real blockers for Stage 1
1. **No passwordless sudo + bare toolchain.** Whatever relay we pick, boot-persistence needs a privileged step (`/etc/systemd/system` unit + `systemctl enable`, or `loginctl enable-linger` for a `--user` unit). A from-source **strfry** build additionally needs `apt install` of build-essential + dev headers *and* would compile C++/LMDB on a 426 MB box (real OOM risk). → **You'll need to run the privileged steps** (or grant temporary passwordless sudo, or hand me the password via a step you run).
2. **DNS record** for the relay subdomain is yours to add at Njalla before Caddy can issue its cert.

## Recommendation: khatru (Go), cross-compiled locally, single binary scp'd in
Given a 426 MB box with no compiler and no sudo-for-builds, the cleanest fit is **khatru** (Go relay framework):
- **Cross-compile a `linux/amd64` static binary on my laptop → `scp` one file in.** Zero build tooling / zero heavy compile on the box (no OOM risk). Rollback = delete the binary + unit.
- **Write policy is native in-process Go** — accept only Chama's kind-bands (`38100–38112` escrow wire, `38120–38134` governance/bond, chat + NIP-44 DM kinds, seed/roster) and/or an npub allowlist. No per-event plugin subprocess (strfry pipes each event to an external plugin — heavier on a tiny box).
- **SQLite backend** (light), reads open, generous/no eviction for Chama kinds + a far size backstop, standard rate-limit + max-event-size.
- Still needs **one** privileged step from you (the systemd unit / linger) — unavoidable for any boot-persistent daemon.

**Alternative — strfry (the brief's default):** more battle-tested at scale, great write-policy plugin hook, but on this box it means either installing Docker (sudo, daemon overhead on 426 MB) or a cross-built/container-built static binary (strfry ships no official static binary → fiddly). For a community relay at this size, khatru is the lower-risk path; strfry is fine if you'd rather have the standard and accept the extra sudo/build handling. Either way the daemon binds `127.0.0.1` and Caddy fronts TLS.

## Proposed Stage 1–3 plan (pending your confirm)
1. **You:** add `relay.getchama.app A 23.137.251.242` at Njalla (or pick a different subdomain — see question below).
2. **Me:** cross-compile khatru (Chama write-policy + SQLite) → scp binary to `~/relay/` on the box.
3. **You (privileged):** drop the systemd unit I hand you + `systemctl enable --now` (or grant temp sudo and I do it). Binds `127.0.0.1:7777`.
4. **Me (no sudo):** add the `relay.<domain>` Caddy vhost (reverse_proxy → `127.0.0.1:7777`) + `caddy reload`. Cert auto-issues once DNS is live.
5. **Me:** smoke test — publish a test event + read it back over `wss://relay.<domain>`; then run the 3-instance trade flow with the Chama relay in the pool and confirm **vote2 propagates cleanly** (the symptom this exists to kill). Report before/after.
6. **Me:** add `wss://relay.<domain>` to `DEFAULT_RELAYS` (keep the public pool + dev localhost). Left uncommitted for your git split.

## Decisions I need from you (Gate)
- **A. Software:** khatru cross-compiled (recommended) or strfry (brief default, needs more sudo/build handling)?
- **B. Subdomain:** `relay.getchama.app`? (or `relay.chama.community` / `relay.chama.exchange`)
- **C. Sudo:** you run the ~1 privileged step from my copy-paste, or grant temporary passwordless sudo?
- **D. Write policy:** kind-band restriction only, or kind-band **+** npub allowlist (tighter, but I need the member npub list)?
