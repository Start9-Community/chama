# Commitment bond — independent on-chain verification + ceremony consolidation (CC findings)

**Date:** 2026-07-05 · **Network:** Mutinynet (signet, ~30 s blocks) · **Scope:** the sealed v1
single-key timelock commitment bond (`src/bond-multisig/commitment-bond.ts` + store + watcher +
hook actions + ceremony). Brief: *CC brief — commitment bond: on-chain verification + UI/UX
consolidation.* Constraints held: `BONDS_ENFORCED` false · `SHOW_BOND_CEREMONY` dev-only ·
signet test sats only · everything uncommitted.

The bond under test: `<T> OP_CHECKLOCKTIMEVERIFY OP_DROP <ownerXonly> OP_CHECKSIG`, one Taproot
leaf, BIP341 NUMS internal key (key-path dead). Verification bond: throwaway key (gitignored
`scripts/.mutinynet-verify-keys.json`), **T = 3236459**, address
`tb1p26v06h5hy2k7rfh7nsgxaywslm0l79uu5shn0a6dch8ad8np77esctp4u3`, funded with **three** UTXOs
(20 000 / 25 000 / 30 000 sats) in one tx
`0439299368ae640eb824ba1f0b2f38caa9a23e9aa9365dd314df3e65c0bf903d`.

## Part A — the three invariants, against real consensus

New repeatable adversarial harness: `scripts/mutinynet-commitment-verify.ts`
(init · status · early-cltv · early-nonfinal · wrong-key · sweep · confirm). It builds every
transaction through the SHIPPING module, so what the network judged is exactly what the app produces.

| # | Probe | Broadcast at | Node verdict | Result |
|---|-------|--------------|--------------|--------|
| 1a | Sweep with `nLockTime = tip` (FINAL, but < T) — the tx a colluding miner could otherwise mine | tip 3236447 < T | `-26 mempool-script-verify-flag-failed (Locktime requirement not satisfied)` | ✅ the **CLTV opcode itself** rejects |
| 1b | The VALID sweep (`nLockTime = T`) broadcast early | tip 3236447 < T | `-26 non-final` | ✅ tx-level nLockTime rejects |
| 3 | Identical sweep + witness shape, but the 64-byte schnorr sig is from a **non-owner key** | tip ≥ T (isolates the sig check) | `-26 mempool-script-verify-flag-failed (Invalid Schnorr signature)` | ✅ only the owner's key satisfies the leaf |
| 2 | The owner's **3-input sweep** of all 75 000 sats, `nLockTime = T`, size-based fee | tip 3236459 = T | **ACCEPTED** — txid `1dbdd00c0bf118ba61c66551695b5f968d7e5a33eb23523910bb92636bfeede0`, confirmed block 3236461 | ✅ owner reclaims alone, all UTXOs in one tx |

Probe-order note (1a): pre-T, a `nLockTime = T−1` tx dies on *finality* before script execution
ever runs, so the brief's "expect Locktime requirement not satisfied" needs `nLockTime = tip`
(final at the next block, still < T). The harness encodes this so the CLTV-opcode rejection is
isolated from the non-final rejection — both shapes proven above.

Invariant 3's static half is unit-pinned (5b-BONDCLTV): the control block is exactly 33 bytes
(one leaf, no merkle siblings — the executed leaf IS the whole tree) and its internal key equals
the BIP341 NUMS point (key-path unspendable); a wrong private key cannot even *build* a witness.

**Confirmed sweep anatomy** (from the explorer): 3 inputs → 1 output, `locktime 3236459`,
weight 1129 → **vsize 283 — byte-exact equal to `estimateReclaimVsize`'s prediction**, fee 566
sats = 2.0 sat/vB.

## Part A — reclaim checklist findings (fixes landed)

1. **F-1 · Flat `300n` fee underpaid multi-input sweeps** (found; fixed). At 4+ inputs the old
   flat fee drops below 1 sat/vB (unrelayable → a bond that cannot be reclaimed until someone
   hand-crafts a tx). Fix: `estimateReclaimVsize` / `estimateReclaimFeeSats` in
   `commitment-bond.ts` — analytic, exact (BIP340 sigs are fixed 64 B under SIGHASH_DEFAULT),
   unit-asserted byte-exact vs real built txs for 1–4 inputs, live-confirmed at 283 vB / 3
   inputs. 2 sat/vB with a 300-sat floor (single-input reclaims pay what they always did).
2. **F-2 · Late deposits could be stranded** (found; fixed). `checkCommitmentFunding` early-returned
   once any UTXO was cached, so a deposit confirming *after* the first check was never recorded,
   and reclaim swept only the cache. Fix: re-scan on every check (union chain ∪ cache, amounts
   re-totaled), and **reclaim sweeps what the chain says** (fresh scan; cache is only the
   Esplora-down fallback).
3. **F-3 · Broadcast-then-lost-state hole** (found; closed). If the app died between broadcast
   and store write, the bond stayed "locked" forever with spent UTXOs. Fix: `esploraOutspend`
   (`/tx/…/outspend/…`) — the leaf is owner-key-only, so *any* spend of a bond UTXO can only BE
   the owner's reclaim; the hook adopts the on-chain spend as the reclaim (empty-address scan
   path + `missingorspent`/`already-known` broadcast-error path both recover the txid).
4. **F-4 · Dust guard** (added): a reclaim whose output would fall below the 330-sat P2TR dust
   floor now refuses to build with a clear error instead of failing at broadcast.
5. **Recompute-don't-trust holds.** Store tamper gate re-verified + extended: tampered address,
   mutated `lockUntil`, and swapped `ownerXonly` all fail to reproduce the address → record
   rejected on load. Phase-monotonic upsert proven (a stale LOCKED can't downgrade RECLAIMED;
   equal-rank re-saves carry UTXOs forward).
6. **Derivation pinned.** `deriveBondSigningKey` (BIP86 `m/86'/1'/0'/0/0`) now has a golden
   vector test — if the derivation ever drifts, funded bonds' sats become unreachable; the suite
   catches it.
7. **Broadcast path**: `esploraBroadcast` surfaces the node's reason verbatim; genuine
   too-early → the calm "Almost — the chain hasn't reached your unlock block" message (verified
   in the probes above); store flips to `reclaimed` only once a txid is in hand (broadcast return
   or outspend recovery).

## Part B — ceremony rebuilt + vestigial removal

**BondCeremonyModal** rewritten around a **"Your bonds" list** (post another · each shows
status/amount/term/countdown · open each): describe (min-term enforced) → funding
(**auto-polled every 10 s** — "Found N deposits totaling X sats", QR + CopyButton, term-expiry
warnings) → locked (deposits list · monotonic countdown · **Done primary, reclaim
secondary + "Yes, reclaim" confirm**) → reclaimed (txid + copy). Monotonic tip is polled ONCE
for the whole modal (15 s, max-of-readings — jittery load-balanced Esplora can never re-lock a
ready bond); consensus stays the reclaim authority.

**Minimum term**: `MIN_COMMITMENT_TERM_BLOCKS = 30` (~15 min signet, ~5 h mainnet) enforced in
`createCommitmentBond` + the shortest preset; the funding screen warns when < 10 blocks remain
and calls out an already-expired term.

**Live-verified in the browser preview (real chain, real test sats):** posted a bond via the UI
(address `tb1pd4lmkz…`, T = 3236514), sent 2 500 sats from the harness key
(`2a4e506d68b4b0a5244dd59a800cc04c1f418d1457c1fa9577a6e0dea2e68a86`) — the **auto-poll detected
the deposit hands-free** (~7 s after confirmation) and flipped to locked with the correct
amount/txid/countdown; reclaim showed the confirm step (cancelled — bond left locked); the list
shows the LOCKED chip + "Post a new bond". Zero console errors.

**CopyButton sweep** — every raw `navigator.clipboard.writeText` button in `src/ui` is now the
animated `CopyButton` (EcashExportModal, FundWalletModal ×3, NsecLogin, SettingsAdvanced ×4,
AtomicFundingModal ×4 — `onCopy` prop plumbing deleted, sub-panels own their buttons —
ConnectScreen, TradeDetail); `CopyButton` itself gained TradeDetail's robust
webview fallback (`copyTextRobust`, exported for the two non-button sites: App.tsx scan-toast,
TradeCard tap-to-copy ID line). `grep navigator.clipboard src/ui` → only CopyButton.tsx.

**Vestigial 2-of-3 removal** — deleted: test blocks `5b-2A-rig`/`5b-BONDATT`/`5b-BONDLC`/
`5b-BONDSTORE`/`5b-BONDTX` (~120 asserts of dead custody), the 6 dead hook actions
(`createBondCeremony`, `publishBondKeyAttestation`, `discoverCustodianBonds`, `checkBondFunding`,
`bondPegoutFees`, `fundBondViaPegout`), and the orphan files `attestation.ts`,
`bond-transport.ts`, `lifecycle.ts`, `custody-store.ts`, `BondCustodyInboxModal.tsx`,
`mutinynet-bond-harness.ts`, **plus `sim/bond-rig.ts`** (2-of-3-only, transitively dead — not in
the brief's list but unavoidable). `multisig.ts` kept (commitment bond imports
SIGNET/BtcNetwork/BondUtxo) with its 5b-BONDMS tests. Moved before deletion:
`deriveBondSigningKey`/`bip86BondPath` → `commitment-bond.ts`; `newBondId` →
`commitment-store.ts`. `findBondFundingUtxo` (exact-amount singular) removed with its only
consumer; `5b-BONDFUND` rewritten against the LIVE plural path (any-amount multi-UTXO, depth
gate never silently drops an unmeasurable deposit, outspend probe). 38132–38134 kind allocations
documented as RETIRED in `arbiters/bonds.ts` (do not reuse — stale events exist on relays).

## Acceptance state

- Invariants 1a/1b/2/3 consensus-proven on Mutinynet, incl. a real confirmed 3-input sweep. ✅
- Reclaim checklist: multi-UTXO ✓ · size-based fee (byte-exact) ✓ · recompute gate ✓ ·
  broadcast/lost-state recovery ✓. ✅
- Tests extended: fee estimator, NUMS/single-leaf pin, wrong-key, dust, derivation golden
  vector, store lifecycle, watcher depth-gate/outspend. ✅
- One clean ceremony, live-verified end-to-end in preview; copy sweep done; vestigial code gone. ✅
- `npm run predeploy` green (typecheck clean + full suite passing) at time of writing.
- Test-sat accounting: all flows on Mutinynet; the verification bond's 75 000 sats swept back to
  the throwaway key; 2 500 sats remain locked at the preview demo bond until block 3236514.
  No real sats anywhere. Nothing committed.
