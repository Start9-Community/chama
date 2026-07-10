// ══════════════════════════════════════════════════════════════════════════
// Chama — victim "made-whole" attestation (DESIGN-arbiter-economy §11.8)
// ══════════════════════════════════════════════════════════════════════════
//
// The restorative-strand seam. When a slashed arbiter remediates the party they
// defrauded (repays the victim), the VICTIM can sign this attestation — "arbiter
// X made me whole for trade Y" — and the cabinet REFERENCES it when deciding to
// cast that arbiter's withheld bond return (a strand is reversible — §11.8). It
// is deliberately a SEAM, never an auto-trigger:
//
//   • The cabinet's return-heal stays DISCRETIONARY. A paid victim can refuse to
//     sign to extort ("pay me again or your bond stays dead"), so the cabinet's
//     judgment ACTS and the attestation only INFORMS — there is no engine path
//     that turns an attestation into a heal.
//   • It attests to CAPITAL remediation ONLY. Restoring the bond never restores
//     standing — the slash / delist / public record persist (separate ledgers).
//     This event carries no standing claim and clears nothing.
//   • The signer IS the victim (authoritative). The remediated arbiter cannot
//     forge it for themselves; the cabinet cannot fabricate it. Only the victim's
//     own key can produce the positive signal.
//
// Pure: build / parse / signature-verify only. No money, no state machine, no
// relays. Kind 38131 sits clear of the escrow wire (38100–38112), the roster
// (38120), the application (38121), and the bond declaration (38130).

import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import type { NostrEvent } from "../escrow-engine/types.js";

export const VICTIM_ATTESTATION_KIND = 38131;
export const VICTIM_ATTESTATION_TYPE = "chama:victim-made-whole";

const HEX64 = /^[0-9a-f]{64}$/;

function normHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  // local to avoid an import cycle (mirrors bonds.ts / roster.ts).
  return HEX64.test(trimmed) ? trimmed : null;
}

export interface VictimAttestationPayload {
  type: typeof VICTIM_ATTESTATION_TYPE;
  /** The remediated arbiter (HEX) — the bond owner the cabinet may now consider
   *  restoring. This is who the victim says made them whole. */
  arbiter: string;
  /** The trade/escrow id the victim was made whole for. */
  escrowId: string;
  /** Amount the victim was made whole for, in msats. Informational. */
  amountMsats: number;
  note?: string;
}

/** A parsed, signature-verified victim attestation. The signer (victim) is
 *  authoritative. CAPITAL-remediation signal only — carries no standing claim. */
export interface VictimAttestation {
  /** Hex pubkey of the victim (== event signer). */
  victim: string;
  arbiter: string;
  escrowId: string;
  amountMsats: number;
  createdAt: number;
  eventId: string;
}

/** Build the unsigned attestation (the victim's own client signs it). `victim`
 *  must match the signer, so parse can refuse one spoofed for someone else. The
 *  d-tag = escrowId → one replaceable attestation per (victim, escrow). */
export function buildVictimAttestationEvent(params: {
  victim: string;
  arbiter: string;
  escrowId: string;
  amountMsats: number;
  createdAt?: number;
  note?: string;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const victim = normHex(params.victim);
  if (!victim) throw new Error(`Victim pubkey is not a 64-char hex key: ${params.victim}`);
  const arbiter = normHex(params.arbiter);
  if (!arbiter) throw new Error(`Arbiter pubkey is not a 64-char hex key: ${params.arbiter}`);
  if (arbiter === victim) throw new Error("Victim and arbiter must be distinct keys");
  if (!params.escrowId || typeof params.escrowId !== "string") {
    throw new Error("Attestation must reference an escrow id");
  }
  const amountMsats = Math.floor(params.amountMsats);
  if (!Number.isFinite(amountMsats) || amountMsats <= 0) {
    throw new Error("Made-whole amount must be a positive integer of msats");
  }
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const payload: VictimAttestationPayload = {
    type: VICTIM_ATTESTATION_TYPE,
    arbiter,
    escrowId: params.escrowId,
    amountMsats,
    ...(params.note ? { note: params.note } : {}),
  };
  return {
    kind: VICTIM_ATTESTATION_KIND,
    created_at: createdAt,
    tags: [
      // (kind, victim, d=escrowId) — one replaceable slot per victim+escrow.
      ["d", params.escrowId],
      ["t", VICTIM_ATTESTATION_TYPE],
      // queryable back-reference to the arbiter the cabinet is weighing.
      ["p", arbiter],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + structurally validate + signature-verify one attestation. The signer
 *  IS the victim; an arbiter that equals the signer, or a payload that disagrees
 *  with the signer, is rejected. Returns null on any failure (never throws). */
export function parseVictimAttestationEvent(
  event: NostrEvent,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): VictimAttestation | null {
  if (event.kind !== VICTIM_ATTESTATION_KIND) return null;
  let payload: VictimAttestationPayload;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (payload?.type !== VICTIM_ATTESTATION_TYPE) return null;

  const victim = normHex(event.pubkey);
  if (!victim) return null;
  const arbiter = normHex(payload.arbiter);
  if (!arbiter) return null;
  // The remediated arbiter can never sign their own "made whole" — only the
  // victim can produce the positive signal.
  if (arbiter === victim) return null;
  if (!payload.escrowId || typeof payload.escrowId !== "string") return null;
  const amountMsats =
    typeof payload.amountMsats === "number" ? Math.floor(payload.amountMsats) : NaN;
  if (!Number.isFinite(amountMsats) || amountMsats <= 0) return null;

  const verify =
    options?.verifyEvent ?? (verifyNostrEventSignature as unknown as (e: NostrEvent) => boolean);
  if (!verify(event)) return null;

  return {
    victim,
    arbiter,
    escrowId: payload.escrowId,
    amountMsats,
    createdAt: event.created_at,
    eventId: event.id,
  };
}

/** The newest valid victim attestation for a (victim, arbiter, escrow), or null.
 *  Newest-wins, ties → lexicographically smallest event id (mirrors the bond /
 *  roster replaceable selection). Informational: the cabinet reads this as ONE
 *  input to its discretionary restore decision — it never compels a heal. */
export function selectLatestAttestation(
  arbiter: string,
  escrowId: string,
  events: readonly NostrEvent[],
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): VictimAttestation | null {
  const wantArb = normHex(arbiter);
  if (!wantArb || !escrowId) return null;
  let best: VictimAttestation | null = null;
  for (const event of events) {
    const att = parseVictimAttestationEvent(event, options);
    if (!att || att.arbiter !== wantArb || att.escrowId !== escrowId) continue;
    if (
      !best ||
      att.createdAt > best.createdAt ||
      (att.createdAt === best.createdAt && att.eventId < best.eventId)
    ) {
      best = att;
    }
  }
  return best;
}
