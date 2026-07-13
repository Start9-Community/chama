# Chama community relay — build + deploy runbook

A khatru (Go) Nostr relay for `wss://relay.chama.community`, tuned for Chama:
- **Store-all, collapse-nothing.** Chama's escrow/chat events are addressable (kind 38xxx, every event in a trade shares `d=<escrowId>`). A stock relay treats them as parameterized-replaceable and keeps only the latest per `(kind, pubkey, d)` — which would gut chat history (every CHAT is kind 38108). This relay routes the replaceable/addressable path to a plain save, so **nothing is ever replaced or deleted**. Kind-5 deletes aren't accepted, so nothing can erase a stored event.
- **Chama-only writes.** Only the kinds the app publishes are accepted; reads stay open. See `allowedKind()` in `main.go`.
- **Also serves NIP-46** (remote signing — Amber/nsecBunker). Kind 24133 is allowlisted; it's ephemeral, so khatru just brokers it between client and signer and stores nothing. This replaces the old 1984 box's throwaway relay (`relay.satoshimarket.app`) as the NIP-46 rendezvous — see "Old box" below.
- Runs bound to `127.0.0.1:7777`; Caddy fronts TLS. Badger backend, no eviction (13 GB disk; retention off).

Why: public relays propagate votes/chat unreliably (the "vote2 didn't arrive" glitch = public defaults down below fetch quorum). One always-up home every client publishes to AND reads back fixes it for every user. Kept **alongside** the public pool in `src/escrow-engine/default-relays.ts` (redundancy — publics are the fallback).

## Old box (1984 / relay.satoshimarket.app) — migrate or start over?
Investigated (2026-07-01): the old box is up (129-day uptime), but its relay (`~/nostr-relay.mjs`) is a 2.4 KB **in-memory** toy — `const events = []; // last 500`, no database, no persistence. So there is **zero durable data to migrate**. Its only real function was as the **NIP-46 rendezvous relay** (the only place `src/escrow-engine/nip46-signer.ts` pointed). This relay now absorbs that role (kind 24133 above), and `nip46-signer.ts` is repointed to `relay.chama.community` (with `relay.satoshimarket.app` kept as a transitional fallback). **Once this relay is live + NIP-46 verified, the old box can be decommissioned** and the fallback line dropped.

## Files here
- `main.go`, `go.mod`, `go.sum` — the relay source (khatru v0.19.1 / eventstore v0.17.8 / go-nostr v0.52.3).
- `chama-relay.service` — systemd unit (User=satoshi, binds 127.0.0.1:7777, memory-capped for the 426 MB box).
- `relay.caddy-block` — the Caddyfile vhost to append.

## Build (cross-compile a static linux/amd64 binary — the box has no compiler)
```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o chama-relay .
# → static ELF, no libc dependency. scp to satoshi@getchama.app:/home/satoshi/relay/chama-relay
```
Badger is pure Go, so `CGO_ENABLED=0` yields a fully static binary. Already built + staged at `/home/satoshi/relay/chama-relay` on the box (sha256 verified, and test-run confirmed it serves NIP-11 there).

## Deploy — current status: ✅ LIVE at wss://relay.chama.community (2026-07-02).
DNS set, systemd unit running (127.0.0.1:7777), Caddy vhost live with a valid Let's Encrypt cert. Verified over `wss://`: CHAT (38108) write→read, two-voter VOTE (38103) both returned (the vote2 fix), kind-1 blocked, NIP-46 (24133) delivered to a live subscriber + stored 0 copies. Existing sites (getchama.app / chama.community) unaffected (200). Steps below are the original bring-up (kept for reference / rebuild).

**Still owed:** Jetty commits the two uncommitted code edits (`default-relays.ts`, `nip46-signer.ts`); on-device 3-instance vote2 confirm + a real NIP-46 (Amber) login round-trip; then decommission the old 1984 box and drop the `relay.satoshimarket.app` fallback line.


### Step 1 (Jetty) — DNS
Add at Njalla:  `relay.chama.community  A  23.137.251.242`  (TTL 300).

### Step 2 (Jetty, sudo) — install + start the relay
```bash
sudo cp /home/satoshi/relay/chama-relay.service /etc/systemd/system/chama-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now chama-relay
systemctl status chama-relay --no-pager
curl -sS -H 'Accept: application/nostr+json' http://127.0.0.1:7777/ | head -c 120   # sanity: NIP-11 doc
```

### Step 3 (no sudo — satoshi owns the Caddyfile) — front it with TLS
Append `relay.caddy-block` to `/etc/caddy/Caddyfile`, then:
```bash
caddy reload --config /etc/caddy/Caddyfile     # local admin API, no sudo; validates before swapping
```
A bad Caddyfile is rejected and the running config is kept — a failed reload can't take the web app down. Best done **after** Step 1 (DNS) so the cert issues immediately.

### Step 4 — smoke test
```bash
# from anywhere with nak:
nak event -k 38108 -c "relay smoke $(date +%s)" -t d=smoke --sec 01 wss://relay.chama.community
nak req   -k 38108 -t d=smoke                                   wss://relay.chama.community   # expect it back
```
Then:
- run the 3-instance trade flow with the Chama relay in the pool and confirm **vote2 propagates cleanly**;
- test **NIP-46 login** (Connect screen → remote signer / Amber) end-to-end, since this relay is now the rendezvous. (kind 24133 is ephemeral — verified locally that it's delivered to a live subscriber and stored as 0 copies.)

## Rollback (fully reversible)
```bash
sudo systemctl disable --now chama-relay
sudo rm /etc/systemd/system/chama-relay.service && sudo systemctl daemon-reload
# remove the relay.chama.community block from /etc/caddy/Caddyfile → caddy reload --config ...
rm -rf /home/satoshi/relay            # binary + data
# revert the DEFAULT_RELAYS edit in src/escrow-engine/default-relays.ts
```
Nothing here touches the web app's vhosts, certs, or the chama-dist deploy path.

## Operate
```bash
systemctl status chama-relay --no-pager
journalctl -u chama-relay -n 50 --no-pager
du -sh /home/satoshi/relay/data        # DB growth
```
Data dir is `/home/satoshi/relay/data`. Retention is off (keep everything); revisit only if disk pressure appears (13 GB free today).
