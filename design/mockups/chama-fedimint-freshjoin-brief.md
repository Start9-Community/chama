# CC brief — CRITICAL: native Fedimint fresh-join hang (the iroh-dns lever is never pulled)

**Severity: LAUNCH BLOCKER.** Fresh installs can't join the federation → no listings, no funding, no trades; sometimes login fails too. Seen on both **APK and Tauri**. Error popup:
`Native Fedimint bridge /join failed (500): open failed before join attempt: failed to open Fedimint client: Client database not initialized: timed out joining federation: deadline has elapsed`

## Root cause (verified in code)
The v3.6.0 iroh-dns lever — `CHAMA_FEDIMINT_IROH_DNS` / `--iroh-dns` (`native/fedimint-bridge/src/main.rs:71`, *"Optional iROH DNS/PKARR resolver URL for Chama-owned discovery infra"*), added so *"a first-time federation join resolves reliably instead of timing out on an unreachable guardian"* — **is never passed when the bridge is spawned.** `start_bridge_sidecar` (`src-tauri/src/main.rs:212–222`) launches the sidecar with only `--data-dir … serve --bind …`. So `iroh_dns = None` → `set_iroh_dns` (main.rs:1184) never runs → every fresh join (`open_or_join` → `join_invite`, no local `client.db`) depends on **default iroh discovery** to reach the guardians, and hangs into the 45s `FEDERATION_JOIN_TIMEOUT` (main.rs:49). Returning users (existing `client.db` → `open()`) are fine; **fresh installs hang — exactly the Nairobi launch audience.**

## CRUCIAL EVIDENCE: the guardian is UP — this is a native-transport bug, not infra/foul-play
The **browser/Fedi path reaches BLF fine** — `federation-config.ts:7` marks BLF `browserReliable: true` after the v0.5.0 canary iroh-relay 0.90 bump (guardians expose WebSocket endpoints; browser uses the iroh-relay). So the guardian is online and serving. The failure is specifically the **native bridge's iroh discovery** (DHT/DNS) — a different, finickier path than the browser's iroh-relay. So **don't anchor on "stand up a PKARR" / "fix the guardian"** — the likely fix is aligning the **native bridge's iroh transport** (relay version / `iroh_enable_dht` (main.rs:64) / `iroh_enable_next` (main.rs:68) / `iroh_dns`) with the transport that already makes BLF browser-reliable. The codebase's long iroh-relay version history (0.90 bump, the 400 Bad Request fix, "canary iroh bump" — `communities/registry.ts:86,108,115`) shows this layer is fragile bleeding-edge, not sabotage.

**First thing CC should do:** diagnose why the native bridge's iroh discovery can't reach a guardian the browser reaches — compare the bridge's iroh-relay/DHT/DNS config against what the browser (iroh-relay 0.90) uses for BLF. The lever-wiring below is one lever; the real target is the native iroh transport config.

## What iroh-dns actually is (so the fix doesn't break fed-switching)
`iroh-dns`/PKARR is a **discovery server**, not a guardian address: iroh nodes (guardians) are keyed by a pubkey, and a PKARR/DNS resolver turns that pubkey → the guardian's current address. **One resolver resolves all guardians** (their keys come from the federation invite). iroh ships a **default** resolver (n0's `dns.iroh.link`) — the bridge uses it today. A guardian is only resolvable via a resolver it **publishes to**. ⇒ Pointing the bridge at a single Chama-only resolver that **replaces** the default would break joining any *other* federation whose guardians publish only to the default. **Do not replace the default.**

## Fix — two correct paths (decide with Jetty which applies)
- **PREFERRED — guardian-side (universal, fed-switch-safe, no client change):** make the launch guardian (`d73fffd06a`) publish its iroh record to the **default** resolver reliably. Then default discovery finds it, every federation keeps working, switching is fine, and the client lever is unnecessary. Fixes the cause.
- **FALLBACK — client multi-resolver:** if the guardian can't use the default, pass Chama's resolver **in addition to** the default (an extra discovery service, not a replacement), so BLF/Afribit resolve via Chama's and other feds still resolve via n0's. ⚠ Confirm whether fedimint's `set_iroh_dns` (main.rs:1184) **adds or replaces** — if it replaces, CC must chain default + Chama explicitly so fed-switching survives.

If the fallback is used, wire it in `start_bridge_sidecar` (src-tauri:212–222) AND the APK/Android bridge-launch path.

Regardless of path:
- **Timeout robustness.** Bump `FEDERATION_JOIN_TIMEOUT` from 45s (main.rs:49) — fresh join over mobile + iroh discovery + config download can exceed 45s; e.g. 90s.
- **Failure UX.** The raw 500 popup is alarming. On join failure show "Couldn't reach {federation} — retrying…", auto-retry a couple times, then surface the existing Reconnect.

## Jetty resolves (blocks the fix — determines which path)
1. Did v3.6.0 actually **stand up a Chama-owned PKARR/iroh-dns server** (is there a URL), or did it only add the flag? No server ⇒ no URL ⇒ fix is guardian-side.
2. Do you **control the guardian's config** (`d73fffd06a`) to fix its publishing to the default resolver? Yes ⇒ that's the clean, universal path.

## Verify
- Fresh install (or after "Reset local state") joins the launch federation under the timeout, **repeatedly**, on a real mobile network (not just wifi).
- Existing-DB open still works.

Leave uncommitted for Jetty's split.
