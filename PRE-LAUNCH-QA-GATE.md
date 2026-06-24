# Chama — Pre-Launch QA Gate (Go / No-Go)

A release passes only when every **must** item is green. This gate is the test plan for
the current suite under validation: the native iroh fresh-join hardening (pkarr default,
90s timeout, retries, friendly UX, `/health` diagnostics) + gateway diagnostics.

> Build under test: **next release (post-v3.7.0)** — iroh/gateway changes are uncommitted
> at time of writing ("left for Jetty's split"). Re-run this gate against the committed build.

---

## 0. Build is current (do this FIRST — easy to forget)

- [ ] Rebuild the desktop sidecar: `npm run tauri:sidecar` (compiles the Rust bridge).
- [ ] Rebuild the Android bridge + APK: `scripts/build-android-fedimint-bridge.sh`, then APK.
- [ ] **Confirm the new binary is actually live**, not the old one:
  `curl -s 127.0.0.1:18002/health | jq` → must show `discovery.{status}` and
  `resolver: "n0-pkarr-https+dns"` (old binary lacks these). Title bar build time should be fresh.
- [ ] Fully **Cmd+Q** all dev windows before relaunch so ports free (close ≠ quit).

## 1. Automated gates (must be green)

- [ ] `npm run typecheck` — clean.
- [ ] `npm test` — **2660 passing, 0 failing** (incl. the launcher arg-parity + fresh-join guards).
- [ ] `npm run predeploy` (typecheck + test) — clean.
- [ ] `cargo check` + `cargo fmt --check` in `native/fedimint-bridge` — clean.

## 2. Native fresh-join — THE launch blocker (decisive test = real mobile)

Per `native/fedimint-bridge/FRESH-JOIN-SMOKE.md`. **Localhost passing is NOT sufficient.**

- [ ] *(sanity)* Localhost: "Reset local state" → fresh join succeeds under timeout.
- [ ] **(must) Real mobile, on cellular (not wifi):** fresh-install APK joins the launch
  federation under 90s, repeatably (≥5/5 cold attempts).
- [ ] On any failure, use `/health` `discovery.status` to classify:
  `degraded` ⇒ resolution problem; `reachable` **and** join still hangs ⇒ connectivity
  (the `FM_IROH_CONNECT_OVERRIDES` / upstream-relay branch, NOT a quick toggle).
- [ ] Existing-DB `open()` still works (returning users unaffected).
- [ ] **Federation switch** (e.g. BP ↔ GBF) still works → proves pkarr is *additive*, default not replaced.
- [ ] Friendly retry UX throughout — no raw `500` popup; "retrying… / Reconnect" visible, never looks frozen.

## 3. Lightning gateway / funding (the `/invoice` issue)

- [ ] `curl -s 127.0.0.1:18002/gateways | jq` and `/probe-gateways | jq` → at least one
  **reachable** gateway exists for the launch federation.
- [ ] Buyer can **lock/fund a trade** end-to-end (create + pay a Lightning invoice; sats move).
- [ ] **NO-GO if** no reachable gateway for the launch federation — resolve gateway/federation infra first.

## 4. Core trade flow (3-instance: seller :3001 / buyer :3002 / arbiter :3003)

- [ ] Listing visible; happy path **reserve → fund/lock → settle** completes.
- [ ] Escrow **release** (buyer+seller majority) AND **refund** paths both work; arbiter vote when invoked.
- [ ] Sats reconcile end-to-end — no stuck/locked sats, no double-spend, balances correct.
- [ ] In-trade chat works between parties.

## 5. Connectivity / security hygiene

- [ ] Nostr relays connected; no persistent `wss://` failures during core flows (≥ enough relays healthy).
- [ ] FX / BTC price feed live (median of sources), not stuck "waiting for sources".
- [ ] Console clean on core flows: **no private keys / secrets** logged (event-level logs only).

## 6. Platforms

- [ ] **Web** (getchama.app / chama.community) — loads + core flow.
- [ ] **Tauri desktop** — runs + core flow.
- [ ] **Android APK** (Zapstore + GitHub) — installs + core flow **including fresh-join on cellular**.

---

## Go / No-Go decision

**GO** only if: §0 + §1 green · §2 real-mobile fresh-join passes repeatably · §3 a reachable
gateway exists and a trade funds · §4 happy path + escrow **both** directions · no secrets in logs.

**NO-GO** if any of: fresh-join fails on real mobile · no reachable LN gateway for the launch
federation · sats can get stuck/lost · automated gates red.

Sign-off — date: ________  ·  tester: ________  ·  commit: ________  ·  decision: GO / NO-GO
