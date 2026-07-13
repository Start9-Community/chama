# Fresh-join smoke gate (native Fedimint bridge)

The native fresh-join hang ("timed out joining federation: deadline has elapsed")
is **network-dependent and flaky**: it passes on localhost/wifi and fails on real
mobile/CGNAT networks. **Localhost passing is NOT sufficient.** This gate exists so
the fix is proven on the surface that actually breaks — a real phone on cellular
data — before a release ships.

## What the fix does (so you know what you're proving)

Native (non-wasm) Fedimint clients otherwise discover guardians only via DNS
queries (:53) and the mainline DHT (UDP) — both routinely throttled/blocked on
mobile/CGNAT. The browser already reaches these same guardians by resolving them
over **HTTPS** via n0's PKARR relay. The bridge now defaults its PKARR resolver to
that same relay (`https://dns.iroh.link/pkarr`), **added on top of** DNS + DHT (not
replacing them — verified in `fedimint-connectors-0.11.1/src/iroh.rs`). So a fresh
join now resolves guardians the same reliable HTTPS way the browser does.

- Lever: `DEFAULT_IROH_PKARR_RELAY` in `src/main.rs`, applied via `set_iroh_dns`.
- Override: `--iroh-dns <url>` / `CHAMA_FEDIMINT_IROH_DNS` (e.g. Chama-owned infra).
- Both launchers (`src-tauri/src/main.rs`, `android/.../MainActivity.java`) inherit
  the default automatically — no launcher flag, so there is no arg-parity to drift.

## Pre-check (necessary, not sufficient)

On the dev box, confirm the resolver is wired and reachable:

```sh
curl -s http://127.0.0.1:8787/health | jq '{join_timeout_secs, iroh, discovery}'
```

Expect:
- `iroh.resolver == "n0-pkarr-https+dns"`
- `iroh.resolver_url == "https://dns.iroh.link/pkarr"`
- `discovery.status == "reachable"` (boot probe TCP-connected to dns.iroh.link:443)
- `join_timeout_secs == 90`

Bridge stderr at boot also logs the effective config:
`chama-fedimint-bridge effective iroh config: dht=true, next=true, resolver=n0-pkarr-https+dns, resolver_url=https://dns.iroh.link/pkarr`

## The gate (do this on a real device + cellular data)

1. **Build** an APK (or Tauri desktop) from this tree.
2. **Wipe state**: fresh install, OR in-app "Reset local state" (deletes `client.db`
   so the join path — not the open path — runs).
3. **Get on a real mobile network**: cellular data, ideally a carrier known for
   CGNAT. **Not** wifi, **not** localhost. Try ≥2 different networks if possible.
4. **Join the launch federation** (BLF by default; Afribit Kibera for the Kenya/KES
   community). Confirm it completes **under 90s**.
5. **Repeat ≥3×**, resetting local state (and toggling airplane mode) between runs,
   to catch the flakiness. All runs must join under the timeout.

### Also verify (regression guards)
- **Existing-DB open still works**: relaunch without resetting → wallet opens fast
  (the open path, 30s timeout, was never the problem — confirm it's untouched).
- **Federation switching still works**: switch to BP and to GBF → both join. This
  proves the resolver is additive and did not replace the n0 default (any fed whose
  guardians publish to n0 must still resolve).

## Reading the result

- **Pass**: every fresh join completes < 90s on cellular, repeatably.
- **Degraded up front**: `/health` `discovery.status == "degraded"` means the device
  can't even reach the HTTPS relay (no network / captive portal / :443 blocked) —
  discovery will fail; fix the network or point `--iroh-dns` at a reachable relay.
- **Still hanging despite `discovery.status == "reachable"`**: resolution works, so
  the failure is guardian **connectivity**, not the resolver. Confirmed in
  `fedimint-connectors-0.11.1/src/iroh.rs`: the native iroh endpoint runs
  `RelayMode::Disabled` on **both** the stable (0.35, line 107) and next (0.90, line
  163) stacks, and there is **no client-side knob to enable relay** (no builder
  method in `lib.rs`). So native reaches guardians by **direct UDP only**.
  Contingency, in order of cost — do NOT attempt before the measurement says it's
  needed:
    1. Confirm the guardian's pkarr record carries a **direct socket address** (not
       relay-only). Outbound UDP from CGNAT to a public guardian addr usually works;
       a relay-only record does not, because relay is disabled here.
    2. If guardians are relay-only or direct UDP is blocked, the fix is **upstream**:
       enable relay in fedimint's iroh connector (fork/patch or upstream PR), or pin
       guardian direct addrs via `FM_IROH_CONNECT_OVERRIDES`. This is **not** a
       Chama-side toggle.
  See `design/mockups/chama-fedimint-freshjoin-CC-brief.md`.

## CI note

The mobile-data leg can't be run in CI (needs a device + carrier network). CI does
lock in the *static* guardrails — the n0-relay default, additive `set_iroh_dns`
wiring, launcher arg-parity, and the iroh-relay version pin — via
`src/escrow-engine/tests.ts` (`npm test`). Treat this document as the manual gate
that the static tests cannot cover.
