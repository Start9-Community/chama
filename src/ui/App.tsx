import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import { useEscrow } from "../hooks/useEscrow.js";
import { type EscrowState, EscrowStatus, TRULY_TERMINAL_STATES } from "../escrow-engine/types.js";
import { getActiveInvite } from "../fedimint/index.js";
import { getCommunityBySlug, DEFAULT_COMMUNITY_SLUG } from "../communities/registry.js";
import { getUserCommunitySlugRaw } from "../communities/storage.js";

import { T } from "./theme.js";
import {
  decideAutoInitTarget,
  decideListingTapEffect,
  decideArbiterWarning,
  canOfferSubscription,
  shouldShowBrowserSupportBanner,
  shouldShowRecoveryBanner,
  hasActiveBuyerSellerCommitment,
  decideChamaBarLabel,
  findActiveTrade,
  identifyStrandedEcashSource,
} from "./decisions.js";
import { Toast } from "./components/Toast.js";
import { BottomNav, BOTTOM_NAV_HEIGHT, type Tab } from "./components/BottomNav.js";
import { BrowserSupportBanner } from "./components/BrowserSupportBanner.js";
import { ActiveTradePill } from "./components/ActiveTradePill.js";
import { RecoveryBanner } from "./screens/RecoveryBanner.js";
import { useBrowserBanner } from "./hooks/useBrowserBanner.js";
import { useFederationCommands } from "./hooks/useFederationCommands.js";

import { BrowseView } from "./screens/BrowseView.js";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { TradeDetail } from "./screens/TradeDetail.js";
import { CreateForm } from "./screens/CreateForm.js";
import { MeScreen } from "./screens/MeScreen.js";
import { SettingsAdvanced } from "./screens/SettingsAdvanced.js";

import { WalletBar } from "./panels/WalletBar.js";
import { ChamaBar } from "./panels/ChamaBar.js";
import { DestroyEcashConfirmModal } from "./panels/DestroyEcashConfirmModal.js";
import { FundWalletModal } from "./panels/FundWalletModal.js";
import { AtomicFundingModal } from "./panels/AtomicFundingModal.js";
import { ClaimPayoutModal } from "./panels/ClaimPayoutModal.js";
import { RecoveryPayoutModal } from "./panels/RecoveryPayoutModal.js";
import { addOrTouchLightningHandle, getSavedLightningHandles } from "../payments/saved-handles.js";
import { SavedHandlesPanel } from "./panels/SavedHandlesPanel.js";
import { SimModePill, SimEntryModal } from "../sim/SimModeBanner.js";

const QRScanner = lazy(() => import("./QRScanner.js"));

// View routing — flat enum; the bottom nav highlights based on which
// "tab family" the current view belongs to (see TAB_FOR_VIEW below).
type View =
  | "browse"
  | "detail"
  | "create"
  | "me"
  | "saved-handles"
  | "advanced";

const TAB_FOR_VIEW: Record<View, Tab> = {
  browse: "browse",
  detail: "browse",
  create: "create",
  me: "me",
  "saved-handles": "me",
  advanced: "me",
};

export default function App() {
  // Toast state needs to be declared before the hook since we pass
  // onClaimProgress which dispatches toasts. useRef holds the callback
  // so the hook gets a stable reference and doesn't re-wire on every render.
  const toastRef = useRef<((t: { message: string; type: "success" | "error" | "info" }) => void) | null>(null);

  const [{ connected, pubkey, escrows, relayStatuses, connectedRelays, error, loading, fedimint }, actions] = useEscrow({
    relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"],
    defaultPlatformFeeBps: 50,
    onClaimProgress: (p) => {
      const t = toastRef.current;
      if (!t) return;
      if (p.phase === "submitted") {
        t({ message: "Claiming… reconstructing ecash.", type: "info" });
      } else if (p.phase === "watching") {
        t({
          message: "Claim submitted. Waiting for your Chama (up to 2 min)…",
          type: "info",
        });
      } else if (p.phase === "success") {
        const sats = Math.floor(p.deltaMsats / 1000).toLocaleString();
        t({
          message: p.viaWatchdog
            ? "Claimed! " + sats + " sats arrived."
            : "Claimed! Ecash redeemed to your Lightning wallet.",
          type: "success",
        });
      } else if (p.phase === "timeout") {
        t({
          message:
            "Still pending on your Chama. Your sats will appear once settled — check back shortly.",
          type: "info",
        });
      } else if (p.phase === "failure") {
        t({ message: p.reason || "Claim failed", type: "error" });
      }
    },
  });

  const [view, setView] = useState<View>("browse");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browseCategory, setBrowseCategory] = useState<string>("all");
  // Per the "every user has a home" doctrine (§2.1, locked for v0.2.0):
  // every user — first-time or returning — gets a community from the
  // moment they sign in. v0.1.87 retired the synthetic "All communities"
  // pill, so browseCommunity is always a real slug. First-time users
  // start on DEFAULT_COMMUNITY_SLUG; community-pill taps mutate from
  // there. v0.2.0 will replace this filter with the matching/non-
  // matching two-section amber layout.
  const [browseCommunity, setBrowseCommunity] = useState<string>(
    () => getUserCommunitySlugRaw() ?? DEFAULT_COMMUNITY_SLUG,
  );
  const [nip46Uri, setNip46Uri] = useState<string | null>(null);
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [nip46Waiting, setNip46Waiting] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  toastRef.current = setToast;
  const [showFundModal, setShowFundModal] = useState(false);
  const [autoLoginChecked, setAutoLoginChecked] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [pendingDestroyConfirm, setPendingDestroyConfirm] = useState<{
    invite: string;
    label: string;
    balanceMsats: number;
    activeInvite: string;
    /** v0.2.0 item 1: when set, navigate to this escrow's detail
     *  after the switch confirms. Used by listing-tap dispatch when
     *  balance > 0 forces destroy-confirm before the silent switch
     *  to the listing's fed can happen. */
    navigateToEscrowAfter?: string;
  } | null>(null);
  const [autoInitDone, setAutoInitDone] = useState(false);
  // v0.2.0 item 1: brief inline overlay during silent re-init triggered
  // by listing-tap. Sub-second on a healthy fed; modal-free.
  const [switchingToCommunity, setSwitchingToCommunity] = useState<{ displayName: string } | null>(null);

  // v0.2.0 item 8: when the user picks "Withdraw via Lightning" from the
  // destroy-confirm modal, we stash the pending switch here. The
  // withdraw-watcher useEffect (below the actions setup) auto-dispatches
  // the switch once balance reaches zero. Per Q4: if the user closes the
  // FundWalletModal before draining, drop this state — explicit
  // abandonment.
  const [pendingSwitchAfterWithdraw, setPendingSwitchAfterWithdraw] = useState<{
    invite: string;
    label: string;
    navigateToEscrowAfter?: string;
  } | null>(null);
  // v0.3.0 Phase 2: AtomicFundingModal mount state. When the user taps
  // Fund on a listing, we stash the pending fund-and-lock here and the
  // modal mounts. The TradeDetail Fund button awaits a promise that
  // resolves on modal close, preserving the in-flight disabled state
  // throughout the modal's lifetime.
  const [pendingFundAndLock, setPendingFundAndLock] = useState<{
    escrowId: string;
    amountMsats: number;
    ctaLabel: string;
    savedHandleId?: string;
    resolve: () => void;
  } | null>(null);
  // v0.3.0 Phase 3: ClaimPayoutModal mount state. Same shape as
  // pendingFundAndLock — TradeDetail's setClaiming(true) flag survives
  // the modal lifetime via the resolve-on-close promise.
  const [pendingClaim, setPendingClaim] = useState<{
    escrowId: string;
    payoutMsats: number;
    resolve: () => void;
  } | null>(null);
  // v0.3.0 Phase 4: RecoveryPayoutModal mount state. Single mount used
  // by BOTH the failure-mode RecoveryBanner (no follow-up after drain)
  // AND the DestroyEcashConfirmModal flow (queues pendingSwitchAfter-
  // Withdraw — the existing watcher useEffect dispatches the switch
  // when balance reaches zero). The `title` prop differentiates the
  // two surfaces visually.
  const [pendingRecovery, setPendingRecovery] = useState<{
    title: string;
    subtitle?: string;
  } | null>(null);
  // Browser-support banner state lives in a dedicated hook so the
  // per-pubkey scoping (Bug E from v0.1.85 smoke testing) stays
  // testable in isolation and App.tsx stays an orchestrator.
  const { dismissed: browserBannerDismissed, dismiss: dismissBrowserBanner } =
    useBrowserBanner(pubkey);

  // v0.2.0 item 8 / v0.3.0 Phase 4 reminder #3: post-recover auto-
  // switch. State machine unchanged; only the trigger surface moves
  // (FundWalletModal in v0.2.0 → RecoveryPayoutModal in v0.3.0). When
  // the user picked "Recover & switch" from the destroy-confirm modal,
  // the watcher waits for balance to drain to zero, then dispatches
  // the originally-attempted federation switch. If the user dismisses
  // the picker before resolving, the modal's onClose drops the pending
  // switch (explicit abandonment).
  useEffect(() => {
    if (!pendingSwitchAfterWithdraw) return;
    if ((fedimint.balanceMsats ?? 0) > 0) return;
    // Balance reached zero — dispatch the switch.
    const target = pendingSwitchAfterWithdraw;
    setPendingSwitchAfterWithdraw(null);
    (async () => {
      try {
        setToast({ message: `Switching to ${target.label}…`, type: "info" });
        if (fedimint.federationId) {
          await actions.switchFederation(target.invite);
        } else {
          await actions.initFedimint(target.invite);
        }
        setToast({ message: `Joined ${target.label}!`, type: "success" });
        if (target.navigateToEscrowAfter) {
          setSelectedId(target.navigateToEscrowAfter);
          setView("detail");
        }
      } catch (e: any) {
        setToast({
          message: e?.message || `Couldn't switch to ${target.label}. Try again.`,
          type: "error",
        });
      }
    })();
  }, [pendingSwitchAfterWithdraw, fedimint.balanceMsats, fedimint.federationId, actions]);

  // Auto-login: on native platforms, check for saved nsec in secure storage
  useEffect(() => {
    if (autoLoginChecked || connected || loading) return;
    if (!Capacitor.isNativePlatform()) { setAutoLoginChecked(true); return; }
    (async () => {
      try {
        const { value } = await Preferences.get({ key: "chama_saved_nsec" });
        if (value) {
          (window as any).__chama_connect_nsec = value;
          actions.connect();
        }
      } catch (e) {
        console.warn("[chama] auto-login check failed:", e);
      } finally {
        setAutoLoginChecked(true);
      }
    })();
  }, [autoLoginChecked, connected, loading, actions]);

  // Auto-init Fedimint after connect. v0.1.87 wires the
  // sticky-community decision via decideAutoInitTarget — refresh
  // always lands the user on their home community's federation,
  // unless an in-flight trade with funds at risk forces preserving
  // the OPFS-bound fed so the trade can resume.
  //
  // Note on inputs at boot: hasCurrentEscrow and balanceMsats are
  // both unknowable before initFedimint completes (escrows haven't
  // streamed yet, the WASM client isn't open). For v0.1.87 we pass
  // conservative defaults (false / 0); the v0.1.74 reconciliation
  // guard in initFedimint catches the race where balance is actually
  // non-zero and the home fed differs from the OPFS-bound one. v0.2.0
  // will tighten this once the recovery-banner / one-trade-at-a-time
  // gates are in place.
  useEffect(() => {
    if (!connected || autoInitDone) return;
    // `connected` flips true synchronously when client.connect() is
    // dispatched, but relay WebSocket handshakes happen async. Firing
    // initFedimint with zero connected relays drives getOrCreateSeed
    // into the fresh-seed publish path (first-launch users with no
    // marker) → relayManager.publish() throws "No connected relays —
    // cannot publish" → autoInitDone is already true → the user is
    // stuck on "No Chama" until they tap Reconnect manually. Wait
    // until at least one relay is actually open before dispatching.
    if (connectedRelays === 0) return;
    if (fedimint.joined || fedimint.busy || fedimint.initialized) return;

    const target = decideAutoInitTarget({
      activeInvite: getActiveInvite(),
      homeCommunity: getUserCommunitySlugRaw(),
      hasCurrentEscrow: false,
      balanceMsats: 0,
    });

    if (target.kind === "skip") return;
    setAutoInitDone(true);

    // v0.2.0 item 6: when target.kind === "use-default" we also persist
    // the assigned community to localStorage so subsequent reloads land
    // in the use-home branch — first-time-default fires exactly once
    // per npub, not on every refresh.
    if (target.kind === "use-default") {
      actions.setCommunity(target.defaultCommunity);
    }

    // All branches dispatch through initFedimint(invite). The v0.1.74
    // reconciliation guard inside initFedimint handles the case where
    // the desired invite differs from the OPFS-bound one AND a
    // non-zero balance is detected — it throws
    // RECONCILE_REFUSED_NONZERO_BALANCE and we surface the modal.
    const failureLabel =
      target.kind === "use-home"
        ? (getCommunityBySlug(target.slug)?.displayName ?? target.slug)
        : target.kind === "use-default"
          ? (getCommunityBySlug(target.defaultCommunity)?.displayName ?? target.defaultCommunity)
          : "your previous community";
    actions.initFedimint(target.invite).catch((e: any) => {
      if (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE") {
        setPendingDestroyConfirm({
          invite: e.desiredInvite,
          label: failureLabel,
          balanceMsats: e.balanceMsats || 0,
          activeInvite: e.previousActiveInvite,
        });
      } else {
        setToast({
          message: e?.message || "Couldn't reconnect. Try again?",
          type: "error",
        });
      }
    });
  }, [connected, connectedRelays, autoInitDone, fedimint.joined, fedimint.busy, fedimint.initialized, actions]);

  const now = Math.floor(Date.now() / 1000);
  const HIDE_AFTER = 7 * 86400;
  const visibleTrades = [...escrows.values()]
    .filter(s => {
      if (["CREATED", "LOCKED", "APPROVED"].includes(s.status)) return true;
      if (s.createdAt && (now - s.createdAt) > HIDE_AFTER) return false;
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const isParticipant = (s: EscrowState) =>
    s.participants.buyer === pubkey ||
    s.participants.seller === pubkey ||
    s.participants.arbiter === pubkey;

  const myTrades = visibleTrades.filter(isParticipant);

  // v0.2.0 item 3: one-trade-at-a-time. Hard-block applies to buyer/
  // seller commitments; arbiter status triggers warnings (item 10),
  // not blocks. activeTrade drives the pill's tap target.
  const activeTrade = pubkey
    ? findActiveTrade({ escrows: escrows.values(), userPubkey: pubkey })
    : null;
  const hasActiveCommitment = pubkey
    ? hasActiveBuyerSellerCommitment({ escrows: escrows.values(), userPubkey: pubkey })
    : false;

  // v0.2.0 item 2: recovery banner. Fires when balance > 0 AND no
  // active trade — orphan ecash from a previous trade that didn't
  // finish cleanly. The banner intercepts Browse + Create routes;
  // Me/Settings stay accessible (per the brief, users may need to
  // update LN address / fetch counterparty kind:0 / check history
  // as part of resolving the recovery itself).
  const showRecoveryBanner = shouldShowRecoveryBanner({
    balanceMsats: fedimint.balanceMsats ?? 0,
    hasCurrentEscrow: hasActiveCommitment,
  });
  const strandedSource = pubkey && showRecoveryBanner
    ? identifyStrandedEcashSource({ escrows: escrows.values(), userPubkey: pubkey })
    : null;

  // v0.2.0 item 10: arbiter attention warning. Computed once at App
  // level and threaded into the Create wizard. Fires alongside the
  // buyer/seller hard-block; in practice the hard-block takes priority
  // (a buyer/seller on a non-terminal trade can't reach Create at all).
  const arbiterWarning = pubkey
    ? decideArbiterWarning({ escrows: escrows.values(), userPubkey: pubkey })
    : { kind: "none" as const };

  // v0.2.0 item 7: graduated trust gate for subscription mode. v0.2.0
  // ships with the aggregator returning null (no rating events being
  // published yet) → gate is closed for everyone. v0.2.1 wires the
  // aggregator and the gate naturally opens for qualifying sellers.
  const userCanSubscribe = canOfferSubscription({ ratings: null });

  const matchesBrowseCategory = (s: EscrowState) => {
    if (browseCategory === "all") return true;
    if (browseCategory === "subscription") return s.subscription !== null;
    return s.category === browseCategory;
  };

  // v0.2.0 item 4: browse two-section layout. matchingListings render
  // first as normal cards; nonMatchingListings render below an
  // "N LISTINGS ON OTHER FEDERATIONS" divider with amber tint per
  // chama_browse_amber_tint_sorted spec. The community-pill filter
  // is gone (along with the "All" pill in v0.1.87) — pills are
  // identity-only now; Browse shows everything fed-routed.
  //
  // Match predicate: listing's mintUrl === user's active fed invite.
  // Pre-PR-A listings without mintUrl fall through to non-matching
  // (the listing-tap dispatch handles them via community-derived
  // fallback — see decideListingTapEffect).
  const myActiveInvite = fedimint.joined ? getActiveInvite() : null;
  const visibleListings = visibleTrades.filter(s =>
    !isParticipant(s)
    && s.status === EscrowStatus.CREATED
    && matchesBrowseCategory(s)
  );
  const matchingListings = visibleListings.filter(s =>
    !!myActiveInvite && s.mintUrl === myActiveInvite
  );
  const nonMatchingListings = visibleListings.filter(s =>
    !myActiveInvite || s.mintUrl !== myActiveInvite
  );
  // browseCommunity drives pill highlighting; it no longer filters
  // (the pill is identity-only post-v0.1.87). matchesBrowseCommunity
  // helper retired with the filter.
  void browseCommunity;
  const selected = selectedId ? escrows.get(selectedId) : null;

  // v0.1.66.32: refetch on tap when local state may be stale.
  // v0.2.0 item 1: federation-follows-listing dispatch. When the user
  // taps a listing, we silently re-init to the listing's fed BEFORE
  // the detail screen renders. The detail screen always opens on the
  // right fed, so every action (Fund, payment-handle preview, lock
  // timing, etc.) is coherent regardless of where the user came from.
  // State A vs State B narration is computed inside TradeDetail via
  // decideTradeDetailFraming — always-true post-switch is fine because
  // the framing compares listing.fed against home.fed, not against
  // active.fed.
  const openEscrow = (id: string) => {
    const local = escrows.get(id);

    // No local copy yet — the listing may have come from a relay
    // refetch race. Fall through to the legacy refetch path; the
    // post-fetch render will see the local copy and the user can
    // re-tap if a switch is needed. Edge case; rare in practice.
    if (!local) {
      setSelectedId(id);
      setView("detail");
      actions.loadEscrow(id).catch((e: any) => {
        console.debug(
          "[chama] background refetch on openEscrow failed:",
          e?.message || e,
        );
      });
      return;
    }

    const effect = decideListingTapEffect({
      listing: { mintUrl: local.mintUrl, community: local.community },
      currentInvite: getActiveInvite(),
      balanceMsats: fedimint.balanceMsats ?? 0,
    });

    // Always background-refetch so the detail screen sees fresh state
    // by the time it renders. Mirrors the pre-v0.2.0 behavior.
    if (!TRULY_TERMINAL_STATES.has(local.status)) {
      actions.loadEscrow(id).catch((e: any) => {
        console.debug(
          "[chama] background refetch on openEscrow failed:",
          e?.message || e,
        );
      });
    }

    if (effect.kind === "matching") {
      setSelectedId(id);
      setView("detail");
      return;
    }

    if (effect.kind === "switch-silent") {
      setSwitchingToCommunity({ displayName: effect.displayName });
      (async () => {
        try {
          if (fedimint.federationId) {
            await actions.switchFederation(effect.targetInvite);
          } else {
            await actions.initFedimint(effect.targetInvite);
          }
          setSelectedId(id);
          setView("detail");
        } catch (e: any) {
          if (e?.code === "RECONCILE_REFUSED_NONZERO_BALANCE"
            || e?.code === "SWITCH_REFUSED_NONZERO_BALANCE") {
            // Race: balance was zero at decision time, became non-zero
            // before the switch landed. Surface the modal with the
            // navigate-after target so confirm-then-navigate still works.
            setPendingDestroyConfirm({
              invite: effect.targetInvite,
              label: effect.displayName,
              balanceMsats: e.balanceMsats || 0,
              activeInvite: e.previousActiveInvite || getActiveInvite() || "",
              navigateToEscrowAfter: id,
            });
          } else {
            setToast({
              message: e?.message || `Couldn't switch to ${effect.displayName}. Try again.`,
              type: "error",
            });
          }
        } finally {
          setSwitchingToCommunity(null);
        }
      })();
      return;
    }

    // destroy-confirm — funds at risk on user's current fed, surface
    // the modal. After confirm, the switch happens AND we navigate to
    // the listing detail (per v0.2.0 spec the listing-tap user intent
    // carries through the modal).
    setPendingDestroyConfirm({
      invite: effect.targetInvite,
      label: effect.displayName,
      balanceMsats: effect.balanceMsats,
      activeInvite: effect.currentInvite,
      navigateToEscrowAfter: id,
    });
  };

  const handleCreate = async (params: any) => {
    try {
      setToast({ message: "Signing event with NIP-07...", type: "info" });
      const { escrowId } = await actions.createEscrow(params);
      setToast({ message: `Trade published! ${escrowId}`, type: "success" });
      setView("detail");
      setSelectedId(escrowId);
    } catch (e: any) {
      console.error("[chama] Create failed:", e);
      setToast({ message: e.message || "Failed to create trade", type: "error" });
      throw e;
    }
  };

  const handleSignOut = async () => {
    if (Capacitor.isNativePlatform()) {
      try { await Preferences.remove({ key: "chama_saved_nsec" }); } catch {}
    }
    delete (window as any).__chama_connect_nsec;
    window.location.reload();
  };

  // Community-pill tap and custom-invite-paste handlers live in their
  // own hook so the orchestrator stays an orchestrator. The hook
  // encapsulates the dispatch + revert logic; decision logic
  // (decideCommunityTapEffect) lives in src/ui/decisions.ts.
  const { handleSelectCommunity, handlePasteCustomInvite } = useFederationCommands({
    fedimint,
    actions,
    setToast,
    setBrowseCommunity,
    setPendingDestroyConfirm,
  });

  const switchTab = (t: Tab) => {
    if (t === "browse") setView("browse");
    else if (t === "create") setView("create");
    else if (t === "me") setView("me");
  };

  // ── Not connected → show connect screen ──
  if (!connected) {
    return (
      <div style={{ background: T.bg, color: T.text, minHeight: "100vh", fontFamily: T.sans }}>
        <style>{globalCss}</style>
        <SimModePill />
        <SimEntryModal />
        {loginSuccess && <LoginSuccessSplash />}
        {showQRScanner && (
          <Suspense fallback={null}>
            <QRScanner
              onClose={() => setShowQRScanner(false)}
              onScan={async (scanned) => {
                setShowQRScanner(false);
                if (scanned.startsWith("nsec1")) {
                  if (confirm("Found an nsec key. Sign in with it?")) {
                    (window as any).__chama_connect_nsec = scanned;
                    try { await Preferences.set({ key: "chama_saved_nsec", value: scanned }); } catch {}
                    actions.connect();
                  }
                } else if (scanned.startsWith("nostrconnect://") || scanned.startsWith("bunker://")) {
                  navigator.clipboard?.writeText(scanned);
                  alert("Scanned bunker URI copied to clipboard!");
                } else {
                  alert("Scanned: " + scanned.slice(0, 100));
                }
              }}
            />
          </Suspense>
        )}
        <ConnectScreen
          onConnect={actions.connect}
          onConnectNIP46={async () => {
            try {
              if (nip46Waiting) return;
              setNip46Waiting(true);
              const { createNostrConnectSession } = await import("../escrow-engine/nip46-signer.js");
              const session = await createNostrConnectSession();
              setNip46Uri(session.uri);
              const result = await session.waitForConnection();
              (window as any).__chama_nip46_signer = result.signer;
              (window as any).__chama_nip46_pubkey = result.pubkey;
              setNip46Uri(null);
              setNip46Waiting(false);
              setLoginSuccess(true);
              setTimeout(() => {
                setLoginSuccess(false);
                actions.connect();
              }, 1800);
            } catch (e: any) {
              setNip46Waiting(false);
              setNip46Uri(null);
              console.error("[chama] NIP-46 connection failed:", e);
            }
          }}
          onConnectNsec={async (nsec: string, remember: boolean) => {
            (window as any).__chama_connect_nsec = nsec;
            if (remember && Capacitor.isNativePlatform()) {
              try {
                await Preferences.set({ key: "chama_saved_nsec", value: nsec });
              } catch (e) {
                console.warn("[chama] Failed to save nsec to secure storage:", e);
              }
            }
            actions.connect();
          }}
          loading={loading}
          error={error}
          nip46Uri={nip46Uri}
          nip46Waiting={nip46Waiting}
        />
      </div>
    );
  }

  // ── Connected → main app ──
  const activeTab = TAB_FOR_VIEW[view];

  return (
    <div style={{
      background: T.bg, color: T.text, minHeight: "100vh",
      fontFamily: T.sans, maxWidth: 520, margin: "0 auto",
      paddingBottom: BOTTOM_NAV_HEIGHT,
    }}>
      <style>{globalCss}</style>
      <SimModePill />
      <SimEntryModal />

      {toast && <Toast message={toast.message} type={toast.type} onDone={() => setToast(null)} />}

      {/* Header */}
      <div style={{
        padding: "16px 16px 12px", borderBottom: `1px solid ${T.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img
            src="/icons/chama-c-glyph.svg"
            alt="Chama"
            width={28}
            height={28}
            style={{ display: "block", flexShrink: 0 }}
          />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: T.mono, letterSpacing: -0.5 }}>Chama</div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1.5, textTransform: "uppercase" }}>
              Nostr · Fedimint · SSS
            </div>
          </div>
        </div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, padding: "4px 10px", borderRadius: 6, background: T.surface, border: `1px solid ${T.border}` }}>
          v{__APP_VERSION__}
        </div>
      </div>

      {/* Identity bar (relays + npub). Sign out lives in Me → Settings. */}
      <WalletBar
        pubkey={pubkey!}
        connectedRelays={connectedRelays}
        relayStatuses={relayStatuses}
      />

      {/* Chama bar (renamed from FedimintBar in v0.3.0 Phase 5).
          showReconnect is true for users who have a reconnect target
          (picked community or active invite) so the Reconnect CTA
          appears after a failed switch+revert; first-time users (no
          community yet) don't see it because their join path is
          community pills, not Reconnect.

          v0.3.0 Phase 5: onFund is gone. The right-side surface is
          state-aware via chamaLabel — in-trade / stranded / ready —
          rather than a permanent funding entry point. The stranded
          tap reuses the same RecoveryPayoutModal as the banner, so
          the failure-mode escape hatch is reachable from anywhere. */}
      <ChamaBar
        fedimint={fedimint}
        chamaLabel={decideChamaBarLabel({
          balanceMsats: fedimint.balanceMsats ?? 0,
          hasActiveBuyerSellerCommitment: hasActiveCommitment,
          // v0.3.1 Phase 3: bootProbeState routes the "unreachable"
          // ChamaBar variant. Failed → "⚠ Chama unreachable ·
          // Reconnect →"; pending/ok pass through to the existing
          // three-state decision. Same source of truth gates
          // TradeDetail's Fund + Claim buttons (see TradeDetail
          // mount below).
          bootProbeState: fedimint.bootProbeState,
        })}
        onTapStranded={() => setPendingRecovery({ title: "Recover sats" })}
        showReconnect={getUserCommunitySlugRaw() !== null || getActiveInvite() !== null}
        onInit={() => actions.initFedimint().catch(
          (e: any) => setToast({ message: e.message || "Couldn't join your Chama. Try again?", type: "error" })
        )}
      />

      {/* Honest browser-support disclosure — one-time-per-account. Fires
          for ALL browser users regardless of join state, so first-time
          users encounter it before committing to a federation (the right
          educational moment per Pillar 2.7). */}
      {shouldShowBrowserSupportBanner({
        isBrowser: !Capacitor.isNativePlatform(),
        dismissed: browserBannerDismissed,
      }) && (
        <BrowserSupportBanner onDismiss={dismissBrowserBanner} />
      )}

      {/* The first-time onboarding picker no longer renders in the shell.
          Community pills in BrowseView are the primary first-time join
          surface (one-tap = identity + fed init). Power users still get
          the picker via Me → Settings → Advanced → Sandbox mode (which
          surfaces SwitchFederationPanel + custom-invite paste). */}

      {/* Fund Chama modal */}
      {showFundModal && (
        <FundWalletModal
          onClose={() => {
            setShowFundModal(false);
            // v0.2.0 item 8 + Q4: closing the modal before balance
            // drains = explicit abandonment. Drop the pending switch
            // so we don't unexpectedly switch later if they happen to
            // drain via another path.
            setPendingSwitchAfterWithdraw(null);
          }}
          onCreateInvoice={(amountSats, desc) =>
            actions.createFundingInvoice(amountSats * 1000, desc)
          }
          onPayInvoice={(bolt11) => actions.payInvoice(bolt11)}
          onSpendNotes={(amountMsats) => actions.spendNotes(amountMsats)}
          balanceMsats={fedimint.balanceMsats ?? 0}
        />
      )}

      {/* v0.3.0 Phase 2: AtomicFundingModal — listing-tap → exact-amount
          BOLT11 → mint → LOCK in one motion. Replaces the prior
          FundWalletModal-then-Fund two-step on the production funding
          path. FundWalletModal stays mounted above for the (Phase 5-
          gated) Sandbox-mode path. */}
      {pendingFundAndLock && (
        <AtomicFundingModal
          escrowId={pendingFundAndLock.escrowId}
          amountMsats={pendingFundAndLock.amountMsats}
          ctaLabel={pendingFundAndLock.ctaLabel}
          savedHandleId={pendingFundAndLock.savedHandleId}
          fundAndLock={actions.fundAndLock}
          lockAndPublish={actions.lockAndPublish}
          onClose={(terminal) => {
            const { resolve } = pendingFundAndLock;
            setPendingFundAndLock(null);
            if (terminal.kind === "locked") {
              setToast({ message: "Locked! Vote buttons are live.", type: "success" });
            } else if (terminal.kind === "lock-failed") {
              setToast({ message: terminal.error, type: "error" });
            } else if (terminal.kind === "expired") {
              setToast({ message: "Invoice expired — no payment received.", type: "info" });
            } else if (terminal.kind === "mint-timeout") {
              setToast({
                message: "Mint stalled. If sats are stranded, recover via the banner on Browse.",
                type: "info",
              });
            }
            // aborted = silent (user cancelled)
            resolve();
          }}
        />
      )}

      {/* v0.3.0 Phase 3: ClaimPayoutModal — APPROVED winner taps Claim →
          DestinationPicker → atomic claim+payout in one motion.
          Replaces the prior "claim into wallet then withdraw" two-step
          on the production path. claimAndRedeem stays as a building
          block + Sandbox path; production winners always go through
          this modal. */}
      {pendingClaim && (
        <ClaimPayoutModal
          escrowId={pendingClaim.escrowId}
          payoutMsats={pendingClaim.payoutMsats}
          savedHandles={getSavedLightningHandles()}
          claimAndPayout={actions.claimAndPayout}
          probeFederation={actions.probeFederation}
          onClose={(terminal) => {
            const { resolve } = pendingClaim;
            setPendingClaim(null);
            if (!terminal) {
              // User dismissed picker before resolving — silent.
            } else if (terminal.kind === "done") {
              setToast({ message: "Sats sent to your wallet!", type: "success" });
            } else if (terminal.kind === "claim-failed") {
              setToast({ message: terminal.error, type: "error" });
            } else if (terminal.kind === "claim-bridge-threw") {
              // v0.3.1 Phase 1: structural failure (FED_PROBE_FAILED /
              // FED_MISMATCH). Modal surfaced the actual error +
              // Try-again button; if user closed without retrying,
              // the toast reminds them what happened. No sats moved.
              setToast({ message: terminal.error, type: "error" });
            } else if (terminal.kind === "claim-pending") {
              setToast({
                message: "Claim is in flight — sats will arrive shortly.",
                type: "info",
              });
            } else if (terminal.kind === "payout-failed") {
              setToast({
                message: "Payout failed. Recover from the banner on Browse.",
                type: "error",
              });
            }
            resolve();
          }}
        />
      )}

      {/* Federation drift confirm.
          v0.3.0 Phase 4: now a TWO-button modal (no destroy escape).
          Primary "Recover & switch" stashes the pending switch in
          pendingSwitchAfterWithdraw and opens RecoveryPayoutModal
          (DestinationPicker → outbound LN). The withdraw-watcher
          useEffect dispatches the queued switch once balance reaches
          zero. The destroy escape (v0.2.0's tertiary button) is gone
          — Sandbox-mode users who truly need to nuke OPFS use
          Settings → Advanced → Sandbox → Reset OPFS. */}
      {pendingDestroyConfirm && (
        <DestroyEcashConfirmModal
          targetLabel={pendingDestroyConfirm.label}
          balanceMsats={pendingDestroyConfirm.balanceMsats}
          onWithdraw={() => {
            // pendingSwitchAfterWithdraw state machine unchanged —
            // only the trigger surface moves from FundWalletModal
            // to RecoveryPayoutModal (Phase 4 reminder #3). The
            // existing useEffect watcher dispatches the switch when
            // balance reaches zero. Cancel of the picker = explicit
            // abandonment, drops the pending switch.
            setPendingSwitchAfterWithdraw({
              invite: pendingDestroyConfirm.invite,
              label: pendingDestroyConfirm.label,
              navigateToEscrowAfter: pendingDestroyConfirm.navigateToEscrowAfter,
            });
            setPendingDestroyConfirm(null);
            const sats = Math.floor(pendingDestroyConfirm.balanceMsats / 1000);
            setPendingRecovery({
              title: "Recover & switch Chama",
              subtitle: `Send ${sats.toLocaleString()} sats to your Lightning wallet, then switch to ${pendingDestroyConfirm.label}.`,
            });
          }}
          onCancel={() => {
            actions.setCustomInvite(pendingDestroyConfirm.activeInvite);
            setPendingDestroyConfirm(null);
            actions.initFedimint(pendingDestroyConfirm.activeInvite).catch((e: any) =>
              setToast({ message: e?.message || "Re-init failed", type: "error" })
            );
          }}
        />
      )}

      {/* v0.3.0 Phase 4: RecoveryPayoutModal — single mount serving
          both the failure-mode RecoveryBanner path AND the destroy-
          modal recover-then-switch path. Title differentiates per
          surface; the underlying drain semantics are identical. */}
      {pendingRecovery && (
        <RecoveryPayoutModal
          balanceMsats={fedimint.balanceMsats ?? 0}
          savedHandles={getSavedLightningHandles()}
          title={pendingRecovery.title}
          subtitle={pendingRecovery.subtitle}
          payInvoice={(bolt11) => actions.payInvoice(bolt11)}
          addOrTouchLightningHandle={(addr) => { addOrTouchLightningHandle(addr); }}
          onClose={(terminal) => {
            setPendingRecovery(null);
            if (!terminal) {
              // User dismissed picker before resolving. If a switch
              // was queued, drop it (explicit abandonment per the
              // v0.2.0 Q4 semantics — stays the same in Phase 4).
              setPendingSwitchAfterWithdraw(null);
            } else if (terminal.kind === "done") {
              setToast({ message: "Recovered to your wallet!", type: "success" });
              // Balance reaching zero will trigger the watcher
              // useEffect (line ~187) which dispatches the queued
              // switch automatically. No extra wiring needed here.
            } else if (terminal.kind === "payout-failed") {
              setToast({ message: terminal.error, type: "error" });
              // Payout failed — drop any queued switch since the
              // balance never drained.
              setPendingSwitchAfterWithdraw(null);
            }
          }}
        />
      )}

      {/* v0.2.0 item 1: switching overlay during silent re-init when
          user taps a non-matching listing. Sub-second on a healthy
          fed; the overlay just covers the WASM tearDown + init gap
          so the listing detail's Fund button doesn't fire against
          the wrong client. */}
      {switchingToCommunity && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9990,
          background: "rgba(10,10,15,0.85)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 14,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%",
            border: `2px solid ${T.accent}`,
            borderTopColor: "transparent",
            animation: "spin 0.8s linear infinite",
          }} />
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans }}>
            Switching to <strong>{switchingToCommunity.displayName}</strong>…
          </div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5 }}>
            no Lightning round-trip · sub-second
          </div>
        </div>
      )}

      {/* Content — routed by view */}
      {view === "detail" && selected ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <TradeDetail
            state={selected}
            pubkey={pubkey!}
            homeCommunity={getUserCommunitySlugRaw()}
            // v0.3.1 Phase 3 (Q4 scope): same boot-probe flag the
            // ChamaBar's "unreachable" pill reads from. Fund + Claim
            // buttons disable with the "Federation unreachable —
            // reconnect first" subtitle when this is true. Reconnect
            // dispatch lives in ChamaBar only.
            bootProbeFailed={fedimint.bootProbeState === "failed"}
            onBack={() => { setView("browse"); setSelectedId(null); }}
            onVote={(outcome) => actions.vote(selectedId!, outcome).then(
              () => setToast({ message: `Voted ${outcome}!`, type: "success" }),
              (e: any) => setToast({ message: e.message, type: "error" })
            )}
            onClaim={async () => {
              // v0.3.0 Phase 3: open ClaimPayoutModal instead of
              // dispatching claimAndRedeem directly. The modal carries
              // the user through DestinationPicker → claim → outbound
              // LN payout in one motion. Pillar 2.1 Option B: no
              // intermediate balance UI.
              if (!selected) return;
              // Post-fee payout: state.fees deducts platformMsats +
              // arbiterMsats from the winner's share at LOCK time.
              // Same calculation used internally by claimAndRedeemAction
              // for its watchdog expectedDelta.
              const payoutMsats = Math.max(
                0,
                selected.amountMsats - selected.fees.platformMsats - selected.fees.arbiterMsats,
              );
              return new Promise<void>((resolve) => {
                setPendingClaim({
                  escrowId: selectedId!,
                  payoutMsats,
                  resolve,
                });
              });
            }}
            onJoin={async (role) => {
              try {
                setToast({ message: `Joining as ${role}...`, type: "info" });
                await actions.joinEscrow(selectedId!, role);
                setToast({ message: `Joined as ${role}!`, type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || "Failed to join", type: "error" });
              }
            }}
            onReleasePeriod={async (periodIndex: number) => {
              try {
                await actions.releasePeriod(selectedId!, periodIndex);
                setToast({ message: "Period " + (periodIndex + 1) + " released!", type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || "Release failed", type: "error" });
              }
            }}
            onSendChat={(message) => {
              actions.sendChat(selectedId!, message).catch((e: any) =>
                setToast({ message: e.message || "Failed to send", type: "error" })
              );
            }}
            onLock={async (savedHandleId?: string) => {
              if (!fedimint.joined) {
                setToast({ message: "Join a Chama first — tap a community pill.", type: "error" });
                return;
              }
              // v0.2.0 item 3: hard-block Fund when the user has another
              // active commitment. The active-trade pill at the top of
              // the detail screen offers the navigation back to it.
              if (hasActiveCommitment && activeTrade && activeTrade.id !== selectedId!) {
                setToast({
                  message: "Finish your active trade first — Chama is one trade at a time.",
                  type: "error",
                });
                return;
              }
              if (!selected) return;
              // v0.3.0 Phase 2: open AtomicFundingModal instead of
              // dispatching lockAndPublish directly. The modal handles
              // BOLT11 → mint → LOCK in one user-perceived motion.
              // Pillar 2.1 Option B: no intermediate balance UI.
              const lockLabel = selected.category === "marketplace" ? "Pay for Item"
                : selected.category === "lending" ? "Fund Loan"
                : selected.category === "bill-pay" ? "Lock Sats"
                : selected.category === "p2p-trade" ? "Fund Escrow"
                : "Lock Sats";
              return new Promise<void>((resolve) => {
                setPendingFundAndLock({
                  escrowId: selectedId!,
                  amountMsats: selected.amountMsats,
                  ctaLabel: lockLabel,
                  savedHandleId,
                  resolve,
                });
              });
            }}
            onOpenSettings={() => setView("saved-handles")}
          />
        </div>
      ) : view === "create" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {/* Active-trade pill on Create — visible alongside the
              gate card so the user understands *why* Create is
              blocked (per Q2). Browse keeps the pill for research-
              while-waiting; Create swaps the form for the gate. */}
          {activeTrade && (
            <ActiveTradePill
              trade={activeTrade}
              onTap={() => openEscrow(activeTrade.id)}
            />
          )}
          {showRecoveryBanner ? (
            <RecoveryBanner
              balanceMsats={fedimint.balanceMsats ?? 0}
              source={strandedSource}
              fetchKind0Enabled={false}
              onRecover={() => {
                // v0.3.0 Phase 4: open RecoveryPayoutModal — no
                // queued follow-up since this path isn't gated by a
                // pending federation switch.
                setPendingRecovery({
                  title: "Recover sats",
                });
              }}
            />
          ) : hasActiveCommitment && activeTrade ? (
            <CreateBlockedCard
              trade={activeTrade}
              onGoToTrade={() => openEscrow(activeTrade.id)}
            />
          ) : (
            <CreateForm
              onCreate={handleCreate}
              onClose={() => setView("browse")}
              arbiterWarning={arbiterWarning}
              onGoToArbiterTrade={(escrowId) => openEscrow(escrowId)}
              canOfferSubscription={userCanSubscribe}
              userPubkey={pubkey ?? null}
            />
          )}
        </div>
      ) : view === "me" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {activeTrade && (
            <ActiveTradePill
              trade={activeTrade}
              onTap={() => openEscrow(activeTrade.id)}
            />
          )}
          <MeScreen
            pubkey={pubkey!}
            myTrades={myTrades}
            ratings={null /* v0.2.0: no rating events yet; v0.2.1 wires the aggregator */}
            onOpenTrade={openEscrow}
            onOpenSavedHandles={() => setView("saved-handles")}
            onOpenAdvanced={() => setView("advanced")}
            onSignOut={handleSignOut}
          />
        </div>
      ) : view === "saved-handles" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {activeTrade && (
            <ActiveTradePill
              trade={activeTrade}
              onTap={() => openEscrow(activeTrade.id)}
            />
          )}
          <SavedHandlesPanel
            communitySlug={actions.getCommunity()}
            onClose={() => setView("me")}
          />
        </div>
      ) : view === "advanced" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          {activeTrade && (
            <ActiveTradePill
              trade={activeTrade}
              onTap={() => openEscrow(activeTrade.id)}
            />
          )}
          <SettingsAdvanced
            fedimint={fedimint}
            onBack={() => setView("me")}
            onSandboxFund={() => setShowFundModal(true)}
            onSwitchFederation={async (inviteCode, opts) => {
              try {
                setToast({ message: "Joining Chama…", type: "info" });
                // Dispatch: init for first-time join (no fed loaded yet),
                // switch when already joined. Mirrors the community-tap
                // handler's logic so Sandbox works pre-join.
                if (fedimint.federationId) {
                  await actions.switchFederation(inviteCode, opts);
                } else {
                  await actions.initFedimint(inviteCode, opts);
                }
                setToast({ message: "Joined!", type: "success" });
              } catch (e: any) {
                setToast({ message: e?.message || "Join failed", type: "error" });
                throw e;
              }
            }}
            onResetLocalWallet={async () => {
              try {
                setToast({ message: "Resetting local Chama…", type: "info" });
                await actions.resetLocalWallet();
                setToast({ message: "Local Chama reset.", type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || "Reset failed", type: "error" });
              }
            }}
          />
        </div>
      ) : (
        <>
          {activeTrade && (
            <ActiveTradePill
              trade={activeTrade}
              onTap={() => openEscrow(activeTrade.id)}
            />
          )}
          {showRecoveryBanner ? (
            <RecoveryBanner
              balanceMsats={fedimint.balanceMsats ?? 0}
              source={strandedSource}
              fetchKind0Enabled={false}
              onRecover={() => {
                // v0.3.0 Phase 4: open RecoveryPayoutModal — no
                // queued follow-up since this path isn't gated by a
                // pending federation switch.
                setPendingRecovery({
                  title: "Recover sats",
                });
              }}
            />
          ) : (
            <BrowseView
              browseCategory={browseCategory}
              setBrowseCategory={setBrowseCategory}
              browseCommunity={browseCommunity}
              onSelectCommunity={handleSelectCommunity}
              matchingListings={matchingListings}
              nonMatchingListings={nonMatchingListings}
              fedimintJoined={fedimint.joined}
              isFirstTime={getUserCommunitySlugRaw() === null}
              onPasteCustomInvite={handlePasteCustomInvite}
              pubkey={pubkey!}
              onOpenEscrow={openEscrow}
              onLoadById={async (id) => {
                try {
                  setToast({ message: "Loading from relays...", type: "info" });
                  const state = await actions.loadEscrow(id);
                  if (state) {
                    setToast({ message: "Trade loaded!", type: "success" });
                    setSelectedId(id);
                    setView("detail");
                  } else {
                    setToast({ message: "Trade not found on relays", type: "error" });
                  }
                } catch (e: any) {
                  setToast({ message: e.message || "Failed to load", type: "error" });
                }
              }}
            />
          )}
        </>
      )}

      <BottomNav active={activeTab} onSelect={switchTab} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers — global CSS + login splash
// ══════════════════════════════════════════════════════════════════════════

const globalCss = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800;900&display=swap');
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  *{box-sizing:border-box;margin:0;padding:0}
  input::placeholder{color:${T.muted}88}
  input:focus,select:focus{border-color:${T.accent}66!important}
  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:4px}
`;

// v0.2.0 item 3: Create-block gate. When the user is buyer/seller in a
// non-terminal escrow, Create renders this gate-card instead of the
// form. The active-trade pill above (separately rendered) provides
// the navigation; this card explains the why and offers a redundant
// CTA for users who don't see the pill or want explicit confirmation.
function CreateBlockedCard({
  trade,
  onGoToTrade,
}: {
  trade: EscrowState;
  onGoToTrade: () => void;
}) {
  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{
        background: T.purpleDim, border: `1px solid ${T.purple}66`,
        borderRadius: T.r, padding: 24,
        textAlign: "center" as const,
      }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
        <div style={{
          fontSize: 16, fontWeight: 700, color: T.text, fontFamily: T.sans,
          marginBottom: 12,
        }}>
          Finish your active trade first
        </div>
        <div style={{
          fontSize: 13, color: T.text, fontFamily: T.sans,
          lineHeight: 1.55, marginBottom: 16,
        }}>
          Chama is one trade at a time, on purpose. Patience is the
          feature — a good trade is one where both users felt safe and
          left a positive rating, not one that completed at high
          frequency.
        </div>
        <button
          onClick={onGoToTrade}
          style={{
            padding: "12px 20px", borderRadius: T.rs,
            background: T.purple, border: "none",
            color: T.bg, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
            cursor: "pointer", letterSpacing: 0.3,
          }}
        >
          Go to active trade ›
        </button>
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          marginTop: 12, lineHeight: 1.5,
        }}>
          {trade.description}
        </div>
      </div>
    </div>
  );
}

function LoginSuccessSplash() {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: T.bg,
      animation: "fadeIn 0.3s ease-out",
    }}>
      <div style={{
        width: 80, height: 80, borderRadius: "50%",
        background: T.greenDim, border: "2px solid " + T.green,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 20, animation: "fadeIn 0.4s ease-out",
      }}>
        <span style={{ fontSize: 36 }}>✓</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: T.green, fontFamily: T.mono, marginBottom: 8 }}>
        Connected!
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
        Signer authenticated via Nostr
      </div>
    </div>
  );
}

