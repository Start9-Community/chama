// ══════════════════════════════════════════════════════════════════════════
// Chama — AtomicFundingModal (v0.3.0 receive-side atomic flow)
// ══════════════════════════════════════════════════════════════════════════
//
// Listing-tap → exact-amount BOLT11 → ecash mints → LOCK fires, all in
// one user motion. Replaces the prior two-step "open FundWalletModal,
// generate invoice, pay, then tap Fund again to LOCK from balance" flow.
//
// Pillar 2.1 Option B: the user never sees an intermediate balance
// surface. The BOLT11 is the centerpiece of this modal — that IS the
// user's funding moment. Once payment lands and the federation credits,
// LOCK fires automatically and the modal auto-closes.
//
// Phase orchestration lives in src/payments/fund-and-lock.ts. This file
// is the React shell that renders phase transitions.

import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { T, inputStyle } from "../theme.js";
import { CopyButton } from "../components/CopyButton.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { isSimModeOn, setSimMode } from "../../sim/simMode.js";
import { makeLightningInvoiceQrPayload } from "../../payments/lightning-qr.js";
import { isNwcConnectionString } from "../../payments/nwc.js";
import {
  addOrTouchSavedNwcConnection,
  listSavedNwcConnections,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import type {
  FundAndLockPhase,
  FundAndLockTerminal,
} from "../../payments/fund-and-lock.js";
import {
  isChapsmartOnrampEnabled,
  isChapsmartOnrampContext,
  ensureChapsmartAccount,
  getBuyQuoteForSats,
  lookupMpesaTransaction,
  sendBuySats,
  normalizeMpesaConfirmationCode,
  chapsmartMpesaPaySteps,
  formatTzs,
  friendlyChapsmartError,
  ChapsmartApiError,
  CHAPSMART_MPESA_AGENT_NUMBER,
  type ChapsmartBuyQuote,
} from "../../payments/chapsmart-onramp.js";
import type { OnchainInfo } from "../../fedimint/fedimint-client.js";
import type { SelectedMenuItem } from "../../escrow-engine/types.js";

const QRCode = lazy(() => import("../QRCode.js"));

export interface AtomicFundingModalProps {
  /** Trade ID being funded. Passed through to fundAndLock. */
  escrowId: string;
  /** Exact trade amount in millisatoshis. */
  amountMsats: number;
  /** Category-aware label ("Fund Escrow", "Pay for Item", etc.). */
  ctaLabel: string;
  /** Optional handle to reveal in the LOCK payload. */
  savedHandleId?: string;
  /** Optional menu basket snapshot to attach to LOCK. */
  selectedItems?: SelectedMenuItem[];
  /** User's home community (e.g. "sn-cfa"). Trade-context metadata kept
   *  on the funding modal; the pre-LOCK external-swap CTA was removed in
   *  the 2026-06-24 fiat-ramps pass (all swaps are offramp-only, post-
   *  CLAIM), so these are presently informational only. */
  homeCommunity?: string | null;
  /** Active trade community (most specific context). */
  tradeCommunity?: string | null;
  /** Active trade fiat currency. */
  fiatCurrency?: string | null;
  /** Trade category ("marketplace" | "p2p-trade" | "bill-pay" | …). Gates
   *  the ChapSmart M-Pesa on-ramp: Exchange ("p2p-trade") is excluded —
   *  there the seller funds and Exchange IS the P2P on-ramp. */
  tradeCategory?: string | null;
  /** Bound to actions.fundAndLock from useEscrow. */
  fundAndLock: (
    escrowId: string,
    opts: {
      amountMsats: number;
      description: string;
      fundingMethod?: "lightning" | "onchain" | "nwc";
      nwcConnectionString?: string;
      rememberNwc?: boolean;
      savedHandleId?: string;
      selectedItems?: SelectedMenuItem[];
      onPhase: (phase: FundAndLockPhase) => void;
      signal?: AbortSignal;
    },
  ) => Promise<FundAndLockTerminal>;
  /** Reads federation wallet-module onchain fees before showing the slow path. */
  getOnchainInfo: () => Promise<OnchainInfo>;
  /** Bound to actions.lockAndPublish — used for the "Try LOCK now"
   *  retry path on mint-timeout (balance landed, but watchdog gave up
   *  on the mint settling within 60s). */
  lockAndPublish: (escrowId: string, opts: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
  }) => Promise<unknown>;
  /** Hide NWC in environments where funding must stay on an internal
   *  wallet route, e.g. Fedi Mini-App. */
  disableNwc?: boolean;
  /** Closed when the modal terminates (success or user cancel). The
   *  consumer can read the terminal kind to decide post-modal navigation
   *  (e.g. show success toast on locked, error toast on lock-failed). */
  onClose: (terminal: FundAndLockTerminal) => void;
}

type ModalPhase =
  | { kind: "choose-method" }
  | { kind: "creating-invoice" }
  | { kind: "creating-invoice-slow" }
  | { kind: "creating-onchain-address" }
  | {
      kind: "awaiting-onchain-confirmations";
      address: string;
      operationId: string;
      finalityDelay: number;
      pegInFeeSats: number;
      depositAmountSats: number;
      minimumDepositSats: number;
    }
  | { kind: "requesting-fedi-ecash" }
  | { kind: "fedi-ecash-created" }
  | { kind: "awaiting-payment"; bolt11: string; expiresAt: number }
  | { kind: "paying-with-nwc" }
  | { kind: "mint-confirming"; bolt11: string; expiresAt: number }
  | { kind: "mint-confirming-slow"; bolt11: string; expiresAt: number }
  | { kind: "receive-rejected"; reason: string }
  | { kind: "payment-confirmed" }
  | { kind: "locking" }
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "mint-timeout" }
  | { kind: "aborted" }
  | { kind: "lock-failed"; error: string };

export function AtomicFundingModal({
  escrowId,
  amountMsats,
  ctaLabel,
  savedHandleId,
  selectedItems,
  homeCommunity,
  tradeCommunity,
  fiatCurrency,
  tradeCategory,
  fundAndLock,
  getOnchainInfo,
  lockAndPublish,
  disableNwc = false,
  onClose,
}: AtomicFundingModalProps) {
  const amountSats = Math.floor(amountMsats / 1000);
  const [phase, setPhase] = useState<ModalPhase>({ kind: "choose-method" });
  const [fundingMethod, setFundingMethod] = useState<"lightning" | "onchain" | "nwc" | null>(null);
  const [savedNwcConnections, setSavedNwcConnections] = useState<SavedNwcConnection[]>(
    () => disableNwc ? [] : listSavedNwcConnections(),
  );
  const [nwcInput, setNwcInput] = useState("");
  const [rememberNwc, setRememberNwc] = useState(true);
  const [selectedNwcConnection, setSelectedNwcConnection] = useState<string | null>(null);
  const [onchainInfoState, setOnchainInfoState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; info: OnchainInfo }
    | { kind: "error"; error: string }
  >({ kind: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  const [tryLockBusy, setTryLockBusy] = useState(false);
  // ChapSmart M-Pesa on-ramp sub-flow (TZ only, non-Exchange, off in sim).
  // ChapSmart pays the SAME displayed BOLT11 — the receive-watcher and LOCK
  // flow underneath are untouched; this is purely an alternate payer UX.
  const [mpesaOpen, setMpesaOpen] = useState(false);
  const mpesaAvailable =
    isChapsmartOnrampEnabled() &&
    !isSimModeOn() &&
    isChapsmartOnrampContext({ homeCommunity, tradeCommunity, fiatCurrency, tradeCategory });
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setOnchainInfoState({ kind: "loading" });
    getOnchainInfo()
      .then((info) => {
        if (!cancelled) setOnchainInfoState({ kind: "ready", info });
      })
      .catch((e: any) => {
        if (!cancelled) {
          setOnchainInfoState({
            kind: "error",
            error: e?.message || "Onchain funding unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Read once per modal open. The funding action re-checks this before
    // allocating an address, so this surface is only the UX gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase-driven main loop. Re-runs when the user taps "Generate new
  // invoice" (retryToken increments). Aborts on unmount.
  useEffect(() => {
    if (!fundingMethod) return;
    settledRef.current = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let lastBolt11: string | null = null;
    let lastExpiresAt: number | null = null;

    const run = async () => {
      const terminal = await fundAndLock(escrowId, {
        amountMsats,
        description: `Chama trade · ${ctaLabel}`,
        fundingMethod,
        nwcConnectionString: selectedNwcConnection ?? undefined,
        rememberNwc,
        savedHandleId,
        selectedItems,
        signal: ctrl.signal,
        onPhase: (p) => {
          // v0.6.5: drop emits from an aborted run. React StrictMode
          // double-mounts effects in dev — first mount → cleanup
          // (ctrl.abort) → second mount → new run. Without this
          // guard, the FIRST run's late `aborted` emit (and any
          // other phase events it produces post-abort) leaks into
          // the modal's setPhase and silently flips state to
          // `aborted`, which has no render branch — modal goes
          // black. The fix scopes phase events to the live run
          // strictly via the closed-over ctrl.signal.
          if (ctrl.signal.aborted) return;
          if (p.kind === "invoice-created") {
            lastBolt11 = p.bolt11;
            lastExpiresAt = p.expiresAt;
            setPhase({
              kind: "awaiting-payment",
              bolt11: p.bolt11,
              expiresAt: p.expiresAt,
            });
            return;
          }
          if (p.kind === "creating-invoice") {
            setPhase({ kind: "creating-invoice" });
            return;
          }
          if (p.kind === "creating-invoice-slow") {
            // v0.6.5: flip to the honest "still trying, federation
            // is slow" surface. The orchestrator keeps racing the
            // createFundingInvoice call against the hard timeout
            // underneath; this just keeps the user informed.
            setPhase({ kind: "creating-invoice-slow" });
            return;
          }
          if (p.kind === "creating-onchain-address") {
            setPhase({ kind: "creating-onchain-address" });
            return;
          }
          if (p.kind === "onchain-address-created" || p.kind === "awaiting-onchain-confirmations") {
            setPhase({
              kind: "awaiting-onchain-confirmations",
              address: p.address,
              operationId: p.operationId,
              finalityDelay: p.finalityDelay,
              pegInFeeSats: p.pegInFeeSats,
              depositAmountSats: p.depositAmountSats,
              minimumDepositSats: p.minimumDepositSats,
            });
            return;
          }
          if (p.kind === "onchain-deposit-confirmed") {
            setPhase({ kind: "payment-confirmed" });
            return;
          }
          if (p.kind === "requesting-fedi-ecash" || p.kind === "fedi-ecash-created") {
            setPhase(p);
            return;
          }
          if (p.kind === "receive-watch-ready") {
            return;
          }
          if (p.kind === "awaiting-payment") {
            // pollForFunding emits this on entry; we need the BOLT11
            // already resolved from the prior "invoice-created" phase.
            if (lastBolt11 && lastExpiresAt) {
              setPhase({
                kind: "awaiting-payment",
                bolt11: lastBolt11,
                expiresAt: lastExpiresAt,
              });
            }
            return;
          }
          if (p.kind === "mint-confirming") {
            if (lastBolt11 && lastExpiresAt) {
              setPhase({
                kind: "mint-confirming",
                bolt11: lastBolt11,
                expiresAt: lastExpiresAt,
              });
            }
            return;
          }
          if (p.kind === "mint-confirming-slow") {
            // v0.5.1: federation has been crediting for a while without
            // finishing. Flip the UI to the explicit wait-vs-cancel
            // surface; the poll loop keeps running underneath.
            if (lastBolt11 && lastExpiresAt) {
              setPhase({
                kind: "mint-confirming-slow",
                bolt11: lastBolt11,
                expiresAt: lastExpiresAt,
              });
            }
            return;
          }
          if (p.kind === "receive-rejected") {
            setPhase({ kind: "receive-rejected", reason: p.reason });
            return;
          }
          // payment-confirmed / locking / locked / expired / mint-timeout
          // / aborted / lock-failed all map directly.
          setPhase(p as ModalPhase);
        },
      });
      // After loop terminates: if it's a TERMINAL state that should
      // dismiss the modal automatically (locked → success), do it after
      // a brief delay so the user sees the success state.
      if (settledRef.current) return; // Try-LOCK retry path took over
      if (terminal.kind === "locked") {
        if (fundingMethod === "nwc" && rememberNwc && selectedNwcConnection) {
          try {
            addOrTouchSavedNwcConnection(selectedNwcConnection);
            setSavedNwcConnections(listSavedNwcConnections());
          } catch {}
        }
        setTimeout(() => onClose(terminal), 1200);
      } else if (terminal.kind === "aborted") {
        // No callback — user already triggered close.
      }
      // expired / mint-timeout / lock-failed leave the modal open with
      // a retry/cancel surface; user dismisses explicitly.
    };

    run().catch((e) => {
      // runFundAndLock catches its own errors; this is defensive.
      setPhase({ kind: "lock-failed", error: (e as Error).message || "Unexpected error" });
    });

    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken, fundingMethod]);

  // 1Hz tick for the countdown timer when an invoice is live.
  useEffect(() => {
    if (
      phase.kind !== "awaiting-payment" &&
      phase.kind !== "mint-confirming" &&
      phase.kind !== "mint-confirming-slow"
    ) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase.kind]);

  const handleCancel = () => {
    abortRef.current?.abort();
    settledRef.current = true;
    onClose({ kind: "aborted" });
  };

  const handleRegenerate = () => {
    setFundingMethod(null);
    setSelectedNwcConnection(null);
    setPhase({ kind: "choose-method" });
    setRetryToken((t) => t + 1);
  };

  const handleSelectMethod = (method: "lightning" | "onchain") => {
    if (method === "onchain" && onchainInfoState.kind !== "ready") return;
    if (method === "onchain" && onchainInfoState.kind === "ready") {
      const minimumDepositSats = Math.max(
        1,
        Math.trunc(onchainInfoState.info.minimumDepositSats || onchainInfoState.info.pegInFeeSats + 1),
      );
      if (amountSats < minimumDepositSats) return;
    }
    setFundingMethod(method);
    setPhase(
      method === "lightning"
        ? { kind: "creating-invoice" }
        : { kind: "creating-onchain-address" },
    );
  };

  const handleSelectNwc = (connectionString: string, remember: boolean) => {
    if (!isNwcConnectionString(connectionString)) return;
    setSelectedNwcConnection(connectionString.trim());
    setRememberNwc(remember);
    setFundingMethod("nwc");
    setPhase({ kind: "creating-invoice" });
  };

  const handleTryLockNow = async () => {
    settledRef.current = true;
    abortRef.current?.abort();
    setTryLockBusy(true);
    try {
      await lockAndPublish(escrowId, { savedHandleId, selectedItems });
      setPhase({ kind: "locked" });
      setTimeout(() => onClose({ kind: "locked" }), 1200);
    } catch (e: any) {
      setPhase({ kind: "lock-failed", error: e?.message || "LOCK failed" });
    } finally {
      setTryLockBusy(false);
    }
  };


  return (
    <div onClick={handleCancel} style={{
      // v0.6.5: 0xee alpha (≈93%) instead of 0xcc (80%). On first-fire
      // the modal can sit on the CreatingInvoice spinner for a few
      // seconds while the WASM client and federation warm up; with
      // the looser backdrop the TradeDetail page behind it (including
      // the Fund button's transient "Funding…" label) was visually
      // bleeding through and reading like a glitch.
      position: "fixed", inset: 0, background: "#000e", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16, animation: "fadeIn 0.2s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
        padding: 24, maxWidth: 420, width: "100%",
      }}>
        {/* Header — amount is the eyebrow, label is the title */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
              {ctaLabel.toUpperCase()}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
              <BitcoinAmount sats={amountSats} size={22} gap={6} glyphScale={1.2} color={T.text} glyphColor={T.muted} />
            </div>
          </div>
          <button onClick={handleCancel} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        {phase.kind === "choose-method" && (
          <FundingMethodChooser
            amountSats={amountSats}
            onchainInfoState={onchainInfoState}
            onSelect={handleSelectMethod}
            savedNwcConnections={disableNwc ? [] : savedNwcConnections}
            nwcInput={nwcInput}
            rememberNwc={rememberNwc}
            onNwcInputChange={setNwcInput}
            onRememberNwcChange={setRememberNwc}
            onSelectNwc={handleSelectNwc}
            disableNwc={disableNwc}
          />
        )}

        {phase.kind === "creating-invoice" && <CreatingInvoice slow={false} />}

        {phase.kind === "creating-invoice-slow" && (
          <CreatingInvoice slow={true} onCancel={handleCancel} />
        )}

        {phase.kind === "requesting-fedi-ecash" && (
          <RequestingFediEcash amountSats={amountSats} onCancel={handleCancel} />
        )}

        {phase.kind === "creating-onchain-address" && <CreatingOnchainAddress />}

        {phase.kind === "awaiting-onchain-confirmations" && (
          <OnchainAddressDisplay
            address={phase.address}
            amountSats={amountSats}
            depositAmountSats={phase.depositAmountSats}
            pegInFeeSats={phase.pegInFeeSats}
            finalityDelay={phase.finalityDelay}
          />
        )}

        {phase.kind === "fedi-ecash-created" && <PaymentConfirmed amountSats={amountSats} />}

        {phase.kind === "paying-with-nwc" && <PayingWithNwc amountSats={amountSats} />}

        {(phase.kind === "awaiting-payment" || phase.kind === "mint-confirming") && (
          mpesaOpen && phase.kind === "awaiting-payment" ? (
            <ChapsmartMpesaPanel
              amountSats={amountSats}
              bolt11={phase.bolt11}
              expiresAt={phase.expiresAt}
              now={now}
              onBack={() => setMpesaOpen(false)}
            />
          ) : (
            <InvoiceDisplay
              bolt11={phase.bolt11}
              expiresAt={phase.expiresAt}
              now={now}
              phaseKind={phase.kind}
              onFundWithMpesa={
                mpesaAvailable && phase.kind === "awaiting-payment"
                  ? () => setMpesaOpen(true)
                  : undefined
              }
            />
          )
        )}

        {phase.kind === "mint-confirming-slow" && (
          <MintConfirmingSlowState
            amountSats={amountSats}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "receive-rejected" && (
          <ReceiveRejectedState
            amountSats={amountSats}
            reason={phase.reason}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "payment-confirmed" && <PaymentConfirmed amountSats={amountSats} />}

        {phase.kind === "locking" && <Locking />}

        {phase.kind === "locked" && <LockedSuccess amountSats={amountSats} />}

        {phase.kind === "expired" && (
          <ExpiredState
            onRegenerate={handleRegenerate}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "mint-timeout" && (
          <MintTimeoutState
            busy={tryLockBusy}
            onTryLockNow={handleTryLockNow}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === "lock-failed" && (
          <LockFailedState
            error={phase.error}
            onCancel={() => onClose(phase)}
          />
        )}

        {/* v0.6.5: explicit no-op for the `aborted` phase. Pre-this-fix
            phase=aborted had no render branch, so any stray aborted
            event from a torn-down StrictMode first-mount left the modal
            stuck with header + empty body. The closure-scoped emit
            guard above is the real fix; this branch is defense in
            depth so a future emit path can't black-hole the modal
            silently. Renders an explicit "Cancelled" surface so the
            state is at least visible and the user knows to tap × to
            close — though in practice the parent onClose dismissal
            should mean we never paint this. */}
        {phase.kind === "aborted" && (
          <div style={{
            padding: "24px 16px", textAlign: "center",
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.r,
          }}>
            <div style={{
              fontSize: 12, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1,
            }}>
              CANCELLED
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function FundingMethodChooser({
  amountSats,
  onchainInfoState,
  onSelect,
  savedNwcConnections,
  nwcInput,
  rememberNwc,
  onNwcInputChange,
  onRememberNwcChange,
  onSelectNwc,
  disableNwc,
}: {
  amountSats: number;
  onchainInfoState:
    | { kind: "loading" }
    | { kind: "ready"; info: OnchainInfo }
    | { kind: "error"; error: string };
  onSelect: (method: "lightning" | "onchain") => void;
  savedNwcConnections: SavedNwcConnection[];
  nwcInput: string;
  rememberNwc: boolean;
  onNwcInputChange: (value: string) => void;
  onRememberNwcChange: (value: boolean) => void;
  onSelectNwc: (connectionString: string, remember: boolean) => void;
  disableNwc?: boolean;
}) {
  const onchainGate = (() => {
    if (onchainInfoState.kind === "loading") {
      return {
        disabled: true,
        detail: "Checking federation onchain fee...",
        pegInFeeSats: undefined,
        depositAmountSats: undefined,
      };
    }
    if (onchainInfoState.kind === "error") {
      return {
        disabled: true,
        detail: "Onchain unavailable until federation fees load.",
        pegInFeeSats: undefined,
        depositAmountSats: undefined,
      };
    }

    const pegInFeeSats = Math.max(0, Math.trunc(onchainInfoState.info.pegInFeeSats));
    const minimumDepositSats = Math.max(
      1,
      Math.trunc(onchainInfoState.info.minimumDepositSats || pegInFeeSats + 1),
    );
    if (amountSats < minimumDepositSats) {
      return {
        disabled: true,
        detail: <>Minimum <BitcoinAmount sats={minimumDepositSats} size={10} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />. Use LN for this trade.</>,
        pegInFeeSats,
        depositAmountSats: undefined,
      };
    }
    return {
      disabled: false,
      detail: <>Send <BitcoinAmount sats={amountSats + pegInFeeSats} size={10} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> total; wallet adds miner fee.</>,
      pegInFeeSats,
      depositAmountSats: amountSats + pegInFeeSats,
    };
  })();
  const nwcReady = isNwcConnectionString(nwcInput);

  if (disableNwc) {
    return (
      <div>
        <div style={{
          marginBottom: 12, padding: 14, borderRadius: T.r,
          background: T.tealDim, border: `1px solid ${T.teal}66`,
        }}>
          <div style={{
            fontSize: 9, color: T.teal, fontFamily: T.mono,
            letterSpacing: 1, fontWeight: 900, marginBottom: 8,
          }}>
            FEDI WALLET FUNDING
          </div>
          <div style={{
            fontSize: 11, color: T.text, fontFamily: T.mono,
            lineHeight: 1.55,
          }}>
            Chama asks Fedi for ecash and locks the trade directly. No
            Lightning receive invoice or NWC wallet is used here.
          </div>
        </div>

        <div style={{
          marginBottom: 12, padding: "8px 10px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          lineHeight: 1.45, textAlign: "center",
        }}>
          Trade amount: <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />
        </div>

        <button
          onClick={() => onSelect("lightning")}
          style={{
            width: "100%", minHeight: 64, padding: "14px 16px",
            borderRadius: T.r, background: T.accent,
            border: `1px solid ${T.accent}`, color: "#000",
            cursor: "pointer", fontFamily: T.mono, fontSize: 13,
            fontWeight: 900, letterSpacing: 0.5,
          }}
        >
          Use Fedi wallet · <BitcoinAmount sats={amountSats} size={13} gap={4} glyphScale={1.18} color="#000" glyphColor="#000" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.5, marginBottom: 12,
      }}>
        Choose how the external wallet funds this trade. Chama locks the
        credited ecash into SSS automatically after funding lands.
      </div>

      {/* The 2026-06-24 fiat-ramps pass removed the pre-LOCK external-swap
          CTA: nobody onramps in-app, so funding surfaces no provider.
          External swaps are offramp-only and live post-CLAIM in
          ClaimPayoutModal. */}

      {/* v1.2.4: saved NWC connections promoted out of the "More
          options" disclosure to top-level quick-pick buttons. The
          paste-new-NWC textarea stays behind the disclosure since
          it's a rare-path setup step; returning users with a known
          wallet should fund a trade in one tap. */}
      {!disableNwc && savedNwcConnections.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 6, fontWeight: 800,
          }}>
            ⚡ FASTEST · AUTO-PAY FROM SAVED NWC WALLET
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {savedNwcConnections.map((connection) => (
              <button
                key={connection.id}
                onClick={() => onSelectNwc(connection.connectionString, true)}
                style={{
                  width: "100%", padding: "12px 14px", borderRadius: T.r,
                  background: T.accentDim, border: `1px solid ${T.accent}66`,
                  color: T.text, fontFamily: T.mono, fontSize: 12,
                  cursor: "pointer", display: "flex",
                  justifyContent: "space-between", alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{
                  overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", fontWeight: 600,
                }}>
                  {connection.label}
                </span>
                <span style={{
                  color: T.accent, flexShrink: 0, fontSize: 9,
                  fontWeight: 800, letterSpacing: 1,
                }}>
                  AUTO-PAY →
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <button
          onClick={() => onSelect("lightning")}
          style={{
            minHeight: 118, padding: 12, borderRadius: T.r,
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.text, cursor: "pointer", textAlign: "left",
          }}
        >
          <div style={{ fontSize: 20, marginBottom: 8 }}>⚡</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: T.accent, fontFamily: T.mono, marginBottom: 6 }}>
            LN · FAST
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
            Best for almost everyone. Usually settles in seconds.
          </div>
        </button>
        <button
          onClick={() => onSelect("onchain")}
          disabled={onchainGate.disabled}
          style={{
            minHeight: 118, padding: 12, borderRadius: T.r,
            background: T.amberDim, border: `1px solid ${T.amber}66`,
            color: T.text,
            cursor: onchainGate.disabled ? "not-allowed" : "pointer",
            opacity: onchainGate.disabled ? 0.55 : 1,
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 20, marginBottom: 8 }}>₿</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: T.amber, fontFamily: T.mono, marginBottom: 6 }}>
            ONCHAIN · SLOW
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.45 }}>
            {onchainGate.detail}
          </div>
          {typeof onchainGate.pegInFeeSats === "number" && (
            <div style={{
              marginTop: 8, fontSize: 9, color: T.amber,
              fontFamily: T.mono, lineHeight: 1.35,
            }}>
              Federation deposit fee: <BitcoinAmount sats={onchainGate.pegInFeeSats} size={9} gap={3} glyphScale={1.18} color={T.amber} glyphColor={T.amber} />
            </div>
          )}
        </button>
      </div>
      <div style={{
        marginTop: 12, padding: "8px 10px", borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.45, textAlign: "center",
      }}>
        Trade amount: <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />
      </div>

      {!disableNwc && (
      <details style={{ marginTop: 12 }}>
        <summary style={{
          color: T.muted, fontFamily: T.mono, fontSize: 10,
          cursor: "pointer", listStyle: "none",
        }}>
          {savedNwcConnections.length > 0
            ? "Add another NWC wallet"
            : "More options · NWC auto-pay"}
        </summary>
        <div style={{
          marginTop: 10, padding: 12, borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
        }}>
          {/* v1.2.4: saved-wallet list moved up to top-level. This
              disclosure is now only for the paste-new-NWC setup
              path, which is uncommon enough to keep collapsed. */}
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 6,
          }}>
            PASTE NWC CONNECTION
          </div>
          <textarea
            value={nwcInput}
            onChange={(e) => onNwcInputChange(e.target.value)}
            placeholder="nostr+walletconnect://..."
            rows={3}
            style={{ ...inputStyle, resize: "vertical" as const, minHeight: 60, marginBottom: 8 }}
          />
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            marginBottom: 10, color: T.muted, fontFamily: T.mono,
            fontSize: 10, cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={rememberNwc}
              onChange={(e) => onRememberNwcChange(e.target.checked)}
            />
            Remember this NWC wallet
          </label>
          <button
            disabled={!nwcReady}
            onClick={() => onSelectNwc(nwcInput, rememberNwc)}
            style={{
              width: "100%", padding: "11px 12px", borderRadius: T.rs,
              background: nwcReady ? T.accent : T.card,
              border: `1px solid ${nwcReady ? T.accent : T.border}`,
              color: nwcReady ? "#000" : T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: nwcReady ? "pointer" : "not-allowed",
            }}
          >
            Auto-pay with NWC
          </button>
        </div>
      </details>
      )}
    </div>
  );
}

function CreatingOnchainAddress() {
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.amberDim,
      border: `1px solid ${T.amber}44`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${T.amber}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{
        fontSize: 12, fontWeight: 700, color: T.amber,
        fontFamily: T.mono, letterSpacing: 0,
      }}>
        CREATING ONCHAIN ADDRESS…
      </div>
    </div>
  );
}

function makeBitcoinUri(address: string, amountSats: number): string {
  const btcAmount = (amountSats / 100_000_000)
    .toFixed(8)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return btcAmount ? `bitcoin:${address}?amount=${btcAmount}` : `bitcoin:${address}`;
}

function formatBtcDecimal(sats: number): string {
  return `${(sats / 100_000_000).toFixed(8)} BTC`;
}

function OnchainAddressDisplay({
  address,
  amountSats,
  depositAmountSats,
  pegInFeeSats,
  finalityDelay,
}: {
  address: string;
  amountSats: number;
  depositAmountSats: number;
  pegInFeeSats: number;
  finalityDelay: number;
}) {
  const [amountUnit, setAmountUnit] = useState<"btc" | "sats">("btc");
  const qrPayload = makeBitcoinUri(address, depositAmountSats);
  const totalPrimary = amountUnit === "btc"
    ? formatBtcDecimal(depositAmountSats)
    : `${depositAmountSats.toLocaleString()} sats`;
  const totalSecondary = amountUnit === "btc"
    ? `${depositAmountSats.toLocaleString()} sats`
    : formatBtcDecimal(depositAmountSats);
  return (
    <>
      <div style={{
        fontSize: 9, color: T.amber, fontFamily: T.mono,
        letterSpacing: 0, marginBottom: 8, textAlign: "center",
      }}>
        ONCHAIN FUNDING · SLOW PATH
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <Suspense fallback={<div style={{ width: 280, height: 280, background: "#fff", borderRadius: T.rs }} />}>
          <QRCode
            data={qrPayload}
            size={280}
            fgColor="#050505"
            bgColor="#ffffff"
            margin={4}
            alt="Bitcoin onchain address QR code"
          />
        </Suspense>
      </div>
      <div style={{
        padding: 12, marginBottom: 12, borderRadius: T.rs,
        background: T.amberDim, border: `1px solid ${T.amber}55`,
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 10, marginBottom: 8,
        }}>
          <div style={{
            fontSize: 9, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, fontWeight: 800,
          }}>
            QR INCLUDES FULL TOTAL
          </div>
          <div style={{
            display: "inline-flex", padding: 2, borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            flexShrink: 0,
          }}>
            {(["btc", "sats"] as const).map((unit) => (
              <button
                key={unit}
                onClick={() => setAmountUnit(unit)}
                style={{
                  padding: "4px 8px", borderRadius: Math.max(4, T.rs - 2),
                  background: amountUnit === unit ? T.amber : "transparent",
                  border: "none",
                  color: amountUnit === unit ? "#000" : T.muted,
                  fontFamily: T.mono, fontSize: 9, fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                {unit === "btc" ? "BTC" : "sats"}
              </button>
            ))}
          </div>
        </div>
        <div style={{
          color: T.text, fontFamily: T.mono, fontSize: 20,
          fontWeight: 900, lineHeight: 1.1, marginBottom: 4,
          overflowWrap: "anywhere",
        }}>
          {totalPrimary}
        </div>
        <div style={{
          color: T.muted, fontFamily: T.mono, fontSize: 10,
          lineHeight: 1.45,
        }}>
          {totalSecondary} · trade {amountSats.toLocaleString()} sats + federation fee {pegInFeeSats.toLocaleString()} sats
        </div>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs,
        background: T.amberDim,
        border: `1px solid ${T.amber}44`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: T.amber,
          animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.amber, letterSpacing: 0 }}>
          Waiting for {finalityDelay} confirmations before LOCK
        </span>
      </div>
      <div style={{
        padding: 8, marginBottom: 12, borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
        fontFamily: T.mono, fontSize: 9, color: T.muted,
        wordBreak: "break-all", maxHeight: 72, overflowY: "auto", textAlign: "center",
      }}>
        {address}
      </div>
      <div style={{
        padding: "8px 10px", marginBottom: 12, borderRadius: T.rs,
        background: T.amberDim, border: `1px solid ${T.amber}44`,
        fontFamily: T.mono, fontSize: 10, color: T.amber,
        lineHeight: 1.45, textAlign: "center",
      }}>
        Scan this QR or send <BitcoinAmount sats={depositAmountSats} size={10} gap={4} glyphScale={1.18} color={T.amber} glyphColor={T.amber} /> total:{" "}
        <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.amber} glyphColor={T.amber} /> trade +{" "}
        <BitcoinAmount sats={pegInFeeSats} size={10} gap={4} glyphScale={1.18} color={T.amber} glyphColor={T.amber} /> federation deposit fee.
        Your wallet shows and pays the Bitcoin miner fee separately.
      </div>
      <CopyButton
        value={address}
        label="Copy address"
        copiedLabel="✓ Copied"
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      />
    </>
  );
}

function RequestingFediEcash({
  amountSats,
  onCancel,
}: {
  amountSats: number;
  onCancel: () => void;
}) {
  return (
    <div style={{
      padding: "24px 16px", textAlign: "center",
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${T.accent}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{
        fontSize: 12, fontWeight: 700, color: T.accent,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        REQUESTING FEDI ECASH…
      </div>
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.5, marginBottom: 12,
      }}>
        Approve <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> in Fedi. Chama will
        lock the ecash notes directly, without a Lightning receive QR.
      </div>
      <button
        onClick={onCancel}
        style={{
          padding: "8px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10,
          fontWeight: 700, cursor: "pointer", letterSpacing: 0.3,
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function CreatingInvoice({
  slow,
  onCancel,
}: {
  slow: boolean;
  onCancel?: () => void;
}) {
  // v0.6.5: pre-this-fix the tiny 8x8 dot + 9px text was hard to spot
  // at all, and at the modal scale read as "empty modal." Bumped to a
  // visible spinner + larger label so users know we're actively
  // working. The `slow` variant fires at DEFAULT_INVOICE_SLOW_WARN_MS
  // (10s) and surfaces an honest "federation is slow" message plus a
  // cancel affordance — the hard 45s timeout still fires underneath
  // and will flip to lock-failed if nothing comes back.
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: slow ? T.amberDim : T.surface,
      border: `1px solid ${slow ? T.amber + "44" : T.border}`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${slow ? T.amber : T.accent}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{
        fontSize: 12, fontWeight: 700,
        color: slow ? T.amber : T.accent,
        fontFamily: T.mono, letterSpacing: 1,
        marginBottom: slow ? 8 : 0,
      }}>
        {slow ? "FEDERATION IS SLOW…" : "GENERATING INVOICE…"}
      </div>
      {slow && (
        <>
          <div style={{
            fontSize: 11, color: T.text, fontFamily: T.sans,
            lineHeight: 1.5, marginTop: 6, marginBottom: 12,
          }}>
            Still trying to reach your federation's Lightning gateway.
            We'll keep at it for a few more seconds.
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              style={{
                padding: "8px 16px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 10,
                fontWeight: 700, cursor: "pointer", letterSpacing: 0.3,
              }}
            >
              Cancel
            </button>
          )}
        </>
      )}
    </div>
  );
}

function PayingWithNwc({ amountSats }: { amountSats: number }) {
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: T.r,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `3px solid ${T.accent}`,
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        margin: "0 auto 14px",
      }} />
      <div style={{
        fontSize: 12, fontWeight: 800, color: T.accent,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        REQUESTING NWC PAYMENT…
      </div>
      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        lineHeight: 1.5,
      }}>
        Asking your wallet to pay <BitcoinAmount sats={amountSats} size={10} gap={4} glyphScale={1.18} color={T.muted} glyphColor={T.muted} />.
        Your NWC budget and wallet approval rules still apply.
      </div>
    </div>
  );
}

function InvoiceDisplay({
  bolt11, expiresAt, now, phaseKind, onFundWithMpesa,
}: {
  bolt11: string;
  expiresAt: number;
  now: number;
  phaseKind: "awaiting-payment" | "mint-confirming";
  /** Present only when the ChapSmart M-Pesa on-ramp applies (TZ context,
   *  non-Exchange, enabled, not sim). Opens the pay-with-M-Pesa sub-flow. */
  onFundWithMpesa?: () => void;
}) {
  const remainingSec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const isMintConfirming = phaseKind === "mint-confirming";
  const qrPayload = makeLightningInvoiceQrPayload(bolt11);

  return (
    <>
      <div style={{
        fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1,
        marginBottom: 8, textAlign: "center",
      }}>
        {isMintConfirming ? "PAYMENT DETECTED · CREDITING…" : "SCAN OR COPY TO PAY"}
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <Suspense fallback={<div style={{ width: 280, height: 280, background: "#fff", borderRadius: T.rs }} />}>
          <QRCode
            data={qrPayload}
            size={280}
            fgColor="#050505"
            bgColor="#ffffff"
            margin={4}
            alt="Lightning invoice QR code"
          />
        </Suspense>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs,
        background: isMintConfirming ? T.amberDim : T.surface,
        border: `1px solid ${isMintConfirming ? T.amber + "44" : T.border}`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: isMintConfirming ? T.amber : T.accent,
          animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{
          fontSize: 10, fontFamily: T.mono,
          color: isMintConfirming ? T.amber : T.muted, letterSpacing: 0.5,
        }}>
          {isMintConfirming
            ? "Confirming with the federation…"
            : `Waiting for payment · ${mins}:${secs.toString().padStart(2, "0")}`}
        </span>
      </div>
      <div style={{
        padding: 8, marginBottom: 12, borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`,
        fontFamily: T.mono, fontSize: 8, color: T.muted,
        wordBreak: "break-all", maxHeight: 60, overflowY: "auto", textAlign: "center",
      }}>{bolt11}</div>
      {/* v0.4.2 sim mode hotfix round 3: honest auto-credit disclosure.
          This is the atomic-funding modal — the centerpiece of every
          listing-tap flow — so the notice is required here, not just
          on the manual-fund surface. Conditional ONLY on isSimModeOn();
          no other state gates the disclosure. Amber matches the
          SIM MODE pill warning palette (Pillar 2.7). */}
      {isSimModeOn() && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          fontFamily: T.mono, fontSize: 10, color: T.amber,
          lineHeight: 1.5, textAlign: "center",
        }}>
          ▲ Sim mode — auto-credits in 3-8s.<br />
          Do not fund this invoice with real sats.
        </div>
      )}
      <CopyButton
        value={bolt11}
        label="Copy invoice"
        copiedLabel="✓ Copied"
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.accentDim, border: `1px solid ${T.accent}44`,
          color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      />
      {onFundWithMpesa && (
        <button
          onClick={onFundWithMpesa}
          style={{
            width: "100%", marginTop: 8, padding: "10px 16px",
            borderRadius: T.rs, background: T.tealDim,
            border: `1px solid ${T.teal}66`, color: T.teal,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          🇹🇿 No sats? Fund with M-Pesa →
        </button>
      )}
    </>
  );
}

// ── ChapSmart M-Pesa on-ramp sub-flow ────────────────────────────────────
//
// ChapSmart pays the SAME funding BOLT11 the QR shows, in exchange for a
// TZS M-Pesa agent payment. Flow: exact-sats quote → the user pays the
// quoted TZS via the Kutoa-Pesa agent flow → pastes the SMS confirmation
// code → ChapSmart verifies + pays the invoice → the modal's existing
// receive-watcher detects the payment and the LOCK fires. Nothing below
// touches the escrow money-path.

type MpesaPanelState =
  | { kind: "quoting" }
  | { kind: "ready"; quote: ChapsmartBuyQuote; busy: boolean; inlineError: string | null }
  | { kind: "sent" }
  | { kind: "failed"; message: string; quoteExpired: boolean };

function ChapsmartMpesaPanel({
  amountSats, bolt11, expiresAt, now, onBack,
}: {
  amountSats: number;
  bolt11: string;
  expiresAt: number;
  now: number;
  onBack: () => void;
}) {
  const [state, setState] = useState<MpesaPanelState>({ kind: "quoting" });
  const [codeInput, setCodeInput] = useState("");
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const remainingSec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;

  const loadQuote = async () => {
    setState({ kind: "quoting" });
    try {
      const accountNumber = await ensureChapsmartAccount();
      const quote = await getBuyQuoteForSats({ targetSats: amountSats, accountNumber });
      if (aliveRef.current) setState({ kind: "ready", quote, busy: false, inlineError: null });
    } catch (e) {
      if (aliveRef.current) {
        setState({
          kind: "failed",
          message: friendlyChapsmartError(e),
          quoteExpired: e instanceof ChapsmartApiError && e.status === 410,
        });
      }
    }
  };
  useEffect(() => {
    void loadQuote();
    // Quote once per panel open; explicit retry buttons re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    if (state.kind !== "ready" || state.busy) return;
    const quote = state.quote;
    const mpesaId = normalizeMpesaConfirmationCode(codeInput);
    if (!mpesaId) {
      setState({ ...state, inlineError: "That doesn't look like an M-Pesa confirmation code — copy it from the SMS." });
      return;
    }
    setState({ ...state, busy: true, inlineError: null });
    try {
      // Pre-validate via the read-only lookup — friendlier than a 409.
      // FAIL-SOFT on lookup errors (e.g. proxy route missing → 404):
      // send-sats is the authoritative validator either way.
      try {
        const seen = await lookupMpesaTransaction(mpesaId);
        if (!seen.found) {
          if (aliveRef.current) {
            setState({ ...state, busy: false, inlineError:
              "ChapSmart hasn't seen that payment yet. Wait for the M-Pesa SMS, then check the code and try again." });
          }
          return;
        }
        if (typeof seen.amount === "number" && Math.round(seen.amount) !== Math.round(quote.amountTZS)) {
          if (aliveRef.current) {
            setState({ ...state, busy: false, inlineError:
              `That payment was TZS ${formatTzs(seen.amount)} but the quote needs exactly TZS ${formatTzs(quote.amountTZS)}.` });
          }
          return;
        }
      } catch { /* lookup unavailable — let send-sats decide */ }
      await sendBuySats({ quoteId: quote.quoteId, bolt11, mpesaId });
      if (aliveRef.current) setState({ kind: "sent" });
    } catch (e) {
      if (aliveRef.current) {
        if (e instanceof ChapsmartApiError && e.status === 410) {
          setState({ kind: "failed", message: friendlyChapsmartError(e), quoteExpired: true });
        } else {
          setState({ ...state, busy: false, inlineError: friendlyChapsmartError(e) });
        }
      }
    }
  };

  if (state.kind === "quoting") {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>🇹🇿</div>
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5 }}>
          Getting the M-Pesa price from ChapSmart…
        </div>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div>
        <div style={{
          padding: "16px 14px", marginBottom: 12, borderRadius: T.r,
          background: T.amberDim, border: `1px solid ${T.amber}66`,
          fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.55,
        }}>
          {state.message}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button onClick={onBack} style={{
            padding: "10px 16px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}>
            ← Back to invoice
          </button>
          <button onClick={() => void loadQuote()} style={{
            padding: "10px 16px", borderRadius: T.rs,
            background: T.tealDim, border: `1px solid ${T.teal}66`,
            color: T.teal, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer",
          }}>
            {state.quoteExpired ? "Get new quote" : "Try again"}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "sent") {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>⚡</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.teal, fontFamily: T.sans, marginBottom: 6 }}>
          ChapSmart is paying the invoice
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.55 }}>
          Your M-Pesa payment was accepted. The sats arrive in your own
          wallet and the trade locks automatically — this screen updates
          the moment the payment lands.
        </div>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 8, marginTop: 14, padding: "6px 12px", borderRadius: T.rs,
          background: T.tealDim, border: `1px solid ${T.teal}44`,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: T.teal, animation: "pulse 1.4s ease-in-out infinite",
          }} />
          <span style={{ fontSize: 10, fontFamily: T.mono, color: T.teal, letterSpacing: 0.5 }}>
            Waiting for the payment…
          </span>
        </div>
      </div>
    );
  }

  // ready
  const { quote, busy, inlineError } = state;
  const steps = chapsmartMpesaPaySteps(quote.amountTZS);
  return (
    <div>
      <div style={{
        padding: "12px 14px", marginBottom: 10, borderRadius: T.r,
        background: T.tealDim, border: `1px solid ${T.teal}66`, textAlign: "center",
      }}>
        <div style={{ fontSize: 9, color: T.teal, fontFamily: T.mono, letterSpacing: 1, fontWeight: 900, marginBottom: 4 }}>
          PAY EXACTLY
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
          TZS {formatTzs(quote.amountTZS)}
        </div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
          for <BitcoinAmount sats={amountSats} size={9} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> · a different amount will be rejected
        </div>
      </div>

      <ol style={{ margin: "0 0 10px", padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
        {steps.map((step, i) => (
          <li key={i} style={{
            display: "flex", gap: 8, alignItems: "baseline",
            fontSize: 10.5, fontFamily: T.mono, color: T.text, lineHeight: 1.45,
          }}>
            <span style={{ color: T.teal, fontWeight: 800, flexShrink: 0 }}>{i + 1}.</span>
            <span>
              {step.sw}
              <span style={{ color: T.muted }}> · {step.en}</span>
            </span>
          </li>
        ))}
      </ol>

      <CopyButton
        value={CHAPSMART_MPESA_AGENT_NUMBER}
        label={`Copy agent number · ${CHAPSMART_MPESA_AGENT_NUMBER}`}
        copiedLabel="✓ Copied"
        style={{
          width: "100%", marginBottom: 10, padding: "8px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.mono, fontSize: 10.5, fontWeight: 700,
          cursor: "pointer",
        }}
      />

      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 6, lineHeight: 1.5 }}>
        After you confirm, M-Pesa sends an SMS with a confirmation code —
        paste it here:
      </div>
      <input
        value={codeInput}
        onChange={(e) => setCodeInput(e.target.value)}
        placeholder="e.g. XKR4MPT9QZN"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        style={{ ...inputStyle, marginBottom: 8, textTransform: "uppercase" }}
      />

      {inlineError && (
        <div style={{
          padding: "8px 12px", marginBottom: 8, borderRadius: T.rs,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          fontSize: 10, color: T.amber, fontFamily: T.mono, lineHeight: 1.5,
        }}>
          {inlineError}
        </div>
      )}

      <button
        onClick={() => void handleSubmit()}
        disabled={busy || !normalizeMpesaConfirmationCode(codeInput)}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: T.teal, border: `1px solid ${T.teal}`,
          color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 900,
          cursor: busy ? "wait" : "pointer",
          opacity: busy || !normalizeMpesaConfirmationCode(codeInput) ? 0.55 : 1,
        }}
      >
        {busy ? "Verifying with ChapSmart…" : "I paid — send the sats"}
      </button>

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 10,
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", color: T.muted,
          fontFamily: T.mono, fontSize: 10, cursor: "pointer", padding: 0,
        }}>
          ← Pay with Lightning instead
        </button>
        <span style={{ fontSize: 9, color: remainingSec < 300 ? T.amber : T.muted, fontFamily: T.mono }}>
          invoice expires {mins}:{secs.toString().padStart(2, "0")}
        </span>
      </div>
    </div>
  );
}

function MintConfirmingSlowState({
  amountSats, onCancel,
}: { amountSats: number; onCancel: () => void }) {
  // v0.5.1: the federation has acknowledged the inbound payment but
  // hasn't finished crediting our wallet within mintSlowWarnMs (60s by
  // default). We flip from the optimistic "crediting…" surface to this
  // honest "keep waiting or cancel" state. The poll loop keeps running
  // underneath — no extra action needed to keep waiting.
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.amberDim, border: `1px solid ${T.amber}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.amber, fontFamily: T.sans, marginBottom: 4 }}>
          Federation is taking its time
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono, marginBottom: 6 }}>
          +<BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> inbound
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, wordBreak: "break-word" }}>
          Your payment was received. The federation's mint protocol can
          take a few minutes to finish crediting on slow days. We'll
          keep waiting and LOCK as soon as the credit lands.
        </div>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs, background: T.amberDim,
        border: `1px solid ${T.amber}44`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: T.amber, animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.amber, letterSpacing: 0.5 }}>
          Still waiting for the mint to settle…
        </span>
      </div>
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Cancel & recover later
      </button>
    </div>
  );
}

function ReceiveRejectedState({
  amountSats, reason, onCancel,
}: { amountSats: number; reason: string; onCancel: () => void }) {
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>✕</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          Federation rejected the payment
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono, marginBottom: 6 }}>
          <BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> not credited
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, wordBreak: "break-word" }}>
          Gateway status is canceled:{reason}. Chama is checking briefly
          for late wallet credit. If no recovery banner appears, check
          the sending wallet for a failed or refunded payment.
        </div>
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 8, marginBottom: 12, padding: "6px 12px",
        borderRadius: T.rs, background: T.redDim,
        border: `1px solid ${T.red}44`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: T.red, animation: "pulse 1.4s ease-in-out infinite",
        }} />
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.red, letterSpacing: 0.5 }}>
          Checking Chama balance before stopping…
        </span>
      </div>
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Close and check later
      </button>
    </div>
  );
}

function PaymentConfirmed({ amountSats }: { amountSats: number }) {
  return (
    <div style={{
      padding: "28px 16px", textAlign: "center",
      background: T.greenDim, border: `1px solid ${T.green}66`, borderRadius: T.r,
    }}>
      <div style={{ fontSize: 36, marginBottom: 8 }}>⚡</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 4 }}>
        Payment received
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
        +<BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
      </div>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 10, letterSpacing: 1 }}>
        SEALING THE TRADE…
      </div>
    </div>
  );
}

function Locking() {
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.purpleDim, border: `1px solid ${T.purple}44`, borderRadius: T.r,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: T.purple, animation: "pulse 1.4s ease-in-out infinite",
        margin: "0 auto 12px",
      }} />
      <div style={{ fontSize: 11, fontWeight: 600, color: T.purple, fontFamily: T.mono, letterSpacing: 1 }}>
        SPLITTING SHARES · PUBLISHING LOCK
      </div>
    </div>
  );
}

function LockedSuccess({ amountSats }: { amountSats: number }) {
  return (
    <div style={{
      padding: "32px 16px", textAlign: "center",
      background: T.greenDim, border: `1px solid ${T.green}66`,
      borderRadius: T.r, animation: "fadeIn 0.3s ease",
    }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
        Locked in escrow
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
        <BitcoinAmount sats={amountSats} size={18} gap={5} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
      </div>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 12 }}>
        Trade is live · closing…
      </div>
    </div>
  );
}

function ExpiredState({
  onRegenerate, onCancel,
}: { onRegenerate: () => void; onCancel: () => void }) {
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⌛</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          Invoice expired
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          No payment received in the time window. Generate a new one to retry.
        </div>
      </div>
      <button
        onClick={onRegenerate}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: T.accent, border: `1px solid ${T.accent}`,
          color: "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
          cursor: "pointer", marginBottom: 8,
        }}
      >
        ⚡ Generate new invoice
      </button>
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function MintTimeoutState({
  busy, onTryLockNow, onCancel,
}: { busy: boolean; onTryLockNow: () => void; onCancel: () => void }) {
  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.amberDim, border: `1px solid ${T.amber}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.amber, fontFamily: T.sans, marginBottom: 4 }}>
          Mint is taking longer than expected
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          Your payment landed, but the federation hasn't fully credited your wallet yet. You can try locking now or cancel and recover via the banner.
        </div>
      </div>
      <button
        disabled={busy}
        onClick={onTryLockNow}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: T.rs,
          background: busy ? T.surface : T.amber, border: `1px solid ${T.amber}`,
          color: busy ? T.muted : "#000",
          fontFamily: T.mono, fontSize: 12, fontWeight: 800,
          cursor: busy ? "not-allowed" : "pointer", marginBottom: 8,
        }}
      >
        {busy ? "Locking…" : "Try LOCK now"}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: busy ? "not-allowed" : "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function LockFailedState({
  error, onCancel,
}: { error: string; onCancel: () => void }) {
  const isNativeBridgeUnavailable =
    /native_fedimint_bridge_unavailable|Native Fedimint bridge is enabled but unreachable/i.test(error);
  const isWalletVerifiableGatewayError =
    /wallet-verifiable Lightning receive gateway/i.test(error);
  const isReceiveRejection =
    /Federation didn't accept the payment|canceled:|claim_rejected|before Chama received ecash/i.test(error);
  const diagnostics = extractChamaDiagnostics(error);
  const showSimFallback = isWalletVerifiableGatewayError && !isNativeBridgeUnavailable && !isSimModeOn();
  const title = isNativeBridgeUnavailable
    ? "Native Fedimint unavailable"
    : isWalletVerifiableGatewayError
    ? "Funding unavailable here"
    : isReceiveRejection
      ? "Receive rejected"
    : "Couldn't lock the trade";
  const detail = isNativeBridgeUnavailable
    ? "The Rust Fedimint bridge is enabled but not running or reachable. Start the local bridge and reconnect. Chama did not create an invoice, so no sats were requested."
    : isWalletVerifiableGatewayError
    ? "This is the browser Fedimint SDK route, not the Rust bridge. The SDK cannot verify a trusted receive gateway here, so Chama did not create an invoice and no sats were requested. Use nativeFedimint with the local bridge for BLF/GBF."
    : error;

  return (
    <div>
      <div style={{
        padding: "20px 16px", textAlign: "center",
        background: T.redDim, border: `1px solid ${T.red}66`, borderRadius: T.r,
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>✕</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: T.sans, marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, wordBreak: "break-word" }}>
          {detail}
        </div>
      </div>
      {diagnostics && (
        <CopyButton
          value={diagnostics}
          label="Copy Fedimint diagnostics"
          copiedLabel="✓ Copied"
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer", marginBottom: 8,
          }}
        />
      )}
      {!diagnostics && isReceiveRejection && (
        <CopyButton
          value={error}
          label="Copy receive failure"
          copiedLabel="✓ Copied"
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: "pointer", marginBottom: 8,
          }}
        />
      )}
      {showSimFallback && (
        <button
          onClick={openSimDemo}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: T.rs,
            background: T.amberDim, border: `1px solid ${T.amber}55`,
            color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            cursor: "pointer", marginBottom: 8,
          }}
        >
          Open sim demo
        </button>
      )}
      <button
        onClick={onCancel}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Close
      </button>
    </div>
  );
}

function extractChamaDiagnostics(error: string): string | null {
  const marker = "Chama diagnostics:";
  const index = error.indexOf(marker);
  if (index === -1) return null;
  return error.slice(index + marker.length).trim() || null;
}

function openSimDemo(): void {
  setSimMode(true);
  try {
    const next = new URL(window.location.href);
    next.searchParams.set("sim", "1");
    window.location.assign(next.toString());
  } catch {
    window.location.reload();
  }
}
