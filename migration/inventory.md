# Inventory — OLD (1984 Hosting) → NEW (IncogNET Bulgaria)

> Read-only inventory of the LIVE OLD box. The live Caddyfile is the source of truth.
> Scope (revised 2026-06-28): **static sites only** — one IncogNET box, Caddy serving files.
> No databases, no server-side runtime, no WireGuard. The earlier `vps-migration-brief.md`
> (StartTunnel / BuyVM edge+origin / WireGuard / DBs) is **shelved/obsolete**.

**Date:** 2026-06-28  **Operator:** Claude (laptop) / Jetty approves gates

## 0. Boxes
| | OLD | NEW |
|---|---|---|
| Host | `satoshimarket.app` = `89.147.108.68` (hostname `chama-vps`) | `23.137.251.242` (hostname `web.getchama.app`) |
| OS | Ubuntu 24.04.4 LTS, x86_64 | Debian 13 (trixie), x86_64 |
| Resources | — | 1 vCPU · 426 MB RAM · 14 GB disk (13 GB free) |
| SSH user | `satoshi` (key `~/.ssh/.id_satoshi_market`) | `satoshi` (key `~/.ssh/id_chama`); root currently reachable w/ `id_chama` |
| Web server | Caddy v2.11.1 (user `caddy`, `/etc/caddy/Caddyfile`) | to install (match v2.11.x via official repo) |

## 1. Domains

### CORE (must migrate) — both are static `file_server` + SPA fallback
| Domain | Docroot | Type | Size | Notes |
|---|---|---|---|---|
| **getchama.app** | `/home/satoshi/chama-dist` | static SPA | 62M / 255 files | `try_files {path} /index.html`; 1 `.wasm`; asset cache headers; no SW; no `.well-known` |
| **chama.community** | `/home/satoshi/chama-landing` | static | 12M / 54 files | `try_files {path} /index.html`; `index.html`, `faq.html`, `faq.fr.html`, `icons/`, `img/`; no `.well-known` |

### chama.exchange — ⚠ NOT FOUND
- **No site block** in the live Caddyfile, **no match** for "exchange" in `/etc/caddy/` or any `.bak` file.
- **No A record** in public DNS (`dig chama.exchange` empty).
- ⇒ There is **no existing 301 to preserve**. Cannot be replicated without the intended target.
- **BLOCKING for this domain only** — needs Jetty to supply: the 301 target URL (and whether www/apex, 301 vs 302). Does not block getchama.app / chama.community.

### satoshimarket.app + subdomains — ⚠ NOT STATIC (flag, non-blocking)
All reverse-proxy to local Node backends — **out of scope for a static migration**:
| Host | Backend |
|---|---|
| `satoshimarket.app`, `escrow.`, `p2p.`, `market.`, `lending.` | `reverse_proxy localhost:3000` (escrow app) |
| `sandbox.satoshimarket.app` | `reverse_proxy localhost:3001` |
| `relay.satoshimarket.app` | `reverse_proxy localhost:3002` (Nostr relay; `~/nostr-relay.mjs`) |
| `chama.satoshimarket.app` | static `respond 410` ("moved to getchama.app") — trivially movable if wanted |
- Backend source in `~`: `federated-escrow/`, `sandbox-escrow/`, `sandbox-escrow-old/`, `abraham-mirror/`, `nostr-relay.mjs`.
- Config is backed up. App source NOT pulled (likely large / in git). **Decision needed:** leave on OLD, or migrate the relay/app separately later.

## 2. Faithful-replication details for the two core blocks

### getchama.app (replicate EXACTLY)
```caddyfile
getchama.app {
	root * /home/satoshi/chama-dist
	file_server
	try_files {path} /index.html
	@assets path /assets/*
	@html not path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	header @html Cache-Control "no-store, must-revalidate"
	header {
		X-Content-Type-Options nosniff
		X-XSS-Protection "1; mode=block"
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	encode zstd gzip
	log {
		output file /var/log/caddy/getchama-access.log { roll_size 10mb roll_keep 3 }
		format json
	}
}
```

### chama.community (replicate EXACTLY)
```caddyfile
chama.community {
	root * /home/satoshi/chama-landing
	file_server
	try_files {path} /index.html
	header {
		X-Content-Type-Options nosniff
		X-XSS-Protection "1; mode=block"
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	encode zstd gzip
}
```

**Header rule (from the task): no more, no less.** NO COOP/COEP anywhere (app runs without cross-origin
isolation — adding COEP can break it). NO wasm MIME override (Caddy serves `.wasm` as `application/wasm`
via its built-in type map — verify in step 5). NO `.well-known`, NO CORS rules (none exist on OLD).

## 3. Runtimes / DBs / mail
- **Databases:** none (static sites).
- **Runtimes:** none needed for the two core domains (the Node backends belong only to legacy satoshimarket).
- **Mail / MX:** none on this box (no 25/465/587/143/993 listening).
- **Listening ports (OLD):** 22 (ssh), 80/443 (caddy), localhost 3000/3001/3002 (legacy backends), 53 (systemd-resolved local). Public surface = 22/80/443 only.

## 4. TLS / certs
- OLD: Caddy automatic HTTPS (Let's Encrypt), no email configured (no global options block).
- NEW: Caddy automatic HTTPS. ⚠ ACME email NOT set on OLD → **decision needed** (set one for expiry
  notices, or match OLD = none). Certs will issue on NEW only AFTER DNS points here (HTTP-01/TLS-ALPN);
  pre-cutover tests use `curl -k`.

## 5. Security posture to replicate ("just like satoshimarket")
OLD `sshd_config` (effective): `PermitRootLogin no` · `PubkeyAuthentication yes` ·
`PasswordAuthentication no` · `KbdInteractiveAuthentication no` · `UsePAM no` · `AllowUsers satoshi`.
satoshi ∈ `sudo` group (password sudo; sudo installed). No sshd_config.d drop-ins on OLD.

## 6. Backup (step 2) — DONE
Pulled read-only OLD → `migration/backup/`:
- `chama-dist/` 62M/255 files (counts match OLD), `chama-landing/` 12M/54 files (match OLD),
  `caddy/` (Caddyfile + 5 `.bak` variants). `CHECKSUMS` = 316 files (sha256).
- Also pushed to the NEW box in step 4.

## 🛑 Open decisions for Jetty
1. **chama.exchange** — supply the 301 target (or drop the domain). No existing config to copy.
2. **ACME email** — set one for Caddy (recommended), or match OLD (none)?
3. **satoshimarket.app + subdomains** — leave on OLD (recommended; not static), or migrate relay/app separately?
4. **SSH hardening order** — root SSH (key-only `id_chama`) kept ENABLED through provisioning + Caddy
   config + test, then hardened LAST (disable root + password, `AllowUsers satoshi`) before DNS cutover,
   because satoshi has no non-interactive sudo. OK?
