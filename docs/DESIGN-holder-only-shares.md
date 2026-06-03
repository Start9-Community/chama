# Design — Holder-Only Shares + Vote-Carried Release (app-layer escrow safety)

Status: design locked from maintainer plan. Security-critical, money-path. The
LOCK / VOTE / CLAIM changes are **atomic** — they must land together (a
holder-only lock is unclaimable under the old reconstruct path) and ship in one
release. Implement carefully, with the full test matrix green, before shipping.

## The problem (today)

At LOCK, the 2-of-3 Shamir shares are **dual-encrypted**: every share is
NIP-44-encrypted to *all three* participants.

- `escrow-bridge.ts → lockAndPublish` (~L180-193): `for (share) for (pk of
  [buyer, seller, arbiter]) encryptedFor[pk] = encryptShare(share, pk)`.
- `escrow-bridge.ts → claimAndRedeem` (~L324-350): "any participant can decrypt
  all shares — we just need any 2", picks `shareEntries[0]` + `[1]`, decrypts
  both with the **locker** as sender, `reconstructAndVerify`.

So any single participant holds enough to reconstruct the bearer ecash on their
own. The 2-of-3 is only **app-enforced** (you can't reach CLAIM until VOTE/
RESOLVE), not **cryptographically** enforced — a participant who reads the relay
data directly can reconstruct without anyone's agreement. The funder is the
sharpest case (they minted the token; clawback risk). RELEASE-to-non-funder is
the safety-critical path (the recipient never held the original token).

## The fix (app-layer, ships now)

### 1. Holder-only LOCK — `sharePolicy: "holder-only-v1"`
Encrypt each share to **only its assigned holder**:

- shareIndex 0 → buyer's pubkey only
- shareIndex 1 → seller's pubkey only
- shareIndex 2 → arbiter's pubkey only

So each participant holds exactly **one** share. No one can reconstruct alone.
Add `sharePolicy: "holder-only-v1"` to `LockPayload`; stop emitting dual-encrypted
LOCKs immediately. LOCK-carried shares decrypt with the **locker** as sender
(unchanged sender; changed recipient set).

### 2. Vote-carried share release — outcome-bound envelope on VOTE
Extend `VotePayload` with an optional `shareEnvelope`. When a participant votes:

1. Decrypt **their own** LOCK share (holder-only, locker = sender).
2. Re-encrypt it to the **engine-computed recipient** for that outcome
   (`getWinner(state, outcome)` per vertical — never a generic RELEASE/REFUND
   reinterpretation).
3. Attach as the vote's `shareEnvelope`, bound to: `escrowId`, `outcome`,
   `notesHash`, `shareIndex`, sender (voter) pubkey, recipient pubkey.

VOTE-carried shares decrypt with the **voter** as sender (not the locker).

### 3. Claim reconstruction — own LOCK share + one agreeing VOTE share
The recipient (winner per the resolved outcome, possibly an offline non-voter)
reconstructs from **two distinct shares**:

- their **own LOCK share** (they hold it; locker = sender), plus
- **one agreeing voter's VOTE-carried share** (voter = sender).

Two VOTE envelopes aren't required when the recipient already holds one LOCK
share. Disagreement → the arbiter's vote-carried share is the deciding second
share. `claimAndRedeem` branches on `sharePolicy`: `holder-only-v1` uses the
mixed-origin reconstruct (LOCK share sender = locker, VOTE share sender = voter);
absent/legacy uses today's dual-encrypted path.

### 4. Preserve trade semantics
- Recipient/payout mapping comes only from the existing engine, per vertical
  (`getWinner`), never reinterpreted.
- UI shows the real recipient before any money-authorizing action.
- Tests assert the **recipient per vertical**, not just that the flow completes.

### 5. Timeout semantics
Timeout opens a **permissionless refund path**; it does not auto-spend. Anyone
may submit the timeout refund, but it can only pay the pre-committed refund
recipient. A late valid 2-of-3 resolution stays valid until either refund or
resolution lands — first accepted wins. (Mostly relevant to the module below;
the app-layer keeps today's expiry-heal refund, now over holder-only shares.)

## Wire format

```
LockPayload.sharePolicy?: "holder-only-v1"   // absent ⇒ legacy dual-encrypted
LockPayload.shares[i].encryptedFor            // holder-only: exactly one key
VotePayload.shareEnvelope?: {
  shareIndex: number;
  outcome: Outcome;
  notesHash: string;
  recipientPubkey: string;
  encryptedFor: { [recipientPubkey]: ciphertext };   // voter = sender
}
```

## Implementation status (SHIPPED in v2.0.0 — on-device verified)

✅ On-device verified end-to-end (new→new): holder-only LOCK → two RELEASE votes
→ claim reconstructs from own LOCK share + the other voter's agreeing vote-share.
Cross-version loud-fail verified (old client claiming a new lock fails loudly, no
silent strand). Legacy dual-encrypted locks still claim on the new build. One
dedup bug found + fixed during verification: the winner's OWN vote re-encrypts
their own share back to themselves (same shareIndex), so the claim scan now skips
any vote-share at the winner's own index and requires a distinct second holder's
share. Cross-version claim failures now message "update + vote again" plainly.

DONE + unit/protocol-tested (2077 tests):
1. ✅ Types + parser: `LockPayload.sharePolicy`, `VotePayload.shareEnvelope`
   (`VoteShareEnvelope`); parser shape-validation; handleVote binding rejection.
2. ✅ Holder-only LOCK build (`escrow-bridge.lockAndPublish`): share i → holder i
   only, `sharePolicy: "holder-only-v1"`; threaded client → state → state.lock.
3. ✅ Vote-carried release (`escrow-client.vote → buildVoteShareEnvelope`):
   decrypt own share, re-encrypt to `payoutRecipientFor(state, votedOutcome)`,
   best-effort.
4. ✅ Claim reconstruct (`escrow-bridge.claimAndRedeem`): branch on sharePolicy
   — own LOCK share (locker sender) + agreeing VOTE share (voter sender); legacy
   unchanged.
5. ✅ Pure `payoutRecipientFor` extracted to `recipients.ts` (no cycle), pure
   over candidate outcome (#2); `holder-shares.ts` mapping + validation (#5).
6. ✅ Legacy dual-encrypted compat; e2e protocol matrix.

PENDING (cannot be unit-tested — needs the Fedimint client / on-device):
- The bridge SSS-combine of (own LOCK share + vote share) into real ecash.
- Cross-version stranding (#1): manually verify a new-client lock claimed by an
  OLD-client winner FAILS LOUDLY (not silent strand); confirm all active testers
  upgraded in lockstep before any holder-only lock goes live.
- Full device matrix (APK↔APK, APK↔Tauri, Fedi↔APK; same-/cross-fed).

## Staged (but atomically-shipped) implementation

1. **Types + parser.** `sharePolicy` on LockPayload; `shareEnvelope` on
   VotePayload; parser validation (shareEnvelope binds escrowId/outcome/
   notesHash/shareIndex/recipient; reject mismatches).
2. **Holder-only LOCK build.** `lockAndPublish`: encrypt share i to holder i
   only; set `sharePolicy: "holder-only-v1"`. Pure share-assignment helper, unit
   tested (exactly 3 shares, each decryptable only by its holder).
3. **Vote-carried release.** On VOTE for a holder-only escrow: decrypt own LOCK
   share, re-encrypt to `getWinner(state, outcome)`, attach `shareEnvelope`.
4. **Claim reconstruction.** `claimAndRedeem` branches on `sharePolicy`:
   holder-only gathers own LOCK share + an agreeing VOTE share (mixed senders),
   reconstructs; legacy path unchanged.
5. **Legacy compatibility.** Dual-encrypted trades (no `sharePolicy`) still
   claim via the old path until they drain. Mixed legacy/new replay must not
   strand active escrows.
6. **Recipient-per-vertical + UI recipient display + full test matrix.**

## Test matrix (must be green before shipping)

- Holder-only LOCK publishes exactly 3 shares, each decryptable only by its holder.
- Non-holder cannot decrypt another participant's LOCK share.
- Recipient reconstructs from own LOCK share + one agreeing VOTE share.
- Mixed origins: LOCK share sender = locker, VOTE share sender = voter.
- Two VOTE envelopes not required when recipient holds one LOCK share.
- Offline funder refunded via expiry-heal reconstructs on return.
- RELEASE-to-non-funder routes shares to the correct engine-computed recipient.
- Disagreement requires the arbiter's vote-carried share.
- Legacy dual-encrypted trades still claim; mixed legacy/new replay strands nothing.
- VOTE envelope rejects wrong outcome / recipient / notesHash / stale escrowId /
  wrong sender / duplicated shareIndex.
- Vertical matrix asserts recipient mapping for exchange (p2p-trade), market,
  bill-pay, lending.
- End-to-end: APK↔APK, APK↔Tauri, Fedi↔APK; same-fed and cross-fed.

## End-state — Fedimint escrow module (future RFC)

See `docs/RFC-fedimint-escrow-module.md`. The complete fix replaces bearer-ecash
reconstruction with **federation-enforced** 2-of-3: per-trade ephemeral keys,
VOTE events carry a Nostr signature (identity/threading) **and** an explicit
ephemeral-key signature over a canonical module message binding fed id, module
instance id, escrow id, amount, terms hash, outcome, release/refund recipients,
timeout, arbiter-fee policy. `terms_hash` commits to recipient keys + all
payout-critical terms. Timeout = permissionless refund to the pre-committed
recipient; late 2-of-3 valid until refund/resolution lands. BLF/Chama-controlled
federations get the module first; third-party feds stay on app-layer escrow
unless they install it. App-layer holder-only is the safety floor everywhere;
the module is the ceiling on BLF.
```
```

## Assumptions / scope

- App-layer change reduces pre-resolution share exposure; it does **not** remove
  funder clawback (the funder minted the bearer token). The module is the only
  complete fix.
- RELEASE-to-non-funder is the safety-critical path (recipient never held the token).
- Ephemeral per-trade keys are mandatory for the module.
- Browser transport hardening remains separate and still required.
