import { useState } from "react";
import { T } from "../theme.js";
import {
  type PayoutDestination,
  listPayoutDestinations,
  deletePayoutDestination,
} from "../../payments/payout-destinations.js";
import {
  type SavedNwcConnection,
  listSavedNwcConnections,
  deleteSavedNwcConnection,
} from "../../payments/nwc-connections.js";

// Local payout/funding destinations used by Claim, Recover, and NWC
// auto-pay flows. Separate from Payment Handles because these are never
// revealed to a counterparty and never appear in listing/payment-handle
// pickers.
export function PayoutDestinationsPanel({ onClose }: {
  onClose: () => void;
}) {
  const [destinations, setDestinations] = useState<PayoutDestination[]>(
    () => listPayoutDestinations(),
  );
  const [nwcConnections, setNwcConnections] = useState<SavedNwcConnection[]>(
    () => listSavedNwcConnections(),
  );

  const handleDelete = (id: string) => {
    deletePayoutDestination(id);
    setDestinations(listPayoutDestinations());
  };

  const handleDeleteNwc = (id: string) => {
    deleteSavedNwcConnection(id);
    setNwcConnections(listSavedNwcConnections());
  };

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 20,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          Payout destinations
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
        Lightning Addresses and NWC wallets saved from successful claims,
        recoveries, and funding. These stay local to this browser and are
        never shown to a trade counterparty.
      </div>

      {destinations.length === 0 && nwcConnections.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center", borderRadius: T.r,
          background: T.surface, border: `1px dashed ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 12,
          lineHeight: 1.5,
        }}>
          No payout destinations saved yet. Use Claim, Recover, or NWC
          funding and choose remember.
        </div>
      ) : (
        <div>
          {destinations.length > 0 && (
            <>
              <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>
                LIGHTNING ADDRESSES
              </div>
              {destinations.map((destination, i) => (
                <div key={destination.id} style={{
                  background: T.card, border: `1px solid ${T.border}`,
                  borderRadius: T.rs, padding: 12, marginBottom: 8,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 14 }}>⚡</span>
                    <span style={{
                      color: T.text, fontFamily: T.mono, fontSize: 12,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {destination.address}
                    </span>
                    {i === 0 && (
                      <span style={{
                        fontSize: 8, fontFamily: T.mono, letterSpacing: 1,
                        color: T.accent, background: T.accentDim,
                        padding: "2px 6px", borderRadius: 4, flexShrink: 0,
                      }}>DEFAULT</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(destination.id)}
                    style={{
                      background: "none", border: "none",
                      color: T.red, fontFamily: T.mono, fontSize: 10,
                      cursor: "pointer", padding: "0 4px", flexShrink: 0,
                    }}
                  >Delete</button>
                </div>
              ))}
            </>
          )}

          {nwcConnections.length > 0 && (
            <>
              <div style={{
                fontSize: 9, color: T.muted, fontFamily: T.mono,
                letterSpacing: 1, margin: destinations.length > 0 ? "18px 0 8px" : "0 0 8px",
              }}>
                NWC WALLETS
              </div>
              {nwcConnections.map((connection, i) => (
                <div key={connection.id} style={{
                  background: T.card, border: `1px solid ${T.border}`,
                  borderRadius: T.rs, padding: 12, marginBottom: 8,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 12 }}>NWC</span>
                    <span style={{
                      color: T.text, fontFamily: T.mono, fontSize: 12,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {connection.label}
                    </span>
                    {i === 0 && (
                      <span style={{
                        fontSize: 8, fontFamily: T.mono, letterSpacing: 1,
                        color: T.accent, background: T.accentDim,
                        padding: "2px 6px", borderRadius: 4, flexShrink: 0,
                      }}>DEFAULT</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDeleteNwc(connection.id)}
                    style={{
                      background: "none", border: "none",
                      color: T.red, fontFamily: T.mono, fontSize: 10,
                      cursor: "pointer", padding: "0 4px", flexShrink: 0,
                    }}
                  >Delete</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
