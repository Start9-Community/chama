# CC BRIEF — Relay-connection fragility: "Not connected" / "Connect to relays before initializing Fedimint"

**Severity: blocks join / trade / Fedimint-init when the Nostr relay pool is degraded.**
**NOT a regression from #9** (funding/bridge/iroh/payout) — verified against the uncommitted diff:
the connect / signer / relay / init code is unchanged; `connect()`'s only diff is chat-notification
wiring, and the auto-login (`App.tsx:700`) + auto-init (`App.tsx:725`) effects are untouched. Same
family as the **chat-wipe-on-restart** issue (relay flakiness).

## Symptoms (3-instance dev, 2026-06-24, after rebuild+relaunch, also on a freshly created listing)
- Buyer "Join as Buyer" → **"Not connected — call connect() first"** (`useEscrow.ts:1455`, `!clientRef.current`).
- Seller → **"Connect to relays before initializing Fedimint"** (`useEscrow.ts:2086`, `!clientRef.current || !signerRef.current`).
- Relay panel: **3 of 5 `DEFAULT_RELAYS` disconnected** (`relay.damus.io`, `relay.primal.net`, `offchain.pub`); only `nos.lol` + `nostr.mom` connected.

## Root cause — two compounding, both pre-existing
1. **Degraded relay pool.** `src/escrow-engine/default-relays.ts` = 5 relays; 3 are currently
   unreachable, so the app reaches only 2. Public-relay uptime is variable and the set has no
   health/fallback margin (the file comment "five steady relays are plenty" assumes they stay steady).
2. **Connect→init→join race with hard-fail guards.** The code documents the race: `connected` flips
   true *synchronously* when `client.connect()` is dispatched, but relay WebSocket handshakes + the
   Nostr-backed seed round-trip are async (`App.tsx:730-739`; `useEscrow.ts:2105`). Auto-init waits
   for `connectedRelays > 0` then fires once (latched by `autoInitDone`) — under a slow/degraded pool
   it can fire into a not-ready state or get stuck after one failure. User actions (Join, init) during
   the not-ready window hit the hard `throw "Not connected…"` guards (`:1455`, `:2086`) instead of
   waiting/retrying. (Also rule out `signerRef` readiness racing the persisted Tauri session restore —
   `signerRef.current` is set at `useEscrow.ts:1084`.)

## Pinpoint first (cheap — do before coding)
Grab the buyer/seller **console** (filter `[chama]` / `[escrow]` / `relay` / `seed`) — it disambiguates:
- "No connected relays — cannot publish" / seed-publish errors → relay-pool / seed round-trip.
- init firing with `signerRef` null → signer / session-restore race.
- guard thrown while relays still handshaking → connect race.

Also: does tapping **Reconnect** recover it? Recovers ⇒ mostly environmental/race; doesn't ⇒ structural.

## Fix directions
1. **Relay resilience.** Broaden / health-bias `DEFAULT_RELAYS` so 2–3 stay up even when several public
   relays are down (add a couple of high-uptime relays; consider a Chama-run relay for launch). Don't
   let 3 simultaneously-dead relays starve the pool.
2. **Reconnect with backoff.** Dropped relays should auto-reconnect (exponential backoff), not stay
   disconnected until a manual Reconnect tap.
3. **Close the connect→init→join race.** Gate join/init on a *ready* connection (≥1 relay actually
   open AND signer present); on the not-ready path show "Connecting…" + auto-retry rather than throwing
   "Not connected." Re-arm auto-init when relays transition 0→≥1 (don't latch `autoInitDone` after a
   failed/empty attempt).

## Verify
- With only 2 of 5 relays reachable (simulate: point 3 default entries at dead URLs), connect →
  auto-init → join → fund all succeed (or show a graceful connecting/retry — never a dead-end
  "Not connected").
- A dropped relay pool auto-recovers (backoff) without a manual Reconnect.
- `npm run predeploy` green. Leave uncommitted for Jetty's split.

## Notes
- Independent of v4.0.0's funding fund-safety bundle (Part 2 + Part 3 + V8) — that work is done and
  unaffected. This is a separate **reliability** blocker in the multi-relay layer.
- Likely **also fixes the chat-wipe-on-restart** item (same relay-flakiness family — partial relay
  rehydration after restart). Tackle together.

## Update — bridge terminal logs (2026-06-24)
- **Bridge side is HEALTHY** — the relay failure is purely the frontend Nostr layer. All 3 bridges:
  `effective iroh config: resolver=n0-pkarr-https+dns` (pkarr fix live), and gateway selection working
  on BOTH paths — seller `selected reachable gateway 0284cf70… (https) to create a receive invoice`
  (Part 1), buyer `…(https) to send this Lightning payment` (Part 2). So #9's funding fixes are
  verified live; this is unrelated.
- **Likely amplifier — LOCAL memory pressure, not (only) dead relays.** The buyer/arbiter host logged
  `netwatch::interfaces::bsd: fetch_rib failed: … OutOfMemory "Cannot allocate memory"`. Running 2–3
  full Tauri+Vite+cargo+bridge stacks on one Mac starves the box; a memory-starved WebView drops relay
  WebSockets, which can present as "relays disconnected." **Rule this out first** (Activity Monitor /
  close an instance / spread across machines) before concluding the public relay pool is the cause.
- The relay-connect errors are in the **WebView devtools console** (Cmd+Opt+I in the Tauri window),
  NOT the terminal — still needed to pinpoint signer-null vs publish-fail vs race if it persists after
  freeing memory.
- Benign: `ApiError { code: 404, message: "chain_id" }` from guardians on all peers — non-fatal
  (gateway selection succeeded right after); a client↔guardian API version quirk, not the blocker.
