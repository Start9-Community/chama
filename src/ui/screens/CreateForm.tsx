// ══════════════════════════════════════════════════════════════════════════
// Chama — Create wizard (v0.2.0 item 5 + items 7, 10)
// ══════════════════════════════════════════════════════════════════════════
//
// Three-step wizard for publishing a listing. Per the v0.2.0 brief:
//
//   Step 1 — Category + community context. Four large category cards
//     (P2P / Bill Pay / Marketplace / Lending) above a read-only
//     "Listing in [home community]" line. Federation is never named
//     here — derived downstream from the community.
//
//     Item 10: arbiter attention warning surfaces here when the user
//     is arbiter on a LOCKED escrow (soft = no disagreement yet, hard
//     = vote-pending tiebreaker). Soft = informational; hard =
//     conflict-explicit with asymmetric CTA. Either way it's a warning,
//     not a block — Pillar 2.7 educational moment.
//
//     Save-draft surfacing: "Continue your last [vertical] listing"
//     cards for any drafts in localStorage, cap 3 visible (sorted by
//     savedAt desc), older drafts behind "Show more drafts" expander.
//
//   Step 2 — Vertical-specific form. v0.2.0 ships description + amount
//     + fiat + (marketplace: fulfillment) + (graduated: subscription).
//     v0.2.1 will add direction toggle, premium %, payment-rail picker,
//     photos, delivery method, lending terms — too much surface for the
//     federation-follows-listing convergence release.
//
//     Item 7: subscription toggle is invisible unless canOfferSubscription
//     === true. v0.2.0 universally false (no rating events yet) → toggle
//     hidden for everyone. When v0.2.1 wires the rating aggregator the
//     gate naturally opens for graduated sellers.
//
//   Step 3 — Review & publish. Preview card (left/top) + federation-
//     honesty info card (one-time-per-account, dismissed on first
//     publish). Save-draft button + Publish button.

import { useState, useEffect } from "react";
import { categoryAllowsFulfillmentChoice, type Fulfillment } from "../../labels/vote-labels.js";
import { getCommunityBySlug, DEFAULT_COMMUNITY_SLUG } from "../../communities/registry.js";
import { getUserCommunitySlug } from "../../communities/storage.js";
import { resolveFederationForCommunity } from "../../fedimint/federation-config.js";
import { type ArbiterWarning, displayCounterpartyName } from "../decisions.js";
import { T, inputStyle } from "../theme.js";

type Step = 1 | 2 | 3;
type Vertical = "p2p-trade" | "bill-pay" | "marketplace" | "lending";

const VERTICALS: { id: Vertical; label: string; icon: string; description: string }[] = [
  { id: "p2p-trade", label: "P2P Trade", icon: "⚡", description: "Swap sats for fiat with another user." },
  { id: "bill-pay", label: "Bill Pay", icon: "🧾", description: "Pay a bill in exchange for sats." },
  { id: "marketplace", label: "Marketplace", icon: "🏪", description: "Sell goods, services, or digital items." },
  { id: "lending", label: "Lending", icon: "🤝", description: "Lend sats with repayment terms." },
];

interface FormState {
  desc: string;
  sats: string;
  fiat: string;
  cur: string;
  fulfillment: Fulfillment;
  isSubscription: boolean;
  periods: string;
  intervalDays: string;
}

interface SavedDraft {
  vertical: Vertical;
  formState: FormState;
  savedAt: number;
}

const DRAFT_KEY_PREFIX = "chama_create_draft_";
const FIRST_PUBLISH_KEY_PREFIX = "chama_first_publish_done_";

function readDraft(vertical: Vertical): SavedDraft | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + vertical);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.vertical || !parsed?.formState) return null;
    return parsed;
  } catch { return null; }
}

function writeDraft(draft: SavedDraft): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(DRAFT_KEY_PREFIX + draft.vertical, JSON.stringify(draft));
  } catch { /* no-op */ }
}

function clearDraft(vertical: Vertical): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(DRAFT_KEY_PREFIX + vertical);
    }
  } catch { /* no-op */ }
}

function readAllDrafts(): SavedDraft[] {
  return VERTICALS
    .map(v => readDraft(v.id))
    .filter((d): d is SavedDraft => d !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}

function hasFirstPublishedBefore(pubkey: string | null): boolean {
  if (!pubkey) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(FIRST_PUBLISH_KEY_PREFIX + pubkey) === "1";
  } catch { return false; }
}

function markFirstPublished(pubkey: string | null): void {
  if (!pubkey) return;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FIRST_PUBLISH_KEY_PREFIX + pubkey, "1");
    }
  } catch { /* no-op */ }
}

const EMPTY_FORM_STATE: FormState = {
  desc: "",
  sats: "",
  fiat: "",
  cur: "USD",
  fulfillment: "physical",
  isSubscription: false,
  periods: "3",
  intervalDays: "30",
};

export function CreateForm({
  onCreate, onClose,
  arbiterWarning, onGoToArbiterTrade,
  canOfferSubscription, userPubkey,
}: {
  onCreate: (params: any) => void;
  onClose: () => void;
  arbiterWarning: ArbiterWarning;
  onGoToArbiterTrade: (escrowId: string) => void;
  canOfferSubscription: boolean;
  userPubkey: string | null;
}) {
  const [step, setStep] = useState<Step>(1);
  const [vertical, setVertical] = useState<Vertical>("p2p-trade");
  const [form, setForm] = useState<FormState>(EMPTY_FORM_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [arbiterDismissed, setArbiterDismissed] = useState(false);
  const [drafts, setDrafts] = useState<SavedDraft[]>(() => readAllDrafts());
  const [showAllDrafts, setShowAllDrafts] = useState(false);

  // Resolve community context for the listing. Read once at mount;
  // listing publishes into seller's current community (Pillar 2.3).
  const community = (() => {
    const slug = getUserCommunitySlug();
    return getCommunityBySlug(slug) ? slug : DEFAULT_COMMUNITY_SLUG;
  })();
  const homeCommunity = getCommunityBySlug(community);

  // Auto-save draft on field change (silent, debounced via the form
  // state's natural batching). Cleared on successful publish.
  useEffect(() => {
    // Don't save empty drafts.
    if (!form.desc.trim() && !form.sats.trim() && !form.fiat.trim()) return;
    writeDraft({ vertical, formState: form, savedAt: Date.now() });
    setDrafts(readAllDrafts());
  }, [form, vertical]);

  const continueDraft = (draft: SavedDraft) => {
    setVertical(draft.vertical);
    setForm(draft.formState);
    setStep(2);
  };

  const handlePublish = async () => {
    if (!form.desc || !form.sats) return;
    setSubmitting(true);
    try {
      const amountMsats = parseInt(form.sats) * 1000;
      const mintUrl = resolveFederationForCommunity(community);
      const params: any = {
        description: form.desc,
        amountMsats: form.isSubscription
          ? parseInt(form.periods) * amountMsats
          : amountMsats,
        fiatAmount: form.fiat ? parseFloat(form.fiat) : undefined,
        fiatCurrency: form.fiat ? form.cur : undefined,
        category: vertical,
        community,
        fulfillment: vertical === "marketplace" ? form.fulfillment : undefined,
        mintUrl,
      };
      if (form.isSubscription) {
        params.subscription = {
          totalPeriods: parseInt(form.periods),
          periodAmountMsats: amountMsats,
          periodDurationSeconds: parseInt(form.intervalDays) * 86400,
        };
      }
      await onCreate(params);
      // Successful publish — clear this vertical's draft + mark
      // first-publish so the honesty card never re-shows.
      clearDraft(vertical);
      markFirstPublished(userPubkey);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render: arbiter warning intercepts before the wizard renders ──
  if (arbiterWarning.kind !== "none" && !arbiterDismissed) {
    return (
      <ArbiterWarningCard
        warning={arbiterWarning}
        onContinue={() => setArbiterDismissed(true)}
        onCancel={onClose}
        onGoToArbiterTrade={onGoToArbiterTrade}
      />
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 14,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          New listing
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: T.muted,
          fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <StepProgress currentStep={step} />

      {step === 1 && (
        <Step1
          vertical={vertical}
          setVertical={setVertical}
          homeCommunity={homeCommunity}
          drafts={drafts}
          showAllDrafts={showAllDrafts}
          setShowAllDrafts={setShowAllDrafts}
          onContinueDraft={continueDraft}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <Step2
          vertical={vertical}
          form={form}
          setForm={setForm}
          canOfferSubscription={canOfferSubscription}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <Step3
          vertical={vertical}
          form={form}
          setForm={setForm}
          homeCommunity={homeCommunity}
          firstPublishDone={hasFirstPublishedBefore(userPubkey)}
          submitting={submitting}
          onBack={() => setStep(2)}
          onPublish={handlePublish}
          onSaveDraft={() => {
            writeDraft({ vertical, formState: form, savedAt: Date.now() });
            setDrafts(readAllDrafts());
            onClose();
          }}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step progress indicator
// ══════════════════════════════════════════════════════════════════════════

function StepProgress({ currentStep }: { currentStep: Step }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      marginBottom: 20,
    }}>
      {[1, 2, 3].map((n) => {
        const active = n === currentStep;
        const done = n < currentStep;
        return (
          <div key={n} style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%",
              background: active ? T.accent : done ? T.green : T.surface,
              border: `1px solid ${active ? T.accent : done ? T.green : T.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              color: active || done ? T.bg : T.muted,
              flexShrink: 0,
            }}>
              {done ? "✓" : n}
            </div>
            {n < 3 && (
              <div style={{
                flex: 1, height: 1,
                background: done ? T.green : T.border,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Arbiter warning card (item 10)
// ══════════════════════════════════════════════════════════════════════════

function ArbiterWarningCard({
  warning,
  onContinue,
  onCancel,
  onGoToArbiterTrade,
}: {
  warning: ArbiterWarning;
  onContinue: () => void;
  onCancel: () => void;
  onGoToArbiterTrade: (escrowId: string) => void;
}) {
  if (warning.kind === "none") return null;
  const isHard = warning.kind === "hard";
  const counterpartyA = displayCounterpartyName({
    npub: warning.counterpartyA,
    fetchKind0Enabled: false,
    kind0Name: null,
  });
  const counterpartyB = displayCounterpartyName({
    npub: warning.counterpartyB,
    fetchKind0Enabled: false,
    kind0Name: null,
  });

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        background: isHard ? T.redDim : T.amberDim,
        border: `1px solid ${isHard ? T.red + "66" : T.amber + "66"}`,
        borderRadius: T.r, padding: 20,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>
          {isHard ? "⚠️" : "⚖️"}
        </div>
        <div style={{
          fontSize: 11, fontWeight: 700, color: isHard ? T.red : T.amber,
          fontFamily: T.mono, letterSpacing: 1.5, textTransform: "uppercase",
          marginBottom: 12,
        }}>
          {isHard ? "Arbitration vote pending" : "You're an arbiter"}
        </div>
        {isHard ? (
          <>
            <div style={{
              fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans,
              lineHeight: 1.4, marginBottom: 12,
            }}>
              A trade you're arbiting needs your vote.
            </div>
            {/* v0.3.0 Phase 6 (item 8): tightened from 4 sentences to
                3, dropping the "Your decision determines where their
                sats go" filler and shortening "splitting attention here
                can cost someone real money" → "could cost someone their
                sats". Same urgency, less verbiage. */}
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans,
              lineHeight: 1.55, marginBottom: 20,
            }}>
              <strong>{counterpartyA}</strong> and <strong>{counterpartyB}</strong>{" "}
              disagreed on their trade. Splitting your attention now could
              cost someone their sats. Resolve theirs first.
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans,
              lineHeight: 1.4, marginBottom: 12,
            }}>
              You're currently arbiter on an active trade.
            </div>
            <div style={{
              fontSize: 13, color: T.text, fontFamily: T.sans,
              lineHeight: 1.55, marginBottom: 20,
            }}>
              <strong>{counterpartyA}</strong> and <strong>{counterpartyB}</strong>{" "}
              haven't disputed and may never need you, but your attention could
              be needed quickly.
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, flexDirection: "column" }}>
          {isHard ? (
            <>
              <button
                onClick={() => onGoToArbiterTrade(warning.escrowId)}
                style={primaryButtonStyle(T.accent)}
              >
                Go to arbitration trade ›
              </button>
              <button
                onClick={onContinue}
                style={mutedSecondaryButtonStyle()}
              >
                Continue anyway
              </button>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onCancel} style={equalButtonStyle()}>
                Cancel
              </button>
              <button onClick={onContinue} style={equalButtonStyle()}>
                Continue anyway
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function primaryButtonStyle(color: string): React.CSSProperties {
  return {
    width: "100%", padding: "12px",
    background: color, border: "none", borderRadius: T.rs,
    color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 800,
    cursor: "pointer", letterSpacing: 0.3,
  };
}
function mutedSecondaryButtonStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "12px",
    background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.muted, fontFamily: T.mono, fontSize: 12, fontWeight: 600,
    cursor: "pointer",
  };
}
function equalButtonStyle(): React.CSSProperties {
  return {
    flex: 1, padding: "12px",
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
    cursor: "pointer",
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Step 1 — Category + community + drafts
// ══════════════════════════════════════════════════════════════════════════

function Step1({
  vertical, setVertical,
  homeCommunity,
  drafts, showAllDrafts, setShowAllDrafts,
  onContinueDraft,
  onNext,
}: {
  vertical: Vertical;
  setVertical: (v: Vertical) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  drafts: SavedDraft[];
  showAllDrafts: boolean;
  setShowAllDrafts: (b: boolean) => void;
  onContinueDraft: (d: SavedDraft) => void;
  onNext: () => void;
}) {
  const visibleDrafts = showAllDrafts ? drafts : drafts.slice(0, 3);
  const hiddenDraftCount = Math.max(0, drafts.length - 3);

  return (
    <>
      {/* Save-draft cards (visible when any drafts exist) */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 11, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            CONTINUE A DRAFT
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleDrafts.map(d => {
              const v = VERTICALS.find(vert => vert.id === d.vertical)!;
              const ageMs = Date.now() - d.savedAt;
              const ageMin = Math.floor(ageMs / 60_000);
              const ageStr = ageMin < 1 ? "just now"
                : ageMin < 60 ? `${ageMin}m ago`
                : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h ago`
                : `${Math.floor(ageMin / 1440)}d ago`;
              return (
                <button
                  key={d.vertical}
                  onClick={() => onContinueDraft(d)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "10px 12px",
                    background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: T.rs, cursor: "pointer",
                    textAlign: "left" as const,
                    color: T.text, fontFamily: T.sans,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{v.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      Continue your last {v.label} listing
                    </div>
                    <div style={{
                      fontSize: 10, color: T.muted, fontFamily: T.mono,
                      marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                    }}>
                      {d.formState.desc || "(no description yet)"} · {ageStr}
                    </div>
                  </div>
                  <span style={{ color: T.muted, fontSize: 16 }}>›</span>
                </button>
              );
            })}
            {!showAllDrafts && hiddenDraftCount > 0 && (
              <button
                onClick={() => setShowAllDrafts(true)}
                style={{
                  background: "none", border: "none",
                  color: T.muted, fontFamily: T.mono, fontSize: 11,
                  cursor: "pointer", padding: "8px",
                }}
              >
                ▼ Show {hiddenDraftCount} more draft{hiddenDraftCount !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Category cards */}
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        WHAT KIND OF TRADE?
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
        marginBottom: 20,
      }}>
        {VERTICALS.map(v => {
          const active = vertical === v.id;
          return (
            <button
              key={v.id}
              onClick={() => setVertical(v.id)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start",
                gap: 6, padding: "16px 14px",
                background: active ? T.accentDim : T.surface,
                border: `1px solid ${active ? T.accent + "66" : T.border}`,
                borderRadius: T.r, cursor: "pointer",
                textAlign: "left" as const, transition: "all 0.15s",
              }}
            >
              <span style={{ fontSize: 22 }}>{v.icon}</span>
              <span style={{
                fontSize: 13, fontWeight: 700, color: active ? T.accent : T.text,
                fontFamily: T.sans,
              }}>
                {v.label}
              </span>
              <span style={{
                fontSize: 10, color: T.muted, fontFamily: T.sans,
                lineHeight: 1.4,
              }}>
                {v.description}
              </span>
            </button>
          );
        })}
      </div>

      {/* Community context */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 12px", marginBottom: 24,
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: T.rs,
      }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>
          {homeCommunity?.flagEmoji ?? "🌐"}
        </span>
        <span style={{ flex: 1, fontSize: 12, color: T.text, fontFamily: T.sans }}>
          Listing in <strong>{homeCommunity?.displayName ?? "your community"}</strong>
        </span>
        <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5 }}>
          YOUR COMMUNITY
        </span>
      </div>

      <button onClick={onNext} style={{
        width: "100%", padding: "14px",
        background: T.accent, border: "none", borderRadius: T.rs,
        color: T.bg, fontFamily: T.mono, fontSize: 14, fontWeight: 800,
        cursor: "pointer", letterSpacing: 0.5,
      }}>
        Next ›
      </button>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step 2 — Vertical-specific form
// ══════════════════════════════════════════════════════════════════════════

function Step2({
  vertical, form, setForm,
  canOfferSubscription,
  onBack, onNext,
}: {
  vertical: Vertical;
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  canOfferSubscription: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const ready = form.desc.trim().length > 0 && form.sats.trim().length > 0;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  return (
    <>
      {categoryAllowsFulfillmentChoice(vertical) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FULFILLMENT</div>
          <select value={form.fulfillment} onChange={e => set("fulfillment", e.target.value as Fulfillment)}
            style={{ ...inputStyle, color: T.text, background: T.surface }}>
            <option value="physical">Physical</option>
            <option value="service">Service</option>
            <option value="digital">Digital</option>
          </select>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>DESCRIPTION</div>
        <input value={form.desc} onChange={e => set("desc", e.target.value)}
          placeholder={vertical === "bill-pay" ? "Pay my electricity bill" : "What are you trading?"}
          style={inputStyle} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>AMOUNT (SATS)</div>
          <input type="number" value={form.sats} onChange={e => set("sats", e.target.value)} placeholder="100000" style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>FIAT</div>
          <div style={{ display: "flex", gap: 6 }}>
            <select value={form.cur} onChange={e => set("cur", e.target.value)}
              style={{ ...inputStyle, width: 70, padding: "12px 6px", fontSize: 12, color: T.text, background: T.surface }}>
              {["USD","EUR","GBP","NGN","KES","TZS","XOF","BRL"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" value={form.fiat} onChange={e => set("fiat", e.target.value)} placeholder="50" style={{ ...inputStyle, flex: 1 }} />
          </div>
        </div>
      </div>

      {/* Subscription toggle — invisible unless graduated (item 7).
          v0.2.0 universally false (no rating events yet). */}
      {canOfferSubscription && (
        <div style={{
          marginBottom: 20, padding: 16,
          background: form.isSubscription ? T.purpleDim : T.surface,
          border: `1px solid ${form.isSubscription ? T.purple + "33" : T.border}`,
          borderRadius: T.r, transition: "all 0.3s",
        }}>
          <div
            onClick={() => set("isSubscription", !form.isSubscription)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              cursor: "pointer",
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: form.isSubscription ? T.purple : T.muted, fontFamily: T.mono }}>
                🔄 SUBSCRIPTION MODE
              </div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
                Periodic release — lock upfront, release in installments
              </div>
            </div>
            <div style={{
              width: 40, height: 22, borderRadius: 11,
              background: form.isSubscription ? T.purple : T.border,
              padding: 2, transition: "background 0.2s", cursor: "pointer",
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: "50%",
                background: T.text, transition: "transform 0.2s",
                transform: form.isSubscription ? "translateX(18px)" : "translateX(0)",
              }} />
            </div>
          </div>

          {form.isSubscription && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>PERIODS</div>
                  <select value={form.periods} onChange={e => set("periods", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                    {[2,3,4,5,6,7,8,9,10,11,12,24,36,52].map(n => (
                      <option key={n} value={n}>{n} period{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono, marginBottom: 4 }}>INTERVAL</div>
                  <select value={form.intervalDays} onChange={e => set("intervalDays", e.target.value)}
                    style={{ ...inputStyle, fontSize: 12, color: T.text, background: T.surface }}>
                    <option value="7">Weekly</option>
                    <option value="14">Bi-weekly</option>
                    <option value="30">Monthly</option>
                    <option value="90">Quarterly</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onBack} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          ‹ Back
        </button>
        <button onClick={onNext} disabled={!ready} style={{
          flex: 2, padding: "14px",
          background: ready ? T.accent : T.surface,
          border: ready ? "none" : `1px solid ${T.border}`,
          borderRadius: T.rs,
          color: ready ? T.bg : T.muted,
          fontFamily: T.mono, fontSize: 14, fontWeight: 800,
          cursor: ready ? "pointer" : "default",
          letterSpacing: 0.5,
        }}>
          Review ›
        </button>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Step 3 — Review & publish
// ══════════════════════════════════════════════════════════════════════════

function Step3({
  vertical, form, setForm,
  homeCommunity,
  firstPublishDone,
  submitting,
  onBack, onPublish, onSaveDraft,
}: {
  vertical: Vertical;
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  homeCommunity: ReturnType<typeof getCommunityBySlug>;
  firstPublishDone: boolean;
  submitting: boolean;
  onBack: () => void;
  onPublish: () => void;
  onSaveDraft: () => void;
}) {
  const v = VERTICALS.find(vert => vert.id === vertical)!;
  const ready = form.desc.trim().length > 0 && form.sats.trim().length > 0;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  return (
    <>
      {/* Honesty info card — one-time-per-account, dismissed on first
          successful publish (handled by handlePublish above). Not
          dismissable inline; just disappears after the user has
          published once. */}
      {!firstPublishDone && (
        <div style={{
          marginBottom: 16, padding: 14,
          background: T.accentDim, border: `1px solid ${T.accent}33`,
          borderRadius: T.r,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            FIRST LISTING? HEADS UP
          </div>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            This listing will run on{" "}
            <strong>{homeCommunity?.displayName ?? "your community"}</strong>'s
            backing federation. Buyers on other federations will be auto-
            switched when they tap your listing — they don't move money via
            Lightning to switch, just spin up a fresh Chama on the right fed.
          </div>
        </div>
      )}

      {/* Editable bits — small subset for the review screen */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
          DESCRIPTION
        </div>
        <input value={form.desc} onChange={e => set("desc", e.target.value)}
          placeholder="What are you trading?"
          style={inputStyle} />
      </div>

      {/* Preview card */}
      <div style={{
        marginBottom: 20, padding: 16,
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 12,
        }}>
          PREVIEW
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 16 }}>{v.icon}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
            {v.label}
          </span>
          {homeCommunity && (
            <span style={{
              fontSize: 9, color: T.muted, fontFamily: T.mono,
              padding: "2px 6px", borderRadius: 8,
              background: T.surface, border: `1px solid ${T.border}`,
            }}>
              {homeCommunity.flagEmoji} {homeCommunity.displayName}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, marginBottom: 8 }}>
          {form.desc || <span style={{ color: T.muted, fontStyle: "italic" }}>(no description)</span>}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.accent, fontFamily: T.mono }}>
          {form.isSubscription
            ? `${parseInt(form.periods || "0") * parseInt(form.sats || "0")} sats total`
            : `${form.sats || 0} sats`}
          {form.fiat && (
            <span style={{ color: T.muted, marginLeft: 8, fontWeight: 400 }}>
              {form.cur} {form.fiat}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={onBack} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          ‹ Back
        </button>
        <button onClick={onSaveDraft} style={{
          flex: 1, padding: "14px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs,
          color: T.text, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
          cursor: "pointer",
        }}>
          Save draft
        </button>
        <button
          onClick={onPublish}
          disabled={!ready || submitting}
          style={{
            flex: 2, padding: "14px",
            background: ready && !submitting ? T.accent : T.surface,
            border: ready && !submitting ? "none" : `1px solid ${T.border}`,
            borderRadius: T.rs,
            color: ready && !submitting ? T.bg : T.muted,
            fontFamily: T.mono, fontSize: 14, fontWeight: 800,
            cursor: ready && !submitting ? "pointer" : "default",
            letterSpacing: 0.5,
          }}
        >
          {submitting ? "Publishing…" : "Publish to community"}
        </button>
      </div>
      <div style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: T.muted, fontFamily: T.mono }}>
        kind:38100 CREATE · NIP-44 encrypted · multi-relay
      </div>
    </>
  );
}
