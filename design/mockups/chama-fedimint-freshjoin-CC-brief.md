# CC BRIEF — CRITICAL: native Fedimint fresh-join hang (iroh discovery never reaches the guardian)

**Severity: LAUNCH BLOCKER.** Fresh installs can't join the federation → no listings, no funding, no trades; login can fail too. Seen on **both APK and Tauri**, and it's **flaky** (works on localhost sometimes, fails on real networks — consistent with a discovery/transport race, not a hard outage).

Popup:
```
Native Fedimint bridge /join failed (500): open failed before join attempt:
failed to open Fedimint client: Client database not initialized:
timed out joining federation: deadline has elapsed
```

All claims below were verified against the code at the cited `file:line`. The two original "blocker" questions are **already answered from the code** — CC does not need to wait on Jetty to start.

---

## ⏱ IMPLEMENTATION STATUS — updated 2026-06-23 (hardening pass landed; root cause still OPEN)

A hardening pass was implemented (by another agent while CC was down) and **verified in-tree here** (uncommitted). It makes the failure graceful, time-tolerant and diagnosable, and adds the regression guards — but it does **NOT** fix the root cause. **Fresh-join still rides the same iroh discovery that's failing**, so the launch blocker is *mitigated, not resolved.*

**DONE & verified (maps to §6–§7):**
- Bridge join timeout 45s → **90s** (`main.rs:49`).
- Effective-iroh-config **diagnostics**: struct + startup log + `/health` exposure (`main.rs:509-531, 1414-1424`). With a custom resolver set, `/health` reports `resolver:"custom+default"` — encoding the additive semantics below.
- Frontend: **105s** per-attempt wait, **2 retries w/ backoff** `[0, 1.5s, 4s]`, retries **only** on discovery errors (a bad invite throws immediately), friendly "Couldn't reach … tap Reconnect" copy replacing the raw 500 (`native-bridge-adapter.ts:37-38, 374, 600-642`).
- **Guardrails (§7):** launcher arg-parity test asserting Tauri (`main.rs`) and Android (`MainActivity.java`) bridge args match **and** their `--iroh-dns`/`CHAMA_FEDIMINT_IROH_DNS` wiring presence is identical; plus stale-sidecar, join-retry, and native/browser iroh-relay tracking tests (`tests.ts:9688, 9831`).
- Checks reported: `npm run typecheck` ✓ · `npm test` 2656 passed ✓ · `cargo check` ✓ · `cargo fmt` ✓.

**Blocker #2 — RESOLVED (favorably):** in vendored `fedimint-connectors 0.11.1`, `set_iroh_dns` **adds** a custom resolver while the iroh endpoint **keeps** the default DNS/DHT path → **additive, not replace.** ⇒ Path B is fed-switch-safe. ⚠ Not re-verifiable in this sandbox (no Cargo registry mounted); the bridge now encodes it as `resolver="custom+default"`, consistent with the claim — CC should re-confirm on the real toolchain.

**STILL OPEN (the actual launch blocker):**
1. **Root-cause fix (§5).** Nothing yet makes native discovery reach the guardian. Path B stayed correctly unwired (no resolver URL exists). Path A (guardian publishes to the default resolver) needs guardian access + a live test. Drive it with the new `/health` `effective_iroh_config` + startup log on a real device.
2. **Real fresh-install mobile-data smoke** — explicitly not done (needs APK/device/network + guardian path). This is the gate that proves the fix; localhost passing is not sufficient (the bug is flaky/network-dependent).
3. **Watch:** worst-case fully-broken discovery now retries ~90s × 3 (+backoff) ≈ up to ~5 min before the friendly error. Fine on flaky nets where a retry helps, but confirm the "retrying…" state is visible throughout so it never looks frozen.

**Related open backlog items** (`BACKLOG.md`): "Iroh-WebSocket browser asymmetry note" (L414) and "Native browser iroh transport" long-horizon (L417) — docs/upstream, not blockers.

---

## 🆕 RELATED-BUT-DISTINCT ISSUE — 2026-06-23: `/invoice` "no reachable Lightning gateway"

Surfaced in 3-window dev test (buyer :3002 → bridge :18002). Popup: *"Native Fedimint bridge /invoice failed (500): Couldn't find a reachable federation Lightning gateway… Gateway selection timed out after 12s."*

**This is NOT the fresh-join discovery bug.** Proof, from the code: that exact wording is the branch at `main.rs:849-853`, reached **only when `refresh_error == None`** — i.e. `ln.update_gateway_cache()` succeeded, which *requires reaching the guardians*. So the join/discovery layer is working in this session. The failure is one layer deeper: `ln.select_available_gateway(None, None)` timed out at `GATEWAY_SELECT_TIMEOUT` (12s, `main.rs:51`) → the federation's **Lightning gateway** is unreachable/unavailable (or none is registered). Frontend `/invoice` sends no `gateway_id`/`force_internal` (`native-bridge-adapter.ts:718-723`), so it's pure auto-select.

**30-second live confirm** (buyer bridge): `curl -s 127.0.0.1:18002/gateways` and `curl -s 127.0.0.1:18002/probe-gateways`.
- Empty `gateways` → federation has **no LN gateway** → infra/federation problem (use a federation with a live gateway, or get one online). Not a Chama code bug.
- Gateways present but `probe-gateways` shows none reachable → gateway(s) **offline/unreachable**; check whether their `api` URLs are clearnet (uptime/firewall) or iroh (then it *is* transport-adjacent to the join issue).
- Gateways present + reachable but `vetted=false` → `select_available_gateway` may be filtering them out (cf. GBF note, `federation-invites.ts:67-70`); Chama-side fix = allow vetted=false or pass an explicit `gateway_id`.

**Status:** diagnosed, root cause depends on the probe output above; likely federation/gateway infra, not the iroh join fix. Separate task from the launch-blocker join fix.

---

## 📌 FOLLOW-UP FOR CC — 2026-06-23 (two caveats on the discovery fix)

**Direction endorsed.** Default the bridge's `iroh_dns` to n0's pkarr relay (`https://dns.iroh.link/pkarr`) — additive (stacks on DNS+DHT), overridable via `--iroh-dns` / `CHAMA_FEDIMINT_IROH_DNS`, inherited by both launchers with zero arg edits. Your add-vs-replace and version-availability findings match this repo's `Cargo.lock` (iroh `0.35.0` **and** `0.90.0`, both `iroh-relay` majors, and `pkarr` are all present). Bake in two things:

**1. Pkarr fixes *resolution*, not *connectivity* — watch `RelayMode::Disabled`.**
Adding the PkarrResolver lets native *find* the guardian's address over HTTPS (the browser's path). It does **not** change how native *connects*. You found the native connector running `RelayMode::Disabled` (direct-UDP only). On mobile/CGNAT, direct UDP is frequently blocked — the browser only traverses CGNAT because it uses iroh-relay-over-WebSocket for transport. So a successful resolution can still be followed by a connection timeout (same "deadline elapsed" symptom).
- Confirm first whether relay is actually disabled on the path *in use* — stable (0.35) vs `iroh_next` (0.90) may differ; `build_from_client_defaults` enables both.
- If the real-mobile test (§8) still fails after the pkarr default → enable relay fallback (don't leave RelayMode Disabled). `iroh-relay 0.90` is already in the tree. Ship pkarr first, measure, then relay only if needed.
- Make the `/health` join readiness probe real (currently stubbed `"unprobed"`) so a device can distinguish resolution-failure from connection-failure instead of guessing.

**2. The `/invoice` "no reachable Lightning gateway" error is a SEPARATE layer — don't fold it into this fix.**
Seen 06-23 (buyer :3002 → bridge :18002). Not the discovery bug: the wording is the `select_receive_gateway` branch (`main.rs:849-853`) that runs **only after** `update_gateway_cache()` succeeded — guardians were already reachable. The failure is `select_available_gateway()` timing out (12s) → the federation's LN gateway is unreachable/absent, one layer past discovery.
- Triage with the bridge's own routes: `curl -s 127.0.0.1:18002/gateways` and `/probe-gateways`.
  - empty list → no gateway registered (federation/infra; test on a federation with a live gateway).
  - listed but none reachable → gateway offline; check `api` URL scheme (clearnet = uptime/firewall; iroh = the pkarr/relay work above may help on mobile).
  - reachable but `vetted=false` → `select_available_gateway` is filtering them out (cf. GBF note, `federation-invites.ts:67-70`); Chama-side fix = accept unvetted or pass explicit `gateway_id`.
- The pkarr/relay discovery fix *may* help gateway resolution on mobile (if gateways are iroh nodes) but will **not** fix the localhost gateway error. Keep it a separate task.

---

## 1. Verified root cause

- **Fresh-join path.** `Bridge::open_or_join` (`native/fedimint-bridge/src/main.rs:552`) tries `open()` first, which needs an existing `client.db`. A fresh install has none, so it falls through to `join_invite` (`main.rs:505`) and appends the open error as context → produces the exact popup string (`main.rs:570`).
- **Where it hangs.** `join_invite` runs `builder.preview(connectors, &invite).join(db, root_secret)` inside `tokio::time::timeout(FEDERATION_JOIN_TIMEOUT, …)` (`main.rs:511`). `preview` has to **resolve and reach a guardian via iroh discovery**. On a fresh client over mobile it doesn't, so the **45s** timeout (`FEDERATION_JOIN_TIMEOUT`, `main.rs:49`) elapses → "deadline has elapsed". Returning users (existing `client.db` → `open()`, 30s) are fine. Fresh installs hang — exactly the Nairobi launch audience.
- **The discovery lever is never pulled.** `iroh_dns: Option<SafeUrl>` (`main.rs:71-72`, env `CHAMA_FEDIMINT_IROH_DNS`) gates `set_iroh_dns` (`main.rs:1183-1184`). It is `None` because **neither launcher passes it**:
  - **Tauri** `start_bridge_sidecar` spawns only `--data-dir <dir> serve --bind <addr>` (`src-tauri/src/main.rs:215-221`). Tauri sidecars don't inherit parent env, so even exporting `CHAMA_FEDIMINT_IROH_DNS` on the app wouldn't reach it.
  - **Android** `MainActivity.startFedimintBridge()` builds the identical arg list `--data-dir <dir> serve --bind <addr>` (`android/app/src/main/java/app/chama/market/MainActivity.java:84-90`); the only env it sets is `RUST_LOG` + `LD_LIBRARY_PATH` (`:94-95`).
- **Key nuance — discovery is already ON and it still hangs.** `iroh_enable_dht` defaults to `true` (`main.rs:63`) and `iroh_enable_next` defaults to `true` (`main.rs:67`). So DHT + the next-gen iroh stack are both enabled on fresh join and the guardian still isn't reached. ⇒ the missing piece is **reliable resolution of the guardian's iroh node**, not "turn discovery on". This points at transport/resolver *alignment*, not a toggle.

---

## 2. Crucial evidence: the guardian is UP — this is a native-transport bug, not infra/foul-play

- **Browser path reaches the federation fine.** `src/fedimint/federation-config.ts:5-11` and `src/communities/registry.ts:106-115`: after the v0.5.0 canary SDK bumped **iroh-relay to 0.90** (which cleared a 400 Bad Request that previously gated browser WebSocket transport), BLF is `browserReliable: true` and end-to-end browser join/mint/claim is verified. So guardians are online and serving.
- **The native bridge fails on a different iroh path** — DHT/DNS **discovery** of the guardian node, which is finickier than the browser's iroh-relay. Do **not** anchor on "guardian is down" or "stand up a PKARR" or foul-play. The long relay-version churn in the codebase (0.90 bump, the 400 fix, "canary iroh bump") shows this layer is fragile bleeding-edge.
- **First diagnostic step for CC:** compare the bridge's *effective* iroh transport — the iroh-relay version the fedimint crate actually pulls, plus DHT / next / DNS resolver — against what the browser SDK uses for BLF, and align them. The lever-wiring in §4 is one fix; the real target is making the native iroh transport resolve the guardian the browser already reaches.

---

## 3. What iroh-dns/PKARR actually is (so the fix doesn't break fed-switching)

- An iroh node (guardian) is addressed by a **node pubkey**. A PKARR/DNS **resolver** maps node-pubkey → current address. The guardian keys come from the federation invite. iroh ships a **default** resolver (n0's `dns.iroh.link`); the bridge uses it today.
- A guardian is only resolvable via a resolver it **publishes to**. ⇒ pointing the bridge at a single Chama-only resolver that **replaces** the default would break joining any *other* federation whose guardians publish only to the default. **Chama is multi-federation** — do not replace the default:
  - BP `b21068c8…`, Afribit Kibera `ff286a6e…`, Bitsacco (id null), BLF `888b70ec…`, GBF `1bcb64e6…`.
- **On `d73fffd06a`:** that value matches **none** of the federation IDs above — it is a guardian **node id** (precisely the thing PKARR resolves), not a federation ID. Confirm which federation it belongs to before any guardian-side change — almost certainly **Afribit Kibera**, explicitly "the Adopting Bitcoin Nairobi demo partner community" (`src/fedimint/federation-invites.ts:26-37`).

---

## 4. Blocker resolutions (answered from the code)

1. **Did v3.6.0 stand up a Chama PKARR/iroh-dns server?** **NO.** v3.6.0 (commit `1be9c34`) added *only* the flag + plumbing (`iroh_dns`, `set_iroh_dns`). The identifiers `CHAMA_FEDIMINT_IROH_DNS` / `set_iroh_dns` / `iroh_dns` appear in **exactly one file** (the bridge `main.rs`) — there is **no resolver URL** in any env file, config, script, or doc. ⇒ there is nothing for the client path to point at today.
2. **Does `set_iroh_dns` add or replace?** **Not determinable from this repo** — it's a method on fedimint-client's `ConnectorRegistry` (a dependency, not our code). The `set_` name implies **replace**. CC MUST confirm against the vendored/cargo fedimint source before using the client path; if it replaces, CC must chain default + Chama explicitly.

⇒ Because of (1), the **guardian-side fix is the only one shippable without new infra**, and it's also the universal / fed-switch-safe one.

---

## 5. Fix — decision tree

**Path A — PREFERRED (guardian-side; universal, fed-switch-safe, no client change, no new infra).**
Make the launch guardian (node `d73fffd06a…`) publish its iroh record to the **default** resolver (`dns.iroh.link`) reliably and keep it refreshed. Default discovery (already enabled) then finds it; every federation keeps working; switching is fine; the client lever stays unused. **Fixes the cause.** Needs: control of the guardian config + confirmation it's actually publishing/refreshing its PKARR record.

**Path B — FALLBACK (only if the guardian can't use the default AND a resolver is stood up).**
1. Stand up a Chama PKARR/iroh-dns resolver; get a URL.
2. Pass it as an **additional** discovery service, **not** a replacement. ⚠ Verify `set_iroh_dns` semantics first (blocker #2); if it replaces, chain default + Chama so other feds still resolve via n0.
3. Wire the value into **BOTH** launchers (env passthrough or explicit `--iroh-dns`):
   - Tauri `start_bridge_sidecar` (`src-tauri/src/main.rs:215-221`)
   - Android `MainActivity.startFedimintBridge()` (`MainActivity.java:84-95`)
   Missing either one = APK or desktop still broken.

---

## 6. Regardless of path — robustness + UX (do now)

- **Timeout.** Bump `FEDERATION_JOIN_TIMEOUT` 45s → ~90s (`main.rs:49`). Fresh join over mobile + discovery + config download can exceed 45s. Leave `FEDERATION_OPEN_TIMEOUT` (30s, `main.rs:48`) as-is — openers aren't the problem.
- **Failure UX.** Replace the raw 500 popup with "Couldn't reach {federation} — retrying…", auto-retry ~2× with backoff, then surface the existing Reconnect affordance.

---

## 7. Guardrails (the "bury it once and for all" ask)

1. **Launcher arg-parity test.** Assert the Tauri and Android bridge arg lists are identical except `--bind`/`--data-dir`, and that any policy-required discovery flag (e.g. `--iroh-dns` when configured) is present in **both**. This exact divergence caused the bug.
2. **Startup readiness probe.** On bridge boot, attempt guardian resolution for the configured launch federation; expose a health flag and surface "discovery degraded" in-app instead of failing silently at first join.
3. **Effective-config logging.** Have the bridge log its resolved iroh config at startup (`dht`, `next`, `resolver = default | <url>`) so a misconfig is obvious in logs.
4. **Iroh-relay version pin/track.** Pin or assert the iroh-relay version the fedimint crate resolves to, with a note/test, so a future bump can't silently desync native vs browser transport again.
5. **Fresh-join smoke gate.** CI job or documented manual gate: wipe db / "Reset local state" → join launch federation under timeout → on a real mobile network → repeatably.

---

## 8. Verify before done

- Fresh install (or post "Reset local state") joins the launch federation **under the timeout, repeatedly, on real mobile data** — not just wifi/localhost (the flakiness is network-dependent; localhost passing is not sufficient).
- Existing-DB `open()` still works.
- Switching to another federation (e.g. BP / GBF) still works — proves the resolver change did **not** replace the default.
- **Leave uncommitted for Jetty's split.**

---

## Appendix — answering "are private keys leaked in the console?" → NO

- The `nostr-provider.js:36 / :71` lines (`calling nip44.decrypt with {peer, ciphertext}` / `result: …`) are emitted by the **nos2x-fox browser extension**, not Chama — there is no `nostr-provider.js` in the repo. They show decrypted escrow **payloads** (votes/resolves and a share envelope whose actual shares remain encrypted under `encryptedFor`) and **public** peer keys. No `nsec` / secret signing key appears.
- Chama's own logging is hygienic: it logs seed **events** ("Seed decrypted via NIP-44", `src/fedimint/seed-manager.ts`), never seed **values**, and truncates decrypt-error messages to 50 chars. `App.tsx:1491` logs the error object on nsec save failure, not the nsec.
- Optional hardening: gate the `seed-manager.ts` `console.debug` seed lines behind a dev flag. The noisy decrypt logs are the dev signer's (the extension) — fix by switching signer or filtering console in dev, not a Chama code change.
