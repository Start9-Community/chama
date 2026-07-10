# Test results — pre-DNS-cutover (step 5)

**Date:** 2026-06-28  **New box:** `23.137.251.242` (web.getchama.app), Caddy 2.11.4
**TLS note:** tested with a TEMPORARY `tls internal` (self-signed) cert via
`migration/configs/Caddyfile.test`, because automatic Let's Encrypt cannot issue until DNS
points here. `-k` is used to accept the self-signed cert. At cutover the production
`migration/configs/Caddyfile` (automatic HTTPS, no `tls internal`) is deployed → real LE certs.

Two test vantage points:
- **On-box** (`curl -k --resolve <d>:443:127.0.0.1`) — authoritative for content/headers/MIME.
- **Laptop** (`curl -k --resolve <d>:443:23.137.251.242`) — proves UFW + public network path.

## getchama.app — PASS
| Check | Result |
|---|---|
| `GET /` | **200**, `text/html`, 4997 B |
| Security headers | `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin` — all present |
| `Server` header | **removed** (`-Server` works) |
| HTML cache | `Cache-Control: no-store, must-revalidate` |
| **SPA fallback** `/me` | **200**, body **sha256-identical** to disk `index.html` (not 404) ✓ |
| `.wasm` MIME | `/assets/…wasm` → **200**, `content_type=application/wasm` ✓ (Caddy native, no override) |
| `.wasm` cache | `Cache-Control: public, max-age=31536000, immutable` |
| hashed JS asset | `/assets/QRScanner-…js` → 200, `text/javascript`, `immutable` cache |
| HTTP→HTTPS (`:80`) | **308** → `Location: https://getchama.app/` |
| Laptop via public IP | **200**, 4997 B; `:80` → 308 |

## chama.community — PASS
| Check | Result |
|---|---|
| `GET /` | **200**, `text/html`, 87824 B; body sha256-identical to disk `index.html` |
| Security headers | `X-Content-Type-Options`, `Referrer-Policy` present; `Server` removed |
| `GET /faq.html` (real file) | **200**, `text/html` |
| `GET /some-client-route` (fallback) | **200**, body == `index.html` ✓ |
| Laptop via public IP | **200**, 87824 B |

## Not yet on the box (pending Jetty)
- **chama.exchange** — no source config existed on OLD; awaiting 301 target.
- **satoshimarket.app** + subdomains — legacy reverse-proxy apps; not migrated (flagged).
- **ACME email** — none set (matches OLD); optional to add.

## POST-CUTOVER (step 6) — LIVE, real certs, WITHOUT `-k` — ALL PASS
DNS cut over 2026-06-28 (getchama.app + chama.community → 23.137.251.242 only; chama.exchange → new box;
satoshimarket.app kept on OLD). Caddy issued Let's Encrypt certs via HTTP-01 in ~4s.

| Domain | Live result |
|---|---|
| getchama.app `/` | **200**, `cert_verify=0` (valid LE), 4997 B |
| getchama.app `/me` | **200** SPA fallback |
| getchama.app `.wasm` | `application/wasm`, immutable cache |
| getchama.app headers | nosniff / referrer-policy / html `no-store` present; `Server` absent |
| getchama.app `:80` | **308** → https |
| chama.community `/` | **200**, `cert_verify=0`, 87824 B |
| chama.community `/faq.html` / `/some-route` | 200 / 200 (fallback) |
| chama.exchange | **301** → `https://getchama.app/`; path preserved (`/foo/bar`) |
| Certs | Let's Encrypt (CN=YE1/YE2), valid **through Sep 26 2026**, auto-renew |

## SSH hardening (step 7) — DONE, matches OLD
`/etc/ssh/sshd_config.d/00-chama-hardening.conf`: `PermitRootLogin no`, `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `UsePAM no`, `PubkeyAuthentication yes`, `AllowUsers satoshi`.
Verified fresh: `satoshi` key login OK; `root` SSH rejected.
