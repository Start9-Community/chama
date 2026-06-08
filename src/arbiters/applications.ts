// ══════════════════════════════════════════════════════════════════════════
// Arbiter applications — kind:38121 (V3 #74, the consensus-admission on-ramp)
// ══════════════════════════════════════════════════════════════════════════
//
// The human path ONTO a community's signed roster (kind:38120, roster.ts):
// any signed-in user can publish an application for a community; the
// community's roster steward reviews applications and adds accepted keys to
// the roster they sign. Community-consensus admission VOTES (kind:38122,
// reserved) come later — until then the steward is the admission decision,
// which is honest about where governance actually is today (DESIGN-arbiter-
// economy.md §3, build order stage 3).
//
// An application is self-signed by the APPLICANT — there is no authority to
// check here; the signature only proves the statement really came from that
// key. Spam resistance is the steward's eyeballs for now (applications are
// pull-fetched by the steward card, never pushed into anyone's feed).

import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import type { NostrEvent } from "../escrow-engine/types.js";

export const ARBITER_APPLICATION_KIND = 38121;
export const ARBITER_APPLICATION_TYPE = "chama:arbiter-application";
/** Keep statements human-sized; relays drop oversized events anyway. */
export const MAX_APPLICATION_STATEMENT_CHARS = 800;

export interface ArbiterApplicationPayload {
  type: typeof ARBITER_APPLICATION_TYPE;
  community: string;
  /** Why this person should arbitrate — shown verbatim to the steward. */
  statement: string;
  appliedAt?: number;
}

export interface ArbiterApplication {
  community: string;
  applicant: string;
  statement: string;
  createdAt: number;
  eventId: string;
}

/** Build the unsigned application event (the applicant's client signs it). */
export function buildArbiterApplicationEvent(params: {
  community: string;
  statement: string;
  createdAt?: number;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const community = params.community.trim();
  if (!community) throw new Error("Application community slug is required");
  const statement = params.statement.trim();
  if (!statement) throw new Error("Tell the community why — the statement is the application");
  if (statement.length > MAX_APPLICATION_STATEMENT_CHARS) {
    throw new Error(`Keep the statement under ${MAX_APPLICATION_STATEMENT_CHARS} characters`);
  }
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const payload: ArbiterApplicationPayload = {
    type: ARBITER_APPLICATION_TYPE,
    community,
    statement,
    appliedAt: createdAt,
  };
  return {
    kind: ARBITER_APPLICATION_KIND,
    created_at: createdAt,
    tags: [
      ["d", community],
      ["t", ARBITER_APPLICATION_TYPE],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + validate + signature-verify one application event. */
export function parseArbiterApplicationEvent(
  event: NostrEvent,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): ArbiterApplication | null {
  if (event.kind !== ARBITER_APPLICATION_KIND) return null;
  const dTag = event.tags.find(t => t[0] === "d")?.[1];
  if (!dTag) return null;
  let payload: ArbiterApplicationPayload;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (payload?.type !== ARBITER_APPLICATION_TYPE) return null;
  if (payload.community !== dTag) return null;
  const statement = typeof payload.statement === "string" ? payload.statement.trim() : "";
  if (!statement || statement.length > MAX_APPLICATION_STATEMENT_CHARS) return null;
  const verify = options?.verifyEvent ?? (verifyNostrEventSignature as unknown as (e: NostrEvent) => boolean);
  if (!verify(event)) return null;
  return {
    community: dTag,
    applicant: event.pubkey.toLowerCase(),
    statement,
    createdAt: event.created_at,
    eventId: event.id,
  };
}

/** Collapse raw events into the steward's review list: one entry per
 *  applicant (their NEWEST application wins), already-rostered keys filtered
 *  out, newest first. */
export function collectArbiterApplications(
  events: readonly NostrEvent[],
  options?: {
    excludePubkeys?: readonly string[];
    verifyEvent?: (event: NostrEvent) => boolean;
  },
): ArbiterApplication[] {
  const excluded = new Set(
    (options?.excludePubkeys ?? []).map(pk => pk.trim().toLowerCase()).filter(Boolean),
  );
  const byApplicant = new Map<string, ArbiterApplication>();
  for (const event of events) {
    const app = parseArbiterApplicationEvent(event, { verifyEvent: options?.verifyEvent });
    if (!app || excluded.has(app.applicant)) continue;
    const existing = byApplicant.get(app.applicant);
    if (
      !existing ||
      app.createdAt > existing.createdAt ||
      (app.createdAt === existing.createdAt && app.eventId < existing.eventId)
    ) {
      byApplicant.set(app.applicant, app);
    }
  }
  return [...byApplicant.values()].sort(
    (a, b) => b.createdAt - a.createdAt || (a.eventId < b.eventId ? -1 : 1),
  );
}
