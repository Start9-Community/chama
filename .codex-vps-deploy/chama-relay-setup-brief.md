# CC Brief — Stand up the Chama community relay (`relay.<chama-domain>`)

**Status:** ready for CC. **This is INFRA on the LIVE VPS** (the same box that serves the web app /
`chama-dist`). Different risk profile from code: a wrong move can take the app offline. **Investigate before
you touch anything; confirm the plan before installing; keep it reversible.** The `DEFAULT_RELAYS` code change
is committed (real prod relay); leave it uncommitted for Jetty's git split like usual.

## Why
Public relays propagate Chama's vote/chat events unreliably — the "vote2 didn't arrive" glitch is public-relay
flakiness (3 of the defaults were down at once, below fetch quorum). A **Chama-run relay that every client
publishes to AND fetches from** is one always-up common home, so events land + are read back instantly. It's
the launch-grade answer `src/escrow-engine/default-relays.ts` already names, and it fixes the glitch for EVERY
user, not just the dev box. (The dev-gated `ws://localhost:7777` already in `default-relays.ts` is the same
fix at dev scale — this is the production version.)

## ⭐ Stage 0 — Investigate the live box FIRST (read-only, report before changing anything)
Jetty switched VPS providers ~2 days ago and thinks a **NIP-46 listening relay is already configured but
unused**. So the first job is to map the box, not install:
- Read `vps-migration-brief.md` (root) for the new-provider context + what moved.
- **What's already listening / running?** `ss -tlnp`, `docker ps`, `systemctl list-units --type=service`.
  Find the existing relay Jetty mentioned — identify the software (strfry / nostr-rs-relay / khatru / a
  bunker's bundled relay) and port, and whether it's a **general-purpose relay** (reusable) or a minimal
  NIP-46-only thing. **If it's a real relay, prefer configuring/exposing IT over a second install** — one
  daemon to run and maintain.
- **What serves the web app?** Identify the reverse proxy (Caddy/nginx) + TLS + the `chama-dist` deploy path
  (`release.sh` scp's `dist/*` here). The relay must reuse that proxy for TLS and MUST NOT disrupt the app's
  vhost / certs / the deploy.
- **DNS/subdomain:** is `relay.getchama.app` (or `relay.chama.community` / `relay.satoshimarket.app`) available
  and pointing at this box? Jetty may need to add the DNS record — surface that, don't guess.
- **Deliverable:** a short findings report (existing relay? reuse or install? which proxy/domain?) + the
  concrete plan, for Jetty to confirm BEFORE Stage 1.

## Stage 1 — The relay (reuse the existing one, or strfry)
- **Reuse** the existing relay if Stage 0 finds a real general-purpose one — just add the Chama write-policy
  + retention (Stage 2) and front it with TLS (below).
- **Otherwise install strfry** (C++/LMDB — the production standard; light, handles a community on a small
  VPS). Docker or a static build; bind to `127.0.0.1:<port>`; systemd unit so it survives reboots.
- **TLS:** front it with the box's EXISTING reverse proxy (a new vhost `relay.<domain>` → the local relay
  port). Wallets need `wss://`. Do NOT stand up a second conflicting proxy or touch the app's vhost/certs.
- **Retention: KEEP Chama's long-lived events — no aggressive eviction.** Escrow chains, bond events, and chat
  are long-lived; the relay must never drop a vote2 or a chat message. Configure generous/no eviction for the
  Chama kinds (below); a size/age cap only as a far backstop.

## Stage 2 — Write policy (this is what makes it "the chamacitos' relay," not a spam magnet)
- **Restrict WRITES** to Chama's traffic: the governance/bond band (`38120–38134`), the escrow wire
  (`38100–38112`), chat + NIP-44 DM kinds, and the seed/roster kinds — and/or a **members allowlist** of known
  Chama npubs. strfry has a write-policy plugin hook; khatru makes a custom policy trivial. Reads can stay open
  (or scoped) — it's writes that attract garbage.
- Rate-limit + max event size as normal relay hygiene.

## Stage 3 — Wire it in + verify (the actual bug this solves)
- Add `wss://relay.<domain>` to `DEFAULT_RELAYS` (`src/escrow-engine/default-relays.ts`) — **keep the public
  pool** (redundancy) **and the dev-gated `ws://localhost`**. This edit ships to prod, so it's committed-grade
  (leave uncommitted for Jetty's split).
- **Smoke test:** publish a test event to `wss://relay.<domain>` and fetch it back (`nak` is handy). Then run
  the 3-instance trade flow with the Chama relay in the pool and **confirm vote2 propagates cleanly** — that's
  the symptom this exists to kill. Report the before/after.
- **Redundancy note for Jetty:** one relay is a single point of failure. Either rely on `Chama-relay + public
  pool` (fine — publics are the fallback), or run a **second** Chama relay later. Don't make the app
  hard-depend on a single self-hosted relay.

## ⚠ Safety (loud — this is a live production box)
- **The web app is served from here.** Nothing in this brief may disrupt the app's vhost, TLS certs, the
  reverse proxy, or the `chama-dist` deploy path. If a step could take the app offline (DNS, firewall, proxy,
  cert changes), STOP and confirm with Jetty first.
- **Investigate → plan → confirm → install → verify.** Make everything reversible (systemd unit, a documented
  config file, no hand-edits you can't undo). No destructive ops on existing services/data.
- Relay ops only — no touching wallets, keys, or funds. `BONDS_ENFORCED` etc. are unrelated here.

## Privacy (state it, not a blocker)
As operator you'd see event *metadata* (who posts what, when). Chama's sensitive content is already encrypted
(NIP-44 chat, the bond descriptors), escrow events are public-ish by design, and self-hosting is arguably MORE
private than renting from damus/primal (you control the logs). Conscious, not a concern.

## Report back
Stage 0 findings (existing relay? reuse vs install? proxy/domain/DNS), the chosen config (retention +
write-policy), and the vote2 before/after smoke-test. Then Jetty commits the `DEFAULT_RELAYS` line.
