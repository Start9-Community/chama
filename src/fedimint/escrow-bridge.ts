// ══════════════════════════════════════════════════════════════════════════
// Chama — Escrow ↔ Fedimint Bridge
// ══════════════════════════════════════════════════════════════════════════
//
// Glues the EscrowClient (trade protocol on Nostr) to the FedimintClient
// (ecash operations via WASM). Provides the full escrow flow in two
// high-level methods:
//
//   lockAndPublish()  — Spend ecash, SSS split, encrypt shares, publish LOCK
//   claimAndRedeem()  — Decrypt shares, SSS combine, verify, redeem, publish CLAIM
//
// This is the integration layer the UI calls for the money-critical steps.

import { type EscrowClient, type Signer } from "../escrow-engine/escrow-client.js";
import { type EscrowLockBundle, type FedimintClient, type SSSShare } from "./fedimint-client.js";
import { stashPendingRedemption, clearPendingRedemption } from "./pending-redemptions.js";
import {
  type EscrowState,
  type SelectedMenuItem,
  type LockShareEntry,
  type VotePayload,
  EscrowEventKind,
  Role,
  Outcome,
  getEffectiveParticipantAt,
  selectedMenuItemsTotalMsats,
} from "../escrow-engine/types.js";
import { getWinner, payoutRecipientFor } from "../escrow-engine/state-machine.js";
import {
  HOLDER_ONLY_SHARE_POLICY,
  holderRoleForShareIndex,
  shareIndexForRole,
} from "../escrow-engine/holder-shares.js";
import { arbiterPriorityOrderFor } from "../escrow-engine/arbiter-substitution.js";
import { getSavedHandle } from "../payments/saved-handles.js";
import { pickArbiterFromPool } from "../arbiters/pool.js";
import { buildChamaOperationMeta, type ChamaOperationMeta } from "../payments/sats-trace.js";
import { receiveFediEcash } from "./fedi-internal.js";

function claimTraceEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem("chama_debug_money") !== null;
  } catch {
    return false;
  }
}

function claimTrace(checkpoint: string, fields: Record<string, unknown>): void {
  if (!claimTraceEnabled()) return;
  const parts: string[] = [`[claim-trace] ${checkpoint}`];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) val = "undef";
    else if (v === null) val = "null";
    else if (typeof v === "string") val = v.length > 64 ? `${v.slice(0, 60)}...(${v.length})` : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = JSON.stringify(v).slice(0, 80);
    parts.push(`${k}=${val}`);
  }
  // eslint-disable-next-line no-console
  console.info(parts.join(" "));
}

interface LockOptions {
  /** PR 3: ID of a saved handle in the seller's localStorage. The
   *  bridge resolves it to cleartext at lock time and includes both
   *  the cleartext + audit ID in the (encrypted) LockPayload so the
   *  buyer and arbiter can read where to send fiat. Optional —
   *  marketplace digital trades and raw escrows don't need it. */
  savedHandleId?: string;
  /** Menu basket snapshot. Required when locking a menu listing. */
  selectedItems?: SelectedMenuItem[];
  /** v2.3: committed substitution grace ceiling (seconds). The hook resolves
   *  this from the consensus-safe power-user override; absent ⇒ the legacy 4h
   *  default. Rides into the signed LOCK so backup eligibility replays
   *  identically everywhere. */
  substitutionGraceSeconds?: number;
}

function amountMsatsForLock(state: EscrowState, selectedItems?: SelectedMenuItem[]): number {
  if (!state.items || state.items.length === 0) return state.amountMsats;
  const total = selectedMenuItemsTotalMsats(selectedItems);
  if (!selectedItems || selectedItems.length === 0 || total <= 0) {
    throw new Error("Select at least one menu item before locking this trade.");
  }
  return total;
}

// ══════════════════════════════════════════════════════════════════════════
// BRIDGE
// ══════════════════════════════════════════════════════════════════════════

export class EscrowFedimintBridge {
  private escrow: EscrowClient;
  private fedimint: FedimintClient;
  private signer: Signer;

  constructor(escrow: EscrowClient, fedimint: FedimintClient, signer: Signer) {
    this.escrow = escrow;
    this.fedimint = fedimint;
    this.signer = signer;
  }

  private async prepareLockContext(escrowId: string): Promise<{
    state: EscrowState;
    buyerPubkey: string;
    sellerPk: string;
    arbiterPubkey: string;
  }> {
    const state = this.escrow.getState(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const createEvent = state.eventChain.find(
      (e: any) => e.kind === 38100 || e.payload?.type === "escrow:create"
    );
    const expectedFed: string | undefined =
      (createEvent?.payload as any)?.fed;

    if (expectedFed) {
      let probe: { fed: string | null };
      try {
        probe = await this.fedimint.probeReachable();
      } catch (probeErr) {
        const err: any = new Error(
          "Couldn't verify your federation. Your wallet may be disconnected. " +
            "Try again in a moment. (No sats were spent.)"
        );
        err.code = "FED_PROBE_FAILED";
        err.cause = probeErr;
        throw err;
      }

      if (probe.fed !== expectedFed) {
        const err: any = new Error(
          `This trade requires federation ${expectedFed}. ` +
            `Your wallet is on ${probe.fed}. ` +
            `Sign out and rejoin with the correct federation invite. ` +
            `(No sats were spent.)`
        );
        err.code = "FED_MISMATCH";
        err.expected = expectedFed;
        err.got = probe.fed;
        throw err;
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const buyerPubkey = getEffectiveParticipantAt(state, Role.BUYER, nowSec, { includeLockGrace: true });
    if (!buyerPubkey) {
      throw new Error(
        "Cannot lock — no buyer pubkey known. The buyer must publish a JOIN " +
        "ACK (or the locker's payment-detection path must supply the buyer " +
        "pubkey) before LOCK can fire."
      );
    }
    const sellerPk = getEffectiveParticipantAt(state, Role.SELLER, nowSec, { includeLockGrace: true });
    if (!sellerPk) {
      throw new Error("Cannot lock — no seller pubkey known for this trade.");
    }
    const arbiterPubkey = getEffectiveParticipantAt(state, Role.ARBITER, nowSec, { includeLockGrace: true })
      ?? pickArbiterFromPool(state.communityArbiters, state.id, [buyerPubkey, sellerPk]);
    if (!arbiterPubkey) {
      throw new Error(
        "Cannot lock — no arbiter available. The trade has no JOINed arbiter " +
        "and the communityArbiters pool has no eligible backup after excluding " +
        "the buyer and seller."
      );
    }
    if (arbiterPubkey === buyerPubkey || arbiterPubkey === sellerPk) {
      throw new Error(
        "Cannot lock — buyer, seller, and arbiter must be three different keys. " +
        "(No sats were spent.)"
      );
    }

    return { state, buyerPubkey, sellerPk, arbiterPubkey };
  }

  private async publishLockBundle(
    escrowId: string,
    state: EscrowState,
    lockBundle: EscrowLockBundle,
    participants: {
      buyerPubkey: string;
      sellerPk: string;
      arbiterPubkey: string;
    },
    opts: LockOptions = {},
  ): Promise<EscrowState> {
    const { buyerPubkey, sellerPk, arbiterPubkey } = participants;
    const allPks = [buyerPubkey, sellerPk, arbiterPubkey];

    const shares: { shareIndex: number; encryptedFor: Record<string, string> }[] = [];

    // Holder-only-v1: encrypt each share to ONLY its assigned holder. allPks is
    // [buyer, seller, arbiter] — exactly the shareIndex→holder convention
    // (0=buyer, 1=seller, 2=arbiter) — so share i goes to holder i and no single
    // party holds two. Reconstruction needs the agreeing voter's VOTE-carried
    // share (see appendVoteShareEnvelope / claimAndRedeem). We stop emitting
    // dual-encrypted shares entirely; old locks still claim via the legacy path
    // (keyed on the absent sharePolicy). See docs/DESIGN-holder-only-shares.md.
    //
    // Arbiter substitution (DESIGN-arbiter-substitution.md): the ARBITER share
    // (index 2) alone is encrypted to the escrow's deterministic priority
    // order — the assigned arbiter + up to 2 backups — so a pool backup can
    // carry the deciding share if the assigned arbiter goes absent. Each pool
    // member still holds only this ONE slot, so nobody can reconstruct alone;
    // buyer/seller shares remain strictly single-holder.
    const arbiterRecipients = arbiterPriorityOrderFor({
      escrowId,
      pool: state.communityArbiters ?? [],
      buyerPubkey,
      sellerPubkey: sellerPk,
      assignedArbiter: arbiterPubkey,
    });
    for (let i = 0; i < lockBundle.shares.length; i++) {
      const share = lockBundle.shares[i];
      const recipients = i === 2 && arbiterRecipients.length > 0
        ? arbiterRecipients
        : allPks[i] ? [allPks[i]] : [];
      if (recipients.length === 0) continue;
      const encryptedFor: Record<string, string> = {};
      for (const pk of recipients) {
        encryptedFor[pk] = await this.encryptShare(share, pk);
      }
      shares.push({ shareIndex: i, encryptedFor });
    }

    let handleId: string | undefined;
    let handle: string | undefined;
    let rail: string | undefined;
    let handleNetworks: string[] | undefined;
    if (opts.savedHandleId) {
      const saved = getSavedHandle(opts.savedHandleId);
      if (saved) {
        handleId = saved.id;
        handle = saved.handle;
        rail = saved.rail;
        if (saved.networks && saved.networks.length > 0) {
          handleNetworks = saved.networks;
        }
      } else {
        console.warn(
          `[chama] lockAndPublish: savedHandleId ${opts.savedHandleId} ` +
          `not found in local storage — proceeding without handle reveal`
        );
      }
    }

    return this.escrow.lockEscrow(escrowId, {
      notesHash: lockBundle.notesHash,
      shares,
      sharePolicy: HOLDER_ONLY_SHARE_POLICY,
      arbiterPoolShare: arbiterRecipients.length > 0,
      ...(typeof opts.substitutionGraceSeconds === "number"
        ? { substitutionGraceSeconds: opts.substitutionGraceSeconds }
        : {}),
      sellerReceivesMsats: lockBundle.sellerReceivesMsats,
      arbiterFeeMsats: lockBundle.arbiterFeeMsats,
      buyerPubkey,
      arbiterPubkey,
      selectedItems: opts.selectedItems,
      handleId,
      handle,
      rail,
      handleNetworks,
    });
  }

  // ── Lock: Spend ecash → SSS split → encrypt shares → publish LOCK ──────

  /**
   * Full lock flow:
   *   0. v0.1.72: Probe-and-verify locker's federation matches CREATE's.
   *   1. Spend ecash from Fedimint wallet (total trade amount)
   *   2. Split into 2-of-3 SSS shares
   *   3. NIP-44 encrypt each share to its recipient
   *   4. Publish the LOCK event to Nostr relays
   *
   * After this, the money is in escrow — no one can move it alone.
   */
  async lockAndPublish(escrowId: string, opts: LockOptions = {}): Promise<EscrowState> {
    const context = await this.prepareLockContext(escrowId);
    const amountMsats = amountMsatsForLock(context.state, opts.selectedItems);
    const lockBundle = await this.fedimint.createEscrowLock(
      amountMsats,
      {
        arbiterFeeMsats: context.state.fees.arbiterMsats,
      },
      buildChamaOperationMeta({
        flow: "lock_spend",
        escrowId,
        amountMsats,
      }),
    );
    return this.publishLockBundle(escrowId, context.state, lockBundle, context, opts);
  }

  async preflightLock(escrowId: string): Promise<void> {
    await this.prepareLockContext(escrowId);
  }

  async lockAndPublishWithEcash(escrowId: string, oobNotes: string, opts: LockOptions = {}): Promise<EscrowState> {
    const context = await this.prepareLockContext(escrowId);
    const amountMsats = amountMsatsForLock(context.state, opts.selectedItems);
    const lockBundle = await this.fedimint.createEscrowLockFromNotes(
      oobNotes,
      amountMsats,
      {
        arbiterFeeMsats: context.state.fees.arbiterMsats,
      },
      buildChamaOperationMeta({
        flow: "lock_external_ecash",
        escrowId,
        amountMsats,
      }),
    );
    return this.publishLockBundle(escrowId, context.state, lockBundle, context, opts);
  }

  // ── Claim: Decrypt shares → SSS combine → verify → redeem → publish CLAIM

  /**
   * Full claim flow (winner only):
   *   1. Identify which 2 shares the winner can access
   *      (their own share + the share of a voter who agreed with them)
   *   2. Decrypt both shares
   *   3. Reconstruct the original ecash via SSS combine
   *   4. Verify the hash matches the LOCK event
   *   5. Redeem the ecash into their Fedimint wallet
   *   6. Publish the CLAIM event to Nostr relays
   *
   * After this, the money is in the winner's wallet.
   */
  async claimAndRedeem(
    escrowId: string,
    opts: {
      clearPendingOnRedeem?: boolean;
      redeemWith?: "browser-sdk" | "fedi-internal";
    } = {},
  ): Promise<EscrowState> {
    const state = this.escrow.getState(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const myPubkey = await this.signer.getPublicKey();
    const winner = getWinner(state);
    claimTrace("bridge-in", {
      escrowId,
      status: state.status,
      outcome: state.resolvedOutcome,
      myPubkey: myPubkey.slice(0, 8),
      winnerRole: winner?.role,
      winnerPubkey: winner?.pubkey?.slice(0, 8),
    });
    if (!winner || winner.pubkey !== myPubkey) {
      throw new Error("You are not the winner of this escrow");
    }

    if (!state.lock.notesHash) {
      throw new Error("No lock data available — escrow may not be fully loaded");
    }

    if (!state.lock.shares || state.lock.shares.size < 1) {
      throw new Error("No shares available — state may be incomplete");
    }

    // NIP-44 decrypt needs the sender's pubkey. LOCK shares were encrypted by
    // the locker (the LOCK event signer).
    const lockEvent = state.eventChain.find((e: any) => e.kind === 38102 || e.payload?.type === "escrow:lock");
    const lockerPubkey = lockEvent?.raw?.pubkey || lockEvent?.pubkey || myPubkey;

    let decryptedMyShare: SSSShare;
    let decryptedPartnerShare: SSSShare;

    if (state.lock.sharePolicy === HOLDER_ONLY_SHARE_POLICY) {
      // Holder-only: the winner reconstructs from their OWN LOCK share (the
      // locker encrypted it to them at their holder index) PLUS one agreeing
      // voter's VOTE-carried share (a voter re-encrypted their own share to the
      // winner when voting this outcome). Two distinct shares, mixed senders —
      // the cryptographic 2-of-3. See docs/DESIGN-holder-only-shares.md.
      const ownShareIndex = shareIndexForRole(winner.role);
      const ownEntry = state.lock.shares.get(String(ownShareIndex));
      if (!ownEntry?.encryptedFor?.[myPubkey]) {
        throw new Error("Can't find your share of this trade. Make sure you're on Chama v2.x.x or higher and let it finish syncing — if the other side is on an older version, everyone needs to update for the trade to complete.");
      }
      // LOCK share: locker is the sender.
      decryptedMyShare = await this.decryptShareDual(ownEntry, myPubkey, lockerPubkey);

      // VOTE share: scan for an agreeing voter's share routed to me — but it
      // must be a DISTINCT share from my own. The winner usually also voted, and
      // their own vote re-encrypts their own share (same index) back to
      // themselves; using it would feed SSS two copies of one share ("shares
      // must contain unique values"). Skip any envelope at my own shareIndex so
      // we take a different holder's agreeing share.
      let partner: SSSShare | null = null;
      for (const ve of state.eventChain) {
        if (ve.kind !== EscrowEventKind.VOTE) continue;
        const env = (ve.payload as VotePayload | undefined)?.shareEnvelope;
        if (!env || env.outcome !== state.resolvedOutcome || env.recipientPubkey !== myPubkey) continue;
        if (env.shareIndex === ownShareIndex) continue; // my own share — not a 2nd
        const ct = env.encryptedFor?.[myPubkey];
        if (!ct) continue;
        // VOTE share: the VOTER is the sender (not the locker).
        partner = await this.decryptShare(ct, ve.raw.pubkey);
        break;
      }
      if (!partner) {
        // Tell apart "no one has agreed yet" from a VERSION MISMATCH: a voter on
        // a pre-2.0 build votes WITHOUT a holder-only shareEnvelope, so their
        // agreement carries no release key and the winner can never assemble the
        // second share. The fix is an upgrade — say so plainly instead of leaving
        // a cryptic share error (the original field-test confusion).
        const agreedButNoKey = state.eventChain.some((ve: any) =>
          ve.kind === EscrowEventKind.VOTE &&
          (ve.payload as VotePayload | undefined)?.outcome === state.resolvedOutcome &&
          ((ve.raw?.pubkey || ve.pubkey) !== myPubkey) &&
          !(ve.payload as VotePayload | undefined)?.shareEnvelope
        );
        if (agreedButNoKey) {
          throw new Error("Can't release yet — someone who agreed is on an older Chama that can't carry the release key. Ask them to update to Chama v2.x.x or higher and vote again, then you can claim.");
        }
        throw new Error("Waiting on a second agreeing vote — someone other than you must vote your way before you can claim.");
      }
      decryptedPartnerShare = partner;
    } else {
      // Legacy dual-encryption: every share is locker-encrypted to all three,
      // so any two reconstruct.
      const shareEntries = [...state.lock.shares.values()];
      if (shareEntries.length < 2) {
        throw new Error("Not enough shares: got " + shareEntries.length + ", need 2");
      }
      decryptedMyShare = await this.decryptShareDual(shareEntries[0], myPubkey, lockerPubkey);
      decryptedPartnerShare = await this.decryptShareDual(shareEntries[1], myPubkey, lockerPubkey);
    }

    // v0.1.63: Publish CLAIM before redeem
    // ──────────────────────────────────────
    // The chain-correctness move. Reconstructing the notes + matching the
    // hash is already cryptographic proof that the winner has the ecash.
    // Publish CLAIM on the strength of that proof so the Nostr event chain
    // reflects reality *now*, even if the federation redeem is slow.
    //
    // Order is:
    //   1. reconstruct + verify (deterministic, local, fast)
    //   2. publish CLAIM       (chain is now correct)
    //   3. redeemWithRetry     (settle the wallet)
    //
    // If step 3 hard-fails, we throw a marked error so the hook can
    // route to the "watching" UI state instead of red-toasting.

    const { notesHash, oobNotes } = await this.fedimint.reconstructAndVerify(
      decryptedMyShare,
      decryptedPartnerShare,
      state.lock.notesHash
    );
    claimTrace("bridge-reconstructed", {
      escrowId,
      notesHashPrefix: notesHash.slice(0, 16),
      oobNotesLen: oobNotes.length,
    });

    // v0.4.4 federation gates (fed-ID equality) ──────────────────────────
    // Probe reachability of the redeemer's wallet, and verify it sits on
    // the same federation the trade was created on. If not, the redeem
    // would either silently partial-credit (the v0.1.71 incident root
    // cause) or hard-fail with a confusing error from the SDK. Catch it
    // here with a clear actionable error instead.
    //
    // The CREATE event's `fed` tag is the source of truth for which
    // federation the lock lives on. We compare it to the wallet's own
    // fed ID. Legacy trades without payload.fed fall through to the
    // redeem itself, whose native federation rejection still surfaces
    // a (less-clear) error.
    const claimCreateEvent = state.eventChain.find(
      (e: any) => e.kind === 38100 || e.payload?.type === "escrow:create"
    );
    const expectedFed: string | undefined =
      (claimCreateEvent?.payload as any)?.fed;

    let redeemProbe: { fed: string | null };
    try {
      redeemProbe = await this.fedimint.probeReachable();
      claimTrace("bridge-probe", {
        escrowId,
        expectedFed: expectedFed ?? "none",
        actualFed: redeemProbe.fed,
      });
    } catch (probeErr) {
      // v0.3.1 Phase 1: honest copy. This throw fires BEFORE
      // stashPendingRedemption (below, ~line 341) AND before the CLAIM
      // publish at this.escrow.claim() — nothing has been stashed,
      // nothing has been published, no chain advance. The previous
      // "Notes stashed for retry" copy was technically false at this
      // point in the flow (Pillar 2.7 violation surfaced in v0.3.0
      // production smoke). The other claim-side throw at the
      // post-redeem catch (below, claimPublished:true) keeps its
      // existing copy because notes ARE stashed by that point.
      const err: any = new Error(
        "Couldn't verify your federation before claiming. " +
          "(No sats were spent — retry when your Chama is reachable.)"
      );
      err.code = "FED_PROBE_FAILED";
      err.cause = probeErr;
      throw err;
    }

    if (expectedFed && redeemProbe.fed !== expectedFed) {
      const err: any = new Error(
        `This trade's sats were minted on federation ${expectedFed}. ` +
          `Your wallet is on ${redeemProbe.fed}. ` +
          `Sign out and rejoin with the correct federation, then retry. ` +
          `Your claim has been published — your sats are safe and waiting.`
      );
      err.code = "FED_MISMATCH";
      err.expected = expectedFed;
      err.got = redeemProbe.fed;
      // Don't publish CLAIM yet — refusing redeem before claim publish
      // means the trade chain doesn't advance prematurely. The user
      // switches feds and retries; CLAIM will publish on the next try.
      throw err;
    }

    const existingClaim = state.eventChain.find((e: any) => {
      const payload = e.payload;
      return (e.kind === EscrowEventKind.CLAIM || payload?.type === "escrow:claim") &&
        payload?.claimerRole === winner.role &&
        payload?.notesHashVerification === notesHash;
    });
    claimTrace("bridge-claim-event", {
      escrowId,
      existingClaim: Boolean(existingClaim),
      notesHashPrefix: notesHash.slice(0, 16),
    });
    const stateAfterClaim = existingClaim
      ? state
      : await this.escrow.claim(escrowId, notesHash);

    // v0.1.68: Stash oobNotes to localStorage BEFORE attempting redeem.
    // ───────────────────────────────────────────────────────────────────
    // At this point:
    //   - The chain has advanced: CLAIM is published, trade is settling.
    //   - The reconstructed oobNotes bearer token exists only on this
    //     JS stack frame.
    //   - If the app closes before redeemWithRetry resolves, the token
    //     is lost and the sats are orphaned (see sm_moadjfkb_9ue9pd5p
    //     incident, v0.1.67 and earlier).
    //
    // Persisting here, then clearing after a successful redeem, makes
    // the claim path crash-safe. A boot-time drainPendingRedemptions()
    // call in useEscrow.initFedimint retries any entries that survive
    // the browser/app dying mid-redeem.
    //
    // Note: stashPendingRedemption is synchronous (localStorage), so
    // there's no new await that could itself be interrupted.
    stashPendingRedemption({
      escrowId,
      oobNotes,
      notesHash,
      amountMsats: state.amountMsats,
    });
    claimTrace("bridge-stashed", {
      escrowId,
      amountMsats: state.amountMsats,
      notesHashPrefix: notesHash.slice(0, 16),
    });

    try {
      if (opts.redeemWith === "fedi-internal") {
        const receivedMsats = await receiveFediEcash(oobNotes, state.amountMsats);
        claimTrace("bridge-fedi-receive-ok", {
          escrowId,
          expectedMsats: state.amountMsats,
          receivedMsats: receivedMsats ?? "unknown",
        });
      } else {
        await this.fedimint.redeemWithRetry(
          oobNotes,
          3,
          buildChamaOperationMeta({
            flow: "claim_reissue",
            escrowId,
            amountMsats: state.amountMsats,
            notesHashPrefix: notesHash.slice(0, 16),
          }),
        );
      }
      claimTrace("bridge-redeem-ok", {
        escrowId,
        redeemWith: opts.redeemWith ?? "browser-sdk",
        clearPendingOnRedeem: opts.clearPendingOnRedeem !== false,
      });
      // Redeem confirmed (or already-spent, which redeemWithRetry treats
      // as success). Federation has the notes, stash is no longer needed.
      if (opts.clearPendingOnRedeem !== false) {
        clearPendingRedemption(escrowId);
      }
    } catch (redeemErr) {
      const redeemCode = (redeemErr as any)?.code;
      claimTrace("bridge-redeem-error", {
        escrowId,
        code: redeemCode,
        errMsg: (redeemErr instanceof Error ? redeemErr.message : String(redeemErr)).slice(0, 120),
      });
      // Stash stays. The boot-drain on next initFedimint() will retry.
      // UI error surface is unchanged from v0.1.67.
      const wrapped = new Error(
        "Claim published to relays, but ecash redeem failed: " +
          (redeemErr instanceof Error ? redeemErr.message : String(redeemErr))
      );
      (wrapped as any).claimPublished = true;
      if (
        opts.redeemWith === "fedi-internal" ||
        redeemCode === "MINT_REISSUE_FAILED" ||
        redeemCode === "MINT_REISSUE_UNKNOWN"
      ) {
        (wrapped as any).settlementFailed = true;
        (wrapped as any).code = opts.redeemWith === "fedi-internal"
          ? "FEDI_RECEIVE_FAILED"
          : redeemCode;
      }
      (wrapped as any).cause = redeemErr;
      throw wrapped;
    }

    return stateAfterClaim;
  }

  async claimAndReceiveFedi(
    escrowId: string,
    opts: { clearPendingOnRedeem?: boolean } = {},
  ): Promise<EscrowState> {
    return this.claimAndRedeem(escrowId, {
      ...opts,
      redeemWith: "fedi-internal",
    });
  }

  // ── Pre-claim verification (optional but recommended) ───────────────────

  /**
   * Verify that the shares can reconstruct valid ecash
   * BEFORE actually redeeming. Non-destructive check.
   */
  async verifyClaim(escrowId: string): Promise<{
    valid: boolean;
    amountMsats?: number;
    error?: string;
  }> {
    const state = this.escrow.getState(escrowId);
    if (!state) return { valid: false, error: "Escrow not loaded" };

    const myPubkey = await this.signer.getPublicKey();
    const myShare = this.getMyEncryptedShare(state, myPubkey);
    const partnerShare = this.getPartnerEncryptedShare(state, myPubkey);

    if (!myShare || !partnerShare) {
      return { valid: false, error: "Cannot find 2 accessible shares" };
    }

    try {
      const decMyShare = await this.decryptShare(myShare.encryptedShare, myShare.senderPubkey);
      const decPartnerShare = await this.decryptShare(partnerShare.encryptedShare, partnerShare.senderPubkey);

      return this.fedimint.verifyShares(
        decMyShare,
        decPartnerShare,
        state.lock.notesHash!
      );
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Decrypt a share using the dual-encryption format.
   * Looks up own pubkey in encryptedFor map and NIP-44-decrypts with
   * the locker's pubkey as the sender.
   */
  private async decryptShareDual(
    share: LockShareEntry,
    myPubkey: string,
    lockerPubkey: string,
  ): Promise<SSSShare> {
    const ciphertext = share.encryptedFor[myPubkey];
    if (!ciphertext) {
      throw new Error(
        `No encrypted share found for pubkey ${myPubkey.slice(0, 8)}...`
      );
    }
    return this.decryptShare(ciphertext, lockerPubkey);
  }

  /** Encrypt an SSS share to a recipient pubkey */
  private async encryptShare(share: SSSShare, recipientPubkey: string): Promise<string> {
    // SSS shares MUST be NIP-44 encrypted to each recipient.
    // This is the real security boundary — unencrypted shares on relays
    // would let anyone reconstruct the ecash.
    const json = JSON.stringify(share);
    return await this.signer.nip44Encrypt(json, recipientPubkey);
  }

  /** Decrypt an SSS share from a sender */
  private async decryptShare(encryptedShare: string, senderPubkey: string): Promise<SSSShare> {
    // In dev/plaintext mode, shares are not encrypted — try parsing directly first
    let decrypted: string;
    try {
      const parsed = JSON.parse(encryptedShare);
      if (parsed && (parsed.index !== undefined || parsed.data !== undefined)) {
        // Already plaintext JSON — no decryption needed
        decrypted = encryptedShare;
      } else {
        decrypted = await this.signer.nip44Decrypt(encryptedShare, senderPubkey);
      }
    } catch {
      // Not valid JSON — must be encrypted, decrypt it
      try {
        decrypted = await this.signer.nip44Decrypt(encryptedShare, senderPubkey);
      } catch (decryptErr) {
        // If decrypt also fails, the share might be a simulated plaintext string
        // (from simulatedLock which uses "sim_share_0_..." format)
        console.warn("[chama] Share decrypt failed, using as-is:", encryptedShare.slice(0, 30));
        decrypted = encryptedShare;
      }
    }
    // Try parsing as JSON (real SSS shares are JSON objects)
    try {
      return JSON.parse(decrypted) as SSSShare;
    } catch {
      // Not JSON — simulated or raw share string
      // Wrap it as a minimal SSSShare-like object so downstream code can handle it
      console.warn("[chama] Share is not JSON, wrapping as raw:", decrypted.slice(0, 30));
      return { index: 0, data: decrypted } as unknown as SSSShare;
    }
  }

  /**
   * Get our own encrypted share from the escrow state.
   * The locker encrypted it to our pubkey as part of the dual-encryption map.
   * Returns the ciphertext and the locker's pubkey (needed for NIP-44 decrypt).
   */
  private getMyEncryptedShare(
    state: EscrowState,
    myPubkey: string
  ): { encryptedShare: string; senderPubkey: string } | null {
    // Any share will do — they're all encrypted to every participant.
    // Pick the first one that has a ciphertext for us.
    for (const share of state.lock.shares.values()) {
      const ciphertext = share.encryptedFor[myPubkey];
      if (ciphertext) {
        const lockEvent = state.eventChain.find(e => e.kind === 38102);
        const senderPubkey = lockEvent?.pubkey || state.initiator.pubkey;
        return { encryptedShare: ciphertext, senderPubkey };
      }
    }
    return null;
  }

  /**
   * Get a partner's encrypted share — someone who voted the same as the majority.
   *
   * In the happy path (buyer + seller agree): the winner gets both their
   * own share plus the other agreeing voter's share.
   *
   * In a dispute: the winner gets their share + the arbiter's share
   * (since the arbiter sided with them).
   *
   * The trick: the shares were encrypted to EACH recipient by the locker.
   * So the winner can't directly decrypt another participant's share.
   * Instead, the majority voters need to RE-ENCRYPT their shares to the
   * winner after the vote resolves. This is handled by a share-exchange
   * step that happens after RESOLVE and before CLAIM.
   *
   * For the MVP: we assume the escrow client handles share exchange
   * via NIP-44 DMs between majority voters. The bridge just reads
   * whatever shares are available in state.lock.shares.
   */
  private getPartnerEncryptedShare(
    state: EscrowState,
    myPubkey: string
  ): { encryptedShare: string; senderPubkey: string } | null {
    if (!state.resolvedOutcome || !state.resolvedMajority) return null;

    // Find the other voter in the majority who isn't me
    const myRole = this.getRoleForPubkey(state, myPubkey);
    if (!myRole) return null;

    const partnerRole = state.resolvedMajority.find(r => r !== myRole);
    if (!partnerRole) return null;

    const partnerPubkey = state.participants[partnerRole];
    if (!partnerPubkey) return null;

    // Look for any share where the partner has an entry in encryptedFor.
    // Under dual-encryption any share object contains a ciphertext for
    // every participant (including partner), so we iterate until we find
    // the partner's ciphertext.
    for (const share of state.lock.shares.values()) {
      const ciphertext = share.encryptedFor[partnerPubkey];
      if (ciphertext) {
        return { encryptedShare: ciphertext, senderPubkey: partnerPubkey };
      }
    }
    return null;
  }

  private getRoleForPubkey(state: EscrowState, pubkey: string): Role | null {
    if (state.participants[Role.BUYER] === pubkey) return Role.BUYER;
    if (state.participants[Role.SELLER] === pubkey) return Role.SELLER;
    if (state.participants[Role.ARBITER] === pubkey) return Role.ARBITER;
    return null;
  }

  // ── Wallet passthrough: used by Fund Wallet modal ──────────────────────
  // These delegate to FedimintClient and are exposed on the bridge so the
  // UI can route ALL money operations through a single object. Keeps the
  // hook layer consistent (always calls bridge.*) and makes it easy to
  // add logging/metrics around wallet ops in one place.

  async payInvoice(bolt11: string, meta?: ChamaOperationMeta): Promise<void> {
    await this.fedimint.payInvoice(bolt11, meta);
  }

  async spendNotes(amountMsats: number, meta?: ChamaOperationMeta): Promise<string> {
    // FedimintClient exposes spendNotes via its wallet; route through there.
    return await this.fedimint.spendNotes(amountMsats, meta);
  }

  async redeemEcash(oobNotes: string, meta?: ChamaOperationMeta): Promise<void> {
    await this.fedimint.redeemEcash(oobNotes, meta);
  }

  async getOnchainWithdrawFees(address: string, amountSats: number) {
    return await this.fedimint.getOnchainWithdrawFees(address, amountSats);
  }

  async withdrawOnchain(address: string, amountSats: number, meta?: ChamaOperationMeta) {
    return await this.fedimint.withdrawOnchain(address, amountSats, {
      wait: true,
      meta,
    });
  }
}
