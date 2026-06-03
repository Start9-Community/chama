import { useEffect, useRef, useState } from "react";
import {
  type EscrowState,
  type ChatImageAttachment,
  type JoinPayload,
  type SelectedMenuItem,
  EscrowEventKind,
  Role,
  Outcome,
  EscrowStatus,
  getEffectiveParticipantsAt,
  getJoinHoldRemainingSeconds,
  joinHoldExpiresAt,
  selectedMenuItemsTotalMsats,
} from "../../escrow-engine/types.js";
import { getWinner } from "../../escrow-engine/state-machine.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getVoteLabel } from "../../labels/vote-labels.js";
import {
  listSavedHandles,
  maskHandle,
  handleDisplayForViewer,
} from "../../payments/saved-handles.js";
import { getRailByKey, matchRails, toRailKey, categoryUsesPaymentRails } from "../../payments/rail-registry.js";
import {
  T, STATUS, ROLE_COLOR, CAT_LABEL, TRINITY_RING_ORDER,
  fmtSats, refundRecipientFor, inputStyle,
} from "../theme.js";
import { listingPremiumLine } from "../listing-metrics.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { decideTradeDetailFraming, decideVotePrompt } from "../decisions.js";
import { pickArbiterFromPool } from "../../arbiters/pool.js";
import {
  hasStateBExplained,
  markStateBExplained,
} from "./state-b-explainer.js";
import { Badge } from "../components/Badge.js";
import { Dot } from "../components/Dot.js";
import { CountdownTimer } from "../components/CountdownTimer.js";
import { SubscriptionTimeline } from "../components/SubscriptionTimeline.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { BitcoinPricePill } from "../components/BitcoinPricePill.js";
import { NwcStatusBanner } from "../components/NwcStatusBanner.js";
import { ChatPanel } from "../panels/ChatPanel.js";
import {
  listSavedNwcConnections,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import { profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import {
  estimateFiatForMsats,
  formatFiatAmount,
  normalizeFiatCurrency,
  resolveEstimatedFiatCurrency,
  shouldQuoteEstimatedFiat,
  type AmountDisplayMode,
} from "../amount-display.js";

const samePubkey = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Copy text to the clipboard, robustly. navigator.clipboard is undefined or a
 *  no-op in some Tauri/Capacitor webviews (same class as window.confirm), so
 *  fall back to a hidden-textarea + execCommand("copy"). Returns whether a copy
 *  path was attempted; callers still show the ID so the user can hand-select if
 *  even the fallback is blocked. */
function copyTextRobust(text: string): void {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
      return;
    }
  } catch { /* fall through */ }
  execCommandCopy(text);
}
function execCommandCopy(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch { /* user can still hand-select the visible ID */ }
}

export function TradeDetail({
  state, pubkey, homeCommunity, bootProbeFailed, receiveUnavailable, fundingInProgress,
  claimBlockedReason, amountDisplayMode = "sats", onAmountDisplayModeChange, kind0Enabled = false, profileNames,
  disableNwc = false, onBack, onVote, onClaim, onJoin, onLock, onLockDirectNwc, onClaimDirectNwc,
  onSendChat, onReleasePeriod, onOpenSettings, onOpenNwcSettings,
  onPrewarmFunding, onRebroadcast, onForget, onPurchase, stockLeft, isOversoldOrder = false,
}: {
  state: EscrowState; pubkey: string;
  /** User's home community slug — drives State A vs State B subtitle
   *  on CREATED listings (item 1, listing-detail half). For LOCKED+
   *  trades the subtitle reflects trade status, not framing. */
  homeCommunity: string | null;
  /** v0.3.1 Phase 3: when true (bootProbeState === "failed"), Fund +
   *  Claim buttons render disabled with the "Federation unreachable —
   *  reconnect first" subtitle. The Reconnect CTA lives in ChamaBar
   *  per the Phase 3 directive (single source of truth for Reconnect);
   *  TradeDetail just gates its action buttons. The boolean is
   *  computed by App.tsx from fedimint.bootProbeState — passing the
   *  bool keeps TradeDetail's API minimal and explicit. */
  bootProbeFailed: boolean;
  /** Last Lightning receive attempt failed after the federation itself
   *  looked reachable. Funding is disabled until reconnect/preflight
   *  clears the receive-health cache; Claim remains governed by the
   *  boot probe because outbound payout can still be retry-safe. */
  receiveUnavailable: boolean;
  /** v0.6.5: true while another runFundAndLock flow is mid-flight on
   *  the shared OPFS wallet. Disables Fund and swaps its label to
   *  "{lockLabel} unavailable" + explanatory subtitle so users see
   *  why the button is greyed rather than just dead. */
  fundingInProgress: boolean;
  /** Terminal local claim settlement failure. When present, retrying
   *  the same CLAIM cannot help because the federation already consumed
   *  the ecash notes and the local mint reissue failed. */
  claimBlockedReason?: string | null;
  amountDisplayMode?: AmountDisplayMode;
  onAmountDisplayModeChange?: (mode: AmountDisplayMode) => void;
  kind0Enabled?: boolean;
  profileNames?: NostrProfileNameMap;
  /** Fedi Mini-App must stay on internal ecash paths, not NWC shortcuts. */
  disableNwc?: boolean;
  onBack: () => void;
  // v1.2.2 vote-freeze fix: typed as Promise<void> so handleVote can
  // await the publish-and-toast chain wired in App. The previous `void`
  // return type encouraged a fire-and-forget call that re-enabled the
  // button on a 1 s setTimeout even though the real publish takes
  // 8–16 s, making the screen look frozen.
  onVote: (outcome: Outcome) => Promise<void>;
  onClaim: () => Promise<void>;
  onJoin: (
    role: Role,
    opts?: { selectedItems?: SelectedMenuItem[]; amountMsats?: number; orderFinalized?: boolean },
  ) => void | Promise<void>;
  onLock: (opts?: {
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
    amountMsats?: number;
  }) => Promise<void>;
  /**
   * v1.2.4: direct-NWC fund path. When a user has a saved NWC wallet,
   * the Fund button bypasses the AtomicFundingModal chooser and calls
   * this prop, which routes straight to actions.fundAndLock with
   * fundingMethod=nwc. Phase updates flow through onPhase so the
   * button can render inline progress ("Funding via Alby…",
   * "Locking…"). Returns the terminal so the button can show
   * success/failure copy after the action resolves.
   */
  onLockDirectNwc?: (opts: {
    nwcConnectionString: string;
    savedHandleId?: string;
    selectedItems?: SelectedMenuItem[];
    amountMsats: number;
    onPhase?: (label: string) => void;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * v1.2.4: direct-NWC claim path. Mirror of onLockDirectNwc — when
   * the winner has a saved NWC wallet, Claim resolves a destination
   * invoice via NWC make_invoice and dispatches the claim in one
   * shot, no modal.
   */
  onClaimDirectNwc?: (opts: {
    nwcConnectionString: string;
    onPhase?: (label: string) => void;
  }) => Promise<{ ok: boolean; error?: string }>;
  onPrewarmFunding?: () => void | Promise<void>;
  onSendChat: (message: string | { message: string; attachments?: ChatImageAttachment[] }) => void;
  onReleasePeriod?: (periodIndex: number) => void | Promise<void>;
  onOpenSettings?: () => void;
  /** Opens Me › Advanced Settings focused on the NWC wallets section.
   *  Distinct from onOpenSettings (which opens saved Payment Handles). */
  onOpenNwcSettings?: () => void;
  /** Re-broadcast this trade's full event chain to today's relays — heals a
   *  "ghost" trade the counterparty can't see (events never reached their
   *  relays). Surfaced in the Advanced event-chain panel. Resolves with how
   *  many of the chain's events at least one relay accepted. */
  onRebroadcast?: (escrowId: string) => Promise<{ published: number; total: number }>;
  /** Forget this trade locally (drop saved pointer + hide from the list) for
   *  unrecoverable ghosts. Money stays in escrow; re-loadable by ID. App
   *  navigates back to the list after this resolves. */
  onForget?: (escrowId: string) => void;
  /** #7 multi-unit storefront: buy `quantity` units from THIS parent listing.
   *  Spawns a child purchase escrow and navigates to it (App handles that), so
   *  the buyer locks the child via the normal flow. */
  onPurchase?: (parentId: string, quantity: number) => void | Promise<void>;
  /** #7 multi-unit storefront: derived units left on this parent listing (for
   *  the buy stepper's max + the "N left" line). */
  stockLeft?: number;
  /** #7 seller overcommit refund: this child order is OVERSOLD (locked beyond
   *  the parent's stock by lock order). Reliable only for the seller. Shows a
   *  refund banner. */
  isOversoldOrder?: boolean;
}) {
  const btcPrice = useBitcoinPrice();
  const fiatRates = useFiatRates();
  const homeQuoteCurrency = homeCommunity ? getCommunityBySlug(homeCommunity)?.currency ?? null : null;
  // v0.2.0 item 1: State A/B framing for CREATED listings. By the time
  // the detail screen renders, the silent re-init has already landed
  // the user on the listing's fed (the openEscrow dispatch in
  // App.tsx handles that). State B's narration is past-tense:
  // "Running on BLF · we switched you in for this trade."
  const framing = decideTradeDetailFraming({
    listingMintUrl: state.mintUrl,
    listingCommunity: state.community,
    homeCommunity,
  });
  const fundUnavailable = bootProbeFailed || receiveUnavailable;
  const [voting, setVoting] = useState(false);
  const [joining, setJoining] = useState(false);
  const [locking, setLocking] = useState(false);
  // Advanced "re-broadcast / heal" — idle → broadcasting → a result line.
  const [rebroadcasting, setRebroadcasting] = useState(false);
  const [rebroadcastResult, setRebroadcastResult] = useState<string | null>(null);
  const [rebroadcastDone, setRebroadcastDone] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  // Inline two-tap forget confirm (no native confirm() — it's a no-op in the
  // Tauri/Capacitor webview, which made the button look frozen).
  const [forgetArmed, setForgetArmed] = useState(false);
  // #7 multi-unit storefront: buyer "Buy N units" quantity + in-flight flag.
  const [buyQty, setBuyQty] = useState(1);
  const [purchasing, setPurchasing] = useState(false);

  // v1.2.4: direct-NWC paths for Fund + Claim. When the user has a
  // saved NWC wallet, the action buttons skip the chooser modal and
  // route straight to actions.fundAndLock / claimAndPayout with NWC
  // auto-pay. The banner above each button surfaces connection state
  // and lets the user paste a wallet inline. directNwcFundPhase and
  // directNwcClaimPhase carry the current phase label for inline
  // progress on the button while the action is in flight; null means
  // the action is idle.
  const [savedNwcs, setSavedNwcs] = useState<SavedNwcConnection[]>(
    () => listSavedNwcConnections(),
  );
  const activeNwc = !disableNwc && savedNwcs.length > 0 ? savedNwcs[0] : null;
  const [directNwcFundPhase, setDirectNwcFundPhase] = useState<string | null>(null);
  const [directNwcClaimPhase, setDirectNwcClaimPhase] = useState<string | null>(null);
  const refreshSavedNwcs = () => setSavedNwcs(listSavedNwcConnections());
  // v0.3.0 Phase 3: claiming flag survives the ClaimPayoutModal lifetime
  // via the promise-based onClaim contract (mirrors Phase 2's onLock).
  // Disables the Claim button while the modal is open so re-taps can't
  // queue another flow.
  const [claiming, setClaiming] = useState(false);
  const [selectedHandleId, setSelectedHandleId] = useState<string>("");
  const [menuQuantities, setMenuQuantities] = useState<Record<string, number>>({});
  const [menuAmounts, setMenuAmounts] = useState<Record<string, string>>({});
  // v0.3.0 Phase 6: one-time educational card for State B (cross-fed
  // listing). Renders ONCE per pubkey, same gate-pattern as v0.2.0's
  // first-publish honesty card. Dismiss is sticky in localStorage.
  const [stateBDismissed, setStateBDismissed] = useState(() => hasStateBExplained(pubkey));
  const nowSec = Math.floor(Date.now() / 1000);
  const menuItems = state.items ?? [];
  const hasMenu = menuItems.length > 0;
  const hasExchangeMenu = hasMenu && state.category === "p2p-trade";
  const selectedMenuItems: SelectedMenuItem[] = hasMenu
    ? hasExchangeMenu
      ? menuItems.flatMap(item => {
          const exactSats = parsePositiveWholeSats(menuAmounts[item.id] ?? "");
          if (exactSats <= 0) return [];
          const exactMsats = exactSats * 1000;
          const minMsats = item.minAmountMsats ?? item.amountMsats;
          const maxMsats = item.maxAmountMsats ?? item.amountMsats;
          if (exactMsats < minMsats || exactMsats > maxMsats) return [];
          return [{
            itemId: item.id,
            label: item.label,
            kind: item.kind,
            amountMsats: exactMsats,
            quantity: 1,
            minAmountMsats: item.minAmountMsats,
            maxAmountMsats: item.maxAmountMsats,
            description: item.description,
            fiatAmount: item.fiatAmount,
            fiatCurrency: item.fiatCurrency,
            fulfillment: item.fulfillment,
            imageDataUrl: item.imageDataUrl,
            dueAt: item.dueAt,
            termDays: item.termDays,
            aprBps: item.aprBps,
            trustTier: item.trustTier,
          }];
        })
      : menuItems.flatMap(item => {
        const quantity = menuQuantities[item.id] ?? 0;
        if (quantity <= 0) return [];
        return [{
          itemId: item.id,
          label: item.label,
          kind: item.kind,
          amountMsats: item.amountMsats,
          quantity,
          minAmountMsats: item.minAmountMsats,
          maxAmountMsats: item.maxAmountMsats,
          description: item.description,
          fiatAmount: item.fiatAmount,
          fiatCurrency: item.fiatCurrency,
          fulfillment: item.fulfillment,
          imageDataUrl: item.imageDataUrl,
          dueAt: item.dueAt,
          termDays: item.termDays,
          aprBps: item.aprBps,
          trustTier: item.trustTier,
        }];
      })
    : [];
  const selectedMenuAmountMsats = selectedMenuItemsTotalMsats(selectedMenuItems);
  const menuSelectorRole = state.category === "lending" ? Role.SELLER : Role.BUYER;
  const savedOrderItems = state.joinHolds?.[menuSelectorRole]?.selectedItems ?? [];
  const savedOrderAmountMsats =
    selectedMenuItemsTotalMsats(savedOrderItems)
    || state.joinHolds?.[menuSelectorRole]?.amountMsats
    || 0;
  const savedOrderKey = savedOrderItems
    .map(item => `${item.itemId}:${item.amountMsats}:${item.quantity}`)
    .join("|");
  const selectedOrderKey = selectedMenuItems
    .map(item => `${item.itemId}:${item.amountMsats}:${item.quantity}`)
    .join("|");
  const acceptedPaymentMethods = (state.paymentMethods ?? [])
    .map(method => method.trim())
    .filter(Boolean);
  // #4: suggest + match a shared payment rail before lock. Intersect the
  // seller's accepted rails with the rails THIS viewer can pay on (their saved
  // handles), community-ranked. Surfaced to a prospective buyer (not the
  // seller, who set the rails). The seller's matched handle is revealed at lock.
  const viewerRailKeys = listSavedHandles().map(h => h.rail);
  const railMatch = matchRails(state.paymentMethods, viewerRailKeys, state.community);
  const sharedRailSet = new Set(railMatch.shared);
  const suggestedRail = railMatch.suggested ? getRailByKey(railMatch.suggested) : null;
  // #7 multi-unit storefront: a parent listing (stock set, no parent ref) is
  // bought by quantity — each purchase spawns its own child escrow rather than
  // locking the parent. The buy stepper clamps to the units left.
  const isMultiUnitParent = state.stock !== undefined && state.parent === undefined;
  // Units a buyer can still take. stockLeft is the derived remaining (0 when
  // sold out); fall back to the listing's stock only when remaining is unknown.
  // NOT floored at 1 — the old Math.max(1, …) let a buyer purchase a sold-out
  // listing (stockLeft 0 → still offered "Buy 1"), which is how 6 units sold
  // from a stock of 5. (The genuine concurrent last-unit race is still possible
  // on a coordinator-free relay backbone — Option A: the loser refunds — but no
  // one can buy a *visibly* sold-out listing.)
  const buyMax = stockLeft !== undefined ? Math.max(0, stockLeft) : (state.stock ?? 1);
  const soldOut = isMultiUnitParent && buyMax <= 0;
  const buyQtyClamped = Math.min(Math.max(1, buyQty), Math.max(1, buyMax));
  const premiumLine = listingPremiumLine(state, btcPrice.usd);
  const selectionMatchesSavedOrder = selectedOrderKey.length > 0 && selectedOrderKey === savedOrderKey;
  const savedOrderFinalizedAt = state.joinHolds?.[menuSelectorRole]?.orderFinalizedAt ?? null;
  const savedOrderFinalized = !!savedOrderFinalizedAt;
  const participants = getEffectiveParticipantsAt(state, nowSec);
  const myRole = samePubkey(participants.buyer, pubkey) ? Role.BUYER
    : samePubkey(participants.seller, pubkey) ? Role.SELLER
    : samePubkey(participants.arbiter, pubkey) ? Role.ARBITER : null;
  const participantPubkeys = [
    participants.buyer,
    participants.seller,
    participants.arbiter,
  ].filter((pk): pk is string => !!pk);
  const sellerPubkey = participants.seller
    ?? (state.initiator.role === Role.SELLER ? state.initiator.pubkey : null);
  const sellerProfileName = profileNameFor(profileNames, sellerPubkey, kind0Enabled);
  const participantPubkeySet = new Set(participantPubkeys.map(pk => pk.toLowerCase()));
  const hasDuplicateParticipant = participantPubkeys.length !== participantPubkeySet.size;
  const currentKeyAlreadyPresent =
    samePubkey(state.initiator.pubkey, pubkey) || participantPubkeys.some(pk => samePubkey(pk, pubkey));
  // v0.6.5: deterministic preview of which arbiter LOCK will pick from
  // the community pool, used purely for the Trinity-Ring "auto-assigned"
  // dot on CREATED listings that don't yet have a JOINed arbiter. Same
  // function escrow-bridge.ts uses at LOCK time, so the predicted
  // pubkey matches the eventual real assignment.
  const previewArbiterPk = state.status === EscrowStatus.CREATED
    && !participants[Role.ARBITER]
    && state.communityArbiters.length > 0
    ? (pickArbiterFromPool(state.communityArbiters, state.id, [
        participants[Role.BUYER],
        participants[Role.SELLER],
      ]) ?? null)
    : null;
  const votePrompt = decideVotePrompt(state, pubkey, participants);
  const winner = getWinner(state);
  const iAmWinner = samePubkey(winner?.pubkey, pubkey);
  const claimRetryBlocked =
    state.status === EscrowStatus.CLAIMED &&
    !!claimBlockedReason &&
    /reissue|consumed|settle/i.test(claimBlockedReason);
  const statusKey = claimRetryBlocked ? "CLAIM_FAILED" : state.status;
  const s = STATUS[statusKey] || STATUS.CREATED;

  const expectedLocker = state.category === "marketplace" ? Role.BUYER
    : state.category === "lending" ? Role.SELLER
    : (state.category === "p2p-trade" || state.category === "bill-pay") ? Role.SELLER
    : null;
  const canILock = !expectedLocker || myRole === expectedLocker;
  const canSelectMenu =
    hasMenu &&
    state.status === EscrowStatus.CREATED &&
    myRole === menuSelectorRole &&
    !savedOrderFinalized;
  const selectorNeedsSaveOrder = canSelectMenu && !canILock;
  const lockMenuItems = hasMenu && canILock && myRole !== menuSelectorRole
    ? savedOrderItems
    : selectedMenuItems;
  const lockMenuAmountMsats = selectedMenuItemsTotalMsats(lockMenuItems);
  const lockAmountMsats = hasMenu && lockMenuAmountMsats > 0
    ? lockMenuAmountMsats
    : state.amountMsats;
  const lockRequiresFinalOrder = hasMenu && canILock && myRole !== menuSelectorRole;
  const menuOrderNotFinal = lockRequiresFinalOrder && lockMenuItems.length > 0 && !savedOrderFinalized;
  const createdMenuRows = canSelectMenu
    ? menuItems
    : savedOrderItems.length > 0
      ? savedOrderItems
      : [];
  const renderedMenuRows = state.status === EscrowStatus.CREATED
    ? createdMenuRows
    : state.lock.selectedItems ?? [];
  const menuDisplayAmountMsats = canSelectMenu
    ? selectedMenuAmountMsats || savedOrderAmountMsats
    : lockMenuAmountMsats || savedOrderAmountMsats;
  const hasEligibleArbiter =
    !!participants[Role.ARBITER] || !!previewArbiterPk;
  const lockBlockedByNoArbiter =
    state.status === EscrowStatus.CREATED &&
    !!participants[Role.BUYER] &&
    !hasEligibleArbiter;
  const canJoinAsArbiter =
    !participants.arbiter &&
    !previewArbiterPk &&
    state.communityArbiters.includes(pubkey);
  const canJoinAsBuyer = !participants.buyer;
  const canJoinAsSeller = !participants.seller;
  const canJoinTrade = canJoinAsBuyer || canJoinAsSeller || canJoinAsArbiter;
  const prewarmedEscrowRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onPrewarmFunding) return;
    if (state.status !== EscrowStatus.CREATED) return;
    if (!canILock || bootProbeFailed || receiveUnavailable || fundingInProgress || menuOrderNotFinal) return;
    if (prewarmedEscrowRef.current === state.id) return;
    prewarmedEscrowRef.current = state.id;
    void onPrewarmFunding();
  }, [
    state.id,
    state.status,
    canILock,
    bootProbeFailed,
    receiveUnavailable,
    fundingInProgress,
    menuOrderNotFinal,
    onPrewarmFunding,
  ]);

  useEffect(() => {
    if (!hasMenu || state.status !== EscrowStatus.CREATED) return;
    if (hasExchangeMenu) {
      setMenuAmounts(prev => {
        const next: Record<string, string> = {};
        for (const item of menuItems) {
          next[item.id] = prev[item.id] ?? "";
        }
        return next;
      });
      return;
    }
    setMenuQuantities(prev => {
      const next: Record<string, number> = {};
      for (const item of menuItems) {
        next[item.id] = Math.max(0, prev[item.id] ?? 0);
      }
      return next;
    });
  }, [hasExchangeMenu, hasMenu, state.id, state.status, menuItems]);

  useEffect(() => {
    if (!hasMenu || state.status !== EscrowStatus.CREATED || savedOrderItems.length === 0) return;
    if (hasExchangeMenu) {
      setMenuAmounts(prev => {
        const next = { ...prev };
        for (const item of savedOrderItems) {
          if (!next[item.itemId]) next[item.itemId] = satsInputValue(item.amountMsats);
        }
        return next;
      });
      return;
    }
    setMenuQuantities(prev => {
      const next = { ...prev };
      for (const item of savedOrderItems) {
        if (!next[item.itemId]) next[item.itemId] = item.quantity;
      }
      return next;
    });
  }, [savedOrderKey, hasExchangeMenu, hasMenu, state.id, state.status]);

  const lockLabel = state.category === "marketplace" ? "Pay for Order"
    : state.category === "lending" ? "Fund Loan"
    : state.category === "bill-pay" ? "Fund Bill Order"
    : state.category === "p2p-trade" ? "Fund Buyer Order"
    : "Lock Sats";
  const liveJoinHold = state.status === EscrowStatus.CREATED
    ? [Role.BUYER, Role.SELLER]
        .filter(role => role !== state.initiator.role)
        .map(role => {
          const remaining = getJoinHoldRemainingSeconds(state, role, nowSec);
          const hold = state.joinHolds?.[role];
          return remaining && remaining > 0 && hold
            ? { role, expiresAt: hold.expiresAt, remaining }
            : null;
        })
        .filter((hold): hold is { role: Role; expiresAt: number; remaining: number } => !!hold)
        .sort((a, b) => a.expiresAt - b.expiresAt)[0] ?? null
    : null;
  const expiredJoinHold = state.status === EscrowStatus.CREATED
    ? [Role.BUYER, Role.SELLER]
        .filter(role => role !== state.initiator.role)
        .map(role => {
          const hold = state.joinHolds?.[role];
          if (!hold || state.participants[role] !== hold.pubkey || participants[role]) return null;
          return hold.expiresAt <= nowSec
            ? { role, pubkey: hold.pubkey, expiredAgo: nowSec - hold.expiresAt }
            : null;
        })
        .filter((hold): hold is { role: Role; pubkey: string; expiredAgo: number } => !!hold)
        .sort((a, b) => b.expiredAgo - a.expiredAgo)[0] ?? null
    : null;
  const liveLockWindowRole = liveJoinHold
    ? expectedLocker ?? liveJoinHold.role
    : null;
  // #7 Stage 0 — contention visibility. When the viewer is NOT a participant
  // (a would-be second buyer / observer) and the live hold belongs to someone
  // else, surface it honestly so they aren't stranded thinking they joined:
  // "reserved — being viewed by another buyer, Ns left." Frees on expiry,
  // taken on lock. The reducer already rejects their JOIN (ROLE_TAKEN); this
  // just makes that truth visible instead of a phantom lock window.
  const reservedByOther = (!myRole && liveJoinHold
    && state.joinHolds?.[liveJoinHold.role]
    && !samePubkey(state.joinHolds[liveJoinHold.role]!.pubkey, pubkey))
    ? liveJoinHold
    : null;
  const buyerJoinEvents = state.status === EscrowStatus.CREATED
    ? state.eventChain.filter(event => event.kind === EscrowEventKind.JOIN
        && (event.payload as JoinPayload).role === Role.BUYER)
    : [];
  const buyerAttemptRows = buyerJoinEvents
    .map((event, index) => {
      const payload = event.payload as JoinPayload;
      const selectedItems = payload.selectedItems ?? [];
      const amountMsats = payload.amountMsats
        ?? selectedMenuItemsTotalMsats(selectedItems)
        ?? 0;
      const expiresAt = payload.holdExpiresAt ?? joinHoldExpiresAt(payload.joinedAt);
      const isLatest = index === buyerJoinEvents.length - 1;
      const isLive = isLatest && expiresAt > nowSec;
      const finalized = !!payload.orderFinalizedAt;
      const statusLabel = isLive
        ? finalized ? "ready" : "holding"
        : expiresAt <= nowSec ? "expired" : "updated";
      return {
        id: event.raw.id,
        pubkey: event.pubkey,
        joinedAt: payload.joinedAt,
        expiresAt,
        amountMsats,
        selectedCount: selectedItems.length,
        statusLabel,
        isLive,
      };
    })
    .sort((a, b) => b.joinedAt - a.joinedAt);
  const showBuyerAttempts =
    state.category === "p2p-trade"
    && state.status === EscrowStatus.CREATED
    && buyerAttemptRows.length > 0
    && !!sellerPubkey
    && samePubkey(sellerPubkey, pubkey);
  const nextStep = detailNextStep({
    state,
    myRole,
    canILock,
    hasMenu,
    menuSelectorRole,
    savedOrderFinalized,
    savedOrderAmountMsats,
    lockAmountMsats,
    menuSelectionMissing: hasMenu && lockMenuItems.length === 0,
    menuOrderNotFinal,
    participantsBuyer: participants.buyer ?? undefined,
    votePromptKind: votePrompt.kind,
    iAmWinner,
    claimRetryBlocked,
    canJoinTrade,
  });
  const heroAmountMsats = nextStep.amountMsats ?? (menuDisplayAmountMsats || state.amountMsats);
  const exactHeroFiat = detailHeroFiatAmount({
    state,
    selectedMenuItems,
    savedOrderItems,
    menuItems,
  });
  const estimatedHeroFiat = detailEstimatedHeroFiatAmount({
    state,
    amountMsats: heroAmountMsats,
    quoteCurrency: homeQuoteCurrency,
    usdPerBtc: btcPrice.usd,
    usdFiatRates: fiatRates.rates,
  });
  const quoteViewerFiat = shouldQuoteEstimatedFiat({
    viewerCurrency: homeQuoteCurrency,
    listingCurrency: exactHeroFiat?.currency
      ?? state.fiatCurrency
      ?? (state.community ? getCommunityBySlug(state.community)?.currency : null),
  });
  // Always anchor the headline on the seller's NATIVE listing price. Never
  // swap it for the viewer's converted estimate — a cross-country buyer (e.g.
  // a KES Chama viewing a TZS listing, same fed) would otherwise see a number
  // in their own currency and assume that IS the price. The viewer-currency
  // estimate rides alongside as a secondary "≈" line whenever the viewer's
  // Chama currency differs from the listing's. (Browse/TradeCard does the same.)
  const heroFiat = exactHeroFiat ?? estimatedHeroFiat;
  const heroFiatLabel = heroFiat ? formatFiatAmount(heroFiat.amount, heroFiat.currency) : null;
  const viewerEstimate = quoteViewerFiat
    && estimatedHeroFiat
    && (!heroFiat || normalizeFiatCurrency(estimatedHeroFiat.currency) !== normalizeFiatCurrency(heroFiat.currency))
      ? estimatedHeroFiat
      : null;
  const viewerEstimateLabel = viewerEstimate
    ? `≈ ${formatFiatAmount(viewerEstimate.amount, viewerEstimate.currency)}`
    : null;
  const premiumCheckoutLine = detailPremiumCheckoutLine(state, heroFiat);
  const showHeroFiat = amountDisplayMode === "fiat" && !!heroFiatLabel;
  const shortTradeId = state.id.length > 18 ? `${state.id.slice(0, 10)}…${state.id.slice(-6)}` : state.id;
  const tradeRoomTitle = state.status === EscrowStatus.CREATED
    ? hasMenu ? "Build the order" : "Ready to start"
    : state.status === EscrowStatus.LOCKED
      ? "Trade is live"
      : state.status === EscrowStatus.COMPLETED
        ? "Trade complete"
        : state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED
          ? "Ready to settle"
          : "Trade room";
  const releaseVoteCount = Object.values(state.votes).filter(v => v === Outcome.RELEASE).length;
  const refundVoteCount = Object.values(state.votes).filter(v => v === Outcome.REFUND).length;
  const decisionTone = state.resolvedOutcome === Outcome.RELEASE
    ? T.green
    : state.resolvedOutcome === Outcome.REFUND
      ? T.amber
      : T.teal; // pending: tie the "awaiting decision" chip to the teal Arbiter above it
  const decisionLabel = state.resolvedOutcome ? "final decision" : "awaiting decision";
  const decisionValue = state.resolvedOutcome ?? "pending";
  const heroImages = [
    ...(renderedMenuRows.length > 0 ? renderedMenuRows : menuItems),
  ].filter(item => !!item.imageDataUrl).slice(0, 2);
  // Trade detail follows the sketch: route education stays as a tiny
  // context note in the hero instead of a full pre-room card.
  const showVerboseRouteEducation = false;
  const routeNote = state.status === EscrowStatus.CREATED
    ? framing.kind === "state-b"
      ? `Cross-fed · ${framing.listingFlagEmoji} ${framing.listingCommunityName}`
      : framing.sameFedSameCommunity
        ? "Same community"
        : "Same federation"
    : null;

  const handleVote = async (outcome: Outcome) => {
    // v1.2.2 vote-freeze fix: await the wired publish-and-toast
    // chain so the button reflects the REAL flight duration
    // (8–16 s typical) instead of resetting after 1 s. With the
    // previous fire-and-forget pattern, sellers would tap, see no
    // visible change, tap again, and the second tap hit the
    // VOTE_SUPPRESSED swallow path with no UI feedback at all.
    // Now: button stays "publishing" until the toast fires.
    if (voting) return;
    setVoting(true);
    try {
      await onVote(outcome);
    } finally {
      setVoting(false);
    }
  };

  return (
    <div className="trade-detail-shell">
      <div className="trade-live-head" style={{
        display: "grid",
        gridTemplateColumns: "42px minmax(0,1fr) auto",
        alignItems: "center",
        gap: 12,
        marginBottom: 18,
      }}>
        <button onClick={onBack} aria-label="Back" style={{
          width: 38,
          height: 38,
          borderRadius: 999,
          background: T.surface,
          border: `1px solid ${T.border}`,
          color: T.text,
          fontFamily: T.mono,
          fontSize: 18,
          cursor: "pointer",
          lineHeight: 1,
        }}>
          ←
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: T.muted,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            marginBottom: 3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {CAT_LABEL[state.category] || state.category} · {shortTradeId}
          </div>
          <div className="trade-detail-title" style={{
            color: T.text,
            fontFamily: T.sans,
            fontSize: 22,
            fontWeight: 800,
            lineHeight: 1.08,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {tradeRoomTitle}
          </div>
        </div>
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
          minWidth: 0,
        }}>
          <BitcoinPricePill
            compact
            amountMode={amountDisplayMode}
            onAmountModeChange={onAmountDisplayModeChange}
          />
          <Badge status={statusKey} />
        </div>
      </div>

      <div className="trade-detail-layout">
        <div className="trade-detail-listing-pane">
          <div className="trade-detail-hero" style={{
            padding: "6px 0 18px",
            marginBottom: 6,
            textAlign: "center" as const,
          }}>
            {heroImages.length > 0 && (
              <div style={{
                display: "grid",
                gridTemplateColumns: heroImages.length > 1 ? "1fr 1fr" : "1fr",
                gap: 8,
                marginBottom: 18,
                borderRadius: T.r,
                overflow: "hidden",
                border: `1px solid ${T.border}`,
              }}>
                {heroImages.map((item, index) => (
                  <img
                    key={`${"itemId" in item ? item.itemId : item.id}-${index}`}
                    src={item.imageDataUrl ?? ""}
                    alt=""
                    style={{
                      width: "100%",
                      height: 150,
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                ))}
              </div>
            )}
            <img
              className="trade-lock-ring"
              src="/icons/chama-woven-trust-mark-transparent-256.png"
              alt=""
              aria-hidden="true"
              style={{
                width: 128,
                height: 128,
                margin: "0 auto 18px",
                display: "block",
                objectFit: "contain",
                filter: `drop-shadow(0 0 34px ${s.c}22)`,
              }}
            />
            <div className="trade-detail-amount-row" style={{
              textAlign: "center",
            }}>
              {showHeroFiat ? (
                <div className="trade-detail-amount" style={{
                  color: T.accent,
                  fontFamily: T.mono,
                  fontSize: 44,
                  fontWeight: 900,
                  lineHeight: 1,
                  letterSpacing: 0,
                }}>
                  {heroFiatLabel}
                </div>
              ) : (
                <BitcoinAmount className="trade-detail-amount" msats={heroAmountMsats} size={46} gap={8} glyphScale={1.12} />
              )}
            </div>
            <div style={{
              marginTop: 10,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 11,
              lineHeight: 1.5,
            }}>
              {state.description}
              {showHeroFiat
                ? ` · ₿ ${fmtSats(heroAmountMsats)}`
                : heroFiatLabel
                  ? ` · ${heroFiatLabel}`
                  : ""}
              {viewerEstimateLabel ? ` · ${viewerEstimateLabel}` : ""}
              {routeNote ? ` · ${routeNote}` : ""}
              {myRole ? ` · ${roleDisplayName(myRole)}` : ""}
            </div>
            {state.category === "marketplace" && sellerPubkey && (
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: 10,
                padding: "5px 9px",
                borderRadius: 999,
                background: `linear-gradient(135deg, ${T.amber}2b, ${T.green}18)`,
                border: `1px solid ${T.amber}55`,
                color: T.amber,
                fontFamily: T.mono,
                fontSize: 10,
                fontWeight: 900,
                maxWidth: "100%",
              }}>
                <span aria-hidden="true">★</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Store · {sellerProfileName ?? shortParticipantPubkey(sellerPubkey)}
                </span>
              </div>
            )}
          </div>

          {hasMenu && (
            <div className="trade-order-panel" style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: T.r,
              padding: 12,
              marginBottom: 12,
            }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.muted,
              fontFamily: T.mono,
              letterSpacing: 1,
            }}>
              {state.status === EscrowStatus.CREATED && !canSelectMenu
                ? `${roleDisplayName(menuSelectorRole).toUpperCase()} CART`
                : menuHeaderTitle(state.category, state.status === EscrowStatus.CREATED)}
            </div>
            <div style={{
              color: T.accent,
              fontFamily: T.mono,
              fontSize: 13,
              fontWeight: 800,
              display: "inline-flex",
              justifyContent: "flex-end",
              minWidth: 96,
            }}>
              {state.status === EscrowStatus.CREATED && !canSelectMenu && menuDisplayAmountMsats <= 0
                ? `waiting on ${roleDisplayName(menuSelectorRole).toLowerCase()}`
                : state.status === EscrowStatus.CREATED && hasExchangeMenu && menuDisplayAmountMsats <= 0
                ? "choose amount"
                : state.status === EscrowStatus.CREATED && menuDisplayAmountMsats <= 0
                ? menuSelectionHint(state.category)
                : (
                  <BitcoinAmount
                    msats={state.status === EscrowStatus.CREATED ? (menuDisplayAmountMsats || lockAmountMsats) : state.amountMsats}
                    size={13}
                    gap={4}
                    glyphScale={1.18}
                  />
                )}
            </div>
          </div>
          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: canSelectMenu ? 260 : 170,
            overflowY: "auto",
            paddingRight: 2,
          }}>
            {renderedMenuRows.length === 0 && (
              <div style={{
                padding: "18px 14px",
                background: T.surface,
                border: `1px dashed ${T.border}`,
                borderRadius: T.rs,
                color: T.muted,
                fontFamily: T.mono,
                fontSize: 11,
                lineHeight: 1.55,
                textAlign: "center",
              }}>
                Waiting for {roleDisplayName(menuSelectorRole).toLowerCase()} to build the order.
              </div>
            )}
            {renderedMenuRows.map(item => {
              const itemId = "itemId" in item ? item.itemId : item.id;
              const savedOrderItem = savedOrderItems.find(orderItem => orderItem.itemId === itemId);
              const interactive = canSelectMenu;
              const qty = "quantity" in item
                ? item.quantity
                : interactive
                  ? (menuQuantities[itemId] ?? 0)
                  : (savedOrderItem?.quantity ?? 0);
              const exactSats = parsePositiveWholeSats(menuAmounts[itemId] ?? "");
              const minMsats = item.minAmountMsats ?? item.amountMsats;
              const maxMsats = item.maxAmountMsats ?? item.amountMsats;
              const exactMsats = exactSats * 1000;
              const exactAmountValid = exactMsats >= minMsats && exactMsats <= maxMsats;
              const metaLine = menuMetaLine(item);
              const allowsQuantity = state.category === "marketplace";
              // Anti-drain (#6): clamp the buyer's stepper to the seller's
              // per-item cap (and the global 99 ceiling). The reducer rejects
              // over-cap LOCKs regardless; this just stops the buyer building
              // an order the seller could never lock.
              const itemQtyCap = "maxQuantity" in item && typeof item.maxQuantity === "number"
                ? Math.min(99, item.maxQuantity)
                : 99;
              const selected = hasExchangeMenu
                ? interactive
                  ? exactSats > 0 && exactAmountValid
                  : !!savedOrderItem
                : qty > 0;
              return (
                <div key={itemId} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: T.rs,
                }}>
                  {item.imageDataUrl && (
                    <img
                      src={item.imageDataUrl}
                      alt=""
                      style={{
                        width: 54,
                        height: 44,
                        objectFit: "cover",
                        borderRadius: 8,
                        border: `1px solid ${T.border}`,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: T.text,
                      fontFamily: T.sans,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap" as const,
                    }}>
                      {item.label}
                    </div>
                    <div style={{
                      marginTop: 3,
                      fontSize: 10,
                      color: T.muted,
                      fontFamily: T.mono,
                    }}>
                      {menuAmountLabel(item)}
                      {"quantity" in item && item.quantity > 1 ? ` × ${item.quantity}` : ""}
                      {allowsQuantity && itemQtyCap < 99 ? ` · max ${itemQtyCap}` : ""}
                    </div>
                    {metaLine && (
                      <div style={{
                        marginTop: 3,
                        fontSize: 9,
                        color: T.muted,
                        fontFamily: T.mono,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap" as const,
                      }}>
                        {metaLine}
                      </div>
                    )}
                  </div>
                  {interactive && hasExchangeMenu ? (
                    <div style={{ minWidth: 104 }}>
                      <input
                        type="number"
                        value={menuAmounts[itemId] ?? ""}
                        onChange={e => setMenuAmounts(prev => ({ ...prev, [itemId]: e.target.value }))}
                        placeholder={fmtSats(minMsats)}
                        style={{
                          ...inputStyle,
                          padding: "9px 10px",
                          fontSize: 12,
                          borderColor: (menuAmounts[itemId] && !exactAmountValid) ? `${T.red}66` : T.border,
                          color: exactAmountValid ? T.accent : T.text,
                        }}
                      />
                    </div>
                  ) : interactive && !allowsQuantity ? (
                    <button
                      onClick={() => setMenuQuantities(prev => ({
                        ...prev,
                        [itemId]: (prev[itemId] ?? 0) > 0 ? 0 : 1,
                      }))}
                      style={menuPickButtonStyle(selected)}
                    >
                      {selected ? "Selected" : menuPickLabel(state.category)}
                    </button>
                  ) : interactive ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={() => setMenuQuantities(prev => ({
                          ...prev,
                          [itemId]: Math.max(0, (prev[itemId] ?? 0) - 1),
                        }))}
                        style={menuQtyButtonStyle()}
                      >
                        −
                      </button>
                      <span style={{
                        minWidth: 18,
                        textAlign: "center",
                        color: qty > 0 ? T.accent : T.muted,
                        fontFamily: T.mono,
                        fontSize: 12,
                        fontWeight: 800,
                      }}>
                        {qty}
                      </span>
                      <button
                        onClick={() => setMenuQuantities(prev => ({
                          ...prev,
                          [itemId]: Math.min(itemQtyCap, (prev[itemId] ?? 0) + 1),
                        }))}
                        style={menuQtyButtonStyle()}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <div style={{
                      color: selected ? T.accent : T.muted,
                      fontFamily: T.mono,
                      fontSize: 12,
                      fontWeight: 800,
                    }}>
                      {selected
                        ? hasExchangeMenu && savedOrderItem
                          ? (
                            <BitcoinAmount
                              msats={savedOrderItem.amountMsats}
                              size={12}
                              gap={4}
                              glyphScale={1.18}
                            />
                          )
                          : allowsQuantity
                            ? `×${qty}`
                            : "selected"
                        : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {selectorNeedsSaveOrder && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 8,
              marginTop: 12,
            }}>
              <button
                disabled={joining || selectedMenuItems.length === 0 || selectionMatchesSavedOrder}
                onClick={async () => {
                  setJoining(true);
                  try {
                    await onJoin(menuSelectorRole, {
                      selectedItems: selectedMenuItems,
                      amountMsats: selectedMenuAmountMsats,
                    });
                  } finally {
                    setJoining(false);
                  }
                }}
                style={{
                  padding: "12px 10px",
                  borderRadius: T.rs,
                  border: `1px solid ${selectedMenuItems.length > 0 && !selectionMatchesSavedOrder ? T.border : T.border}`,
                  background: T.surface,
                  color: selectedMenuItems.length > 0 && !selectionMatchesSavedOrder ? T.text : T.muted,
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 900,
                  cursor: joining || selectedMenuItems.length === 0 || selectionMatchesSavedOrder ? "default" : "pointer",
                }}
              >
                {joining
                  ? "Saving..."
                  : selectionMatchesSavedOrder
                    ? "Cart saved"
                    : selectedMenuItems.length === 0
                      ? menuSelectionButtonLabel(state.category)
                      : (
                        <>
                          Save cart · <BitcoinAmount msats={selectedMenuAmountMsats} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                        </>
                      )}
              </button>
              <button
                disabled={joining || selectedMenuItems.length === 0}
                onClick={async () => {
                  setJoining(true);
                  try {
                    await onJoin(menuSelectorRole, {
                      selectedItems: selectedMenuItems,
                      amountMsats: selectedMenuAmountMsats,
                      orderFinalized: true,
                    });
                  } finally {
                    setJoining(false);
                  }
                }}
                style={{
                  padding: "12px 10px",
                  borderRadius: T.rs,
                  border: `1px solid ${selectedMenuItems.length > 0 ? T.accent + "66" : T.border}`,
                  background: selectedMenuItems.length > 0 ? T.accentDim : T.surface,
                  color: selectedMenuItems.length > 0 ? T.accent : T.muted,
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 900,
                  cursor: joining || selectedMenuItems.length === 0 ? "default" : "pointer",
                }}
              >
                {joining
                  ? "Confirming..."
                  : selectedMenuItems.length === 0
                    ? "Not ready"
                    : (
                      <>
                        Ready · <BitcoinAmount msats={selectedMenuAmountMsats} size={11} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                      </>
                    )}
              </button>
            </div>
          )}
        </div>
      )}

      {categoryUsesPaymentRails(state.category) && acceptedPaymentMethods.length > 0 && (
        <div style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: T.r,
          padding: 12,
          marginBottom: 12,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.muted,
            fontFamily: T.mono,
            letterSpacing: 1,
            marginBottom: 10,
          }}>
            ACCEPTED PAYMENT
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {acceptedPaymentMethods.map(method => {
              // For a prospective buyer, flag the rails they can already pay on.
              const isShared = myRole !== Role.SELLER && sharedRailSet.has(toRailKey(method));
              return (
                <span
                  key={method}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "5px 9px",
                    borderRadius: 999,
                    background: isShared ? `${T.green}22` : T.surface,
                    border: `1px solid ${isShared ? T.green : T.border}`,
                    color: isShared ? T.green : T.text,
                    fontFamily: T.mono,
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {isShared ? "✓ " : ""}{method}
                </span>
              );
            })}
          </div>
          {myRole !== Role.SELLER && suggestedRail && (
            <div style={{ marginTop: 10, color: T.muted, fontSize: 11, lineHeight: 1.5 }}>
              {railMatch.shared.length > 0 ? (
                <>You both use <strong style={{ color: T.green }}>{suggestedRail.displayName}</strong> — the easiest rail to settle on before you lock.</>
              ) : (
                <>No saved handle matches the seller's rails yet. Suggested: <strong style={{ color: T.text }}>{suggestedRail.displayName}</strong>. Add it in Me → Saved handles to match faster.</>
              )}
            </div>
          )}
        </div>
      )}

      {premiumLine && (
        <div style={{
          background: T.card,
          border: `1px solid ${T.amber}44`,
          borderRadius: T.r,
          padding: 12,
          marginBottom: 12,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.muted,
            fontFamily: T.mono,
            letterSpacing: 1,
            marginBottom: 8,
          }}>
            PREMIUM
          </div>
          <div style={{
            color: T.amber,
            fontFamily: T.mono,
            fontSize: 14,
            fontWeight: 900,
          }}>
            {premiumLine}
          </div>
          {premiumCheckoutLine && (
            <div style={{
              marginTop: 6,
              color: T.muted,
              fontFamily: T.mono,
              fontSize: 11,
              lineHeight: 1.4,
            }}>
              {premiumCheckoutLine}
            </div>
          )}
        </div>
      )}

      {/* v0.2.0 item 1: State A vs State B narration. Only fires on
          CREATED listings (the funding moment); LOCKED+ trades have
          a clearer status surface elsewhere and don't need the
          home/listing-fed framing. */}
      {showVerboseRouteEducation && state.status === EscrowStatus.CREATED && framing.kind === "state-a" && (
        <div style={{
          padding: "8px 12px", marginBottom: 12,
          fontSize: 11, color: T.muted, fontFamily: T.mono,
          textAlign: "center" as const, lineHeight: 1.5,
        }}>
          {framing.sameFedSameCommunity
            ? "Same community as your Chama"
            : "Same federation as your Chama · cross-community trade"}
        </div>
      )}
      {/* v0.3.0 Phase 6: one-time State B educational card. Renders
          ONCE per pubkey above the permanent State B callout. Dismiss
          is sticky via chama_state_b_explained_<pubkey> in localStorage
          (same shape as v0.2.0's chama_first_publish_done_<pubkey>).
          Pillar 2.7: educate at the first opportunity, never lecture
          returning users. */}
      {showVerboseRouteEducation && state.status === EscrowStatus.CREATED && framing.kind === "state-b" && !stateBDismissed && (
        <div style={{
          padding: 14, marginBottom: 12,
          background: T.accentDim, border: `1px solid ${T.accent}33`,
          borderRadius: T.r,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.accent, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            FIRST CROSS-FEDERATION TRADE? HEADS UP
          </div>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 12 }}>
            Your wallet was on {framing.homeFlagEmoji} {framing.homeCommunityName}.
            Since this listing is on {framing.listingFlagEmoji} {framing.listingCommunityName} and
            your balance was 0 sats, we switched automatically. No funds moved
            on Lightning — fresh wallet on {framing.listingFlagEmoji} {framing.listingCommunityName} for
            this trade. Switching back is just another tap.
          </div>
          <button
            onClick={() => {
              markStateBExplained(pubkey);
              setStateBDismissed(true);
            }}
            style={{
              background: "none", border: `1px solid ${T.accent}66`,
              color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              padding: "6px 12px", borderRadius: T.rs,
              cursor: "pointer", letterSpacing: 0.3,
            }}
          >
            Got it
          </button>
        </div>
      )}
      {showVerboseRouteEducation && state.status === EscrowStatus.CREATED && framing.kind === "state-b" && (
        <div style={{
          padding: 14, marginBottom: 12,
          background: T.surface, border: `1px solid ${T.amber}33`,
          borderRadius: T.rs,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            CROSS-FEDERATION
          </div>
          {/* v0.3.0 Phase 6: tightened from
                "Running on {emoji} {name} · we switched you in for this trade."
              to drop "we" — the system did it; the framing is the user's. */}
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 6 }}>
            Running on {framing.listingFlagEmoji} <strong>{framing.listingCommunityName}</strong> · switched in for this trade
          </div>
          {/* v0.3.0 Phase 6: educational essay moved to the one-time
              card above. This callout is now a single reassuring
              sentence, the only thing returning State-B users see. */}
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5 }}>
            Your Chama switched automatically — no funds at risk.
          </div>
        </div>
      )}

      {/* Subscription timeline */}
      {state.subscription && (
        <SubscriptionTimeline
          subscription={state.subscription}
          onRelease={async (periodIndex) => {
            try {
              await onReleasePeriod?.(periodIndex);
            } catch (e: any) {
              console.error("[chama] Period release failed:", e);
            }
          }}
        />
      )}

      {/* Expiry policy — visible on all LOCKED trades */}
      {state.status === "LOCKED" && (() => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = state.expiresAt - now;
        const isExpired = remaining <= 0;
        const isUrgent = remaining > 0 && remaining < 7200;
        return (
          <div style={{ marginBottom: 12 }}>
            {isExpired ? (
              <div style={{
                padding: "14px 16px", borderRadius: 8, textAlign: "center",
                background: T.redDim, border: `1px solid ${T.red}44`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.red, fontFamily: T.mono }}>
                  ⏰ TRADE EXPIRED
                </div>
                <div style={{ fontSize: 11, color: T.text, fontFamily: T.sans, marginTop: 6 }}>
                  🛡️ Community arbiter will auto-vote REFUND
                </div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
                  Sats will be returned to the {refundRecipientFor(state.category)} automatically
                </div>
              </div>
            ) : (
              <div style={{
                padding: "8px 12px", borderRadius: 6, textAlign: "center",
                background: isUrgent ? T.redDim : T.surface,
                border: `1px solid ${isUrgent ? T.red + "33" : T.amber + "22"}`,
              }}>
                <span style={{
                  fontSize: 10, fontFamily: T.mono,
                  color: isUrgent ? T.red : T.amber,
                }}>
                  {isUrgent ? "⚠️ Expiring soon! " : "⏱️ "}
                  If time expires → arbiter auto-refunds to {refundRecipientFor(state.category)}
                </span>
              </div>
            )}
          </div>
        );
      })()}

      {reservedByOther && (
        <div style={{
          marginBottom: 16,
          padding: 14,
          borderRadius: T.r,
          background: T.amberDim,
          border: `1px solid ${T.amber}55`,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 800, color: T.amber, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            ⏳ RESERVED · BEING VIEWED BY ANOTHER {roleDisplayName(reservedByOther.role).toUpperCase()}
          </div>
          <CountdownTimer
            expiresAt={reservedByOther.expiresAt}
            label="FREES UP IN (IF THEY DON'T LOCK)"
          />
          <div style={{
            marginTop: 8, fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
          }}>
            Someone is on this order. If their hold expires you can grab it; if they
            lock, it's taken. None of your sats have moved.
          </div>
        </div>
      )}

      {state.expiresAt
        && !reservedByOther
        && state.status !== "COMPLETED"
        && state.status !== "CANCELLED"
        && state.status !== "EXPIRED"
        && state.status !== "APPROVED"
        && state.status !== "CLAIMED" && (
        <div style={{ marginBottom: 16 }}>
          <CountdownTimer
            expiresAt={liveJoinHold?.expiresAt ?? state.expiresAt}
            label={liveJoinHold
              ? `${roleDisplayName(liveLockWindowRole ?? liveJoinHold.role).toUpperCase()} LOCK WINDOW ENDS IN`
              : state.status === EscrowStatus.CREATED ? "LISTING EXPIRES IN" : "TRADE EXPIRES IN"}
          />
        </div>
      )}
        </div>

      {/* Participants — Trinity Ring order: Buyer · Arbiter · Seller.
          Order is sourced from theme.TRINITY_RING_ORDER. PHILOSOPHY.md
          §5.2 places the arbiter at the apex with buyer/seller flanking
          below; this row mirrors that arrangement. v0.2.0 shipped with
          B/S/A — the §43 test pins B/A/S so future refactors can't
          silently revert the order.

          v0.6.5 — auto-assigned arbiter preview (see previewArbiterPk
          above the return). For freshly-created listings on communities
          with a recruited arbiter pool (BLF etc.), the arbiter slot
          would otherwise read "Empty" until LOCK lands. Pre-filling
          with the same pubkey LOCK will pick (via pickArbiterFromPool
          keyed on escrow id) is honest, not speculative — the round-
          robin is deterministic. The Dot renders this slot dimmer +
          italic "Auto · xxxx" so a real JOIN remains distinguishable. */}
      <div className="trade-room-card" style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: T.r,
        padding: 18,
        marginBottom: 16,
      }}>
        <div style={{
          padding: 14,
          borderRadius: T.rs,
          background: nextStep.tone === "green" ? T.greenDim
            : nextStep.tone === "red" ? T.redDim
            : nextStep.tone === "purple" ? T.purpleDim
            : nextStep.tone === "teal" ? T.tealDim
            : T.surface,
          border: `1px solid ${
            nextStep.tone === "green" ? T.green + "44"
            : nextStep.tone === "red" ? T.red + "44"
            : nextStep.tone === "purple" ? T.purple + "44"
            : nextStep.tone === "teal" ? T.teal + "44"
            : T.accent + "33"
          }`,
          marginBottom: 16,
        }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 7,
          }}>
            <div style={{
              color: nextStep.color,
              fontFamily: T.mono,
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: 1,
            }}>
              {nextStep.kicker}
            </div>
            {nextStep.amountMsats !== null && (
              <BitcoinAmount msats={nextStep.amountMsats} size={12} gap={4} style={{ whiteSpace: "nowrap" }} />
            )}
          </div>
          <div style={{
            color: T.text,
            fontFamily: T.sans,
            fontSize: 16,
            fontWeight: 800,
            lineHeight: 1.28,
          }}>
            {nextStep.title}
          </div>
        </div>

        {showBuyerAttempts && (
          <div style={{
            paddingTop: 14,
            marginBottom: 16,
            borderTop: `1px solid ${T.border}`,
          }}>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              marginBottom: 10,
            }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: T.muted,
                fontFamily: T.mono,
                letterSpacing: 1,
              }}>
                BUYER ATTEMPTS
              </div>
              <div style={{
                color: T.amber,
                fontFamily: T.mono,
                fontSize: 10,
                fontWeight: 900,
              }}>
                {buyerAttemptRows.length} event{buyerAttemptRows.length === 1 ? "" : "s"}
              </div>
            </div>
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}>
              {buyerAttemptRows.slice(0, 5).map(attempt => (
                <div key={attempt.id} style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: `1px solid ${T.border}66`,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      minWidth: 0,
                    }}>
                      <span style={{
                        color: attempt.isLive ? T.accent : T.muted,
                        fontFamily: T.mono,
                        fontSize: 10,
                        fontWeight: 900,
                        textTransform: "uppercase",
                      }}>
                        {attempt.statusLabel}
                      </span>
                      <span style={{
                        color: T.text,
                        fontFamily: T.mono,
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {shortParticipantPubkey(attempt.pubkey)}
                      </span>
                    </div>
                    <div style={{
                      marginTop: 4,
                      color: T.muted,
                      fontFamily: T.mono,
                      fontSize: 10,
                      lineHeight: 1.4,
                    }}>
                      {attempt.selectedCount > 0
                        ? `${attempt.selectedCount} option${attempt.selectedCount === 1 ? "" : "s"} selected`
                        : "no order snapshot yet"}
                      {" · "}
                      {attempt.expiresAt > nowSec
                        ? `${Math.ceil((attempt.expiresAt - nowSec) / 60)}m left`
                        : `${Math.ceil((nowSec - attempt.expiresAt) / 60)}m expired`}
                    </div>
                  </div>
                  {attempt.amountMsats > 0 && (
                    <BitcoinAmount
                      msats={attempt.amountMsats}
                      size={12}
                      gap={4}
                      glyphScale={1.18}
                      color={attempt.isLive ? T.accent : T.muted}
                      glyphColor={attempt.isLive ? T.accent : T.muted}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1 }}>PARTICIPANTS</div>
          {state.communityArbiters && state.communityArbiters.length > 0 && (
            <div style={{ fontSize: 10, color: T.purple, fontFamily: T.mono }}>
              {state.communityArbiters.length} backup arbiter{state.communityArbiters.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
        {/* Match the vote tally's 3-column grid (below) exactly so the arbiter
            (middle) sits directly above the FINAL DECISION chip and the buyer /
            seller align over their vote columns. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, justifyItems: "center" }}>
          {TRINITY_RING_ORDER.map(role => {
            const realPk = participants[role];
            const isAutoArbiter = role === Role.ARBITER && !realPk && !!previewArbiterPk;
            return (
              <Dot key={role} role={role}
                pk={realPk ?? (isAutoArbiter ? previewArbiterPk : null)}
                isYou={myRole === role}
                voted={!!state.votes[role]} outcome={state.votes[role]}
                autoAssigned={isAutoArbiter}
                displayName={profileNameFor(
                  profileNames,
                  realPk ?? (isAutoArbiter ? previewArbiterPk : null),
                  kind0Enabled,
                )} />
            );
          })}
        </div>
        {(state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED ||
          state.status === EscrowStatus.CLAIMED || state.status === EscrowStatus.COMPLETED) && (
          <div className="trade-vote-decisions" style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
            paddingTop: 14,
            marginTop: 16,
            marginBottom: 18,
            borderTop: `1px solid ${T.border}`,
          }}>
            {/* Tally reads left→right like the Trinity ring above it (Buyer ·
                Arbiter · Seller). The winning outcome's green chip sits under
                whoever wins RELEASE: the Buyer for p2p/bill-pay/lending, but the
                SELLER for Market (buyer locks → seller wins release). So Market
                mirrors the chips — amber refund under the Buyer, green release
                under the Seller — and the arbiter's decision stays centered. */}
            {(() => {
              const releaseChip = (
                <div className="trade-vote-decision-chip" style={voteDecisionChipStyle(T.green)}>
                  <strong style={voteDecisionValueStyle()}>{releaseVoteCount}</strong>
                  <span style={voteDecisionLabelStyle()}>release votes</span>
                </div>
              );
              const centerChip = (
                <div className="trade-vote-decision-chip" style={voteDecisionChipStyle(decisionTone)}>
                  <strong style={voteDecisionValueStyle()}>{decisionValue}</strong>
                  <span style={voteDecisionLabelStyle()}>{decisionLabel}</span>
                </div>
              );
              const refundChip = (
                <div className="trade-vote-decision-chip" style={voteDecisionChipStyle(T.amber)}>
                  <strong style={voteDecisionValueStyle()}>{refundVoteCount}</strong>
                  <span style={voteDecisionLabelStyle()}>refund votes</span>
                </div>
              );
              return state.category === "marketplace"
                ? <>{refundChip}{centerChip}{releaseChip}</>
                : <>{releaseChip}{centerChip}{refundChip}</>;
            })()}
          </div>
        )}

      {isOversoldOrder && (state.status === EscrowStatus.LOCKED || state.status === EscrowStatus.APPROVED) && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}66`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.5,
        }}>
          <div style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, marginBottom: 6 }}>
            ⚠ OVERSOLD ORDER{state.participants[Role.BUYER] ? ` · buyer ${shortParticipantPubkey(state.participants[Role.BUYER]!)}` : ""}
          </div>
          {myRole === Role.SELLER
            ? "This unit was already sold to an earlier buyer (a last-unit race), so it's safe to refund. Use “Refund duplicate order” below — don't release it. Your real sale is the order without this banner."
            : "This unit went to an earlier buyer in a last-unit race — tap Refund below to get your sats back. The seller's side refunds too, so you're made whole."}
        </div>
      )}

      {hasDuplicateParticipant && (
        <div style={{
          background: T.redDim, border: `1px solid ${T.red}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.red, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          This trade has the same key in more than one role. Do not fund it;
          cancel it or create a fresh trade.
        </div>
      )}

      {!hasDuplicateParticipant && lockBlockedByNoArbiter && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          No eligible arbiter is available for this buyer and seller pair.
          A participant cannot also be the arbiter, so this trade should not be funded.
        </div>
      )}

      {expiredJoinHold && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 800, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 6,
          }}>
            LOCK WINDOW EXPIRED
          </div>
          {samePubkey(expiredJoinHold.pubkey, pubkey)
            ? `Your ${roleDisplayName(expiredJoinHold.role).toLowerCase()} reservation expired before LOCK was published. Join again when you are ready. No sats moved.`
            : `${roleDisplayName(expiredJoinHold.role)} ${expiredJoinHold.pubkey.slice(0, 8)}... joined, but no LOCK was published before the window closed. Ask them to join again. No sats moved.`}
        </div>
      )}

      {!myRole && !hasDuplicateParticipant && state.status === EscrowStatus.CREATED && currentKeyAlreadyPresent && (
        <div style={{
          background: T.amberDim, border: `1px solid ${T.amber}44`,
          borderRadius: T.r, padding: 14, marginBottom: 16,
          color: T.amber, fontFamily: T.sans, fontSize: 12, lineHeight: 1.45,
        }}>
          This listing is already tied to your key. Use a different Chama key
          only if you are deliberately testing the other side.
        </div>
      )}

      {/* JOIN buttons — show when user is not a participant and slots are open */}
      {!myRole && !hasDuplicateParticipant && !currentKeyAlreadyPresent && state.status === EscrowStatus.CREATED && canJoinTrade && (
        <div style={{
          paddingTop: 16,
          marginTop: 16,
          marginBottom: 16,
          borderTop: `1px solid ${T.border}`,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
            {isMultiUnitParent ? "BUY FROM THIS LISTING" : "JOIN THIS TRADE"}
          </div>
          {isMultiUnitParent && onPurchase && (
            soldOut ? (
              <div style={{ padding: "12px 14px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 12, fontWeight: 700, textAlign: "center", letterSpacing: 0.5 }}>
                SOLD OUT · all units claimed
              </div>
            ) : (
            <div style={{ marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <button type="button" disabled={purchasing || buyQtyClamped <= 1}
                  onClick={() => setBuyQty(q => Math.max(1, Math.min(q, buyMax) - 1))}
                  style={{ width: 40, height: 40, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 18, fontWeight: 800, cursor: (purchasing || buyQtyClamped <= 1) ? "default" : "pointer" }}>−</button>
                <div style={{ minWidth: 44, textAlign: "center", fontFamily: T.mono, fontSize: 18, fontWeight: 800, color: T.text }}>{buyQtyClamped}</div>
                <button type="button" disabled={purchasing || buyQtyClamped >= buyMax}
                  onClick={() => setBuyQty(q => Math.min(buyMax, q + 1))}
                  style={{ width: 40, height: 40, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 18, fontWeight: 800, cursor: (purchasing || buyQtyClamped >= buyMax) ? "default" : "pointer" }}>+</button>
                <div style={{ color: T.muted, fontFamily: T.mono, fontSize: 11, marginLeft: 4 }}>
                  {typeof stockLeft === "number" ? `${stockLeft} left` : `${state.stock} in stock`}
                </div>
              </div>
              <button type="button" disabled={purchasing}
                onClick={async () => {
                  setPurchasing(true);
                  try { await onPurchase(state.id, buyQtyClamped); } finally { setPurchasing(false); }
                }}
                style={{
                  width: "100%", padding: "14px", borderRadius: T.rs,
                  background: T.accentDim, border: `1px solid ${T.accent}44`,
                  color: T.accent, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                  cursor: purchasing ? "default" : "pointer",
                }}>
                {purchasing ? "Starting your order…" : `Buy ${buyQtyClamped} unit${buyQtyClamped > 1 ? "s" : ""}`}
              </button>
              <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, margin: "8px 2px 0" }}>
                Each purchase is its own 2-of-3 escrow — you'll fund and lock it on the next screen.
              </p>
            </div>
            )
          )}
          {!isMultiUnitParent && (<>
          <div style={{ display: "flex", gap: 10 }}>
            {canJoinAsBuyer && (
              <button disabled={joining} onClick={async () => {
                setJoining(true);
                try { await onJoin(Role.BUYER); } finally { setJoining(false); }
              }} style={{
                flex: 1, padding: "14px", borderRadius: T.rs,
                background: T.accentDim, border: `1px solid ${T.accent}44`,
                color: T.accent, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                cursor: joining ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {joining ? "Joining..." : "Join as Buyer"}
              </button>
            )}
            {/* v0.6.5: hide the Join-as-Arbiter affordance when the
                community pool will auto-assign one. v0.8.0 tightens
                the empty-pool case too: no pool means no trusted arbiter
                slot, not "anyone may volunteer." */}
            {canJoinAsArbiter && (
              <button disabled={joining} onClick={async () => {
                setJoining(true);
                try { await onJoin(Role.ARBITER); } finally { setJoining(false); }
              }} style={{
                flex: 1, padding: "14px", borderRadius: T.rs,
                background: T.purpleDim, border: `1px solid ${T.purple}44`,
                color: T.purple, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
                cursor: joining ? "default" : "pointer", transition: "all 0.2s",
              }}>
                {joining ? "Joining..." : "Join as Arbiter"}
              </button>
            )}
          </div>
          {canJoinAsSeller && (
            <button disabled={joining} onClick={async () => {
              setJoining(true);
              try { await onJoin(Role.SELLER); } finally { setJoining(false); }
            }} style={{
              width: "100%", marginTop: 10, padding: "14px", borderRadius: T.rs,
              background: T.tealDim, border: `1px solid ${T.teal}44`,
              color: T.teal, fontFamily: T.mono, fontSize: 13, fontWeight: 700,
              cursor: joining ? "default" : "pointer", transition: "all 0.2s",
            }}>
              {joining ? "Joining..." : "Join as Seller"}
            </button>
          )}
          </>)}
        </div>
      )}

      {/* CREATED — atomic lock surface for the locker. The locker can
          spend only after any cross-role menu order is finalized. */}
      {state.status === EscrowStatus.CREATED && myRole && canILock && (() => {
        const fiatCategory = state.category === "p2p-trade"
          || state.category === "bill-pay"
          || state.category === "lending";
        const allHandles = fiatCategory ? listSavedHandles() : [];
        const menuSelectionMissing = hasMenu && lockMenuItems.length === 0;
        return (
        <div style={{
          paddingTop: 16,
          marginTop: 16,
          marginBottom: 16,
          borderTop: `1px solid ${T.accent}33`,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 12,
          }}>
            ATOMIC LOCK
          </div>
          <div style={{
            textAlign: "center", fontFamily: T.mono, fontSize: 12,
            color: T.accent, marginBottom: 14,
          }}>
            {hasMenu && menuSelectionMissing
              ? `Waiting for ${roleDisplayName(menuSelectorRole).toLowerCase()} to choose what they want…`
              : menuOrderNotFinal
              ? `${roleDisplayName(menuSelectorRole)} is still editing. Lock opens after they press Ready.`
              : participants.buyer
              ? "Spending from your Chama will split shares and publish LOCK in one step."
              : "Waiting for buyer to acknowledge the trade…"}
          </div>

          {/* Handle reveal picker for fiat categories */}
          {fiatCategory && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: T.muted,
                fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 6,
              }}>
                REVEAL HANDLE TO PARTICIPANTS
              </div>
              {allHandles.length === 0 ? (
                <div style={{
                  padding: "10px 12px", borderRadius: T.rs,
                  background: T.surface, border: `1px dashed ${T.border}`,
                  color: T.muted, fontFamily: T.mono, fontSize: 11,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span>No saved handles. Lock will proceed without one.</span>
                  {onOpenSettings && (
                    <button onClick={onOpenSettings} style={{
                      background: "none", border: "none",
                      color: T.accent, fontFamily: T.mono, fontSize: 11,
                      fontWeight: 700, cursor: "pointer", padding: 0,
                    }}>+ Add</button>
                  )}
                </div>
              ) : (
                <select
                  value={selectedHandleId}
                  onChange={e => setSelectedHandleId(e.target.value)}
                  style={{ ...inputStyle, color: T.text, background: T.surface }}
                >
                  <option value="">— don't reveal a handle —</option>
                  {allHandles.map(h => {
                    const rail = getRailByKey(h.rail);
                    return (
                      <option key={h.id} value={h.id}>
                        {(rail?.displayName || h.rail) + " · " + maskHandle(h.handle)}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          )}

          {/* v1.2.4: NWC status banner + direct-NWC Fund path. If the
              user has a saved NWC wallet, the Fund button bypasses the
              AtomicFundingModal chooser and dispatches straight via
              actions.fundAndLock. The banner above lets the user
              switch / add wallets without leaving the trade page. */}
          <NwcStatusBanner
            activeConnection={activeNwc}
            onSaved={refreshSavedNwcs}
            onManage={onOpenNwcSettings}
          />

          <button
            disabled={locking || directNwcFundPhase !== null || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal}
            title={fundingInProgress
              ? "Another funding operation is in progress. Complete it first."
              : receiveUnavailable
                ? "Lightning receive is unavailable on this browser route. Use Fedi, native bridge, or sim demo."
              : lockBlockedByNoArbiter
                ? "No eligible arbiter is available for this trade."
              : menuOrderNotFinal
                ? `${roleDisplayName(menuSelectorRole)} must press Ready before this order can be locked.`
              : menuSelectionMissing
                ? menuSelectionTitle(state.category)
                : undefined}
            onClick={async () => {
              // v1.2.4: when the user has a saved NWC and the parent
              // wired the direct path, skip the modal entirely. The
              // direct path threads phase labels back via onPhase so
              // the button itself becomes the progress indicator.
              if (activeNwc && onLockDirectNwc) {
                setDirectNwcFundPhase("Starting…");
                try {
                  const result = await onLockDirectNwc({
                    nwcConnectionString: activeNwc.connectionString,
                    savedHandleId: selectedHandleId || undefined,
                    selectedItems: hasMenu ? lockMenuItems : undefined,
                    amountMsats: lockAmountMsats,
                    onPhase: (label) => setDirectNwcFundPhase(label),
                  });
                  if (!result.ok) {
                    // Failure path: parent has already surfaced the
                    // humanized toast. The "Try other method" link
                    // below offers the modal as a fallback.
                  }
                } finally {
                  setDirectNwcFundPhase(null);
                }
                return;
              }
              setLocking(true);
              try {
                await onLock({
                  savedHandleId: selectedHandleId || undefined,
                  selectedItems: hasMenu ? lockMenuItems : undefined,
                  amountMsats: lockAmountMsats,
                });
              } finally {
                setLocking(false);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: "100%", padding: "16px", borderRadius: T.rs,
              background: locking || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal
                ? T.surface
                : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
              border: "none",
              color: locking || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal ? T.muted : T.bg,
              fontFamily: T.mono, fontSize: 14, fontWeight: 800,
              cursor: locking || fundingInProgress || !participants.buyer || fundUnavailable || lockBlockedByNoArbiter || menuSelectionMissing || menuOrderNotFinal ? "default" : "pointer",
              letterSpacing: 0.5, transition: "all 0.2s",
            }}
          >
            {directNwcFundPhase
              ? `${directNwcFundPhase}`
              : locking
              ? "Funding…"
              : fundingInProgress || receiveUnavailable || lockBlockedByNoArbiter
                ? lockLabel + " unavailable"
              : menuOrderNotFinal
                ? `Waiting for ${roleDisplayName(menuSelectorRole)} Ready`
              : menuSelectionMissing
                ? menuSelectionButtonLabel(state.category)
                : activeNwc && onLockDirectNwc
                  ? (
                      <>
                        ⚡ {lockLabel} via {activeNwc.label} · <BitcoinAmount msats={lockAmountMsats} size={14} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                      </>
                    )
                  : (
                      <>
                        ⚡ {lockLabel} · <BitcoinAmount msats={lockAmountMsats} size={14} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
                      </>
                    )}
          </button>
          {/* v1.2.4: indeterminate progress strip under the Fund
              button while the direct-NWC path is mid-action.
              Cosmetic — the button label already shows the phase
              text; this gives a continuous visual that something is
              moving during NWC round-trips. */}
          {directNwcFundPhase && (
            <div style={{
              marginTop: 8,
              height: 3,
              borderRadius: 999,
              background: `${T.accent}1f`,
              overflow: "hidden",
              position: "relative",
            }}>
              <div style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "30%",
                height: "100%",
                borderRadius: 999,
                background: `linear-gradient(90deg, ${T.accent}00, ${T.accent}, ${T.amber}, ${T.amber}00)`,
                animation: "nwcProgressSweep 1.4s ease-in-out infinite",
              }} />
            </div>
          )}
          {/* v1.2.4: "Try other method" fallback when the direct-NWC
              path is the default and the user wants the chooser
              modal instead (different wallet, Onchain, external swap,
              etc.). Hidden when no NWC is set up — the regular button
              already routes through the modal in that case. */}
          {activeNwc && onLockDirectNwc && !directNwcFundPhase && !locking && (
            <button
              onClick={async () => {
                setLocking(true);
                try {
                  await onLock({
                    savedHandleId: selectedHandleId || undefined,
                    selectedItems: hasMenu ? lockMenuItems : undefined,
                    amountMsats: lockAmountMsats,
                  });
                } finally {
                  setLocking(false);
                }
              }}
              style={{
                background: "none", border: "none",
                color: T.muted, fontFamily: T.mono, fontSize: 10,
                cursor: "pointer", padding: "8px 0",
                width: "100%", textAlign: "center",
                textDecoration: "underline",
              }}
            >
              Use a different funding method
            </button>
          )}
          {fundingInProgress && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Another funding operation is in progress. Complete it first.
            </div>
          )}
          {lockBlockedByNoArbiter && !fundingInProgress && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              No eligible arbiter for this trade
            </div>
          )}
          {bootProbeFailed && !fundingInProgress && !lockBlockedByNoArbiter && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Federation unreachable — reconnect first
            </div>
          )}
          {receiveUnavailable && !bootProbeFailed && !fundingInProgress && !lockBlockedByNoArbiter && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Lightning receive unavailable — use Fedi/native bridge or sim demo
            </div>
          )}
          <div style={{
            textAlign: "center", marginTop: 8,
            fontSize: 9, color: T.muted, fontFamily: T.mono,
          }}>
            Real 2-of-3 Shamir split · ecash spent from your Chama
          </div>
        </div>
        );
      })()}

      {/* Revealed payment handle for the trade's three participants. */}
      {state.status === EscrowStatus.LOCKED && state.lock.handle && (
        <div style={{
          paddingTop: 16,
          marginTop: 16,
          marginBottom: 16,
          borderTop: `1px solid ${T.amber}33`,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted,
            fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
          }}>
            PAYMENT HANDLE
            {state.lock.handle.rail && (
              <span style={{ color: T.amber, marginLeft: 8 }}>
                · {getRailByKey(state.lock.handle.rail)?.displayName || state.lock.handle.rail}
              </span>
            )}
          </div>
          <div style={{
            fontFamily: T.mono, fontSize: 14, color: T.text,
            padding: "10px 12px", background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.border}`,
            wordBreak: "break-all" as const,
          }} title={myRole ? state.lock.handle.value : undefined}>
            {handleDisplayForViewer(state.lock.handle.value, !!myRole)}
          </div>
          {/* v0.6.5: networks the seller accepts on this handle.
              Phone numbers serve many mobile-money networks; without
              this chip row the buyer has no honest way to know which
              one to use. Only renders for participants (the cleartext
              value itself is hidden from non-participants anyway, so
              the network tags would be a privacy leak there). */}
          {!!myRole && state.lock.handle.networks && state.lock.handle.networks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{
                fontSize: 9, color: T.muted, fontFamily: T.mono,
                letterSpacing: 0.3, marginBottom: 5,
              }}>
                ACCEPTS
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {state.lock.handle.networks.map(networkKey => (
                  <span key={networkKey} style={{
                    padding: "4px 10px", borderRadius: 12,
                    background: T.tealDim,
                    border: `1px solid ${T.teal}66`,
                    color: T.teal, fontFamily: T.mono,
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.2,
                  }}>
                    {getRailByKey(networkKey)?.displayName || networkKey}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            marginTop: 8, lineHeight: 1.4,
          }}>
            {myRole
              ? "Revealed only to the three trade participants via the LOCK event."
              : "Hidden — only the buyer, seller, and arbiter can see the full handle."}
          </div>
        </div>
      )}

      {/* Vote buttons — vertical-aware copy from the label dictionary.
          v0.2.0 item 9: when the user is the arbiter, the vote
          buttons mirror role colors per Pillar 5.2 — purple for
          "side with buyer," orange for "side with seller." Buyer
          and seller voting on their own experience keep the
          green/amber semantics (happy path / refund).

          Color derivation: RELEASE flows sats to the role that
          didn't lock. For marketplace, buyer locks → RELEASE goes
          to seller. For other verticals, seller locks → RELEASE
          goes to buyer. The arbiter's button color reflects who
          actually receives the sats on each vote, removing the
          ambiguity that otherwise sits in the highest-stakes UI
          interaction in the product. */}
      {votePrompt.kind === "waiting" && (
        <div style={{
          padding: "14px 0 0",
          marginTop: 16,
          borderTop: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11,
          lineHeight: 1.5, textAlign: "center", marginBottom: 16,
        }}>
          {votePrompt.message}
        </div>
      )}

      {votePrompt.kind === "buttons" && (() => {
        const voteRole = votePrompt.role;
        const isArbiter = voteRole === Role.ARBITER;
        const isMarketplace = state.category === "marketplace";
        // Oversold order: this unit was already taken by an earlier buyer, so the
        // ONLY correct action for BOTH sides is to refund — releasing just loses
        // someone their sats. Hide Release for buyer and seller alike (the arbiter,
        // in the rare case it reaches them, still sees both to decide). Refunding
        // the right order is what protects everyone.
        const isOversoldVoterView = isOversoldOrder && voteRole !== Role.ARBITER;
        const showRelease = votePrompt.outcomes.includes(Outcome.RELEASE) && !isOversoldVoterView;
        const showRefund = votePrompt.outcomes.includes(Outcome.REFUND);
        // Who wins on RELEASE / REFUND
        const releaseWinner = isMarketplace ? "seller" : "buyer";
        const refundWinner = isMarketplace ? "buyer" : "seller";

        const arbiterReleaseColor = ROLE_COLOR[releaseWinner];
        const arbiterRefundColor = ROLE_COLOR[refundWinner];

        const releaseBg = isArbiter ? `${arbiterReleaseColor}22` : T.greenDim;
        const releaseBorder = isArbiter ? `${arbiterReleaseColor}66` : `${T.green}44`;
        const releaseText = isArbiter ? arbiterReleaseColor : T.green;

        const refundBg = isArbiter
          ? `${arbiterRefundColor}22`
          : state.subscription ? T.redDim : T.amberDim;
        const refundBorder = isArbiter
          ? `${arbiterRefundColor}66`
          : `${state.subscription ? T.red : T.amber}44`;
        const refundText = isArbiter
          ? arbiterRefundColor
          : state.subscription ? T.red : T.amber;
        const releaseLabel = isArbiter
          ? "Side with " + releaseWinner
          : voteOutcomeLabel("Release", getVoteLabel(state.category, state.fulfillment, voteRole, Outcome.RELEASE));
        const refundLabel = state.subscription
          ? "Cancel & refund remaining"
          : isArbiter
            ? "Side with " + refundWinner
            : isOversoldVoterView
              // The single, unmistakable action on an oversold unit, phrased for
              // whoever is tapping it: the seller refunds the duplicate; the buyer
              // simply gets their own sats back.
              ? (voteRole === Role.SELLER ? "Refund duplicate order" : "Refund — get my sats back")
              : isMarketplace && voteRole === Role.SELLER
                // Market seller votes first; "Refund" stays neutral rather than
                // presuming "Buyer never received" before any dispute exists.
                ? "Refund"
                : voteOutcomeLabel("Refund", getVoteLabel(state.category, state.fulfillment, voteRole, Outcome.REFUND));

        const releaseButton = showRelease ? (
          <button
            key="release"
            disabled={voting}
            onClick={() => handleVote(Outcome.RELEASE)}
            aria-label={`Vote release: ${releaseLabel}`}
            style={voteActionButtonStyle({
              disabled: voting,
              background: releaseBg,
              border: releaseBorder,
              color: releaseText,
            })}
          >
            <span aria-hidden="true" style={voteActionIconStyle(releaseText)}>✓</span>
            <span style={voteActionLabelStyle()}>{releaseLabel}</span>
          </button>
        ) : null;
        const refundButton = showRefund ? (
          <button
            key="refund"
            disabled={voting}
            onClick={() => handleVote(Outcome.REFUND)}
            aria-label={`Vote refund: ${refundLabel}`}
            style={voteActionButtonStyle({
              disabled: voting,
              background: refundBg,
              border: refundBorder,
              color: refundText,
            })}
          >
            <span aria-hidden="true" style={voteActionIconStyle(refundText)}>↩</span>
            <span style={voteActionLabelStyle()}>{refundLabel}</span>
          </button>
        ) : null;
        // Buyer-favoring vote on the LEFT (purple), seller-favoring on the RIGHT
        // (orange), mirroring the B · A · S participant ring + the tally. RELEASE
        // wins for the buyer in p2p/bill-pay/lending but for the SELLER in
        // Market — so Market swaps the two so the buyer's outcome stays left.
        return (
          <div className="trade-vote-actions" style={{
            display: "grid",
            gridTemplateColumns: showRelease && showRefund ? "minmax(0, 1fr) minmax(0, 1fr)" : "1fr",
            gap: 10,
            marginBottom: 16,
          }}>
            {isMarketplace ? <>{refundButton}{releaseButton}</> : <>{releaseButton}{refundButton}</>}
          </div>
        );
      })()}

      {/* Claim button.
          v0.3.1 Phase 3 expanded scope (Q4): boot probe also gates
          the Claim button. When bootProbeFailed === true, the button
          disables with "Federation unreachable — reconnect first"
          subtitle. The Reconnect CTA lives in ChamaBar (single
          source of truth). */}
      {(state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED) && iAmWinner && !state.subscription && (
        <div style={{
          marginTop: 18,
          paddingTop: 16,
          marginBottom: 18,
          borderTop: `1px solid ${T.border}`,
        }}>
          {/* v1.2.4: NWC status banner + direct-NWC Claim path.
              Mirror of the Fund button treatment — saved NWC wallet
              → one-tap claim straight to that wallet, banner above
              for context + paste-to-add. */}
          <NwcStatusBanner
            activeConnection={activeNwc}
            onSaved={refreshSavedNwcs}
            onManage={onOpenNwcSettings}
          />

          <button
            disabled={claiming || directNwcClaimPhase !== null || bootProbeFailed || claimRetryBlocked}
            onClick={async () => {
              // v1.2.4: direct-NWC claim path. Saved NWC wallet skips
              // the ClaimPayoutModal chooser → resolveNwcConnectionToInvoice
              // → claimAndPayout in one shot, all from the button.
              if (activeNwc && onClaimDirectNwc) {
                setDirectNwcClaimPhase("Starting…");
                try {
                  await onClaimDirectNwc({
                    nwcConnectionString: activeNwc.connectionString,
                    onPhase: (label) => setDirectNwcClaimPhase(label),
                  });
                } finally {
                  setDirectNwcClaimPhase(null);
                }
                return;
              }
              setClaiming(true);
              try {
                await onClaim();
              } finally {
                setClaiming(false);
              }
            }}
            style={{
              width: "100%", padding: "18px", borderRadius: T.rs,
              background: claimRetryBlocked
                ? T.redDim
                : claiming || directNwcClaimPhase !== null || bootProbeFailed
                ? T.surface
                : `linear-gradient(135deg, ${T.accent}, ${T.amber})`,
              border: claimRetryBlocked ? `1px solid ${T.red}55` : "none",
              color: claimRetryBlocked ? T.red : claiming || directNwcClaimPhase !== null || bootProbeFailed ? T.muted : T.bg,
              fontFamily: T.mono, fontSize: 15, fontWeight: 800,
              cursor: claiming || directNwcClaimPhase !== null || bootProbeFailed || claimRetryBlocked ? "default" : "pointer", letterSpacing: 1,
              animation: (claiming || directNwcClaimPhase !== null || bootProbeFailed || claimRetryBlocked) ? "none" : "pulse 2s ease-in-out infinite",
            }}>
            {directNwcClaimPhase
              ? directNwcClaimPhase
              : claimRetryBlocked
              ? "✕ CLAIM DID NOT SETTLE"
              : claiming
              ? state.status === EscrowStatus.CLAIMED ? "Retrying claim…" : "Claiming…"
              : activeNwc && onClaimDirectNwc
                ? (state.status === EscrowStatus.CLAIMED
                    ? `⚡ RETRY CLAIM via ${activeNwc.label}`
                    : `⚡ CLAIM YOUR SATS via ${activeNwc.label}`)
                : state.status === EscrowStatus.CLAIMED ? "⚡ RETRY CLAIM" : "⚡ CLAIM YOUR SATS"}
          </button>
          {/* v1.2.4: same indeterminate progress strip under the
              Claim button while the direct-NWC claim is mid-action.
              Mirror of the Fund strip — purely cosmetic, since the
              button label is already showing the phase text. */}
          {directNwcClaimPhase && (
            <div style={{
              marginTop: 8,
              height: 3,
              borderRadius: 999,
              background: `${T.accent}1f`,
              overflow: "hidden",
              position: "relative",
            }}>
              <div style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "30%",
                height: "100%",
                borderRadius: 999,
                background: `linear-gradient(90deg, ${T.accent}00, ${T.accent}, ${T.amber}, ${T.amber}00)`,
                animation: "nwcProgressSweep 1.4s ease-in-out infinite",
              }} />
            </div>
          )}
          {/* "Try other method" fallback link — same pattern as the
              Fund button. Opens ClaimPayoutModal with the full
              chooser when the user wants a different destination. */}
          {activeNwc && onClaimDirectNwc && !directNwcClaimPhase && !claiming && (
            <button
              onClick={async () => {
                setClaiming(true);
                try {
                  await onClaim();
                } finally {
                  setClaiming(false);
                }
              }}
              style={{
                background: "none", border: "none",
                color: T.muted, fontFamily: T.mono, fontSize: 10,
                cursor: "pointer", padding: "8px 0",
                width: "100%", textAlign: "center",
                textDecoration: "underline",
              }}
            >
              Use a different payout method
            </button>
          )}
          {bootProbeFailed && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Federation unreachable — reconnect first
            </div>
          )}
          {claimRetryBlocked && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.red, fontFamily: T.mono,
            }}>
              Ecash redeem failed after federation consumed the notes — retry is disabled
            </div>
          )}
          {!bootProbeFailed && !claimRetryBlocked && state.status === EscrowStatus.CLAIMED && (
            <div style={{
              textAlign: "center", marginTop: 8,
              fontSize: 10, color: T.amber, fontFamily: T.mono,
            }}>
              Claim already published — retry only settles/pays out after wallet balance confirms
            </div>
          )}
        </div>
      )}

      {/* Trade chat */}
      {myRole && (
        <ChatPanel state={state} myRole={myRole} onSend={onSendChat} embedded />
      )}
      </div>
      </div>

      {/* Event chain */}
      <details style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: T.r,
        padding: "14px 16px",
      }}>
        <summary style={{
          color: T.muted,
          cursor: "pointer",
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1,
          listStyle: "none",
        }}>
          ADVANCED EVENT CHAIN · {state.eventChain.length} events · {state.chatMessages.length} chat messages
        </summary>
        <div style={{ marginTop: 12 }}>
          {state.eventChain.map((evt) => (
            <div key={evt.raw.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.green }} />
              <span style={{ fontSize: 11, fontFamily: T.mono, color: T.muted }}>
                kind:{evt.kind} — {evt.payload.type.replace("escrow:", "")}
              </span>
              <span style={{ fontSize: 9, fontFamily: T.mono, color: T.border, marginLeft: "auto" }}>
                {evt.raw.id.slice(0, 8)}…
              </span>
            </div>
          ))}
        </div>
        {onRebroadcast && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
            <button
              type="button"
              disabled={rebroadcasting}
              onClick={async () => {
                setRebroadcasting(true);
                setRebroadcastResult(null);
                setRebroadcastDone(false);
                try {
                  const { published, total } = await onRebroadcast(state.id);
                  if (total === 0) {
                    setRebroadcastResult("Nothing cached to re-broadcast on this device — re-open the trade so its full history loads, then try again.");
                  } else {
                    // Show the ID-to-share whenever we have a chain. Relays may
                    // not re-ACK events they already store (published can be 0
                    // even though they're available) — the ID hand-off is what
                    // actually heals it, so never hide that on the ACK count.
                    setRebroadcastResult(
                      published > 0
                        ? `Re-published ${published}/${total} events to today's relays.`
                        : `Sent ${total} events — relays may already store them. Share the trade ID below either way.`,
                    );
                    setRebroadcastDone(true);
                  }
                } catch (e) {
                  setRebroadcastResult(`Re-broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setRebroadcasting(false);
                }
              }}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                borderRadius: T.r,
                color: T.muted,
                cursor: rebroadcasting ? "default" : "pointer",
                fontFamily: T.mono,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.5,
                opacity: rebroadcasting ? 0.6 : 1,
                padding: "8px 12px",
                width: "100%",
              }}
            >
              {rebroadcasting ? "RE-BROADCASTING…" : "↻ RE-BROADCAST / HEAL THIS TRADE"}
            </button>
            <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, margin: "8px 2px 0" }}>
              {rebroadcastResult
                ?? "Re-publishes this trade's full event chain to today's relays. Money stays in escrow either way."}
            </p>
            {rebroadcastDone && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: T.card, border: `1px solid ${T.accent}`, borderRadius: T.r }}>
                <div style={{ color: T.text, fontSize: 10, fontWeight: 700, fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 6 }}>
                  NEXT — SEND THIS TRADE ID TO THE OTHER PARTY
                </div>
                <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginBottom: 8 }}>
                  The events are on the relays now, but their app only fetches trades it already knows. Have them paste this ID into “Load a trade” to pull it in and claim.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ flex: 1, color: T.text, fontSize: 10, fontFamily: T.mono, wordBreak: "break-all", background: T.border, padding: "6px 8px", borderRadius: 6, userSelect: "all", WebkitUserSelect: "all" }}>
                    {state.id}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      copyTextRobust(state.id);
                      setIdCopied(true);
                      setTimeout(() => setIdCopied(false), 1500);
                    }}
                    style={{
                      background: T.accent, border: "none", borderRadius: 6, color: "#fff",
                      cursor: "pointer", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      padding: "7px 10px", whiteSpace: "nowrap",
                    }}
                  >
                    {idCopied ? "COPIED ✓" : "COPY"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {onForget && (
          <div style={{ marginTop: 12 }}>
            {!forgetArmed ? (
              <button
                type="button"
                onClick={() => setForgetArmed(true)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: T.red,
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  padding: "6px 2px",
                  textDecoration: "underline",
                }}
              >
                FORGET THIS TRADE LOCALLY
              </button>
            ) : (
              <div style={{ background: T.card, border: `1px solid ${T.red}`, borderRadius: T.r, padding: "10px 12px" }}>
                <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, marginBottom: 8 }}>
                  Hide this trade on this device? Your money stays in 2-of-3 escrow — nothing is cancelled or lost, and you can re-load it anytime by its ID.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => { setForgetArmed(false); onForget(state.id); }}
                    style={{
                      background: T.red, border: "none", borderRadius: 6, color: "#fff",
                      cursor: "pointer", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      letterSpacing: 0.5, padding: "7px 12px",
                    }}
                  >
                    FORGET IT
                  </button>
                  <button
                    type="button"
                    onClick={() => setForgetArmed(false)}
                    style={{
                      background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6,
                      color: T.muted, cursor: "pointer", fontFamily: T.mono, fontSize: 10,
                      fontWeight: 700, letterSpacing: 0.5, padding: "7px 12px",
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </details>
    </div>
  );
}

type DetailNextStepTone = "accent" | "green" | "red" | "purple" | "teal";

function detailNextStep({
  state,
  myRole,
  canILock,
  hasMenu,
  menuSelectorRole,
  savedOrderFinalized,
  savedOrderAmountMsats,
  lockAmountMsats,
  menuSelectionMissing,
  menuOrderNotFinal,
  participantsBuyer,
  votePromptKind,
  iAmWinner,
  claimRetryBlocked,
  canJoinTrade,
}: {
  state: EscrowState;
  myRole: Role | null;
  canILock: boolean;
  hasMenu: boolean;
  menuSelectorRole: Role;
  savedOrderFinalized: boolean;
  savedOrderAmountMsats: number;
  lockAmountMsats: number;
  menuSelectionMissing: boolean;
  menuOrderNotFinal: boolean;
  participantsBuyer?: string;
  votePromptKind: "waiting" | "buttons" | "none";
  iAmWinner: boolean;
  claimRetryBlocked: boolean;
  canJoinTrade: boolean;
}): {
  kicker: string;
  title: string;
  body: string;
  tone: DetailNextStepTone;
  color: string;
  amountMsats: number | null;
} {
  if (state.status === EscrowStatus.CREATED) {
    if (!myRole) {
      if (!canJoinTrade) {
        if (hasMenu && participantsBuyer && !savedOrderFinalized) {
          return {
            kicker: "ORDER PENDING",
            title: `${roleDisplayName(menuSelectorRole)} is still choosing what they want.`,
            body: "The trade is reserved. The final order snapshot will appear once they press Ready.",
            tone: "accent",
            color: T.accent,
            amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
          };
        }
        return {
          kicker: "WAITING",
          title: "Waiting for the locking side to fund.",
          body: "This trade is already reserved. Once sats enter escrow, the vote and claim path opens from this same trade room.",
          tone: "purple",
          color: T.purple,
          amountMsats: savedOrderAmountMsats || state.amountMsats,
        };
      }
      return {
        kicker: "CHECKOUT",
        title: "Join when you are ready to build an order.",
        body: "Joining reserves your side of the listing and starts the short lock window. No sats move until the locking side funds.",
        tone: "teal",
        color: T.teal,
        amountMsats: hasMenu ? null : state.amountMsats,
      };
    }
    if (hasMenu && myRole === menuSelectorRole && !savedOrderFinalized) {
      return {
        kicker: "YOUR ORDER",
        title: savedOrderAmountMsats > 0 ? "Review your cart, then mark it ready." : "Build your cart before this trade can lock.",
        body: "Save as many edits as you need. Press Ready when the selection is final so the counterparty can fund exactly that snapshot.",
        tone: "accent",
        color: T.accent,
        amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
      };
    }
    if (canILock) {
      if (!participantsBuyer) {
        return {
          kicker: "WAITING",
          title: "Waiting for the buyer to enter the trade.",
          body: "Your listing stays visible. Funding opens once a buyer joins and, for menu listings, finalizes the order.",
          tone: "teal",
          color: T.teal,
          amountMsats: null,
        };
      }
      if (menuSelectionMissing || menuOrderNotFinal) {
        return {
          kicker: "ORDER PENDING",
          title: `${roleDisplayName(menuSelectorRole)} is still choosing what they want.`,
          body: "Do not fund early. The final order snapshot will appear here once they press Ready.",
          tone: "accent",
          color: T.accent,
          amountMsats: savedOrderAmountMsats > 0 ? savedOrderAmountMsats : null,
        };
      }
      return {
        kicker: "READY TO FUND",
        title: "Fund this exact order when you are ready.",
        body: "Chama will mint the ecash escrow, split the Shamir shares, and publish the lock in one step.",
        tone: "accent",
        color: T.accent,
        amountMsats: lockAmountMsats,
      };
    }
    return {
      kicker: "WAITING",
      title: "Waiting for the locking side to fund.",
      body: "Stay nearby. Once sats enter escrow, the vote and claim path opens from this same trade room.",
      tone: "purple",
      color: T.purple,
      amountMsats: savedOrderAmountMsats || state.amountMsats,
    };
  }

  if (state.status === EscrowStatus.LOCKED) {
    if (votePromptKind === "buttons") {
      return {
        kicker: "YOUR NEXT STEP",
        title: "Confirm the outcome when the off-chain side is complete.",
        body: "Release pays the winner for this vertical. Refund sends sats back to the original locker.",
        tone: "purple",
        color: T.purple,
        amountMsats: state.amountMsats,
      };
    }
    return {
      kicker: "LIVE TRADE",
      title: "Sats are locked. Waiting on the next confirmation.",
      body: "Use chat for proof, receipts, and timing. The arbiter only matters if the two sides disagree.",
      tone: "purple",
      color: T.purple,
      amountMsats: state.amountMsats,
    };
  }

  if ((state.status === EscrowStatus.APPROVED || state.status === EscrowStatus.CLAIMED) && iAmWinner) {
    return {
      kicker: claimRetryBlocked ? "CLAIM BLOCKED" : "READY TO CLAIM",
      title: claimRetryBlocked ? "This claim needs recovery, not another retry." : "Claim your sats from escrow.",
      body: claimRetryBlocked
        ? "The federation consumed the notes before local settlement finished. Use the recovery surface if a balance appears."
        : "Chama will settle the ecash and route payout through the best available path for this environment.",
      tone: claimRetryBlocked ? "red" : "accent",
      color: claimRetryBlocked ? T.red : T.accent,
      amountMsats: state.amountMsats,
    };
  }

  if (state.status === EscrowStatus.COMPLETED) {
    return {
      kicker: "COMPLETE",
      title: "This trade is settled.",
      body: "The event chain is preserved below for auditability. Ratings will plug into this moment next.",
      tone: "green",
      color: T.green,
      amountMsats: state.amountMsats,
    };
  }

  if (state.status === EscrowStatus.CANCELLED || state.status === EscrowStatus.EXPIRED) {
    return {
      kicker: "CLOSED",
      title: "This trade is no longer active.",
      body: "No new funding or claim action is available on this escrow.",
      tone: "red",
      color: T.red,
      amountMsats: null,
    };
  }

  return {
    kicker: "TRADE ROOM",
    title: STATUS[state.status]?.l ?? state.status,
    body: "Follow the active controls below. Chama keeps the event trail available for auditability.",
    tone: "teal",
    color: T.teal,
    amountMsats: state.amountMsats,
  };
}

function menuQtyButtonStyle(): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: 999,
    border: `1px solid ${T.border}`,
    background: T.card,
    color: T.text,
    fontFamily: T.mono,
    fontSize: 15,
    fontWeight: 900,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  };
}

function menuPickButtonStyle(selected: boolean): React.CSSProperties {
  return {
    padding: "8px 11px",
    borderRadius: 999,
    border: `1px solid ${selected ? T.green : T.border}`,
    background: selected ? `${T.green}22` : T.card,
    color: selected ? T.green : T.text,
    fontFamily: T.mono,
    fontSize: 11,
    fontWeight: 800,
    cursor: "pointer",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
}

function voteDecisionChipStyle(color: string): React.CSSProperties {
  return {
    minHeight: 44,
    minWidth: 0,
    borderRadius: 18,
    border: `1px solid ${color}38`,
    background: color === T.muted
      ? T.surface
      : `linear-gradient(180deg, ${color}1f 0%, ${color}0f 100%)`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    padding: "7px 5px",
    color,
    fontFamily: T.mono,
    textTransform: "uppercase",
    boxShadow: color === T.muted ? "none" : `inset 0 1px 0 ${color}22`,
    overflow: "hidden",
  };
}

function voteDecisionValueStyle(): React.CSSProperties {
  return {
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 16,
    fontWeight: 900,
    lineHeight: 1.05,
    letterSpacing: 0,
  };
}

function voteDecisionLabelStyle(): React.CSSProperties {
  return {
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 7,
    fontWeight: 800,
    lineHeight: 1.15,
    letterSpacing: 0.45,
    opacity: 0.86,
  };
}

function voteActionButtonStyle({
  disabled,
  background,
  border,
  color,
}: {
  disabled: boolean;
  background: string;
  border: string;
  color: string;
}): React.CSSProperties {
  // v1.2.5: dropped the borderRadius: 999 pill shape in favour of the
  // standard T.r (12px) card radius so the vote buttons sit in the
  // same visual vocabulary as the rest of the TradeDetail surface
  // (participants pill, chama bar, advanced-event-chain card, etc.).
  // Left-aligned content + larger icon/label gap reads less like a
  // toggle and more like a deliberate "pick one of these actions"
  // card pair.
  return {
    width: "100%",
    minWidth: 0,
    minHeight: 60,
    padding: "14px 16px",
    borderRadius: T.r,
    background: disabled ? T.surface : background,
    border: `1px solid ${border}`,
    color,
    fontFamily: T.mono,
    cursor: disabled ? "default" : "pointer",
    transition: "transform 0.2s, border-color 0.2s, background 0.2s",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 12,
    boxShadow: disabled ? "none" : `inset 0 1px 0 ${color}24`,
    overflow: "hidden",
    textAlign: "left",
  };
}

function voteActionIconStyle(color: string): React.CSSProperties {
  // Matching: rounded-square icon chip (T.rs = 8px) instead of a
  // circular badge. Stays small enough to feel like a glyph rather
  // than a competing UI element.
  return {
    width: 28,
    height: 28,
    borderRadius: T.rs,
    border: `1px solid ${color}55`,
    background: `${color}18`,
    color,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
    fontSize: 15,
    fontWeight: 900,
    lineHeight: 1,
  };
}

function voteActionLabelStyle(): React.CSSProperties {
  return {
    minWidth: 0,
    color: "inherit",
    fontSize: 12,
    fontWeight: 800,
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
    overflowWrap: "anywhere",
  };
}

function voteOutcomeLabel(outcome: "Release" | "Refund", label: string): string {
  return label.toLowerCase().includes(outcome.toLowerCase())
    ? label
    : `${outcome} · ${label}`;
}

function menuPickLabel(category: string): string {
  if (category === "bill-pay") return "Pick bill";
  if (category === "lending") return "Pick loan";
  return "Pick";
}

function roleDisplayName(role: Role): string {
  if (role === Role.BUYER) return "Buyer";
  if (role === Role.SELLER) return "Seller";
  return "Arbiter";
}

function parsePositiveWholeSats(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function detailHeroFiatAmount({
  state,
  selectedMenuItems,
  savedOrderItems,
  menuItems,
}: {
  state: EscrowState;
  selectedMenuItems: SelectedMenuItem[];
  savedOrderItems: SelectedMenuItem[];
  menuItems: NonNullable<EscrowState["items"]>;
}): { amount: number; currency: string } | null {
  const lockedRows = state.lock.selectedItems ?? [];
  const activeRows = lockedRows.length > 0
    ? lockedRows
    : selectedMenuItems.length > 0
      ? selectedMenuItems
      : savedOrderItems;
  const rowTotal = sumFiatRows(activeRows);
  if (rowTotal) return rowTotal;
  if (state.fiatAmount != null && state.fiatCurrency) {
    return { amount: state.fiatAmount, currency: state.fiatCurrency };
  }
  return fiatFloorRows(menuItems);
}

function detailEstimatedHeroFiatAmount({
  state,
  amountMsats,
  quoteCurrency,
  usdPerBtc,
  usdFiatRates,
}: {
  state: EscrowState;
  amountMsats: number;
  quoteCurrency: string | null | undefined;
  usdPerBtc: number | null;
  usdFiatRates: Record<string, number>;
}): { amount: number; currency: string } | null {
  const currency = resolveEstimatedFiatCurrency({
    viewerCurrency: quoteCurrency,
    listingCurrency: normalizeFiatCurrency(state.fiatCurrency)
      ?? normalizeFiatCurrency(state.community ? getCommunityBySlug(state.community)?.currency : null),
  });
  if (!currency) return null;
  const amount = estimateFiatForMsats({
    amountMsats,
    currency,
    usdPerBtc,
    usdFiatRates,
  });
  return amount === null ? null : { amount, currency };
}

function detailPremiumCheckoutLine(
  state: EscrowState,
  heroFiat: { amount: number; currency: string } | null,
): string | null {
  if (state.category !== "p2p-trade" && state.category !== "bill-pay") return null;
  if (state.premiumBps === undefined || !heroFiat || heroFiat.amount <= 0) return null;
  const checkoutFiat = heroFiat.amount * (1 + state.premiumBps / 10_000);
  if (!Number.isFinite(checkoutFiat) || checkoutFiat < 0) return null;
  return `${formatFiatAmount(heroFiat.amount, heroFiat.currency)} -> ${formatFiatAmount(checkoutFiat, heroFiat.currency)} at checkout`;
}

function sumFiatRows(rows: readonly { fiatAmount?: number; fiatCurrency?: string; quantity?: number }[]): { amount: number; currency: string } | null {
  const priced = rows.filter((row) => row.fiatAmount !== undefined && row.fiatCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((row) => row.fiatCurrency));
  if (currencies.size !== 1) return null;
  const currency = priced[0]?.fiatCurrency;
  const amount = priced.reduce((sum, row) => sum + (row.fiatAmount ?? 0) * Math.max(1, row.quantity ?? 1), 0);
  return currency && Number.isFinite(amount) && amount > 0 ? { amount, currency } : null;
}

function fiatFloorRows(rows: readonly { fiatAmount?: number; fiatCurrency?: string }[]): { amount: number; currency: string } | null {
  const priced = rows.filter((row) => row.fiatAmount !== undefined && row.fiatCurrency);
  if (priced.length === 0) return null;
  const currencies = new Set(priced.map((row) => row.fiatCurrency));
  if (currencies.size !== 1) return null;
  const currency = priced[0]?.fiatCurrency;
  const amount = Math.min(...priced.map((row) => row.fiatAmount ?? Number.POSITIVE_INFINITY));
  return currency && Number.isFinite(amount) ? { amount, currency } : null;
}

function satsInputValue(amountMsats: number): string {
  return String(Math.floor(amountMsats / 1000));
}

function menuAmountLabel(item: { amountMsats: number; minAmountMsats?: number; maxAmountMsats?: number }) {
  if (item.minAmountMsats !== undefined && item.maxAmountMsats !== undefined) {
    const min = fmtSats(item.minAmountMsats);
    const max = fmtSats(item.maxAmountMsats);
    return (
      <BitcoinAmount
        label={min === max ? min : `${min}-${max}`}
        size={10}
        gap={3}
        glyphScale={1.2}
        color={T.muted}
        glyphColor={T.muted}
      />
    );
  }
  return (
    <BitcoinAmount
      msats={item.amountMsats}
      size={10}
      gap={3}
      glyphScale={1.2}
      color={T.muted}
      glyphColor={T.muted}
    />
  );
}

function menuHeaderTitle(category: string, isListing: boolean): string {
  if (!isListing) return "ORDER";
  if (category === "p2p-trade") return "AMOUNT OPTIONS";
  if (category === "bill-pay") return "BILL BUNDLE";
  if (category === "lending") return "LOAN OFFERS";
  if (category === "marketplace") return "STORE";
  return "MENU";
}

function shortParticipantPubkey(pubkey: string): string {
  return pubkey.length > 13 ? `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}` : pubkey;
}

function menuSelectionHint(category: string): string {
  if (category === "bill-pay") return "pick bills";
  if (category === "lending") return "pick loans";
  if (category === "marketplace") return "build cart";
  return "choose";
}

function menuSelectionTitle(category: string): string {
  if (category === "p2p-trade") return "Enter an exact sats amount inside one option.";
  if (category === "bill-pay") return "Pick at least one bill before locking.";
  if (category === "lending") return "Pick at least one loan offer before locking.";
  if (category === "marketplace") return "Add at least one store item before locking.";
  return "Select at least one menu item.";
}

function menuSelectionButtonLabel(category: string): string {
  if (category === "p2p-trade") return "Choose amount";
  if (category === "bill-pay") return "Pick bills";
  if (category === "lending") return "Pick loans";
  if (category === "marketplace") return "Add item";
  return "Select item";
}

function menuMetaLine(item: {
  dueAt?: number;
  termDays?: number;
  aprBps?: number;
  trustTier?: number;
  fiatAmount?: number;
  fiatCurrency?: string;
}): string | null {
  const parts: string[] = [];
  if (item.fiatAmount !== undefined && item.fiatCurrency) {
    parts.push(`${item.fiatCurrency} ${item.fiatAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  if (item.dueAt) parts.push(`due ${new Date(item.dueAt * 1000).toLocaleDateString()}`);
  if (item.termDays) parts.push(`${item.termDays}d`);
  if (item.aprBps) parts.push(`${(item.aprBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}% APR`);
  if (item.trustTier) parts.push(`tier ${item.trustTier}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
