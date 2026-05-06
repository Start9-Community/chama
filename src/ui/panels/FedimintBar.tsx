import { useState, useEffect } from "react";
import { type FedimintState } from "../../hooks/useEscrow.js";
import {
  type FederationPreset,
  CURATED_PRESETS,
  fetchObserverFederations,
  mergePresets,
} from "../../fedimint/federation-config.js";
import { T } from "../theme.js";

// Compact balance + Chama-funding entry point. Per PHILOSOPHY.md §2.1
// the persistent-balance mental model is dead — but during PR 1 we keep
// the bar in place; the recovery banner + one-trade gate ship in v0.2.0.
export function FedimintBar({ fedimint, onFund, onInit, showReconnect }: {
  fedimint: FedimintState;
  onFund: () => void;
  onInit: () => void;
  /** Whether to surface the Reconnect CTA when not joined. True for
   *  returning users (community picked / active invite present); false
   *  for truly first-time users (no community yet → community pills are
   *  the join surface, no reconnect target). */
  showReconnect: boolean;
}) {
  const sats = Math.floor(fedimint.balanceMsats / 1000);

  const [pillPresets, setPillPresets] = useState<FederationPreset[]>(CURATED_PRESETS);
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetchObserverFederations(ctrl.signal).then((observerList) => {
      if (cancelled || observerList.length === 0) return;
      setPillPresets(mergePresets(CURATED_PRESETS, observerList));
    });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  let displayName: string;
  if (!fedimint.joined) {
    displayName = fedimint.busy ? "Connecting Chama..." : "No federation";
  } else {
    const matched = fedimint.federationId
      ? pillPresets.find((p) => p.federationId === fedimint.federationId)
      : null;
    if (matched) {
      displayName = matched.name;
    } else if (fedimint.federationId) {
      displayName = `Custom federation (${fedimint.federationId.slice(0, 8)})`;
    } else {
      displayName = fedimint.federationName;
    }
  }

  const healthFailed = fedimint.joined && fedimint.lastHealthOk === false;
  const dotColor = healthFailed
    ? T.amber
    : fedimint.joined ? T.green : fedimint.busy ? T.amber : T.muted;
  const dotGlow = !healthFailed && fedimint.joined ? `0 0 8px ${T.green}66` : "none";

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 16px", background: T.surface,
      borderBottom: `1px solid ${T.border}`, fontFamily: T.mono,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div
          title={healthFailed ? "Federation unreachable — receives will be refused" : undefined}
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: dotColor,
            boxShadow: dotGlow,
            animation: fedimint.busy ? "pulse 1.2s infinite" : "none",
            flexShrink: 0,
          }}
        />
        <span style={{
          fontSize: 10, color: T.muted,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {displayName}
        </span>
        {fedimint.joined && (
          <>
            <span style={{ color: T.border }}>·</span>
            <span style={{ fontSize: 13, color: T.accent, fontWeight: 800, letterSpacing: -0.3 }}>
              {sats.toLocaleString()} sats
            </span>
          </>
        )}
      </div>
      {fedimint.joined ? (
        <button onClick={onFund} style={{
          padding: "6px 16px", borderRadius: 20,
          background: `linear-gradient(135deg, ${T.accent}, ${T.accent}cc)`,
          border: "none",
          color: T.bg, fontFamily: T.sans, fontSize: 11, fontWeight: 700,
          cursor: "pointer", letterSpacing: 0.3,
          boxShadow: `0 2px 8px ${T.accent}33`,
        }}>
          Chama
        </button>
      ) : !fedimint.busy && showReconnect && (
        // Reconnect renders whenever we're not joined, not in-flight, and
        // the caller indicates a reconnect target exists (returning user,
        // not a fresh first-timer). Pre-v0.1.85 this was gated on
        // fedimint.initialized, but switch-failure resets initialized=false,
        // so the recovery affordance disappeared exactly when users
        // needed it most. The handler (App.tsx) calls initFedimint()
        // with no args; that resolves via the user's custom invite
        // (or BP fallback) — community-tap revert paths set the custom
        // invite to the previous one so this button reconnects to the
        // right fed.
        <button onClick={onInit} style={{
          padding: "6px 16px", borderRadius: 20,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
          cursor: "pointer",
        }}>
          Reconnect
        </button>
      )}
    </div>
  );
}
