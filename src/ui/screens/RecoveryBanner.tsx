// ══════════════════════════════════════════════════════════════════════════
// Chama — Recovery banner (v0.3.0 Phase 4 — failure-mode framing)
// ══════════════════════════════════════════════════════════════════════════
//
// Per Pillar 2.1 Option B: balance > 0 between trades is ALWAYS a
// failure state. ecash exists only during LOCK→CLAIM. v0.3.0 retunes
// this banner from "Continue your trade · withdraw N sats" (v0.2.0)
// to a failure-mode framing that names the state correctly: the user's
// last trade didn't finish cleanly, sats are stranded on their local
// Chama, and recovering them is a structural repair — not a routine
// "withdraw" operation.
//
// Trigger contract: balance is large enough for an outbound Lightning
// payout && !hasActiveBuyerSellerCommitment (see decisions.
// shouldShowRecoveryBanner). Phase 3's three-way claim failure split
// (claim-failed / claim-pending / payout-failed) makes the banner more
// meaningful, not less — payout-failed is the common path here.
//
// Counterparty resolution: identifyStrandedEcashSource walks the local
// replay to find the most recent CLAIM event the user signed. Generic
// fallback when no CLAIM is found.

import { T, fmtSats } from "../theme.js";
import { displayCounterpartyName, type StrandedEcashSource } from "../decisions.js";
import { Role } from "../../escrow-engine/types.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";

export function RecoveryBanner({
  balanceMsats,
  source,
  fetchKind0Enabled,
  onRecover,
}: {
  balanceMsats: number;
  source: StrandedEcashSource | null;
  fetchKind0Enabled: boolean;
  /** Open the RecoveryPayoutModal. v0.3.0 renames from onWithdraw to
   *  onRecover to match the failure-mode framing — this is structural
   *  repair, not a routine wallet withdrawal. */
  onRecover: () => void;
}) {
  const totalSats = Math.floor(balanceMsats / 1000);
  const recoverableSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const counterpartyName = source
    ? displayCounterpartyName({
        npub: source.counterpartyPubkey,
        fetchKind0Enabled,
        kind0Name: null, // v0.2.1 wires the fetcher
      })
    : "an unknown counterparty";

  const headline = source
    ? `Your trade with ${counterpartyName} didn't finish cleanly`
    : "Your last trade didn't finish cleanly";

  const explanation = source
    ? `${totalSats.toLocaleString()} sats are still in your local Chama. ${recoverableSats.toLocaleString()} sats can be sent to your Lightning address now${reserveSats > 0 ? `, with about ${reserveSats.toLocaleString()} sats kept for Lightning fees` : ""}.`
    : `${totalSats.toLocaleString()} sats are still in your local Chama. ${recoverableSats.toLocaleString()} sats can be sent to your Lightning address now${reserveSats > 0 ? `, with about ${reserveSats.toLocaleString()} sats kept for Lightning fees` : ""}.`;

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        background: T.amberDim, border: `1px solid ${T.amber}66`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        {/* v0.3.0: failure-mode small-caps header. "Continue your trade"
            (v0.2.0) reframed to "Trade needs attention" because Pillar
            2.1 Option B treats stranded balance as a failure to repair,
            not a normal step. */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 10, fontWeight: 700, color: T.amber, fontFamily: T.mono,
          letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: T.amber,
            boxShadow: `0 0 8px ${T.amber}88`,
            animation: "pulse 2s ease-in-out infinite",
          }} />
          ⚠ Trade needs attention
        </div>

        <div style={{
          fontSize: 16, fontWeight: 700, color: T.text, fontFamily: T.sans,
          lineHeight: 1.4, marginBottom: 12,
        }}>
          {headline}
        </div>

        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          lineHeight: 1.55, marginBottom: 16,
        }}>
          {explanation}
        </div>

        {/* Trade identity card — when we have source. Generic copy
            without this card when the local replay yielded no CLAIM. */}
        {source && (
          <div style={{
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.rs, padding: 14, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 9, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              TRADE
            </div>
            <div style={{
              fontFamily: T.mono, fontSize: 11, color: T.muted,
              wordBreak: "break-all" as const, marginBottom: 6,
            }}>
              {source.escrowId}
            </div>
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans, marginBottom: 6,
            }}>
              {source.description}
            </div>
            <div style={{
              fontSize: 12, color: T.muted, fontFamily: T.mono,
            }}>
              Your role: <span style={{ color: T.text }}>
                {source.role === Role.BUYER ? "Buyer"
                  : source.role === Role.SELLER ? "Seller"
                  : "Arbiter"}
              </span>
              {" · "}
              <span style={{ color: T.accent, fontWeight: 700 }}>
                {fmtSats(source.amountMsats)} sats
              </span>
            </div>
          </div>
        )}

        <button
          onClick={onRecover}
          style={{
            width: "100%", padding: "14px",
            background: `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
            border: "none", borderRadius: T.rs,
            color: T.bg, fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            cursor: "pointer", letterSpacing: 0.5,
          }}
        >
          ⚡ Recover {recoverableSats.toLocaleString()} sats →
        </button>

        <div style={{
          textAlign: "center", marginTop: 10,
          fontSize: 9, color: T.muted, fontFamily: T.mono,
        }}>
          Sats land at your Lightning address · Chama frees up for the next trade
        </div>
      </div>

      {/* Bottom paragraph — half-opacity per the spec. */}
      <div style={{
        textAlign: "center", padding: "8px 16px",
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        opacity: 0.5, lineHeight: 1.5,
      }}>
        {source
          ? <>Browse opens once your sats are recovered — Chama keeps it simple, one trade at a time.</>
          : <>Browse opens once your sats are recovered — Chama keeps it simple, one trade at a time.</>}
      </div>
    </div>
  );
}
