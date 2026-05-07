// ══════════════════════════════════════════════════════════════════════════
// Chama — Recovery banner (v0.2.0 item 2)
// ══════════════════════════════════════════════════════════════════════════
//
// Per Pillar 2.1's "no sats stranded, ever" promise: when the user's
// OPFS holds a balance but no active trade claims it, we replace
// Browse + Create with this recovery banner and force a Lightning
// withdrawal before any new commitment can be created. The user
// learns, viscerally, that ecash is bearer cash that needs to leave
// the local wallet to be safe — and that Chama treats every stranded
// sat as a structural failure to repair.
//
// The banner is a Browse-replacement, not a modal. It intercepts
// navigation to Browse and Create only; Me remains fully accessible
// (per the v0.2.0 brief: users may need to update their LN address,
// fetch counterparty kind:0, or check ratings/history as part of
// resolving the recovery itself).
//
// Counterparty resolution: identifyStrandedEcashSource walks the
// local replay to find the most recent CLAIM event the user signed.
// If no CLAIM is found, generic copy ("Trade with unknown
// counterparty") + a generic withdraw flow.

import { T, fmtSats } from "../theme.js";
import { displayCounterpartyName, type StrandedEcashSource } from "../decisions.js";
import { Role } from "../../escrow-engine/types.js";

export function RecoveryBanner({
  balanceMsats,
  source,
  fetchKind0Enabled,
  onWithdraw,
}: {
  balanceMsats: number;
  source: StrandedEcashSource | null;
  fetchKind0Enabled: boolean;
  onWithdraw: () => void;
}) {
  const sats = Math.floor(balanceMsats / 1000);
  const counterpartyName = source
    ? displayCounterpartyName({
        npub: source.counterpartyPubkey,
        fetchKind0Enabled,
        kind0Name: null, // v0.2.1 wires the fetcher
      })
    : "an unknown counterparty";

  const headline = source
    ? `Your trade with ${counterpartyName} didn't finish`
    : "You have unspent sats from a previous trade";

  const explanation = source
    ? "Connection dropped before your sats landed in your Lightning wallet. Pick up where you left off."
    : "Withdraw them to your Lightning wallet to keep them safe — Chama is non-custodial and ecash is bearer cash.";

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        background: T.amberDim, border: `1px solid ${T.amber}66`,
        borderRadius: T.r, padding: 20, marginBottom: 16,
      }}>
        {/* Small-caps header with amber dot */}
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
          Continue your trade
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

        {/* Trade identity card — only when we have source. Generic
            withdraw flow when source is null. */}
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
          onClick={onWithdraw}
          style={{
            width: "100%", padding: "14px",
            background: `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
            border: "none", borderRadius: T.rs,
            color: T.bg, fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            cursor: "pointer", letterSpacing: 0.5,
          }}
        >
          ⚡ Finish trade · withdraw {sats.toLocaleString()} sats
        </button>

        <div style={{
          textAlign: "center", marginTop: 10,
          fontSize: 9, color: T.muted, fontFamily: T.mono,
        }}>
          Sats land in your Lightning wallet · Chama frees up for the next trade
        </div>
      </div>

      {/* Bottom paragraph — half-opacity per the spec. */}
      <div style={{
        textAlign: "center", padding: "8px 16px",
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        opacity: 0.5, lineHeight: 1.5,
      }}>
        {source
          ? <>Browse opens once your trade with {counterpartyName} is finished — Chama keeps it simple, one trade at a time.</>
          : <>Browse opens once your sats are withdrawn — Chama keeps it simple, one trade at a time.</>}
      </div>
    </div>
  );
}
