# CC BRIEF — #9 Funding gateway selection (`/invoice` "no reachable gateway")

**Severity: LAUNCH BLOCKER** (board item #9, "Funding fund-loss fix", gates Fedi-live). Buyer
can't lock/fund a trade. **Separate from the iroh fresh-join work (#17)** — do not conflate.

## Pinned cause (live probe, 2026-06-23, buyer bridge :18002)

Federation has **3** LN gateways; `/probe-gateways` shows **2 reachable, 1 dead**:

| alias | api | probe |
|---|---|---|
| Fedi us-east-1 | `https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1` | ✅ available |
| Banco Bitcoin | `iroh://d312be0b1291d3730ca5dbe9220e3bb424de1fe1a95dc697eb004827e86a18fa` | ❌ `timed out selecting gateway: deadline has elapsed` |
| Henwen 🐷 | `https://gateway.henwen.net/v1` | ✅ available |

All `vetted=false`. Guardians reachable, gateway cache warm, `/health` discovery `reachable`,
new binary confirmed live (`resolver: n0-pkarr-https+dns`, `join_timeout_secs: 90`).

The frontend `/invoice` call sends **no `gatewayId`/`forceInternal`** (`native-bridge-adapter.ts`),
so `select_receive_gateway`'s auto path calls `ln.select_available_gateway(None, None)`
(`main.rs` ~814). Fedimint's auto-select gets stuck on the dead **`iroh://`** gateway and the
**12s `GATEWAY_SELECT_TIMEOUT`** (`main.rs:51`) elapses *before* it falls through to the two
reachable HTTPS gateways → "Couldn't find a reachable federation Lightning gateway… timed out
after 12s" (the `main.rs:849-853` branch, which only fires after cache refresh already succeeded).

⇒ **Not missing/offline infra** — two gateways ARE reachable. It's blind auto-select being
poisoned by one dead `iroh://` gateway. **Chama-side fixable.** Current failure is **safe**:
no invoice created, no sats moved.

## Quick validation (run before & after the fix)

Explicit *reachable* gateway succeeds where blind auto-select fails:

```
curl -s -X POST 127.0.0.1:18002/invoice -H 'content-type: application/json' \
  -d '{"amountMsats":1000,"description":"gw test","gatewayId":"0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4"}' | jq
```

Returns a bolt11 ⇒ confirms cause + fix direction (that gateway_id is Fedi us-east-1, probed
available). Note `/invoice` is camelCase: `amountMsats`, `gatewayId`, `forceInternal`.

## Fix — bridge-side reachable-gateway selection (`select_receive_gateway`, `main.rs:767-856`)

Replace blind `select_available_gateway(None, None)` in the auto path with "pick a known-reachable
gateway and pass it explicitly to `create_bolt11_invoice`":

1. Refresh cache → list gateways.
2. Pick a reachable one using a **short per-gateway timeout** (e.g. 3–4s, not the full 12s) so
   several can be tried within budget; skip any that time out (the dead `iroh://` one).
3. Preference order: reachable first; among reachable prefer **clearnet (`https`) over `iroh://`**
   on native (native can't reliably reach iroh nodes — same transport limit as #17); then vetted;
   then lowest fee.
4. Pass the chosen `gateway_id` into `create_bolt11_invoice`.
5. Cache the last-known-good gateway to avoid re-probing on every invoice; re-probe if it goes stale.

Reuse the existing `probe_gateways` per-gateway logic to choose.

**Cost-ordered options:**
- **A (recommended):** iterate cached gateways, first that passes a short reachability check wins → explicit invoice.
- **B (simplest):** on native auto-select, filter out `iroh://` gateways, select among the rest. Fine while reachable clearnet gateways exist.
- **C (stopgap, frontend):** app calls `/probe-gateways`, passes a reachable `gatewayId` to `/invoice`. Bridge-side (A/B) preferred — fixes all platforms at once.

## Watch / notes
- Shorten the per-attempt timeout so trying all 3 gateways ≤ the 12s budget; surface "trying alternate gateway…" rather than a hard fail.
- **Tie-in to #17:** the dead gateway is `iroh://`; native likely fails it for the same reason mobile guardian discovery is finicky. Funding doesn't need the iroh fix — just use the reachable HTTPS gateways. BUT a federation whose gateways are **all `iroh://`** (possibly **BLF**, iroh-only) would still have no reachable native gateway until iroh connectivity is solid → flag BLF funding explicitly.
- Keep failing **safe** (no sats move) when there's genuinely no reachable gateway.
- Verify: buyer locks/funds end-to-end on the 3-instance dev after the fix; existing flows unaffected; `npm run predeploy` green.
- Leave uncommitted for Jetty's split.

---

## PART 2 — SAME BUG ON THE OUTGOING `/pay` (CLAIM) PATH (found 2026-06-23, after Part 1 shipped)

**Symptom:** seller can't claim released escrow sats to their NWC wallet —
`Native Fedimint bridge /pay failed (500): failed to start outgoing LN payment: Connection failed: Failed to connect to gateway`.

**Root cause (code-confirmed):** Part 1 fixed only the **receive** path (`select_receive_gateway`
→ `pick_reachable_gateway`). The **outgoing** path `pay()` (`main.rs:1090`) still selects blindly:
`ln.get_gateway(gateway_id, force_internal)` (`main.rs:1108-1111`) with `gateway_id=None` /
`force_internal=false` (frontend `/pay` sends neither). `get_gateway(None)` returns a gateway with
**no reachability filter** → lands on the dead `iroh://` Banco Bitcoin gateway → `pay_bolt11_invoice`
(`main.rs:1118`) can't connect → "Failed to connect to gateway." Same dead gateway, sibling path.

**Fund-safety:** appears **SAFE** — the connect fails *before* any outgoing payment starts, and the
released funds are already the seller's fedimint ecash (claim = withdrawal to external LN), so nothing
is lost; the payout is just pending. ⚠ Board #9 is the "fund-*loss*" item — explicitly **confirm
`RETRY CLAIM` is idempotent** (no double-pay if a prior attempt got further than expected).

**Fix:** in `pay()`'s auto path (when `gateway_id` is None and not `force_internal`), select a
**reachable** gateway instead of blind `get_gateway(None)`. Reuse `pick_reachable_gateway`
(refresh cache → clearnet-first, skip dead `iroh://`, last-good cache) and pass the chosen gateway to
`pay_bolt11_invoice`. Leave the explicit-`gatewayId` and `force_internal` paths unchanged.
- Minimal safe fix = just swap the selector; that alone clears the "Failed to connect" error.
- Outgoing also needs the gateway to **route** the payment. A reachable clearnet gateway (Fedi
  us-east-1 / Henwen) routes normal invoices fine. If you add fall-through to the next candidate on
  failure, only do it for **pre-send** failures (connect/select) — never retry once `pay_bolt11_invoice`
  has begun, to avoid double-pay.

**Verify:** seller `RETRY CLAIM` completes the NWC payout end-to-end on the 3-instance dev; existing
flows unaffected; `npm run predeploy` green. Leave uncommitted for Jetty's split.

---

## PART 3 — NATIVE PAYOUT IDEMPOTENCY / DOUBLE-PAY GUARD (the real #9 "fund-loss" fix)

**Severity: LAUNCH BLOCKER (fund-loss).** Part 2 makes native `/pay` actually *send* for the first
time (before, it always failed at gateway-connect → nothing sent). That exposes a latent double-pay:
the v3.5.1 journal guard is browser/WASM-only and dormant on native. **⇒ Part 2 must NOT ship to
native without Part 3 — bundle them in the same release.**

Verified against raw code (2026-06-23):
- Claim guard (`src/payments/claim-and-payout.ts:756-801`) records a payout `submitted`
  (→ reconcile, no re-pay) **only** when the thrown error has `code === "LN_PAY_INFLIGHT"` (`:763`);
  any other throw → `clearPayoutRecord` → re-payable `payout-failed` (`:780`). The `:759-762`
  comment states this IS the double-send guard.
- `LN_PAY_INFLIGHT` is produced **only** in `src/fedimint/sdk-adapter.ts` (browser/WASM) — never by
  the native adapter.
- Native `/pay` failures throw a plain `Error` with no `code`; native `lightning` has no
  `awaitPayOutcome`, so `src/fedimint/fedimint-client.ts:960` returns `"unknown"` → no reconcile.
- ⇒ On native, an ambiguous payout (HTLC settled at the gateway, but `await_outgoing_payment` /
  local watch errors on a slow link → bridge 500) is misclassified as a clean failure → seller
  retries → fresh invoice → **pays twice; ecash leaves twice.**
- SECONDARY (verified): `readOperationId` (`native-bridge-adapter.ts:262`) treats any non-throwing
  200 as success; `pay()` (`main.rs:1130-1134`) can serialize a non-settled (refund/failure) outcome
  as `200 {"Failure":…}` → claim recorded **settled while the seller was not paid** (false-settled).

**Fix — give native the same submitted→reconcile protection the browser already has:**

Bridge (`native/fedimint-bridge/src/main.rs`):
1. `/pay` returns **unambiguous, discriminated outcomes**:
   - pre-send failure (select/connect failed, nothing sent) → error, SAFE to re-pay (Part 2 already makes connect failures pre-send).
   - **post-send ambiguous** (`pay_bolt11_invoice` ok but `await_outgoing_payment` errors/times out) → `operation_id` + explicit `inflight`/`unknown` status (200 with a discriminated field), **not** a bare 500.
   - settled → success; refunded/failed → explicit `refunded`/`failed` status (not a bare 200 read as success).
2. Reconcile endpoint: await/query an outgoing payment's terminal outcome by `operation_id` (wrap `await_outgoing_payment`) → settled / refunded / inflight.

Frontend native adapter (`src/fedimint/native-bridge-adapter.ts`):
3. `payInvoice`: on the bridge's ambiguous/inflight signal, throw `{ code: "LN_PAY_INFLIGHT", operationId }` so the journal records `submitted` (mirrors browser).
4. Implement native `awaitPayOutcome(operationId)` → calls the reconcile endpoint → `settled`/`refunded`/`unknown`.
5. Classify outcomes: a refund/`{"Failure":…}` must NOT resolve as settled — throw the right code / route to a re-payable failure; only a real success calls `markPayoutSettled`.

Result: native ambiguous payout → `submitted` → on retry, `awaitPayOutcome` reconciles → re-pay ONLY
if definitively failed/refunded; settled → mark claimed (no second send). No double-pay, no false-settled.

**Verify:** simulate an ambiguous payout on native (kill the await/watch after send) → retry does NOT
double-pay (reconciles to settled); a genuine pre-send failure → retry re-pays exactly once; a refund
→ not recorded settled. `npm run predeploy` green. **Ship Part 2 + Part 3 together.** Leave uncommitted.
