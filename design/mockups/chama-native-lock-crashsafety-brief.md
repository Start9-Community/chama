# Chama — native lock crash-safety + the "recover a live trade" bug — findings + fix brief

**Status:** diagnosis complete (2026-07-06, deep-trace). Jetty hit this on a real Tauri device pass and
was RIGHT that it's a real bug (not benign leftover — an earlier chat mischaracterized it as
"working-as-designed"; that was wrong). Root cause confirmed with file:line evidence. No fix code yet.

## The symptom
Buyer reloads Tauri and lands on the **RecoveryBanner** ("⚠ TRADE NEEDS ATTENTION / Your trade with X
didn't finish cleanly / N sats still in your local Chama / Recover N →" — drains to Lightning). But the
SELLER sees the trade as only **CREATED/reserved**: no LOCK, no funds in escrow. So the buyer is told to
"recover the full trade amount to Lightning" for a trade that (per consensus) never locked — advice that
would **abandon a live trade and burn LN fees** when the correct action is to **finish the lock**.

## ⭐ Root cause — the native lock is NOT crash-safe (non-atomic spend→publish, no persisted intent)
`escrow-bridge.ts:284-299` `lockAndPublish` is two separate awaits:
1. `createEscrowLock` → `fedimint-client.ts:1073` `mint.spendNotes(...)` — **consumes wallet balance**
   into OOB bearer notes held in a local JS variable, THEN
2. `publishLockBundle` — publishes the LOCK event.

A Tauri **reload between (1) and (2)** = funds moved out of the mint, **no LOCK published** (trade stays
CREATED/reserved for the seller), and **nothing persisted**. On reload the balance is back to material
(notes reabsorbed / left as baseline), but there is **no record that it belongs to trade T's pending
lock**.

- The **Fedi path IS crash-safe**: `useEscrow.ts:3005` passes `stashPendingFunding` →
  `chama_pending_fundings_v1` (`pending-fundings.ts`), re-absorbed/`drainPendingFundings` on boot.
- The **native/BOLT11 path passes NO stash** (`useEscrow.ts:3134-3162`). `pending-fundings.ts:16-17`
  even *claims* native is atomic — a **false premise** for the reload case. `drainPendingFundings`
  also no-ops off-Fedi (`pending-fundings.ts:204`).

## Why the banner then fires + mis-attributes (`decisions.ts` / `App.tsx`)
`shouldShowRecoveryBanner` (`decisions.ts:788-796`): material balance ✓; `hasAnyActiveEscrow` counts
only **LOCKED/APPROVED** (`App.tsx:1011`, `activeCommittedMsats`) so a CREATED/reserved trade = 0 → not
suppressed; `fundingInProgress` (`midFunding`) = false after reload; `claimPayoutInProgress` = false ⇒
**banner fires**. `identifyStrandedEcashSource` (`decisions.ts:818-858`) then walks for the **most-recent
CLAIM the user signed** → attributes the balance to an OLD, unrelated trade (`App.tsx:1030` even
synthesizes an `inferred-from-claim-history` trace). The funded-but-not-locked trade is never even
considered as the source. Displayed recoverable = full wallet balance = the full trade amount (matches
Jetty's report). Threshold = flat `MATERIAL_RECOVERY_MIN_SATS = 2_000` (`lightning-fees.ts:54`) — the
"patched threshold" that treated a symptom, never the non-atomic lock underneath. **This is why it
recurs.**

## ⭐ The core gap
On native there is **NO persisted "funded trade T, LOCK still owed" state**, so the app genuinely cannot
tell **resume** from **stranded**. A pure banner-guard is unreliable: after a crash with no JOIN
published, the buyer isn't even a participant on the CREATED trade, so "suppress when payer on an open
trade" has nothing to key on. The persisted intent must exist first.

## Fix plan
### A. Root-cause (the real fix) — make the native lock crash-safe, mirroring Fedi
- In `escrow-bridge.ts` `lockAndPublish`, **between spend and publish**, stash the spent lock bundle
  keyed by `escrowId` (extend `PendingFunding`/`stashPendingFunding` to carry the native OOB notes or the
  reconstructable share bundle); **clear only after `publishLockBundle` confirms** the LOCK committed.
- **Boot recovery** (native): if a stash entry exists AND the trade is still non-terminal/lockable →
  **re-attempt the LOCK (resume)**; if the trade is gone/terminal → re-absorb into the wallet. Add a
  native drain/resume path (`drainPendingFundings` currently gated to Fedi at `pending-fundings.ts:204`).
- Result: the buyer's funds **complete the trade** instead of being drained out at a fee.

### B. Banner honesty (rides on A's persisted signal)
- Once A persists the intent, `shouldShowRecoveryBanner` gains a suppressor: a pending native lock stash
  (or the user being payer on a resumable trade) ⇒ **suppress the drain banner**, surface a
  **"Finish locking your trade"** resume CTA instead of `RecoveryPayoutModal`. Improve
  `identifyStrandedEcashSource` to prefer the funded pending trade over the most-recent CLAIM.
- RecoveryBanner.tsx needs a resume variant that does NOT call `onRecover` (drain).

### Interim harm-reduction (optional, if A is deferred)
Reframe the banner when attribution is uncertain (`identifyStrandedEcashSource` null / low confidence):
neutral "you have N sats locally — if you were funding a trade, open it to finish; otherwise move to
Lightning", NOT "your trade with X didn't finish cleanly + Recover". Reduces the harmful drain-a-live-
trade push but does NOT fix the root.

## Ownership note
The real fix (A) touches the native lock atomicity (`lockAndPublish`), the `pending-fundings` store, and
boot recovery — code CC has been deep in. Serious money-path; needs a 3-instance/APK device-verify of the
kill-between-spend-and-publish window. Good candidate for CC, or for a careful dedicated build.

---

# ⭐ VERIFIED DESIGN (2026-07-06, CC pre-build recon — 6-agent adversarial pass)

> **STATUS: BUILT + ADVERSARIALLY HARDENED 2026-07-07 (Jetty Go'd D1–D4 as recommended). Uncommitted;
> typecheck clean; FULL suite green 2963/2963 (new block 29g incl. mutex/stale-snapshot races). A post-build
> 4-lens adversarial review raised 18 findings; all triaged, the real ones fixed same-day (per-escrow flow
> mutex, identity-guarded clears, fed-aware + age-bounded suppression, honest lock outcomes, minimized
> unstashed-spend window, sim-gated UI). See the CLAUDE.md task board entry for the full list + accepted
> residuals + Jetty's device-verify checklist.**

The diagnosis above **holds**, with corrections that change the fix plan. Sources: full traces of
escrow-bridge / fedimint-client / native-bridge-adapter / native `main.rs` / fedimint-mint-client 0.11.1
(cargo registry source) / state-machine / event-parser / relay-manager / decisions / App.

## Corrections to the diagnosis

**There are THREE crash windows, not one** (the original brief conflated them):
- **W1 — funded, not yet spent** (reload after `payment-confirmed` but before `spendNotes`, or lock threw
  post-funding): funds are plain **wallet balance**. Banner fires IMMEDIATELY with the full trade amount.
  ⭐ This is almost certainly what Jetty's device pass hit — because in W2 the balance is *gone*, not
  material (see next). No bearer-note limbo; needs attribution + a "finish your lock" CTA, not a stash.
- **W2 — spent, LOCK not published** (the brief's window): the balance does NOT come back on reload.
  fedimint OOB spends carry a client-side `try_cancel_after` auto-refund — **native default = 7 days**
  (`main.rs:2040` `unwrap_or(60*60*24*7)`; adapter sends no timeout) / **browser WASM = 1 day**
  (@fedimint/core default). The refund state machine persists in the sidecar's RocksDB (survives
  reloads/quits; fires on next client-open if the deadline passed while dead). So the banner mis-fires
  **days later** as a "spontaneous balance jump" attributed to an old CLAIM.
- **W3 — reload DURING `/spend-notes`**: the Tauri sidecar survives webview reloads and COMPLETES the
  spend, but the HTTP response (the only copy of the notes) is never delivered to JS. Nothing to stash
  post-hoc. Covered only by a **pre-spend INTENT record** (attribution + honest copy) + the 7-day
  auto-refund; a bridge spend-operation-log recovery endpoint could close it fully later.

**"RESERVED" is UI-only** — no such EscrowStatus; LOCK is accepted only from CREATED
(`state-machine.ts:597`). And the JOIN worry in "The core gap" is misplaced: `joinEscrow` awaits a relay
ACK before returning and the fund CTA only exists post-JOIN — the real resume hazard is **join-hold
expiry** (buyer's 5-min hold + 2-min lock grace can lapse during the crash gap), not an unpublished JOIN.

## ⛔ Plan A's "re-attempt the LOCK (resume)" is REJECTED — boot must NEVER auto-publish

Four independent killers, each traced:
1. **Chain-poison (permanent):** a chain with TWO distinct LOCK events is unloadable FOREVER for every
   client — the second LOCK's `INVALID_STATE` is not replay-benign (`state-machine.ts:1550-1568`) so
   `loadEscrow` returns null on every fresh boot. Same poison shape from LOCK+CANCEL coexisting (replay
   sorts by kind, LOCK before CANCEL — `event-parser.ts:663-684`) and from buyer-reseat →
   `BUYER_PUBKEY_MISMATCH`. Two LOCKs in the same created_at second replay in ARRIVAL order (no event-id
   tiebreak) → clients can even disagree which won. A boot-resume racing a manual re-fund, a sentinel
   auto-cancel, or a reseated buyer is a money-path chain-brick.
2. **Stale-bundle fraud:** after the try_cancel auto-refund fires, a resumed LOCK is HOLLOW — notesHash
   still matches (bytes unchanged), `parseNotes` is offline-structural, the reducer accepts, and the fraud
   surfaces only when the WINNER's redeem fails `ALREADY_SPENT_UNCONFIRMED` (counterparty who performed
   loses). There is NO freshness oracle: the bridge exposes no spend-state/cancel endpoint
   (`main.rs:1784-1806`) and both adapters DISCARD the spend `operation_id`.
3. **Publish-before-check:** `lockEscrow` publishes to relays BEFORE `applyLocally` rejects, and
   `prepareLockContext`/`preflightLock` have NO status gate — a naive resume broadcasts the second LOCK
   before anything stops it, and `lockAndPublishAction` then SWALLOWS the local reject.
4. Resume needs the signer at boot (NIP-46 = interactive re-pair, per-share remote round-trips);
   re-absorb needs no signer at all.

**Replacement: ALWAYS RE-ABSORB, resume-as-foreground-re-lock.** Boot drain reissues the stashed notes
back into the own wallet via `fedimint.redeemWithRetry` → native `POST /reissue-notes` (the exact
primitive the claim drain already uses on native; mint-mutex covered; idempotent — the mint rejects a
second reissue; fee-free; racing the auto-refund is safe: both are self-credits, loser gets
"already spent"). Success PROVES the old bundle is dead ⇒ zero hollow-lock risk afterwards. Then the
"finish locking your trade" CTA runs the NORMAL foreground lock from the restored balance (fresh spend,
fresh horizon, crash-protected again by the same stash). Same UX as resume — no LN fees, no re-payment —
none of the fraud surface.

**The one state check re-absorb still needs (fail-closed):** a crash between publish-ACK and
stash-clear means our LOCK may be LIVE — re-absorbing then hollows OUR OWN escrow (note: the Fedi drain
has exactly this hole today — `drainPendingFundings` re-absorbs with ZERO escrow-state check). Decision
table per entry, after an explicit `client.loadEscrow(escrowId)` (escrow states are NOT guaranteed
loaded when the drain runs — verified boot-ordering race):
- LOCKED with OUR notesHash → **clear only** (committed; never re-absorb).
- LOCKED with a different hash → our notes never committed → re-absorb → clear on confirmed.
- CREATED / CANCELLED / EXPIRED, stage=`spent` (publish never attempted) → re-absorb → clear on confirmed.
- CREATED, stage=`publish-attempted` → re-absorb ONLY on a healthy (quorum-met) fetch showing no LOCK;
  else keep. [D3]
- null / fetch-failed / fed-mismatch → **keep, do nothing this boot** (v0.1.76 unknown ⇒ refuse).

## ⚠ NEW LATENT FUND-LOSS (found by the recon, independent of any crash) — [D2]

**Every lock spend today carries an auto-cancel SHORTER than a disputed trade's life**: browser 1 day,
native 7 days — and default trade expiry is exactly 1 day (`escrow-client.ts:273`), disputes routinely
longer. Past that horizon the FUNDER's own client auto-refunds the locked notes → a healthy-looking
LOCKED/APPROVED escrow silently hollows out; the winner's claim fails `ALREADY_SPENT_UNCONFIRMED`. No
crash needed. Fix (small, additive): thread an explicit long `tryCancelAfter`/`timeoutSecs` through
`mint.spendNotes` for LOCK spends at BOTH adapters (bridge already accepts `timeout_secs`; @fedimint/core
accepts `tryCancelAfter`). Non-lock spends (ecash export) keep today's defaults. The stash+drain (Part A)
replaces the auto-cancel's crash-recovery role, so a long horizon costs nothing.

## Revised staged plan

**Part 0 — lock-spend cancel horizon** (rides D2): explicit `tryCancelAfter` on lock spends, both
platforms. Record the effective value in the stash entry.

**Part A — crash-safe native lock.** New module `src/fedimint/pending-native-locks.ts`, key
`chama_pending_native_locks_v1` (user-scoped) — a SEPARATE store from the Fedi one, per
pending-fundings' own never-share-recover-actions principle (also: zero old-code interop risk; the Fedi
lane stays byte-identical). Entry: `{escrowId, stage: "intent"|"spent"|"publish-attempted", oobNotes?,
amountMsats, parsedTotalMsats?, federationId, operationId?, spendTimeoutSecs, createdAt, attempts,
lastError?}`. Restructure `bridge.lockAndPublish` onto the PROVEN Fedi lifecycle:
`prepareLockContext` → **assert-stash-writable** (V8 fail-closed probe BEFORE any spend; localStorage
write failure ⇒ refuse the lock) → write INTENT (covers W3 attribution) → spend (surface raw notes +
operation_id — today both are discarded; widen the adapter return) → synchronously upgrade entry to
SPENT with the notes → `createEscrowLockFromNotes` (totalMsats from `parseNotes` — spendNotes' parsed
total can differ from requested) → mark `publish-attempted` → `publishLockBundle` → **positive-confirm
`state.lock.notesHash === expectedHash`** (closes the pre-existing false-"locked" hole where
`lockAndPublishAction` swallows "Cannot LOCK" post-spend and the modal reports success) → clear.
Because every native lock funnels through `bridge.lockAndPublish`, one implementation covers all three
entry points (BOLT11/NWC, onchain, AtomicFundingModal "Try LOCK now"). Guards: sim/testnet-gated (sim
funding DOES flow through lockAndPublish and would stash fake SBX notes); **refuse Fund while an entry
exists for that escrowId** (the Fedi store's overwrite-on-restash would clobber live bearer notes);
stash mutations + drain under a Web Lock (whole-map read-modify-write is racy across windows).

**Part A2 — boot drain** `drainPendingNativeLocks(client, fedimint)` beside the existing two
(useEscrow.ts:2543 slot; bridge/signer/wallet all live there). Per entry: sim/testnet skip → fed check
(entry.federationId ≠ current fed ⇒ keep + surface, don't burn attempts — drain re-fires on every fed
switch, so it heals when the user returns) → `loadEscrow` → decision table above → re-absorb via
`redeemWithRetry` (its already-spent classification must be judged by TRADE STATE, not balance-delta —
`confirmAlreadySpentCredit` can't confirm a days-old auto-refund credit) → bounded
MAX attempts → stuck entries get a CALM surface (mirroring pending-redemptions' unresolved-credit list),
never indefinite banner-suppression silence. Single-flight (initFedimint re-runs on every community
switch). Fix the false "native is immune/atomic" comments (pending-fundings.ts:16-17,
useEscrow.ts:2992-2993, tests.ts:7888-7889).

**Part B — banner honesty.** The drain is currently the ONLY affordance on FOUR surfaces, all of which
mis-fire in W1/W2 — the suppressor must hit all four or the fix is partial:
1. `shouldShowRecoveryBanner` — new optional `hasPendingNativeLock` (extends block 31e untouched);
2. `decideChamaBarLabel` stranded pill (one tap into the drain modal, no identity card);
3. MeScreen SATS RECOVERY card;
4. fed-switch destroy-confirm ("Recover & switch" offers the drain).
Plus: gate `hasTraceableIdleBalance` (App.tsx:1021-1064) — it durably PERSISTS the wrong
`inferred-from-claim-history` sats-trace at >0 sats, independent of the banner, even when suppressed.
Attribution comes from the stash/intent (`identifyStrandedEcashSource` is structurally incapable — it
only ever names a CLAIM-bearing trade). New surface: honest "Finish locking your trade" card + CTA →
`openEscrow(escrowId)` → normal foreground lock. Suppression is BOUNDED: stage=intent entries expire;
attempt-exhausted entries flip to the calm card.

**Tests:** extend block 29f (native lane: stash-before-publish, confirm-clear, drain decision table,
sim/testnet gates, fed-mismatch keep, re-stash preserves fields), 31e (suppressor), 42 (ChamaBar), 31a
(per-npub scoping). **Device verify (Jetty, 3-instance/APK):** kill between spend and publish → relaunch
→ drain re-absorbs → "finish locking" CTA → trade completes; kill after publish before clear → drain
detects committed LOCK, clears, NO re-absorb; W1 reload → honest resume card, no drain banner, no wrong
sats-trace.

## Decisions for Jetty (recommendations first)

- **[D1] Boot recovery = re-absorb-only + foreground re-lock** (REC: yes — the resume-publish
  alternative needs a Rust bridge endpoint + capability bump to even be checkable, and still carries the
  chain-poison races).
- **[D2] Lock-spend cancel horizon** (REC: 90 days both platforms — long past any trade+dispute life;
  the stash replaces auto-cancel as crash recovery. Alternative: size to max trade timeout + margin).
- **[D3] `publish-attempted` ambiguity** (REC: re-absorb only when a healthy quorum fetch positively
  shows no LOCK-with-our-hash; else keep + calm surface. Zero-risk alternative: never auto-re-absorb
  these, always surface — costs UX for a rare window).
- **[D4] Scope** (REC: Part 0 + A + A2 + B as ONE unit — shipping A without B leaves four live drain
  surfaces pointing at a suppressed-banner balance; B without A has no signal to key on).
