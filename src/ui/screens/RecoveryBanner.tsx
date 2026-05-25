// ══════════════════════════════════════════════════════════════════════════
// Chama — Recovery banner (v0.3.0 Phase 4 — failure-mode framing)
// ══════════════════════════════════════════════════════════════════════════
//
// Per Pillar 2.1 Option B: unexplained balance > 0 is a failure state.
// ecash exists only during LOCK→CLAIM. v0.3.0 retunes
// this banner from "Continue your trade · withdraw N sats" (v0.2.0)
// to a failure-mode framing that names the state correctly: the user's
// last trade didn't finish cleanly, sats are stranded on their local
// Chama, and recovering them is a structural repair — not a routine
// "withdraw" operation.
//
// Trigger contract: balance is large enough for an outbound Lightning
// payout and no active escrow, funding flow, or claim sweep explains it
// (see decisions.shouldShowRecoveryBanner). Phase 3's three-way claim
// failure split (claim-failed / claim-pending / payout-failed) makes
// the banner more meaningful, not less — payout-failed is the common
// path here.
//
// Counterparty resolution: identifyStrandedEcashSource walks the local
// replay to find the most recent CLAIM event the user signed. Generic
// fallback when no CLAIM is found.

import { T } from "../theme.js";
import { displayCounterpartyName, type StrandedEcashSource } from "../decisions.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
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
          <BitcoinAmount sats={totalSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
          are still in your local Chama.{" "}
          <BitcoinAmount sats={recoverableSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
          can be sent to your Lightning address now
          {reserveSats > 0 && (
            <>
              , with about{" "}
              <BitcoinAmount sats={reserveSats} size={13} gap={4} glyphScale={1.22} color={T.text} glyphColor={T.muted} />{" "}
              kept for Lightning fees
            </>
          )}
          .
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
                <BitcoinAmount msats={source.amountMsats} size={12} gap={4} glyphScale={1.18} />
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
          ⚡ Recover <BitcoinAmount sats={recoverableSats} size={14} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /> →
        </button>

        <div style={{
          textAlign: "center", marginTop: 10,
          fontSize: 9, color: T.muted, fontFamily: T.mono,
        }}>
          Sats land at your Lightning address · Chama keeps your local wallet empty
        </div>
      </div>

      {/* Bottom paragraph — half-opacity per the spec. v0.6.5: with the
          one-trade gate retired, the old "Browse opens once recovered"
          framing is misleading — Browse is always open. Reframe to
          name the actual repair: unexplained sats out of OPFS. */}
      <div style={{
        textAlign: "center", padding: "8px 16px",
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        opacity: 0.5, lineHeight: 1.5,
      }}>
        You can keep using Chama. Recovering just clears unexplained sats out of OPFS.
      </div>
    </div>
  );
}
