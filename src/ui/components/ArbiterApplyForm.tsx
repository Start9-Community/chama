import { useState } from "react";
import { T, ROLE_COLOR } from "../theme.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { HelpTip } from "./HelpTip.js";

// v3.1.1: the arbiter application form, extracted from MeScreen so it can live
// inline inside the Browse floating-menu "Become an arbiter" toast — the single
// place to apply (no more hard-link bounce to Me › Arbiter). Submitting signs a
// kind:38121 application the community's roster steward reviews; no schema
// change (the federation-operator credential rides inside the statement text).
export function ArbiterApplyForm({
  communitySlug,
  onApply,
  onClose,
}: {
  communitySlug: string;
  onApply: (community: string, statement: string) => Promise<void>;
  onClose?: () => void;
}) {
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fedInvite, setFedInvite] = useState("");
  const community = getCommunityBySlug(communitySlug);
  const displayName = community?.displayName ?? communitySlug;

  const submit = async () => {
    if (!statement.trim()) {
      setError("Tell the community why — the statement IS the application.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // v3.1 A3: fed operators are the strongest anchors — carry the invite +
      // steward key inside the statement text (no kind:38121 schema change).
      const fullStatement = fedInvite.trim()
        ? `${statement.trim()}\n\nFederation operator — invite + steward key: ${fedInvite.trim()}`
        : statement;
      await onApply(communitySlug, fullStatement);
      setStatus("Application signed and published. The community steward reviews it from their roster surface.");
      setStatement("");
      setFedInvite("");
    } catch (e: any) {
      setError(e?.message || "Couldn't publish the application. Check relays and retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>⚖️</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 800, color: ROLE_COLOR.arbiter, letterSpacing: 0.5 }}>
            BECOME A COMMUNITY ARBITER
          </span>
          <HelpTip title="What is an arbiter?" label="What is a community arbiter?">
            An arbiter is a trusted community member who can <strong>break a tie in a dispute</strong> — and only then. You step in only when the buyer and seller disagree, never on a normal trade. You can <strong>never take anyone's money</strong>: escrow is 2-of-3, so you only release the sats to the side telling the truth. Arbiters build a public reputation over time.
            {/* TODO(bond 2A): add "post a bond to raise your exposure cap" line here once BONDS_ENFORCED ships. */}
          </HelpTip>
        </span>
        {onClose && (
          <button
            type="button" onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", color: T.muted, fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
          >×</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 10 }}>
        The neutral third key — you vote only when buyer and seller disagree, and
        the dispute fee (1.5%, split-paid by both parties) is yours for the work.
        Presence will be bonded; fairness is your public rating. The steward
        reviews applications and signs the roster today.
      </div>
      <textarea
        value={statement}
        onChange={e => setStatement(e.target.value)}
        placeholder={`Why you? Languages, availability, how ${displayName} knows you…`}
        rows={3}
        maxLength={800}
        style={{
          width: "100%", boxSizing: "border-box", resize: "vertical",
          padding: "10px 12px", borderRadius: T.rs, marginBottom: 8,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.sans, fontSize: 12, lineHeight: 1.5,
        }}
      />
      {/* v3.1 A3: federation-owner credential — the premier "proof of work"
          anchor path. Form + copy only; the invite rides in the statement. */}
      <div style={{
        marginBottom: 8, padding: "10px 12px", borderRadius: T.rs,
        background: `${ROLE_COLOR.arbiter}0f`, border: `1px solid ${ROLE_COLOR.arbiter}33`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: ROLE_COLOR.arbiter, fontFamily: T.mono, letterSpacing: 0.5 }}>
            🏰 RUN YOUR OWN FEDERATION?
          </span>
          <HelpTip title="Federation operator" label="What is the federation-operator field?">
            Optional. If you run the Fedimint federation behind a community, pasting your invite + steward key is the strongest proof you're real — it lets the steward fast-track your application.
          </HelpTip>
        </div>
        <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.45, marginBottom: 8 }}>
          Federation operators are the strongest anchors — the premier proof-of-work path. Paste your invite + steward key and the steward can fast-track you.
        </div>
        <input
          value={fedInvite}
          onChange={e => setFedInvite(e.target.value)}
          placeholder="fed1… invite + steward npub / key (optional)"
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "9px 11px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 12,
          }}
        />
      </div>
      <button
        onClick={submit}
        disabled={busy}
        style={{
          width: "100%", padding: "10px 14px", borderRadius: T.rs,
          border: `1px solid ${ROLE_COLOR.arbiter}66`, background: `${ROLE_COLOR.arbiter}22`,
          color: ROLE_COLOR.arbiter, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
          cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Publishing…" : "Sign + send application"}
      </button>
      {status && (
        <div style={{ marginTop: 8, fontSize: 11, color: T.green, fontFamily: T.mono, lineHeight: 1.4 }}>
          ✓ {status}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: T.red, fontFamily: T.mono, lineHeight: 1.4 }}>
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
