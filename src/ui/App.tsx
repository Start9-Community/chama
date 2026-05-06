import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

import { useEscrow } from "../hooks/useEscrow.js";
import { type EscrowState, TRULY_TERMINAL_STATES } from "../escrow-engine/types.js";
import { getFederationInvite, getActiveInvite } from "../fedimint/index.js";
import { getCommunityBySlug, DEFAULT_COMMUNITY_SLUG } from "../communities/registry.js";
import { getUserCommunitySlugRaw } from "../communities/storage.js";

import { T } from "./theme.js";
import {
  decideCommunityTapEffect,
  decideAutoInitTarget,
  shouldShowBrowserSupportBanner,
} from "./decisions.js";
import { Toast } from "./components/Toast.js";
import { BottomNav, BOTTOM_NAV_HEIGHT, type Tab } from "./components/BottomNav.js";
import { BrowserSupportBanner } from "./components/BrowserSupportBanner.js";
import { useBrowserBanner } from "./hooks/useBrowserBanner.js";
import { useFederationCommands } from "./hooks/useFederationCommands.js";

import { BrowseView } from "./screens/BrowseView.js";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { TradeDetail } from "./screens/TradeDetail.js";
import { CreateForm } from "./screens/CreateForm.js";
import { MeScreen } from "./screens/MeScreen.js";
import { SettingsAdvanced } from "./screens/SettingsAdvanced.js";

import { WalletBar } from "./panels/WalletBar.js";
import { FedimintBar } from "./panels/FedimintBar.js";
import { DestroyEcashConfirmModal } from "./panels/DestroyEcashConfirmModal.js";
import { FundWalletModal } from "./panels/FundWalletModal.js";
import { SavedHandlesPanel } from "./panels/SavedHandlesPanel.js";

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
  } | null>(null);
  const [autoInitDone, setAutoInitDone] = useState(false);
  // Browser-support banner state lives in a dedicated hook so the
  // per-pubkey scoping (Bug E from v0.1.85 smoke testing) stays
  // testable in isolation and App.tsx stays an orchestrator.
  const { dismissed: browserBannerDismissed, dismiss: dismissBrowserBanner } =
    useBrowserBanner(pubkey);

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
    if (fedimint.joined || fedimint.busy || fedimint.initialized) return;

    const target = decideAutoInitTarget({
      activeInvite: getActiveInvite(),
      homeCommunity: getUserCommunitySlugRaw(),
      hasCurrentEscrow: false,
      balanceMsats: 0,
    });

    if (target.kind === "skip") return;
    setAutoInitDone(true);

    // Both use-active and use-home dispatch through initFedimint(invite).
    // The v0.1.74 reconciliation guard inside initFedimint handles the
    // case where the desired invite differs from the OPFS-bound one
    // AND a non-zero balance is detected — it throws
    // RECONCILE_REFUSED_NONZERO_BALANCE and we surface the modal.
    const failureLabel =
      target.kind === "use-home"
        ? (getCommunityBySlug(target.slug)?.displayName ?? target.slug)
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
  }, [connected, autoInitDone, fedimint.joined, fedimint.busy, fedimint.initialized, actions]);

  const now = Math.floor(Date.now() / 1000);
  const HIDE_AFTER = 7 * 86400;
  const myFederationInvite = fedimint.joined ? getFederationInvite() : null;

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

  const matchesBrowseCategory = (s: EscrowState) => {
    if (browseCategory === "all") return true;
    if (browseCategory === "subscription") return s.subscription !== null;
    return s.category === browseCategory;
  };
  const matchesBrowseCommunity = (s: EscrowState) =>
    s.community === browseCommunity;

  const browseList = visibleTrades.filter(s =>
    !isParticipant(s) &&
    s.status === "CREATED" &&
    (myFederationInvite ? s.mintUrl === myFederationInvite : false) &&
    matchesBrowseCategory(s) &&
    matchesBrowseCommunity(s)
  );
  const selected = selectedId ? escrows.get(selectedId) : null;

  // v0.1.66.32: refetch on tap when local state may be stale.
  const openEscrow = (id: string) => {
    setSelectedId(id);
    setView("detail");
    const local = escrows.get(id);
    const shouldRefetch =
      !local || !TRULY_TERMINAL_STATES.has(local.status);
    if (shouldRefetch) {
      actions.loadEscrow(id).catch((e: any) => {
        console.debug(
          "[chama] background refetch on openEscrow failed:",
          e?.message || e,
        );
      });
    }
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

      {/* Chama (Fedimint) bar. showReconnect is true for users who have
          a reconnect target (picked community or active invite) so the
          Reconnect CTA appears after a failed switch+revert; first-time
          users (no community yet) don't see it because their join path
          is community pills, not Reconnect. */}
      <FedimintBar
        fedimint={fedimint}
        showReconnect={getUserCommunitySlugRaw() !== null || getActiveInvite() !== null}
        onFund={() => setShowFundModal(true)}
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
          onClose={() => setShowFundModal(false)}
          onCreateInvoice={(amountSats, desc) =>
            actions.createFundingInvoice(amountSats * 1000, desc)
          }
          onPayInvoice={(bolt11) => actions.payInvoice(bolt11)}
          onSpendNotes={(amountMsats) => actions.spendNotes(amountMsats)}
          balanceMsats={fedimint.balanceMsats ?? 0}
        />
      )}

      {/* Federation drift confirm */}
      {pendingDestroyConfirm && (
        <DestroyEcashConfirmModal
          targetLabel={pendingDestroyConfirm.label}
          balanceMsats={pendingDestroyConfirm.balanceMsats}
          onCancel={() => {
            actions.setCustomInvite(pendingDestroyConfirm.activeInvite);
            setPendingDestroyConfirm(null);
            actions.initFedimint(pendingDestroyConfirm.activeInvite).catch((e: any) =>
              setToast({ message: e?.message || "Re-init failed", type: "error" })
            );
          }}
          onConfirm={async () => {
            const target = pendingDestroyConfirm;
            setPendingDestroyConfirm(null);
            try {
              setToast({ message: "Switching Chama…", type: "info" });
              await actions.initFedimint(target.invite, { force: true });
              setToast({ message: `Joined ${target.label}!`, type: "success" });
            } catch (e: any) {
              setToast({ message: e?.message || "Switch failed", type: "error" });
            }
          }}
        />
      )}

      {/* Content — routed by view */}
      {view === "detail" && selected ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <TradeDetail
            state={selected}
            pubkey={pubkey!}
            onBack={() => { setView("browse"); setSelectedId(null); }}
            onVote={(outcome) => actions.vote(selectedId!, outcome).then(
              () => setToast({ message: `Voted ${outcome}!`, type: "success" }),
              (e: any) => setToast({ message: e.message, type: "error" })
            )}
            onClaim={() => {
              actions.claimAndRedeem(selectedId!).catch((e: any) => {
                console.debug("[chama] Claim action threw (already toasted):", e?.message);
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
              try {
                setToast({ message: "Spending ecash & splitting shares...", type: "info" });
                await actions.lockAndPublish(selectedId!, { savedHandleId });
                setToast({ message: "Locked! Vote buttons are live.", type: "success" });
              } catch (e: any) {
                setToast({ message: e.message || "Lock failed", type: "error" });
              }
            }}
            onOpenSettings={() => setView("saved-handles")}
          />
        </div>
      ) : view === "create" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <CreateForm
            onCreate={handleCreate}
            onClose={() => setView("browse")}
          />
        </div>
      ) : view === "me" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <MeScreen
            pubkey={pubkey!}
            myTrades={myTrades}
            onOpenTrade={openEscrow}
            onOpenSavedHandles={() => setView("saved-handles")}
            onOpenAdvanced={() => setView("advanced")}
            onSignOut={handleSignOut}
          />
        </div>
      ) : view === "saved-handles" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <SavedHandlesPanel
            communitySlug={actions.getCommunity()}
            onClose={() => setView("me")}
          />
        </div>
      ) : view === "advanced" ? (
        <div style={{ animation: "fadeIn 0.3s ease" }}>
          <SettingsAdvanced
            fedimint={fedimint}
            onBack={() => setView("me")}
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
        <BrowseView
          browseCategory={browseCategory}
          setBrowseCategory={setBrowseCategory}
          browseCommunity={browseCommunity}
          onSelectCommunity={handleSelectCommunity}
          browseList={browseList}
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
  *{box-sizing:border-box;margin:0;padding:0}
  input::placeholder{color:${T.muted}88}
  input:focus,select:focus{border-color:${T.accent}66!important}
  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:4px}
`;

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

