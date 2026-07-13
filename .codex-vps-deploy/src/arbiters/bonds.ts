// ══════════════════════════════════════════════════════════════════════════
// Arbiter bond declarations — kind:38130 (Bond Phase 1; the exposure ledger's
// data source — DESIGN-arbiter-economy §3/§8)
// ══════════════════════════════════════════════════════════════════════════
//
// A bond declaration is an arbiter's signed, replaceable statement: "for this
// term I stake B msats, which caps my exposure (§8)." The exposure ledger
// (exposure.ts) reads these to compute live capacity and gate assignment.
//
// ⚠️  PHASE 1 = DECLARATION ONLY, UNBACKED. A 38130 event is a *claim*, not
// custody. The ON-CHAIN backing is the single-key timelock COMMITMENT bond
// (bond-multisig/commitment-bond.ts — the sealed v1 model, DECISIONS 2026-07-03):
// the arbiter's own sats, CLTV-locked to their own key for the term. Phase 1
// trusts the declaration so the ledger + consent gate can be built and tested;
// NOTHING here moves or locks money. Never read a 38130 event as proof that
// capital is actually posted.
//
// KIND ALLOCATION — 38130 sits clear of the escrow wire (38100–38112), the
// roster (38120), the application (38121), the reserved admission-vote (38122),
// and ratings (38123). Governance / economy events live in the 38120+ band;
// trade parsers never see them. Also allocated in this band:
//   • 38131 — victim "made-whole" attestation (arbiters/victim-attestation.ts).
//   • 38132–38134 — RETIRED with the 2-of-3 cabinet-custody bond (key
//     attestation / descriptor / return-PSBT transport; deleted 2026-07-05 —
//     a skeptic's pass proved cabinet custody self-dealing). Do not reuse
//     these kinds for anything else: stale events may exist on relays.
//   • 38135 — commitment-bond ANNOUNCEMENT (bond-multisig/bond-announcement.ts):
//     the CHAIN-BACKED companion to 38130's unbacked claim. An arbiter advertises
//     their on-chain single-key timelock bond for a community; verification
//     recomputes the address + reads it on-chain. The live-chama liveness signal's
//     data source (chama-live-chama-signal-brief.md). d=community, signer-authoritative.
//
// Replaceable semantics mirror the roster: a bond is keyed per signing arbiter
// (one current bond each), newest created_at wins, ties break to the
// lexicographically smallest event id (NIP-01). A declaration is also
// TERM-GATED — only valid while termStart ≤ now < termEnd. The signer IS the
// bonding arbiter: you cannot declare a bond on someone else's behalf.

import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import type { NostrEvent } from "../escrow-engine/types.js";

export const ARBITER_BOND_KIND = 38130;
export const ARBITER_BOND_TYPE = "chama:arbiter-bond";

const HEX64 = /^[0-9a-f]{64}$/;

function normalizeBondPubkey(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  // Bond keys ride in as the event signer (always hex), so hex-only — kept
  // local to avoid a pool↔bonds import cycle (mirrors roster.ts).
  return HEX64.test(trimmed) ? trimmed : null;
}

export interface ArbiterBondPayload {
  type: typeof ARBITER_BOND_TYPE;
  /** Bonding arbiter pubkey (HEX, == the signing event's pubkey). The field is
   *  named `npub` per the bond brief; the value is the 64-char hex key. */
  npub: string;
  /** Self-selected bond size in msats — the exposure ceiling (§8). */
  bondMsats: number;
  /** Term window (unix seconds). The bond is valid only in [termStart, termEnd). */
  termStart: number;
  termEnd: number;
  note?: string;
}

/** A parsed, signature-verified bond declaration. ⚠️ UNBACKED in Phase 1 —
 *  a claim, not custody (see file header). */
export interface ArbiterBond {
  /** Hex pubkey of the bonding arbiter (== event signer). */
  npub: string;
  bondMsats: number;
  termStart: number;
  termEnd: number;
  createdAt: number;
  eventId: string;
}

/** Build the unsigned bond declaration (the arbiter's own client signs it).
 *  `pubkey` is the declaring arbiter's hex key — it must match the signer, so
 *  parse can refuse a bond spoofed for someone else. */
export function buildArbiterBondEvent(params: {
  pubkey: string;
  bondMsats: number;
  termStart: number;
  termEnd: number;
  createdAt?: number;
  note?: string;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const pubkey = normalizeBondPubkey(params.pubkey);
  if (!pubkey) throw new Error(`Bond pubkey is not a 64-char hex key: ${params.pubkey}`);
  const bondMsats = Math.floor(params.bondMsats);
  if (!Number.isFinite(bondMsats) || bondMsats <= 0) {
    throw new Error("Bond amount must be a positive integer of msats");
  }
  const termStart = Math.floor(params.termStart);
  const termEnd = Math.floor(params.termEnd);
  if (!Number.isFinite(termStart) || !Number.isFinite(termEnd) || termEnd <= termStart) {
    throw new Error("Bond term must be a non-empty [termStart, termEnd) window");
  }
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const payload: ArbiterBondPayload = {
    type: ARBITER_BOND_TYPE,
    npub: pubkey,
    bondMsats,
    termStart,
    termEnd,
    ...(params.note ? { note: params.note } : {}),
  };
  return {
    kind: ARBITER_BOND_KIND,
    created_at: createdAt,
    tags: [
      // Constant d-tag → one replaceable bond slot per signing arbiter
      // (parameterized-replaceable key is (kind, pubkey, d)).
      ["d", ARBITER_BOND_TYPE],
      ["t", ARBITER_BOND_TYPE],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + structurally validate + signature-verify one bond event. The signer
 *  is authoritative; a payload `npub` that disagrees with it is rejected. */
export function parseArbiterBondEvent(
  event: NostrEvent,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): ArbiterBond | null {
  if (event.kind !== ARBITER_BOND_KIND) return null;
  let payload: ArbiterBondPayload;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (payload?.type !== ARBITER_BOND_TYPE) return null;
  const bondMsats = typeof payload.bondMsats === "number" ? Math.floor(payload.bondMsats) : NaN;
  if (!Number.isFinite(bondMsats) || bondMsats <= 0) return null;
  const termStart = typeof payload.termStart === "number" ? Math.floor(payload.termStart) : NaN;
  const termEnd = typeof payload.termEnd === "number" ? Math.floor(payload.termEnd) : NaN;
  if (!Number.isFinite(termStart) || !Number.isFinite(termEnd) || termEnd <= termStart) return null;
  const signer = normalizeBondPubkey(event.pubkey);
  if (!signer) return null;
  // The signer IS the bonding arbiter — refuse a declaration spoofed for
  // another key (a present payload npub must match the signer).
  if (payload.npub) {
    const claimed = normalizeBondPubkey(payload.npub);
    if (!claimed || claimed !== signer) return null;
  }
  const verify =
    options?.verifyEvent ?? (verifyNostrEventSignature as unknown as (e: NostrEvent) => boolean);
  if (!verify(event)) return null;
  return {
    npub: signer,
    bondMsats,
    termStart,
    termEnd,
    createdAt: event.created_at,
    eventId: event.id,
  };
}

/** The arbiter's CURRENT valid bond: the newest in-term 38130 they signed, or
 *  null. `now` is unix seconds (pass a fixed clock in tests). Term-gated,
 *  newest-wins, ties → lexicographically smallest event id — mirrors the
 *  roster's replaceable selection. */
export function selectLatestBond(
  npub: string,
  events: readonly NostrEvent[],
  now: number,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): ArbiterBond | null {
  const want = normalizeBondPubkey(npub);
  if (!want) return null;
  let best: ArbiterBond | null = null;
  for (const event of events) {
    const bond = parseArbiterBondEvent(event, options);
    if (!bond || bond.npub !== want) continue;
    if (now < bond.termStart || now >= bond.termEnd) continue; // term-gated
    if (
      !best ||
      bond.createdAt > best.createdAt ||
      (bond.createdAt === best.createdAt && bond.eventId < best.eventId)
    ) {
      best = bond;
    }
  }
  return best;
}
