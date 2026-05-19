import { useState } from "react";
import { T, inputStyle } from "../theme.js";
import {
  type SavedHandle,
  listSavedHandles,
  addSavedHandle,
  updateSavedHandle,
  deleteSavedHandle,
  setHandleVisibility,
  maskHandle,
  formatPhoneNumber,
} from "../../payments/saved-handles.js";
import {
  getRailByKey,
  railsForCommunity,
  railAllowsPublicHandle,
  phoneNetworksForCommunity,
} from "../../payments/rail-registry.js";

const PHONE_NUMBER_RAIL = "phone-number";

// Add/edit/delete payment handles. Per-handle visibility toggle renders
// only when rail.allowPublicHandle === true (sensitive rails are locked
// private — saved-handles.ts enforces the same on writes as defense in
// depth). Handle preview is masked by default with reveal-on-tap so the
// owner can audit without exposing PII to a shoulder-surfer.
//
// v0.6.3: Lightning Addresses moved to PayoutDestinationsPanel. This
// panel is now strictly counterparty-facing handles that may be revealed
// to trade participants at LOCK time.
export function SavedHandlesPanel({ communitySlug, onClose }: {
  communitySlug: string;
  onClose: () => void;
}) {
  const [handles, setHandles] = useState<SavedHandle[]>(() => listSavedHandles());
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [addRail, setAddRail] = useState<string>("");
  const [addValue, setAddValue] = useState<string>("");
  const [phoneValue, setPhoneValue] = useState<string>("");
  // v0.6.5: which mobile-money networks the user accepts on the phone
  // number being added. Stored locally with the handle and revealed
  // alongside it during a trade so counterparties know which network
  // to send fiat to.
  const [phoneNetworks, setPhoneNetworks] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setHandles(listSavedHandles());
  };

  const availableRails = railsForCommunity(communitySlug)
    .filter(r => r.key !== PHONE_NUMBER_RAIL);
  const phoneRail = getRailByKey(PHONE_NUMBER_RAIL);
  const phonePlaceholder = phoneRail?.placeholder || "+254 712 345 678";
  const phoneNetworkOptions = phoneNetworksForCommunity(communitySlug);

  const togglePhoneNetwork = (key: string) => {
    setPhoneNetworks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleAddPhone = () => {
    setError(null);
    if (!phoneValue.trim()) {
      setError("Enter a phone number");
      return;
    }
    try {
      addSavedHandle(PHONE_NUMBER_RAIL, phoneValue.trim(), {
        networks: [...phoneNetworks],
      });
      setPhoneValue("");
      setPhoneNetworks(new Set());
      refresh();
    } catch (e: any) {
      setError(e?.message || "Failed to save phone number");
    }
  };

  const handleToggleHandleNetwork = (h: SavedHandle, networkKey: string) => {
    const current = new Set(h.networks ?? []);
    if (current.has(networkKey)) current.delete(networkKey);
    else current.add(networkKey);
    updateSavedHandle(h.id, { networks: [...current] });
    refresh();
  };

  const handleAdd = () => {
    setError(null);
    if (!addRail || !addValue.trim()) {
      setError("Pick a rail and enter a handle");
      return;
    }
    try {
      addSavedHandle(addRail, addValue.trim());
      setAddRail("");
      setAddValue("");
      refresh();
    } catch (e: any) {
      setError(e?.message || "Failed to save");
    }
  };

  const handleDelete = (id: string) => {
    deleteSavedHandle(id);
    refresh();
  };

  const handleToggleVisibility = (h: SavedHandle) => {
    setError(null);
    const next = h.visibility === "public" ? "private" : "public";
    const result = setHandleVisibility(h.id, next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    refresh();
  };

  const handleReveal = (id: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 20,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          Payment handles
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none",
          color: T.muted, fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        marginBottom: 16, lineHeight: 1.5,
      }}>
        Handles are private by default. They're revealed to the three
        participants of a trade only after lock. Public-by-design rails
        (Revtag, $cashtag, etc.) can be opted in for profile display.
      </div>

      <div style={{
        background: T.card,
        border: `1px solid ${T.teal + "55"}`,
        borderRadius: T.r,
        padding: 16,
        marginBottom: 20,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "baseline", gap: 12, marginBottom: 8,
        }}>
          <div>
            <div style={{
              fontSize: 10, fontWeight: 700, color: T.teal,
              fontFamily: T.mono, letterSpacing: 1.2,
              textTransform: "uppercase",
            }}>
              Default mobile-money handle
            </div>
            <div style={{
              fontSize: 16, fontWeight: 800, color: T.text,
              fontFamily: T.sans, marginTop: 3,
            }}>
              Phone number
            </div>
          </div>
          <span style={{
            padding: "3px 10px", borderRadius: 12,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 9,
            fontWeight: 700, letterSpacing: 0.3, flexShrink: 0,
          }}>
            PRIVATE · LOCKED
          </span>
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.sans,
          lineHeight: 1.5, marginBottom: 12,
        }}>
          Used for M-Pesa, Wave, Airtel Money, Orange Money, bank-transfer
          coordination, and most mobile payments. It is never public.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={phoneValue}
            onChange={e => { setPhoneValue(e.target.value); setError(null); }}
            onBlur={e => {
              // v0.6.5: canonicalize "+CC XXX XXX XXX" the moment the
              // input loses focus, so the user sees the normalized
              // shape before tapping Save. Live-formatting on every
              // keystroke fights the cursor on mobile; blur-time gives
              // immediate feedback without that pain.
              const formatted = formatPhoneNumber(e.target.value);
              if (formatted !== e.target.value) setPhoneValue(formatted);
            }}
            placeholder={phonePlaceholder}
            inputMode="tel"
            autoComplete="tel"
            style={{ ...inputStyle, marginBottom: 0, flex: "1 1 220px", minWidth: 0 }}
          />
          <button
            onClick={handleAddPhone}
            disabled={!phoneValue.trim()}
            style={{
              padding: "0 14px", borderRadius: T.rs,
              background: !phoneValue.trim() ? T.surface : T.tealDim,
              border: `1px solid ${!phoneValue.trim() ? T.border : T.teal + "66"}`,
              color: !phoneValue.trim() ? T.muted : T.teal,
              fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: !phoneValue.trim() ? "default" : "pointer",
              whiteSpace: "nowrap" as const,
            }}
          >
            Save
          </button>
        </div>

        {/* v0.6.5 network chips. Optional tags so a counterparty sees
            "+254 ••• 5678 · M-Pesa" instead of just a number with no
            hint of which mobile-money network to use. Selected
            networks are stored on the SavedHandle and ride through
            the LOCK envelope to the three participants. */}
        {phoneNetworkOptions.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{
              fontSize: 10, color: T.muted, fontFamily: T.mono,
              letterSpacing: 0.4, marginBottom: 6,
            }}>
              Networks this number accepts (optional)
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {phoneNetworkOptions.map(rail => {
                const selected = phoneNetworks.has(rail.key);
                return (
                  <button
                    key={rail.key}
                    onClick={() => togglePhoneNetwork(rail.key)}
                    style={{
                      padding: "5px 11px", borderRadius: 14,
                      background: selected ? T.tealDim : T.surface,
                      border: `1px solid ${selected ? T.teal + "66" : T.border}`,
                      color: selected ? T.teal : T.muted,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      cursor: "pointer", letterSpacing: 0.2,
                    }}
                  >
                    {selected ? "✓ " : ""}{rail.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{
        fontSize: 10, fontWeight: 600, color: T.muted,
        fontFamily: T.mono, letterSpacing: 1.5, marginBottom: 10,
        textTransform: "uppercase",
      }}>
        Handles
      </div>
      {handles.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center", borderRadius: T.r,
          background: T.surface, border: `1px dashed ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 12,
          marginBottom: 20,
        }}>
          No saved handles yet. Add one below to auto-fill at trade time.
        </div>
      ) : (
        <div style={{ marginBottom: 24 }}>
          {handles.map(h => {
            const rail = getRailByKey(h.rail);
            const railName = rail?.displayName || h.rail;
            const allowsPublic = railAllowsPublicHandle(h.rail);
            const revealed = revealedIds.has(h.id);
            const display = revealed ? h.handle : maskHandle(h.handle);
            return (
              <div key={h.id} style={{
                background: T.card, border: `1px solid ${T.border}`,
                borderRadius: T.r, padding: 14, marginBottom: 10,
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  alignItems: "baseline", marginBottom: 8,
                }}>
                  <span style={{
                    fontSize: 12, fontWeight: 700, color: T.text,
                    fontFamily: T.sans,
                  }}>{railName}</span>
                  {allowsPublic ? (
                    <button
                      onClick={() => handleToggleVisibility(h)}
                      style={{
                        padding: "3px 10px", borderRadius: 12,
                        background: h.visibility === "public" ? T.greenDim : T.surface,
                        border: `1px solid ${h.visibility === "public" ? T.green + "66" : T.border}`,
                        color: h.visibility === "public" ? T.green : T.muted,
                        fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                        cursor: "pointer", letterSpacing: 0.3,
                      }}
                    >
                      {h.visibility === "public" ? "PUBLIC" : "PRIVATE"}
                    </button>
                  ) : (
                    <span style={{
                      padding: "3px 10px", borderRadius: 12,
                      background: T.surface, border: `1px solid ${T.border}`,
                      color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                      letterSpacing: 0.3,
                    }}>PRIVATE · LOCKED</span>
                  )}
                </div>
                <div
                  onClick={() => handleReveal(h.id)}
                  style={{
                    fontFamily: T.mono, fontSize: 13, color: T.text,
                    padding: "8px 10px", background: T.surface,
                    borderRadius: T.rs, cursor: "pointer",
                    border: `1px solid ${T.border}`, marginBottom: 8,
                  }}
                  title={revealed ? "Tap to mask" : "Tap to reveal"}
                >
                  {display}
                  <span style={{ float: "right", color: T.muted, fontSize: 10 }}>
                    {revealed ? "🙈 mask" : "👁 reveal"}
                  </span>
                </div>
                {/* v0.6.5: per-handle network chips for phone entries.
                    Tap toggles inclusion. The current set is also what
                    rides through the LOCK envelope. */}
                {h.rail === PHONE_NUMBER_RAIL && phoneNetworkOptions.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{
                      fontSize: 9, color: T.muted, fontFamily: T.mono,
                      letterSpacing: 0.3, marginBottom: 5,
                    }}>
                      NETWORKS
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {phoneNetworkOptions.map(rail => {
                        const selected = (h.networks ?? []).includes(rail.key);
                        return (
                          <button
                            key={rail.key}
                            onClick={() => handleToggleHandleNetwork(h, rail.key)}
                            style={{
                              padding: "4px 9px", borderRadius: 12,
                              background: selected ? T.tealDim : T.surface,
                              border: `1px solid ${selected ? T.teal + "66" : T.border}`,
                              color: selected ? T.teal : T.muted,
                              fontFamily: T.mono, fontSize: 9, fontWeight: 700,
                              cursor: "pointer", letterSpacing: 0.2,
                            }}
                          >
                            {selected ? "✓ " : ""}{rail.displayName}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => handleDelete(h.id)}
                  style={{
                    background: "none", border: "none",
                    color: T.red, fontFamily: T.mono, fontSize: 10,
                    cursor: "pointer", padding: 0,
                  }}
                >Delete</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add new handle */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted,
          fontFamily: T.mono, letterSpacing: 1, marginBottom: 12,
        }}>
          ADD HANDLE
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            RAIL
          </div>
          <select
            value={addRail}
            onChange={e => { setAddRail(e.target.value); setError(null); }}
            style={{ ...inputStyle, color: T.text, background: T.surface }}
          >
            <option value="">— pick a rail —</option>
            {availableRails.map(r => (
              <option key={r.key} value={r.key}>
                {r.displayName} {r.allowPublicHandle ? "" : "· private only"}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            HANDLE
          </div>
          <input
            value={addValue}
            onChange={e => { setAddValue(e.target.value); setError(null); }}
            placeholder={getRailByKey(addRail)?.placeholder || "Your handle"}
            style={inputStyle}
          />
        </div>
        {error && (
          <div style={{
            color: T.red, fontFamily: T.mono, fontSize: 11,
            marginBottom: 10,
          }}>{error}</div>
        )}
        <button
          onClick={handleAdd}
          disabled={!addRail || !addValue.trim()}
          style={{
            width: "100%", padding: "12px", borderRadius: T.rs,
            background: !addRail || !addValue.trim() ? T.surface : T.accentDim,
            border: `1px solid ${!addRail || !addValue.trim() ? T.border : T.accent + "44"}`,
            color: !addRail || !addValue.trim() ? T.muted : T.accent,
            fontFamily: T.mono, fontSize: 12, fontWeight: 700,
            cursor: !addRail || !addValue.trim() ? "default" : "pointer",
          }}
        >
          Save handle
        </button>
      </div>
    </div>
  );
}
