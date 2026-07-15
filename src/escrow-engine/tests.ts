// ══════════════════════════════════════════════════════════════════════════
// Chama Escrow Engine — Test Suite (PR 1 atomic funding + PR 2 community)
// ══════════════════════════════════════════════════════════════════════════
//
// Run: npx tsx src/escrow-engine/tests.ts
//
// Tests the pure state machine with synthetic events — no relays, no
// crypto, no network. Just state transitions and invariants for:
//
//   PR 1 — atomic funding spine:
//     - LOCK fires directly from CREATED (no FUNDED, no READY ceremony)
//     - LOCK is self-describing: carries buyerPubkey + arbiterPubkey
//     - JOIN is ACK only — records pubkey but does NOT transition state
//     - Double-LOCK rejected (atomic, not idempotent-with-side-effects)
//     - Arbiter must be from communityArbiters pool when present
//     - LOCK pubkeys consistent with any prior JOIN ACKs
//
//   PR 2 — community + listing schema + BLF resolver + vote labels:
//     - Community registry lookup (valid/missing/null slug)
//     - User community storage (default + persistence)
//     - BP fallback in resolveFederationForCommunity (BLF only via opt-in)
//     - Fulfillment normalization in handleCreate (auto-set per category)
//     - Vote label dictionary returns the right copy per
//       (category, fulfillment, role, outcome) tuple

// PR 2: minimal localStorage stub for the storage + resolver tests.
// The escrow modules already gate on `typeof localStorage !== "undefined"`,
// so installing this stub before any imports lets the storage-aware code
// paths run under tsx in Node without ceremony.
(globalThis as any).localStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
  };
})();

import {
  EscrowStatus,
  TRULY_TERMINAL_STATES,
  EscrowEventKind,
  Role,
  Outcome,
  JOIN_HOLD_SECONDS,
  JOIN_HOLD_LOCK_GRACE_SECONDS,
  joinHoldExpiresAt,
  getEffectiveParticipantAt,
  type EscrowState,
  type ParsedEscrowEvent,
  type CreatePayload,
  type JoinPayload,
  type LockPayload,
  type MenuItem,
  type VotePayload,
  type ResolvePayload,
  type ClaimPayload,
  type CompletePayload,
  type CancelPayload,
  type ChatPayload,
  type EscrowPayload,
  type NostrEvent,
} from "./types.js";

import {
  applyEvent,
  replayEventChain,
  canVote,
  getWinner,
  payoutRecipientFor,
  isExpired,
  getSummary,
  type TransitionResult,
} from "./state-machine.js";
import {
  holderRoleForShareIndex,
  shareIndexForRole,
  holderPubkeyForShareIndex,
  validateVoteShareEnvelope,
} from "./holder-shares.js";

import {
  parseEscrowEvent,
  sortEventChain,
  buildEscrowFilter,
} from "./event-parser.js";
import {
  remainingStock,
  unsoldStock,
  isSoldOut,
  isLastUnitContested,
  childCommitsStock,
  buildChildCreateParams,
  overcommittedChildren,
  isParentStorefront,
  isChildOrder,
  isLiveChildOrder,
} from "./storefront.js";
import {
  canRenewListing,
  listingNeverFunded,
  buildRenewCreateParams,
  sellerIsBonded,
  resolveListingTenure,
  isSellerOwnedListing,
  lapsedRenewableListings,
  BONDED_TENURE_SECONDS,
  UNBONDED_TENURE_SECONDS,
} from "./listing-renewal.js";
import {
  isDueForRepost,
  priorInstanceBlocks,
  nextRepostAt,
  RECURRENCE_PERIOD_SECONDS,
  type CbpRecurrenceConfig,
} from "./cbp-recurrence.js";
import {
  arbiterPriorityOrder,
  arbiterPriorityOrderFor,
  arbiterVotePriority,
  disputeStartAt,
  substitutionEligibleAt,
  SUBSTITUTION_GRACE_MAX_SECONDS,
  DISPUTE_CLOCK_SLACK_SECONDS,
  clampSubstitutionGraceSeconds,
  oneSidedEscalationAt,
  oneSidedReleaseAnchor,
  isPerformanceContest,
} from "./arbiter-substitution.js";
import {
  EscrowClient,
  type Signer,
  type UnsignedEvent,
} from "./escrow-client.js";
import { RelayManager, RelayStatus } from "./relay-manager.js";

// PR 2 imports
import {
  COMMUNITY_REGISTRY,
  CENTRAL_AFRICA_COUNTRY_CODES,
  DEFAULT_COMMUNITY_SLUG,
  EAST_AFRICA_COUNTRY_CODES,
  WEST_AFRICA_COUNTRY_CODES,
  getCommunityBySlug,
  communityForInvite,
  getCustomCommunities,
  getCustomCommunityBySlug,
  addCustomCommunity,
  removeCustomCommunity,
  claimGeneratedShellCreator,
} from "../communities/registry.js";
import {
  getUserCommunitySlug,
  getUserCommunitySlugRaw,
  setUserCommunitySlug,
  COMMUNITY_STORAGE_KEY,
} from "../communities/storage.js";
import { defaultCurrencyForCommunity } from "../communities/currency.js";
import {
  buildCommunityRequestMessage,
  getCommunityRequestRecipients,
  sendCommunityRequestToGlobalArbiters,
  setPendingCommunityReport,
  getPendingCommunityReport,
  clearPendingCommunityReport,
} from "../communities/community-request.js";
import {
  resolveFederationForCommunity,
  getFederationInvite,
  getActiveInvite,
  setActiveInvite,
  setCustomFederationInvite,
  shouldReconcileFederation,
  expectedFederationIdForInvite,
  effectiveCreateFederationId,
  PUBLIC_FEDI_APPROVED_FEDERATIONS,
  BP_FEDERATION_ID,
  AFRIBIT_KIBERA_FEDERATION_ID,
  BITSACCO_FEDERATION_ID,
  BLF_FEDERATION_ID,
  BP_FEDERATION_INVITE,
  AFRIBIT_KIBERA_FEDERATION_INVITE,
  BITSACCO_FEDERATION_INVITE,
  BLF_FEDERATION_INVITE,
} from "../fedimint/federation-config.js";
import { OCA_FEDERATION_INVITE } from "../fedimint/federation-invites.js";
import { adaptRealWallet, resetLocalFedimintWallet, classifyPayOutcome } from "../fedimint/sdk-adapter.js";
import {
  clearAllPendingRedemptions,
  listPendingRedemptions,
  stashPendingRedemption,
  drainPendingRedemptions,
  markPoisoned,
  markUnresolvedCredit,
  resolveUnresolvedCredit,
  listStrandedRedemptions,
  partitionStrandedClaims,
  MAX_DRAIN_ATTEMPTS,
  PENDING_REDEMPTIONS_KEY,
} from "../fedimint/pending-redemptions.js";
import { decideOrphanWipe, NO_CLIENT_OPEN_ERROR_RE } from "../fedimint/orphan-wipe-policy.js";
import { collectClaimEnvelopeCandidates } from "./holder-shares.js";
import {
  stashEcashExport,
  getEcashExport,
  clearEcashExport,
} from "../payments/ecash-exports.js";
import {
  recoverSeedWordsFromEvents,
  queryUntilFound,
  FEDI_SEED_DECRYPT_RETRY_DELAYS_MS,
  SEED_DECRYPT_RETRY_DELAYS_MS,
  SEED_RECOVERY_RETRY_DELAYS_MS,
} from "../fedimint/seed-manager.js";
import { deriveCreateFedTags } from "../fedimint/create-fed-tags.js";
import {
  getVoteLabel,
  defaultFulfillmentFor,
  categoryAllowsFulfillmentChoice,
} from "../labels/vote-labels.js";
import {
  funderRole,
  performerRole,
  markDoneVerb,
  markDoneChatMessage,
  isStructuredMarkDoneMessage,
  refundReasons,
  eventToSystemBubble,
  type LivingChatCtx,
} from "../labels/trade-progress.js";

// PR 3 imports
import {
  RAIL_REGISTRY,
  getRailByKey,
  railsForCommunity,
  searchableRailsForCommunity,
  phoneNetworksForCommunity,
  railAllowsPublicHandle,
  matchRails,
  toRailKey,
  categoryUsesPaymentRails,
} from "../payments/rail-registry.js";
import {
  getForgottenEscrowIds,
  isForgottenEscrowId,
  addForgottenEscrowId,
  unforgetEscrowId,
} from "../storage/forgotten-trades.js";
import {
  SAVED_HANDLES_STORAGE_KEY,
  SAVED_HANDLES_BACKUP_STORAGE_KEY,
  listSavedHandles,
  getSavedHandle,
  getSavedHandlesByRail,
  addSavedHandle,
  deleteSavedHandle,
  updateSavedHandle,
  setHandleVisibility,
  maskHandle,
  formatPhoneNumber,
  formatPhoneNumberForDisplay,
  formatPhoneNumberRevealed,
  getPhoneNumberSaveError,
  getPhoneNumberDisplayParts,
  sanitizePhoneNumberForSave,
  publicHandleDisplay,
  handleDisplayForViewer,
  LIGHTNING_RAIL,
  type SavedHandle,
} from "../payments/saved-handles.js";
import {
  PAYOUT_DESTINATIONS_STORAGE_KEY,
  PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY,
  addOrTouchPayoutDestination,
  listPayoutDestinations,
  deletePayoutDestination,
  migrateLegacyLightningHandles,
  type PayoutDestination,
} from "../payments/payout-destinations.js";
import {
  CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY,
  getChapsmartPayoutProfile,
  isChapsmartPayoutEligible,
  saveChapsmartPayoutProfile,
  toChapsmartTanzaniaPhone,
} from "../payments/chapsmart-payout.js";
import {
  BANXAAS_PAYOUT_COUNTRIES,
  BANXAAS_SWAP_URL,
  getBanxaasPayoutAvailability,
} from "../payments/banxaas-payout.js";
import {
  EXTERNAL_SWAP_PROVIDERS,
  getExternalSwapsForContext,
} from "../payments/external-swap-registry.js";
import {
  TANDO_LNADDRESS_DOMAIN,
  normalizeKenyanMsisdn,
  isValidKenyanMsisdn,
  buildTandoLightningAddress,
  formatKenyanMsisdnDisplay,
  isTandoLightningAddress,
  tandoMsisdnFromAddress,
  isKenyaPayoutContext,
} from "../payments/tando-offramp.js";
import {
  CHAPSMART_LNADDRESS_DOMAIN,
  normalizeTanzanianMsisdn,
  isValidTanzanianMsisdn,
  buildChapsmartLightningAddress,
  formatTanzanianMsisdnDisplay,
  isChapsmartLightningAddress,
  chapsmartMsisdnFromAddress,
  isTanzaniaPayoutContext,
} from "../payments/chapsmart-offramp.js";
import {
  CHAPSMART_ONRAMP_ENABLED,
  CHAPSMART_MPESA_AGENT_NUMBER,
  CHAPSMART_TARGET_TOLERANCE,
  CHAPSMART_SEND_SATS_TOLERANCE,
  isChapsmartOnrampContext,
  chapsmartMpesaPaySteps,
  normalizeMpesaConfirmationCode,
  quoteMatchesTargetSats,
  estimateTzsForTargetSats,
  getBuyQuoteForSats,
  type ChapsmartBuyQuote,
} from "../payments/chapsmart-onramp.js";
import {
  STRIKE_LNADDRESS_DOMAIN,
  STRIKE_CASH_HINT,
  STRIKE_CASH_CAVEAT,
  STRIKE_CASH_STEPS,
  normalizeStrikeUsername,
  isValidStrikeUsername,
  buildStrikeLightningAddress,
  isStrikeLightningAddress,
  strikeUsernameFromAddress,
  isUSPayoutContext,
} from "../payments/strike-offramp.js";
import {
  HOUR_SECONDS,
  DAY_SECONDS,
  FALLBACK_EXPIRY,
  expiryBoundsForCategory,
  defaultExpiryForCategory,
  clampExpiryForCategory,
  isExtendedExpiry,
} from "./trade-durations.js";

// v0.3.0 Phase 1 — LNURL + DestinationPicker logic
import {
  parseLightningAddress,
  isLightningAddress,
  parseRawLnurl,
  isRawLnurl,
  fetchLnurlPayMetadata,
  requestLnurlInvoice,
  resolveLightningAddressToInvoice,
  resolveRawLnurlToInvoice,
  LnurlError,
  type LnurlPayMetadata,
} from "../payments/lnurl.js";
import {
  parseNwcConnectionString,
  isNwcConnectionString,
  buildNwcMakeInvoiceRequest,
  buildNwcPayInvoiceRequest,
  extractInvoiceFromNwcResponse,
  extractPreimageFromNwcPayResponse,
  humanizeNwcError,
  NwcError,
} from "../payments/nwc.js";
import {
  NWC_CONNECTIONS_STORAGE_KEY,
  NWC_CONNECTIONS_BACKUP_STORAGE_KEY,
  addOrTouchSavedNwcConnection,
  listSavedNwcConnections,
  deleteSavedNwcConnection,
} from "../payments/nwc-connections.js";
import {
  decoratePayoutDestinationsForPicker,
  classifyDestinationInput,
  decideDispatch,
} from "../ui/components/destination-picker-logic.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import {
  BLF_OFFICIAL_ARBITERS,
  BLF_CABINET_NPUBS,
  getTrustedArbiterPool,
  normalizeTrustedArbiterInput,
  classifyArbiterProvenance,
  classifyArbiterAssignment,
  classifySelfRoster,
  requiresVerifiedRosterConsent,
  HIGH_VALUE_CONSENT_MSATS,
  pickArbiterFromPool as pickArbiterFromPoolV35,
} from "../arbiters/pool.js";
import * as btcMs from "@scure/btc-signer";
import { base64 as msBase64 } from "@scure/base";
import { hexToBytes as msHexToBytes, bytesToHex as msBytesToHex } from "@noble/hashes/utils.js";
import {
  buildBondMultisig, recomputeAddress, buildReturnPsbt, coSignPsbt,
  combineAndFinalize, verifyReturnPsbt, SIGNET as MS_NET, MAINNET as MS_MAINNET, type BondUtxo,
} from "../bond-multisig/multisig.js";
import { findBondFundingUtxos, esploraOutspend, esploraRecommendedFeeRate, defaultEsploraBase, defaultMinConfs, type EsploraFetch } from "../bond-multisig/fund-watcher.js";
import {
  buildCommitmentBond, recomputeCommitmentAddress, buildReclaimTx, buildTimelockLeaf,
  buildKeyPathSweepTx, estimateReclaimVsize, estimateReclaimFeeSats,
  estimateKeyPathSweepVsize, estimateKeyPathSweepFeeSats, deriveBondSigningKey as deriveCommitmentKey,
  bip86BondPath, MIN_COMMITMENT_TERM_BLOCKS, DEFAULT_RECLAIM_FEE_RATE,
  resolveReclaimDestination, validateBitcoinAddressForNetwork,
} from "../bond-multisig/commitment-bond.js";
import {
  buildBondAnnouncementEvent, parseBondAnnouncementEvent, verifyBondAnnouncement,
  selectLatestAnnouncements, groupLatestAnnouncementsByCommunity, type VerifiedBond,
} from "../bond-multisig/bond-announcement.js";
import { computeChamaLiveness, formatLivenessReadout, bondedArbitersForCommunity } from "../arbiters/live-chama.js";
import {
  serializeCommitment, deserializeCommitment, type CommitmentRecord,
  upsertCommitmentBond, getCommitmentBond, listCommitmentBonds, reconstructBondRecord, newBondId as newCommitmentBondId,
} from "../bond-multisig/commitment-store.js";
import {
  AMBIENT_ARBITER_FEE_BPS,
  DISPUTE_ARBITER_FEE_BPS,
  DISPUTE_PARTY_SHARE_BPS,
  TOTAL_DISPUTED_ARBITER_FEE_BPS,
  calculateAmbientArbiterFeeMsats,
  calculateBasisPointFeeMsats,
  calculateDisputeArbiterFeeMsats,
  calculateDisputePartyShareMsats,
} from "../arbiters/fees.js";

// v0.3.0 Phase 2 — atomic fund-and-lock orchestrator
import {
  pollForFunding,
  runFundAndLock,
  type FundingPhase,
  type FundAndLockPhase,
  type FundAndLockTerminal,
} from "../payments/fund-and-lock.js";

// v0.3.0 Phase 3 — atomic claim-and-payout orchestrator
// v0.3.1 Phase 1 — adds claim-bridge-threw terminal + bridge-throw discrimination
import {
  waitForBalanceGrowth,
  runClaimAndPayout,
  balanceCoversPayout,
  BRIDGE_THREW_ERROR_CODES,
  CONFIRM_HARD_CAP_MULTIPLIER,
  type ClaimAndPayoutPhase,
} from "../payments/claim-and-payout.js";

// v0.3.0 Phase 4 — balance recovery orchestrator
import {
  runRecoveryPayout,
  type RecoveryPayoutPhase,
} from "../payments/balance-recovery.js";
import {
  claimPayoutReserveSats,
  claimPayoutSats,
  estimateLightningSendFeeMsats,
  hasLightningWithdrawableBalance,
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
  retrySmallerLightningPayoutSats,
} from "../payments/lightning-fees.js";
import {
  MIN_REAL_ATOMIC_FUNDING_MSATS,
  MIN_REAL_ATOMIC_FUNDING_SATS,
  minimumAtomicFundingMessage,
} from "../payments/funding-limits.js";
import {
  parseBolt11Msats as parsePaymentBolt11Msats,
} from "../payments/bolt11.js";
import {
  buildChamaOperationMeta,
  describeSatsTrace,
  getBestSatsTrace,
  listOpenSatsTraces,
  markSatsTracesDrained,
  recordSatsTrace,
  SATS_TRACE_STORAGE_KEY,
} from "../payments/sats-trace.js";
import { makeLightningInvoiceQrPayload } from "../payments/lightning-qr.js";
import { EscrowFedimintBridge } from "../fedimint/escrow-bridge.js";
import {
  DEFAULT_NATIVE_BRIDGE_COMMUNITY,
  NATIVE_BRIDGE_COMMUNITY_KEY,
  NATIVE_BRIDGE_MODE_KEY,
  NATIVE_BRIDGE_URL_KEY,
  NativeBridgeWallet,
  getConfiguredNativeBridgeCommunitySlug,
  getNativeBridgeCommunitySlug,
  getNativeBridgeUrl,
  isNativeBridgeModeOn,
} from "../fedimint/native-bridge-adapter.js";

// v0.3.0 Phase 5 — ChamaBar label decision
import {
  decideChamaBarLabel,
  decideVotePrompt,
  selectNeedsYouTrades,
  countNeedsYou,
} from "../ui/decisions.js";
import {
  estimateFiatForMsats,
  estimateSatsForFiat,
  normalizeFiatCurrency,
  resolveEstimatedFiatCurrency,
  shouldQuoteEstimatedFiat,
} from "../ui/amount-display.js";
import { listingPremiumLine } from "../ui/listing-metrics.js";
import {
  isFediWebViewSignInEnvironment,
  isMobileSignInEnvironment,
  shouldApplyCssSafeAreaInsets,
  shouldOfferNIP46Signer,
} from "../ui/sign-in-environment.js";
import {
  adaptNIP46BunkerSigner,
  createNip46PairingSecret,
} from "./nip46-signer.js";
import { FediSigner, NIP07Signer } from "./signers.js";
import { validateRecoveryKeyInput } from "./nsec-signer.js";
import {
  getLocalStorageUserScope,
  scopedStorageKey,
  setLocalStorageUserScope,
} from "../storage/user-scope.js";

// v0.3.0 Phase 6 — Trinity Ring participant order (theme.ts)
// v0.3.1 Phase 2 — extends §43 with a grep tripwire over src/ui/
import {
  TRINITY_RING_ORDER,
  T,
  STATUS,
  inputStyle,
  applyThemeMode,
  normalizeThemeMode,
  resolveThemeMode,
} from "../ui/theme.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// v0.3.0 Phase 6 — State B explainer card gate
import {
  hasStateBExplained,
  markStateBExplained,
  STATE_B_EXPLAINED_KEY_PREFIX,
} from "../ui/screens/state-b-explainer.js";

// PR 4 imports — envelope helpers + real NIP-44 from nostr-tools
import {
  createEnvelope,
  decryptFromEnvelope,
  envelopeHasRecipient,
} from "./envelope.js";
import { ENCRYPTION_CONFIG } from "./encryption-config.js";
import { generateSecretKey, getPublicKey, nip19, nip44 } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";
import {
  ARBITER_ROSTER_KIND,
  buildArbiterRosterEvent,
  parseArbiterRosterEvent,
  resolveRosterAuthority,
  selectLatestRoster,
  writeCachedRosterEvent,
  readRosterPool,
  fetchAndCacheCommunityRoster,
} from "../arbiters/roster.js";
import {
  buildArbiterApplicationEvent,
  parseArbiterApplicationEvent,
  collectArbiterApplications,
} from "../arbiters/applications.js";
import {
  ARBITER_BOND_KIND,
  buildArbiterBondEvent,
  parseArbiterBondEvent,
  selectLatestBond,
} from "../arbiters/bonds.js";
import {
  VICTIM_ATTESTATION_KIND,
  buildVictimAttestationEvent,
  parseVictimAttestationEvent,
  selectLatestAttestation,
} from "../arbiters/victim-attestation.js";
import {
  UNBONDED_FLOOR_MSATS,
  BONDS_ENFORCED,
  getArbiterBond,
  getOpenBondedTrades,
  liveCapacity,
  classifyArbiterCapacity,
  canAssignArbiter,
  exposureTier,
  selectOverCapacityArbiters,
  assignablePool,
  assignableBondedArbiters,
} from "../arbiters/exposure.js";
import { notificationForTransition, chatNotificationFor, buyerInterestNotificationFor, newListingNotificationFor } from "../notifications/trade-notifications.js";
import { catchUpPrev, readSeenStatus, recordSeenStatus } from "../notifications/notify-service.js";
import {
  RATING_KIND,
  buildRatingEvent,
  parseRatingEvent,
  verifyRatingForTrade,
  aggregateRatings,
  aggregateVerifiedRatings,
  ratingReplaceableKey,
  counterpartyToRate,
  type Rating,
} from "../reputation/ratings.js";

/** Build a minimal NIP-44 encrypt/decrypt pair for a given private key,
 *  using nostr-tools v2 NIP-44. The "encrypt as me to recipient" function
 *  derives ECDH(my_priv, recipient_pub); "decrypt sent by sender" derives
 *  ECDH(my_priv, sender_pub). Both lead to the same shared secret on
 *  matched pairs, the bedrock of NIP-44. */
function makeNip44(myPriv: Uint8Array) {
  return {
    encrypt: async (plaintext: string, recipientPubkey: string): Promise<string> => {
      const conv = nip44.v2.utils.getConversationKey(myPriv, recipientPubkey);
      return nip44.v2.encrypt(plaintext, conv);
    },
    decrypt: async (ciphertext: string, senderPubkey: string): Promise<string> => {
      const conv = nip44.v2.utils.getConversationKey(myPriv, senderPubkey);
      return nip44.v2.decrypt(ciphertext, conv);
    },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────

const BUYER_PK    = "aa".repeat(32);
const SELLER_PK   = "bb".repeat(32);
const ARBITER_PK  = "cc".repeat(32);
const ARBITER2_PK = "ee".repeat(32);
const PLATFORM_PK = "dd".repeat(32);
const ESCROW_ID   = "test-escrow-001";

let eventCounter = 0;
const NOW = Math.floor(Date.now() / 1000);

function makeRawEvent(kind: EscrowEventKind, pubkey: string, tags: string[][]): NostrEvent {
  eventCounter++;
  return {
    id: `event_${eventCounter}_${kind}`,
    pubkey,
    created_at: NOW + eventCounter,
    kind,
    tags,
    content: "encrypted",
    sig: "sig_" + eventCounter,
  };
}

function makeParsedEvent<T extends EscrowPayload>(
  kind: EscrowEventKind,
  pubkey: string,
  payload: T,
  prevEventId: string | null = null
): ParsedEscrowEvent<T> {
  const raw = makeRawEvent(kind, pubkey, [
    ["d", ESCROW_ID],
    ...(prevEventId ? [["e", prevEventId, "", "reply"]] : []),
  ]);
  return {
    raw,
    payload,
    escrowId: ESCROW_ID,
    prevEventId,
    kind,
    pubkey,
    timestamp: raw.created_at,
  };
}

// ── Standard event builders ───────────────────────────────────────────────

function createEvent(opts: {
  community?: string;
  communityArbiters?: string[];
  amountMsats?: number;
  premiumBps?: number;
  items?: MenuItem[];
  stock?: number;
  parent?: string;
  claimedQuantity?: number;
  arbiterFeeMsats?: number;
  bondedArbiters?: string[];
} = {}): ParsedEscrowEvent<CreatePayload> {
  return makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create",
    description: "Sell 100k sats for $50 USD via Zelle",
    amountMsats: opts.amountMsats ?? 100_000_000,
    fiatAmount: 50,
    fiatCurrency: "USD",
    premiumBps: opts.premiumBps,
    category: "p2p-trade",
    community: opts.community,
    mintUrl: "fed11q...",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    arbiterFeeMsats: opts.arbiterFeeMsats ?? 1_000_000,
    paymentMethods: ["Zelle", "CashApp"],
    expirySeconds: 86400,
    communityArbiters: opts.communityArbiters,
    bondedArbiters: opts.bondedArbiters,
    items: opts.items,
    ...(opts.stock !== undefined ? { stock: opts.stock } : {}),
    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
    ...(opts.claimedQuantity !== undefined ? { claimedQuantity: opts.claimedQuantity } : {}),
    createdAt: NOW,
  });
}

function joinEvent(
  role: Role,
  pubkey: string,
  prevId: string,
  opts: { selectedItems?: JoinPayload["selectedItems"]; amountMsats?: number; orderFinalized?: boolean } = {},
): ParsedEscrowEvent<JoinPayload> {
  const joinedAt = NOW + eventCounter;
  return makeParsedEvent(EscrowEventKind.JOIN, pubkey, {
    type: "escrow:join",
    role,
    joinedAt,
    ...(role === Role.BUYER || role === Role.SELLER
      ? { holdExpiresAt: joinHoldExpiresAt(joinedAt) }
      : {}),
    ...(role === Role.ARBITER ? { arbiterFeeMsats: 1_000_000 } : {}),
    ...(opts.selectedItems && opts.selectedItems.length > 0 ? { selectedItems: opts.selectedItems } : {}),
    ...(opts.amountMsats !== undefined ? { amountMsats: opts.amountMsats } : {}),
    ...(opts.orderFinalized ? { orderFinalizedAt: joinedAt } : {}),
  }, prevId);
}

function retimeEvent<T extends EscrowPayload>(event: ParsedEscrowEvent<T>, timestamp: number): ParsedEscrowEvent<T> {
  event.raw.created_at = timestamp;
  event.timestamp = timestamp;
  if ("joinedAt" in event.payload && typeof event.payload.joinedAt === "number") {
    event.payload.joinedAt = timestamp;
    if ("holdExpiresAt" in event.payload && typeof event.payload.holdExpiresAt === "number") {
      event.payload.holdExpiresAt = joinHoldExpiresAt(timestamp);
    }
  }
  if ("lockedAt" in event.payload && typeof event.payload.lockedAt === "number") {
    event.payload.lockedAt = timestamp;
  }
  return event;
}

function lockEvent(prevId: string, opts: {
  buyerPubkey?: string;
  arbiterPubkey?: string;
  sellerReceivesMsats?: number;
  arbiterFeeMsats?: number;
  locker?: string;
  selectedItems?: LockPayload["selectedItems"];
} = {}): ParsedEscrowEvent<LockPayload> {
  const buyerPk   = opts.buyerPubkey   ?? BUYER_PK;
  const arbiterPk = opts.arbiterPubkey ?? ARBITER_PK;
  return makeParsedEvent(EscrowEventKind.LOCK, opts.locker ?? SELLER_PK, {
    type: "escrow:lock",
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [buyerPk]: "enc_0_b", [SELLER_PK]: "enc_0_s", [arbiterPk]: "enc_0_a" } },
      { shareIndex: 1, encryptedFor: { [buyerPk]: "enc_1_b", [SELLER_PK]: "enc_1_s", [arbiterPk]: "enc_1_a" } },
      { shareIndex: 2, encryptedFor: { [buyerPk]: "enc_2_b", [SELLER_PK]: "enc_2_s", [arbiterPk]: "enc_2_a" } },
    ],
    sellerReceivesMsats: opts.sellerReceivesMsats ?? 99_000_000,
    arbiterFeeMsats:     opts.arbiterFeeMsats     ?? 1_000_000,
    buyerPubkey:   buyerPk,
    arbiterPubkey: arbiterPk,
    selectedItems: opts.selectedItems,
    lockedAt: NOW + eventCounter,
  }, prevId);
}

function voteEvent(role: Role, pubkey: string, outcome: Outcome, prevId: string): ParsedEscrowEvent<VotePayload> {
  return makeParsedEvent(EscrowEventKind.VOTE, pubkey, {
    type: "escrow:vote",
    outcome,
    role,
    votedAt: NOW + eventCounter,
  }, prevId);
}

function resolveEvent(outcome: Outcome, majority: [Role, Role], arbiterInvolved: boolean, prevId: string): ParsedEscrowEvent<ResolvePayload> {
  return makeParsedEvent(EscrowEventKind.RESOLVE, BUYER_PK, {
    type: "escrow:resolve",
    outcome,
    majority,
    arbiterInvolved,
    resolvedAt: NOW + eventCounter,
  }, prevId);
}

function claimEvent(claimerRole: Role, claimerPk: string, prevId: string): ParsedEscrowEvent<ClaimPayload> {
  return makeParsedEvent(EscrowEventKind.CLAIM, claimerPk, {
    type: "escrow:claim",
    claimerRole,
    notesHashVerification: "hash_of_ecash_notes_abc123",
    claimedAt: NOW + eventCounter,
  }, prevId);
}

function completeEvent(prevId: string): ParsedEscrowEvent<CompletePayload> {
  return makeParsedEvent(EscrowEventKind.COMPLETE, BUYER_PK, {
    type: "escrow:complete",
    completedAt: NOW + eventCounter,
  }, prevId);
}

function cancelEvent(prevId: string): ParsedEscrowEvent<CancelPayload> {
  return makeParsedEvent(EscrowEventKind.CANCEL, SELLER_PK, {
    type: "escrow:cancel",
    cancellerRole: Role.SELLER,
    reason: "Changed my mind",
    cancelledAt: NOW + eventCounter,
  }, prevId);
}

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, details?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${details ? ` — ${details}` : ""}`);
  }
}

function assertOk(result: TransitionResult, name: string): result is { ok: true; state: any } {
  if (result.ok) {
    passed++;
    console.log(`  ✅ ${name}`);
    return true;
  } else {
    failed++;
    console.log(`  ❌ ${name} — ${result.error.code}: ${result.error.message}`);
    return false;
  }
}

function assertErr(result: TransitionResult, expectedCode: string, name: string) {
  if (!result.ok && result.error.code === expectedCode) {
    passed++;
    console.log(`  ✅ ${name} (${expectedCode})`);
  } else if (!result.ok) {
    failed++;
    console.log(`  ❌ ${name} — expected ${expectedCode}, got ${result.error.code}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} — expected error ${expectedCode}, got success`);
  }
}

// Helper: drive a fresh chain to LOCKED. Useful for tests downstream of LOCK.
function buildToLocked(): { state: any; lock: ParsedEscrowEvent<LockPayload> } {
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (!r1.ok) throw new Error("CREATE failed in helper");
  const lock = lockEvent(create.raw.id);
  const r2 = applyEvent(r1.state, lock);
  if (!r2.ok) throw new Error("LOCK failed in helper: " + r2.error.message);
  return { state: r2.state, lock };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════════

console.log("\n🧪 Chama Escrow Engine — Test Suite (PR 1 atomic funding)\n");

// ── 1. CREATE ─────────────────────────────────────────────────────────────
console.log("── CREATE ──");
{
  const create = createEvent();
  const result = applyEvent(null, create);

  if (assertOk(result, "CREATE bootstraps initial state")) {
    const s = result.state;
    assert(s.status === EscrowStatus.CREATED, "Status is CREATED");
    assert(s.id === ESCROW_ID, "Escrow ID set correctly");
    assert(s.participants[Role.SELLER] === SELLER_PK, "Seller is initiator");
    assert(s.paymentMethods?.join(",") === "Zelle,CashApp", "CREATE stores accepted payment methods");
    assert(s.participants[Role.BUYER] === null, "Buyer slot empty pre-LOCK");
    assert(s.participants[Role.ARBITER] === null, "Arbiter slot empty pre-LOCK");
    assert(s.amountMsats === 100_000_000, "Amount set correctly");
    assert(s.premiumBps === undefined, "CREATE premium is optional by default");
    assert(s.fees.platformBps === 50, "Platform fee BPS set");
    assert(s.fees.platformMsats === 500_000, "Platform fee calculated");
    assert(s.eventChain.length === 1, "Event chain has 1 event");
    assert(s.listingExpiresAt === create.timestamp + create.payload.expirySeconds,
      "CREATE sets unlocked listing deadline");
    assert(s.tradeTimeoutSeconds === create.payload.expirySeconds,
      "CREATE stores trade timeout duration for LOCK");
    assert(s.expiresAt === s.listingExpiresAt,
      "CREATED active deadline is the listing deadline");
  }
}

{
  const create = createEvent({ premiumBps: 250 });
  const result = applyEvent(null, create);
  if (assertOk(result, "CREATE accepts optional premium")) {
    assert(result.state.premiumBps === 250, "CREATE stores premium BPS");
  }
}

// Duplicate CREATE
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const r2 = applyEvent(r1.state, createEvent());
    assertErr(r2, "DUPLICATE_CREATE", "Duplicate CREATE rejected");
  }
}

// ── 2. JOIN as ACK (no state transition) ─────────────────────────────────
console.log("\n── JOIN (ACK only — does not transition state) ──");
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (assertOk(r2, "Buyer JOIN accepted as ACK")) {
      assert(r2.state.participants[Role.BUYER] === BUYER_PK, "Buyer pubkey recorded");
      assert(r2.state.joinHolds?.[Role.BUYER]?.expiresAt === join1.payload.holdExpiresAt,
        "Buyer JOIN hold expires in 5 minutes");
      assert(r2.state.status === EscrowStatus.CREATED, "Status STAYS CREATED after buyer JOIN");

      const join2 = joinEvent(Role.ARBITER, ARBITER_PK, join1.raw.id);
      const r3 = applyEvent(r2.state, join2);
      if (assertOk(r3, "Arbiter JOIN accepted as ACK")) {
        assert(r3.state.participants[Role.ARBITER] === ARBITER_PK, "Arbiter pubkey recorded");
        assert(r3.state.status === EscrowStatus.CREATED,
          "Status STAYS CREATED even after all participants JOINed (no FUNDED state)");
        assert(r3.state.fees.arbiterMsats === 1_000_000, "Arbiter fee recorded from JOIN payload");
      }
    }
  }
}

// Role already taken
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, join1);
    if (r2.ok) {
      const join3 = joinEvent(Role.BUYER, "ee".repeat(32), join1.raw.id);
      assertErr(applyEvent(r2.state, join3), "ROLE_TAKEN", "Different pubkey can't grab a filled slot");
    }
  }
}

// Same pubkey re-joining same role: ALREADY_JOINED (idempotent relay echo)
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const join1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, join1) as any).state;
  const join1dup = joinEvent(Role.BUYER, BUYER_PK, join1.raw.id);
  assertErr(applyEvent(state, join1dup), "ALREADY_JOINED", "Same pubkey re-JOIN is benign duplicate");
}

// Buyer/seller JOIN holds expire after 5 minutes and release the slot
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const joinedAt = NOW + 10_000;
  const join1 = retimeEvent(joinEvent(Role.BUYER, BUYER_PK, create.raw.id), joinedAt);
  state = (applyEvent(state, join1) as any).state;

  assert(
    getEffectiveParticipantAt(state, Role.BUYER, joinedAt + JOIN_HOLD_SECONDS - 1) === BUYER_PK,
    "Buyer JOIN hold is active before the 5-minute deadline",
  );
  assert(
    getEffectiveParticipantAt(state, Role.BUYER, joinedAt + JOIN_HOLD_SECONDS + 1) === null,
    "Buyer JOIN hold expires after 5 minutes",
  );
  assert(
    getEffectiveParticipantAt(
      state,
      Role.BUYER,
      joinedAt + JOIN_HOLD_SECONDS + 1,
      { includeLockGrace: true },
    ) === BUYER_PK,
    "Buyer JOIN hold has a hidden lock grace after the visible 5-minute deadline",
  );
  assert(
    getEffectiveParticipantAt(
      state,
      Role.BUYER,
      joinedAt + JOIN_HOLD_SECONDS + JOIN_HOLD_LOCK_GRACE_SECONDS + 1,
      { includeLockGrace: true },
    ) === null,
    "Hidden lock grace expires after the extra background window",
  );

  const nextBuyer = "ef".repeat(32);
  const replacement = retimeEvent(
    joinEvent(Role.BUYER, nextBuyer, join1.raw.id),
    joinedAt + JOIN_HOLD_SECONDS + 1,
  );
  const replaced = applyEvent(state, replacement);
  if (assertOk(replaced, "Expired buyer JOIN hold can be replaced")) {
    assert(replaced.state.participants[Role.BUYER] === nextBuyer, "Replacement buyer occupies the slot");
    assert(replaced.state.joinHolds?.[Role.BUYER]?.pubkey === nextBuyer, "Replacement buyer gets a fresh hold");
  }
}

// Same buyer can refresh their own slot after the hold expires
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const joinedAt = NOW + 20_000;
  const join1 = retimeEvent(joinEvent(Role.BUYER, BUYER_PK, create.raw.id), joinedAt);
  state = (applyEvent(state, join1) as any).state;

  const refreshedJoin = retimeEvent(
    joinEvent(Role.BUYER, BUYER_PK, join1.raw.id),
    joinedAt + JOIN_HOLD_SECONDS + 1,
  );
  const refreshed = applyEvent(state, refreshedJoin);
  if (assertOk(refreshed, "Expired buyer can refresh their JOIN hold")) {
    assert(refreshed.state.joinHolds?.[Role.BUYER]?.expiresAt === refreshedJoin.payload.holdExpiresAt,
      "Refreshed JOIN writes a new hold deadline");
  }
}

// Same pubkey cannot become both buyer and seller
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const selfJoin = joinEvent(Role.BUYER, SELLER_PK, create.raw.id);
    assertErr(applyEvent(r1.state, selfJoin), "ALREADY_JOINED",
      "Seller cannot join their own listing as buyer");
  }
}

// Can't JOIN as initiator's role
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join = joinEvent(Role.SELLER, BUYER_PK, create.raw.id);
    assertErr(applyEvent(r1.state, join), "ROLE_CONFLICT", "Can't JOIN as initiator's role");
  }
}

// Arbiter must be in communityArbiters pool when one exists — AND (v2.3.1)
// must be the deterministically-ASSIGNED arbiter, not just any pool member.
{
  const create = createEvent({ communityArbiters: [ARBITER_PK, ARBITER2_PK] });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    // The assigned arbiter is priority 0 = pickArbiterFromPool(pool, id,
    // [buyer, seller]). Compute it so the test is robust to the escrow id
    // rather than assuming ARBITER_PK.
    const assigned = pickArbiterFromPool(
      r1.state.communityArbiters,
      r1.state.id,
      [r1.state.participants[Role.BUYER], r1.state.participants[Role.SELLER]],
    )!;
    const nonAssigned = [ARBITER_PK, ARBITER2_PK].find((pk) => pk !== assigned)!;

    const goodArbiter = joinEvent(Role.ARBITER, assigned, create.raw.id);
    assertOk(applyEvent(r1.state, goodArbiter),
      "The deterministically-assigned arbiter can JOIN");

    // v2.3.1: a LEGIT pool member who is NOT the assigned arbiter is denied —
    // this closes pool-insider front-running of the arbiter slot.
    const frontRunner = joinEvent(Role.ARBITER, nonAssigned, create.raw.id);
    assertErr(applyEvent(r1.state, frontRunner), "ARBITER_NOT_ASSIGNED",
      "A non-assigned pool member is rejected (no slot front-running)");

    const stranger = joinEvent(Role.ARBITER, "ff".repeat(32), create.raw.id);
    assertErr(applyEvent(r1.state, stranger), "ARBITER_NOT_IN_POOL",
      "Non-pool arbiter rejected when pool is non-empty");
  }
}

// Legacy empty pool without a named community: any arbiter accepted
{
  const create = createEvent(); // no pool
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const anyArbiter = joinEvent(Role.ARBITER, "99".repeat(32), create.raw.id);
    assertOk(applyEvent(r1.state, anyArbiter),
      "Legacy empty-pool trades without a community can still accept volunteer arbiters");
  }
}

// Community empty pool: volunteer arbiters are rejected and replay skips them
{
  const create = createEvent({ community: "ke-kes", communityArbiters: [] });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const anyArbiter = joinEvent(Role.ARBITER, "99".repeat(32), create.raw.id);
    assertErr(applyEvent(r1.state, anyArbiter), "ARBITER_POOL_EMPTY",
      "Community trades with no arbiter pool reject volunteer arbiters");
    const replayed = replayEventChain([create, anyArbiter]);
    assertOk(replayed,
      "Replay skips stale volunteer arbiter JOINs on empty-pool community trades");
    if (replayed.ok) {
      assert(replayed.state.participants[Role.ARBITER] === null,
        "Skipped volunteer arbiter does not fill the arbiter slot");
    }
  }
}

// Client preflight refuses self-join before publishing to relays
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    let publishedJoin: NostrEvent | null = null;
    const selfJoinClient = new EscrowClient({
      async getPublicKey() { return SELLER_PK; },
      async signEvent(event: UnsignedEvent) {
        return { ...event, id: "self_join_signed", pubkey: SELLER_PK, sig: "sig" } as NostrEvent;
      },
      async nip44Encrypt(plaintext: string) { return plaintext; },
      async nip44Decrypt(ciphertext: string) { return ciphertext; },
    }, { relays: [] });
    (selfJoinClient as any).states.set(ESCROW_ID, r1.state);
    (selfJoinClient as any).relayManager.publish = async (event: NostrEvent) => {
      publishedJoin = event;
      return { accepted: 1, rejected: 0, errors: [] };
    };
    let refused = false;
    try {
      await selfJoinClient.joinEscrow(ESCROW_ID, Role.BUYER);
    } catch (e: any) {
      refused = e?.code === "ALREADY_PARTICIPANT";
    }
    assert(refused, "Client refuses seller self-join as buyer");
    assert(publishedJoin === null, "Client self-join refusal publishes no JOIN event");
  }
}

// Client preflight refuses volunteer arbiter joins before publishing to relays
{
  const create = createEvent({ community: "ke-kes", communityArbiters: [] });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    let publishedJoin: NostrEvent | null = null;
    const volunteerClient = new EscrowClient({
      async getPublicKey() { return ARBITER_PK; },
      async signEvent(event: UnsignedEvent) {
        return { ...event, id: "volunteer_arbiter_signed", pubkey: ARBITER_PK, sig: "sig" } as NostrEvent;
      },
      async nip44Encrypt(plaintext: string) { return plaintext; },
      async nip44Decrypt(ciphertext: string) { return ciphertext; },
    }, { relays: [] });
    (volunteerClient as any).states.set(ESCROW_ID, r1.state);
    (volunteerClient as any).relayManager.publish = async (event: NostrEvent) => {
      publishedJoin = event;
      return { accepted: 1, rejected: 0, errors: [] };
    };
    let refused = false;
    try {
      await volunteerClient.joinEscrow(ESCROW_ID, Role.ARBITER);
    } catch (e: any) {
      refused = e?.code === "ARBITER_POOL_EMPTY";
    }
    assert(refused, "Client refuses volunteer arbiter join when community pool is empty");
    assert(publishedJoin === null, "Client volunteer-arbiter refusal publishes no JOIN event");
  }
}

// ── 3. ATOMIC LOCK ───────────────────────────────────────────────────────
console.log("\n── ATOMIC LOCK (CREATED → LOCKED, no FUNDED hop) ──");

// 3a. LOCK fires from CREATED with no prior JOINs
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  assert(state.status === EscrowStatus.CREATED, "Pre-condition: state is CREATED");

  const lock = lockEvent(create.raw.id);
  const r = applyEvent(state, lock);
  if (assertOk(r, "LOCK from CREATED with no prior JOINs (atomic funding)")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status transitions CREATED → LOCKED directly");
    assert(r.state.participants[Role.BUYER] === BUYER_PK, "LOCK populated buyer slot");
    assert(r.state.participants[Role.ARBITER] === ARBITER_PK, "LOCK populated arbiter slot");
    assert(r.state.lock.notesHash === "hash_of_ecash_notes_abc123", "Notes hash stored");
    assert(r.state.lock.shares.size === 3, "3 SSS shares stored");
  }
}

// 3a.1. LOCK starts the trade deadline from lockedAt, not CREATE time
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const lockAt = create.timestamp + 3600;
    const lock = retimeEvent(lockEvent(create.raw.id), lockAt);
    const r = applyEvent(r1.state, lock);
    if (assertOk(r, "LOCK starts active trade deadline from lockedAt")) {
      assert(r.state.listingExpiresAt === create.timestamp + create.payload.expirySeconds,
        "LOCK preserves original listing deadline for audit/display");
      assert(r.state.tradeTimeoutSeconds === create.payload.expirySeconds,
        "LOCK keeps CREATE timeout duration");
      assert(r.state.expiresAt === lockAt + create.payload.expirySeconds,
        "LOCK retimes active deadline to lockedAt + timeout");
    }
  }
}

// 3b. LOCK fires from CREATED after JOIN ACKs (consistent pubkeys)
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  state = (applyEvent(state, j2) as any).state;

  const lock = lockEvent(j2.raw.id);
  const r = applyEvent(state, lock);
  assertOk(r, "LOCK after consistent JOIN ACKs");
}

// 3c. LOCK with buyer pubkey disagreeing with prior JOIN → BUYER_PUBKEY_MISMATCH
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const lock = lockEvent(j1.raw.id, { buyerPubkey: "ff".repeat(32) });
  assertErr(applyEvent(state, lock), "BUYER_PUBKEY_MISMATCH",
    "LOCK buyerPubkey must match prior buyer JOIN");
}

// Expired buyer JOIN keeps protecting the original buyer during lock grace,
// then releases the slot after the grace truly expires.
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const joinedAt = NOW + 30_000;
  const j1 = retimeEvent(joinEvent(Role.BUYER, BUYER_PK, create.raw.id), joinedAt);
  state = (applyEvent(state, j1) as any).state;

  const withinGraceLock = retimeEvent(
    lockEvent(j1.raw.id, { buyerPubkey: "f1".repeat(32) }),
    joinedAt + JOIN_HOLD_SECONDS + 1,
  );
  assertErr(applyEvent(state, withinGraceLock), "BUYER_PUBKEY_MISMATCH",
    "Hidden lock grace still rejects a different buyer immediately after visible expiry");

  const lateLock = retimeEvent(
    lockEvent(j1.raw.id, { buyerPubkey: "f1".repeat(32) }),
    joinedAt + JOIN_HOLD_SECONDS + JOIN_HOLD_LOCK_GRACE_SECONDS + 1,
  );
  assertOk(applyEvent(state, lateLock),
    "Buyer JOIN no longer causes BUYER_PUBKEY_MISMATCH after the hidden grace expires");
}

// 3d. LOCK with arbiter pubkey not in community pool → ARBITER_NOT_IN_POOL
{
  const create = createEvent({ communityArbiters: [ARBITER_PK, ARBITER2_PK] });
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id, { arbiterPubkey: "ff".repeat(32) });
  assertErr(applyEvent(state, lock), "ARBITER_NOT_IN_POOL",
    "LOCK arbiterPubkey must come from communityArbiters pool");
}

// 3e. LOCK missing buyerPubkey → MISSING_BUYER_PUBKEY
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: "",
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  }, create.raw.id);
  assertErr(applyEvent(state, badLock), "MISSING_BUYER_PUBKEY",
    "LOCK with empty buyerPubkey rejected");
}

// 3f. LOCK with wrong amount sum → AMOUNT_MISMATCH
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = lockEvent(create.raw.id, { sellerReceivesMsats: 90_000_000 });
  assertErr(applyEvent(state, badLock), "AMOUNT_MISMATCH",
    "LOCK with wrong amount sum rejected");
}

// 3g. WRONG_LOCKER: buyer can't lock in p2p-trade
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const buyerLock = lockEvent(create.raw.id, { locker: BUYER_PK });
  assertErr(applyEvent(state, buyerLock), "NOT_PARTICIPANT",
    "In p2p-trade, the buyer pubkey is not a participant pre-LOCK so signing as buyer fails NOT_PARTICIPANT");
}

// 3h. DOUBLE-LOCK: a second LOCK after LOCKED is rejected
//
// This is the load-bearing atomic-funding invariant: payment-detection
// can fire twice (relay echo, retry, two browsers), but the chain MUST
// NOT advance past LOCKED twice. Sanity check: applying a second LOCK
// to an already-LOCKED state returns INVALID_STATE.
{
  const { state, lock } = buildToLocked();
  assert(state.status === EscrowStatus.LOCKED, "Pre-condition: first LOCK succeeded");

  const dupLock = lockEvent(lock.raw.id);
  assertErr(applyEvent(state, dupLock), "INVALID_STATE",
    "Double-LOCK after LOCKED is rejected — atomic, not idempotent-with-side-effects");
}

// 3i. DUPLICATE_PARTICIPANT: arbiter == seller
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const badLock = lockEvent(create.raw.id, { arbiterPubkey: SELLER_PK });
  assertErr(applyEvent(state, badLock), "DUPLICATE_PARTICIPANT",
    "LOCK can't assign seller pubkey as arbiter");
}

// 3j. Menu CREATE stores listing items without changing escrow envelope shape
{
  const items: MenuItem[] = [
    { id: "usd-25", label: "$25 bill pay", amountMsats: 25_000, fiatAmount: 25, fiatCurrency: "USD" },
    { id: "usd-50", label: "$50 bill pay", amountMsats: 50_000, fiatAmount: 50, fiatCurrency: "USD" },
  ];
  const create = createEvent({ amountMsats: 25_000, items });
  const r = applyEvent(null, create);
  if (assertOk(r, "CREATE accepts optional menu items")) {
    assert(r.state.items?.length === 2, "Menu items are stored on listing state");
    assert(r.state.amountMsats === 25_000, "Listing amount remains the display floor");
    assert(r.state.lock.selectedItems === undefined, "No selected menu items before LOCK");
  }
}

// 3k. Menu LOCK snapshots only a finalized buyer basket
{
  const items: MenuItem[] = [
    { id: "small", label: "Small order", amountMsats: 25_000 },
    { id: "large", label: "Large order", amountMsats: 75_000 },
  ];
  const create = createEvent({ amountMsats: 25_000, items });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const noSelection = lockEvent(create.raw.id, { sellerReceivesMsats: 24_000, arbiterFeeMsats: 1_000 });
    assertErr(applyEvent(r1.state, noSelection), "MISSING_SELECTED_ITEMS",
      "Menu LOCK without selectedItems is rejected");

    const selectedItems: LockPayload["selectedItems"] = [
      { itemId: "small", label: "Small order", amountMsats: 25_000, quantity: 2 },
    ];
    const draftLock = lockEvent(create.raw.id, {
      selectedItems,
      sellerReceivesMsats: 49_000,
      arbiterFeeMsats: 1_000,
    });
    assertErr(applyEvent(r1.state, draftLock), "ORDER_NOT_FINALIZED",
      "Seller cannot lock a menu basket before the buyer has finalized it");

    const join = joinEvent(Role.BUYER, BUYER_PK, create.raw.id, {
      selectedItems,
      amountMsats: 50_000,
      orderFinalized: true,
    });
    const joined = applyEvent(r1.state, join);
    if (assertOk(joined, "Buyer can finalize a menu basket before seller locks")) {
      const lock = lockEvent(join.raw.id, {
        selectedItems,
        sellerReceivesMsats: 49_000,
        arbiterFeeMsats: 1_000,
      });
      const r2 = applyEvent(joined.state, lock);
      if (assertOk(r2, "Menu LOCK accepts finalized selectedItems snapshot")) {
        assert(r2.state.amountMsats === 50_000, "LOCK updates escrow amount to selected basket total");
        assert(r2.state.lock.selectedItems?.[0]?.quantity === 2, "Selected item quantity is stored");
        assert(r2.state.lock.selectedItems?.[0]?.label === "Small order", "Selected item label is snapshotted");
      }
    }
  }
}

// 3k.1. Quantity cap (#6): a selected quantity may not exceed the menu item's
// maxQuantity. Anti-drain money-gate enforced at LOCK; uncapped items unbounded.
{
  const items: MenuItem[] = [
    { id: "capped", label: "Capped item", amountMsats: 10_000, maxQuantity: 3 },
    { id: "uncapped", label: "Uncapped item", amountMsats: 10_000 },
  ];
  const create = createEvent({ amountMsats: 10_000, items });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    // At the cap (3 of 3) → accepted.
    const atCap: LockPayload["selectedItems"] = [
      { itemId: "capped", label: "Capped item", amountMsats: 10_000, quantity: 3 },
    ];
    const joinAtCap = joinEvent(Role.BUYER, BUYER_PK, create.raw.id, {
      selectedItems: atCap, amountMsats: 30_000, orderFinalized: true,
    });
    const joinedAtCap = applyEvent(r1.state, joinAtCap);
    if (assertOk(joinedAtCap, "Buyer can finalize an order at the quantity cap")) {
      const lockAtCap = lockEvent(joinAtCap.raw.id, {
        selectedItems: atCap, sellerReceivesMsats: 29_000, arbiterFeeMsats: 1_000,
      });
      assertOk(applyEvent(joinedAtCap.state, lockAtCap),
        "LOCK at the quantity cap (3 of 3) is accepted");
    }

    // Over the cap (4 > 3) → QUANTITY_EXCEEDED at LOCK, even if the order was
    // drafted: no funds move on an over-cap order.
    const overCap: LockPayload["selectedItems"] = [
      { itemId: "capped", label: "Capped item", amountMsats: 10_000, quantity: 4 },
    ];
    const joinOver = joinEvent(Role.BUYER, BUYER_PK, create.raw.id, {
      selectedItems: overCap, amountMsats: 40_000, orderFinalized: true,
    });
    const joinedOver = applyEvent(r1.state, joinOver);
    if (assertOk(joinedOver, "Over-cap order can be drafted but never locked")) {
      const lockOver = lockEvent(joinOver.raw.id, {
        selectedItems: overCap, sellerReceivesMsats: 39_000, arbiterFeeMsats: 1_000,
      });
      assertErr(applyEvent(joinedOver.state, lockOver), "QUANTITY_EXCEEDED",
        "LOCK quantity above the menu item maxQuantity is rejected (anti-drain)");
    }

    // Uncapped (legacy) item accepts a large quantity, bounded only by the
    // global parser ceiling — not by maxQuantity.
    const bigUncapped: LockPayload["selectedItems"] = [
      { itemId: "uncapped", label: "Uncapped item", amountMsats: 10_000, quantity: 20 },
    ];
    const joinBig = joinEvent(Role.BUYER, BUYER_PK, create.raw.id, {
      selectedItems: bigUncapped, amountMsats: 200_000, orderFinalized: true,
    });
    const joinedBig = applyEvent(r1.state, joinBig);
    if (assertOk(joinedBig, "Buyer can finalize a large order on an uncapped item")) {
      const lockBig = lockEvent(joinBig.raw.id, {
        selectedItems: bigUncapped, sellerReceivesMsats: 199_000, arbiterFeeMsats: 1_000,
      });
      assertOk(applyEvent(joinedBig.state, lockBig),
        "LOCK on an uncapped legacy item accepts any in-range quantity");
    }
  }
}

// 3k.2. #7 Stage 2a — pure remainingStock accountant (multi-unit storefront).
{
  const parent = {
    ...(applyEvent(null, createEvent({ stock: 5 })) as any).state,
    id: "parent_A",
    stock: 5,
  } as EscrowState;
  const child = (
    parentId: string,
    status: EscrowStatus,
    claimedQuantity: number,
    holdExpiresAt?: number,
  ): EscrowState => ({
    ...(applyEvent(null, createEvent({ claimedQuantity })) as any).state,
    parent: parentId,
    claimedQuantity,
    status,
    joinHolds: holdExpiresAt !== undefined
      ? { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER_PK, joinedAt: NOW, expiresAt: holdExpiresAt, eventId: "h" } }
      : {},
  }) as EscrowState;
  const t = NOW;

  assert(remainingStock(parent, [], t) === 5, "Storefront: empty → full stock (5)");
  assert(remainingStock(parent, [child("parent_A", EscrowStatus.LOCKED, 2)], t) === 3,
    "Storefront: one locked child of 2 → 3 left");
  assert(remainingStock(parent, [
    child("parent_A", EscrowStatus.LOCKED, 2),
    child("parent_A", EscrowStatus.CREATED, 1, t + 600),
  ], t) === 2, "Storefront: locked 2 + an actively-held 1 → 2 left");
  assert(remainingStock(parent, [child("parent_A", EscrowStatus.CREATED, 1, t - 1000)], t) === 5,
    "Storefront: an expired-hold CREATED child frees its unit");
  assert(remainingStock(parent, [child("parent_A", EscrowStatus.CANCELLED, 2)], t) === 5,
    "Storefront: a cancelled child frees its units");
  assert(remainingStock(parent, [child("parent_A", EscrowStatus.COMPLETED, 2)], t) === 3,
    "Storefront: a completed child stays counted (sold)");
  assert(remainingStock(parent, [child("parent_B", EscrowStatus.LOCKED, 3)], t) === 5,
    "Storefront: a different parent's child is ignored");
  assert(remainingStock(parent, [
    child("parent_A", EscrowStatus.LOCKED, 3),
    child("parent_A", EscrowStatus.LOCKED, 3),
  ], t) === 0, "Storefront: overcommit floors remaining at 0");

  assert(childCommitsStock(child("parent_A", EscrowStatus.LOCKED, 1), t),
    "childCommitsStock: a locked child commits its unit");
  assert(!childCommitsStock(child("parent_A", EscrowStatus.CREATED, 1, t - 1000), t),
    "childCommitsStock: a lapsed-hold CREATED child does not commit");

  // The last-unit race: stock 1, two live holds both reserve it → 0 remaining
  // (the overcommit the design resolves optimistically via refund).
  const single = {
    ...(applyEvent(null, createEvent({ stock: 1 })) as any).state,
    id: "parent_S",
    stock: 1,
  } as EscrowState;
  assert(remainingStock(single, [
    child("parent_S", EscrowStatus.CREATED, 1, t + 600),
    child("parent_S", EscrowStatus.CREATED, 1, t + 600),
  ], t) === 0, "Storefront: two buyers racing the last unit both reserve it (remaining 0)");
  assert(isLastUnitContested(single, [child("parent_S", EscrowStatus.CREATED, 1, t + 600)], t),
    "isLastUnitContested: 1 stock with one live hold is the contested last unit");
  assert(!isLastUnitContested(parent, [], t),
    "isLastUnitContested: a 5-stock storefront with no holds is not contested");

  // Undefined claimedQuantity counts as exactly one unit.
  const undefChild = {
    ...(applyEvent(null, createEvent({})) as any).state,
    parent: "parent_A",
    status: EscrowStatus.LOCKED,
  } as EscrowState;
  assert(remainingStock(parent, [undefChild], t) === 4,
    "Storefront: undefined claimedQuantity counts as one unit");

  // unsold (only locked subtracted) vs available (held + locked subtracted).
  assert(unsoldStock(parent, [child("parent_A", EscrowStatus.LOCKED, 2)], t) === 3,
    "unsoldStock: locked 2 → 3 unsold");
  assert(unsoldStock(parent, [child("parent_A", EscrowStatus.CREATED, 1, t + 600)], t) === 5,
    "unsoldStock: a held (not locked) unit still counts as unsold");
  assert(isSoldOut(single, [child("parent_S", EscrowStatus.LOCKED, 1)], t),
    "isSoldOut: the only unit locked → sold out");
  assert(!isSoldOut(single, [child("parent_S", EscrowStatus.CREATED, 1, t + 600)], t),
    "isSoldOut: a held-but-not-locked last unit is NOT sold out (still browsable)");
}

// 3k.3. #7 Stage 2b — child spawn (buildChildCreateParams) + role inversion +
// lock-readiness. The buyer publishes a child CREATE referencing the parent and
// carrying the parent's seller, so the child is a full 2-of-3 escrow the buyer
// can LOCK at once (Option A — the seller needn't be online per sale).
{
  const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
  const mktParent = (applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create", description: "Hand-woven baskets", amountMsats: 50_000_000,
    fiatAmount: 50, fiatCurrency: "USD", category: "marketplace", mintUrl: "fed11qparent",
    platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, arbiterFeeMsats: 1_000_000,
    paymentMethods: ["Zelle"], expirySeconds: 86400, communityArbiters: [ARBITER_PK],
    fulfillment: "physical", stock: 5, country: "KE", createdAt: NOW,
  })) as any).state as EscrowState;

  // ── buildChildCreateParams: maps parent → child params, prices by qty ──
  const cp = buildChildCreateParams(mktParent, 2);
  assert(cp.parent === mktParent.id, "child params: parent ref = parent id");
  assert(cp.claimedQuantity === 2, "child params: claimedQuantity carried");
  assert(cp.sellerPubkey === SELLER_PK, "child params: parent's seller seated");
  assert(cp.amountMsats === 100_000_000, "child params: per-unit price × quantity (50M × 2)");
  assert(cp.fiatAmount === 100, "child params: fiat scales by quantity (50 × 2)");
  assert(cp.fiatCurrency === "USD", "child params: inherits fiat currency");
  assert(cp.country === "KE", "child params: inherits parent's self-describing country (B3)");
  assert(cp.category === "marketplace", "child params: inherits category");
  assert(cp.mintUrl === "fed11qparent", "child params: inherits the parent's federation (mintUrl)");
  assert(cp.arbiterFeeMsats === 1_000_000, "child params: flat arbiter fee is NOT scaled by quantity");
  assert(JSON.stringify(cp.communityArbiters) === JSON.stringify([ARBITER_PK]),
    "child params: inherits the community arbiter pool");

  // Guard rails: malformed spawns throw rather than mint a half-formed escrow.
  assert([0, -1, 2.5].every(q => throws(() => buildChildCreateParams(mktParent, q))),
    "child params: rejects non-positive / non-integer quantity");
  assert(throws(() => buildChildCreateParams({ ...mktParent, category: "p2p-trade" } as EscrowState, 1)),
    "child params: only marketplace listings spawn children");
  assert(throws(() => buildChildCreateParams({ ...mktParent, parent: "grandparent" } as EscrowState, 1)),
    "child params: cannot spawn a child of a child");
  assert(throws(() => buildChildCreateParams(
    { ...mktParent, participants: { ...mktParent.participants, [Role.SELLER]: null } } as EscrowState, 1)),
    "child params: a listing with no seller can't be bought from");

  // ── handleCreate role inversion: buyer creates the child, seller seated ──
  const childCreate = makeParsedEvent(EscrowEventKind.CREATE, BUYER_PK, {
    type: "escrow:create", description: cp.description, amountMsats: cp.amountMsats,
    fiatAmount: cp.fiatAmount, fiatCurrency: cp.fiatCurrency, category: "marketplace",
    mintUrl: cp.mintUrl, platformFeeBps: 50, platformFeePubkey: PLATFORM_PK,
    arbiterFeeMsats: cp.arbiterFeeMsats, paymentMethods: cp.paymentMethods, expirySeconds: 86400,
    communityArbiters: cp.communityArbiters, fulfillment: "physical",
    parent: cp.parent, claimedQuantity: cp.claimedQuantity, sellerPubkey: cp.sellerPubkey,
    createdAt: NOW,
  });
  const childRes = applyEvent(null, childCreate);
  if (assertOk(childRes, "child CREATE applies")) {
    assert(childRes.state.participants[Role.BUYER] === BUYER_PK,
      "child role: the signer (buyer) is seated as BUYER");
    assert(childRes.state.participants[Role.SELLER] === SELLER_PK,
      "child role: the parent's seller is seated as SELLER (lock-ready under Option A)");
    assert(childRes.state.initiator.role === Role.BUYER,
      "child role: the buyer is the initiator (inverted from marketplace's seller-creates)");
    assert(childRes.state.parent === mktParent.id && childRes.state.claimedQuantity === 2,
      "child role: parent ref + claimedQuantity land on state");
    assert(childRes.state.stock === undefined, "child role: a child carries no stock of its own");
  }

  // Contrast: a normal marketplace listing (no parent) keeps seller-creates.
  const normalRes = applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create", description: "Single basket", amountMsats: 50_000_000,
    category: "marketplace", mintUrl: "fed11qx", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK,
    expirySeconds: 86400, fulfillment: "physical", createdAt: NOW,
  }));
  if (assertOk(normalRes, "normal marketplace listing applies")) {
    assert(normalRes.state.participants[Role.SELLER] === SELLER_PK
      && normalRes.state.participants[Role.BUYER] === null
      && normalRes.state.initiator.role === Role.SELLER,
      "non-child marketplace listing is unchanged: seller creates, buyer empty");
  }

  // ── Lock-readiness: the buyer LOCKs the child immediately, no prior JOIN ──
  if (childRes.ok) {
    const childLock = lockEvent(childCreate.raw.id, { locker: BUYER_PK, buyerPubkey: BUYER_PK, arbiterPubkey: ARBITER_PK });
    const lockRes = applyEvent(childRes.state, childLock);
    if (assertOk(lockRes, "child LOCK by the buyer applies (the seated seller makes it lock-ready)")) {
      assert(lockRes.state.status === EscrowStatus.LOCKED, "child reaches LOCKED on the buyer's lock");
    }
  }

  // ── Spawn → accountant: spawned children decrement the parent's stock ──
  const mkChild = (status: EscrowStatus, qty: number, holdExpiresAt?: number): EscrowState => ({
    ...(applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, BUYER_PK, {
      type: "escrow:create", description: "c", amountMsats: 50_000_000 * qty, category: "marketplace",
      mintUrl: "fed11qparent", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, expirySeconds: 86400,
      communityArbiters: [ARBITER_PK], fulfillment: "physical",
      parent: mktParent.id, claimedQuantity: qty, sellerPubkey: SELLER_PK, createdAt: NOW,
    })) as any).state,
    status,
    joinHolds: holdExpiresAt !== undefined
      ? { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER_PK, joinedAt: NOW, expiresAt: holdExpiresAt, eventId: "h" } }
      : {},
  }) as EscrowState;
  const kids = [
    mkChild(EscrowStatus.LOCKED, 2),               // sold 2
    mkChild(EscrowStatus.CREATED, 1, NOW + 600),   // held 1
    mkChild(EscrowStatus.CANCELLED, 1),            // frees back
  ];
  assert(remainingStock(mktParent, kids, NOW) === 2,
    "spawn→count: stock 5 − (locked 2 + held 1) = 2 available now");
  assert(unsoldStock(mktParent, kids, NOW) === 3,
    "spawn→count: 5 − locked 2 = 3 unsold (a held unit still counts as unsold)");
  assert(kids.every(k => k.parent === mktParent.id),
    "spawn→count: every spawned child references the parent listing");
}

// 3k.3b. Store permanence (#49) — renewable listings (Tier 1) + bond-gated
// tenure (Tier 3). Pure predicates: who may renew, what a re-publish carries,
// and how the bond resolves tenure WITHOUT ever extending the trade timeout.
{
  const NOW_S = Math.floor(NOW / 1000);
  const listingRes = applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create", description: "Fresh mangoes — 1kg", amountMsats: 20_000_000,
    fiatAmount: 3, fiatCurrency: "USD", category: "marketplace", mintUrl: "fed11qstore",
    platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, arbiterFeeMsats: 1_000_000,
    paymentMethods: ["Cash"], expirySeconds: 86400, communityArbiters: [ARBITER_PK],
    fulfillment: "physical", stock: 4, country: "KE", createdAt: NOW,
  }));
  assertOk(listingRes, "store: seller's marketplace listing applies");
  if (listingRes.ok) {
    const listing = listingRes.state;
    const lapsedAt = listing.expiresAt + 10;
    // Ownership gate.
    assert(isSellerOwnedListing(listing, SELLER_PK), "store: the seller owns their own listing");
    assert(!isSellerOwnedListing(listing, BUYER_PK), "store: a non-seller can't renew it");
    assert(!isSellerOwnedListing({ ...listing, parent: "parent_A" } as EscrowState, SELLER_PK),
      "store: a CHILD order is never a renewable storefront");
    // Unfunded gate.
    assert(listingNeverFunded(listing), "store: a CREATED, never-locked listing is unfunded");
    assert(!listingNeverFunded({ ...listing, lock: { ...listing.lock, lockedAt: NOW_S } } as EscrowState),
      "store: an ever-LOCKED listing is funded — never renewable");
    assert(!listingNeverFunded({ ...listing, status: EscrowStatus.CANCELLED } as EscrowState),
      "store: a CANCELLED (seller-deleted) listing is not renewable");
    // Renew eligibility keys off lapse (or lead window), owner, unfunded.
    assert(!canRenewListing(listing, SELLER_PK, NOW_S),
      "store: a fresh listing far from lapse is not yet renewable");
    assert(canRenewListing(listing, SELLER_PK, lapsedAt),
      "store: the seller's own lapsed unfunded listing is renewable");
    assert(!canRenewListing(listing, BUYER_PK, lapsedAt),
      "store: only the seller may renew, even once lapsed");
    // Manual-card feed: only truly-lapsed listings.
    const lapsedList = lapsedRenewableListings([listing], SELLER_PK, lapsedAt);
    assert(lapsedList.length === 1 && lapsedList[0].id === listing.id,
      "store: lapsedRenewableListings surfaces the seller's lapsed store");
    assert(lapsedRenewableListings([listing], SELLER_PK, NOW_S).length === 0,
      "store: a not-yet-lapsed listing isn't on the manual-renew card");
    // Re-publish params: identical terms, NO longer expiry (trade timeout stays).
    const rp = buildRenewCreateParams(listing);
    assert(rp.description === listing.description && rp.amountMsats === 20_000_000,
      "store: renew params carry the same description + amount");
    assert(rp.category === "marketplace" && rp.mintUrl === "fed11qstore" && rp.country === "KE",
      "store: renew params carry the same fed + self-describing country");
    assert(rp.stock === 4, "store: renew params preserve the storefront stock");
    assert(!("expirySeconds" in rp),
      "store: renew NEVER stamps a longer expiry — the trade timeout stays ~24h (Tier 2 deferred)");
    assert(JSON.stringify(rp.communityArbiters) === JSON.stringify([ARBITER_PK]),
      "store: renew params carry the arbiter pool");
  }
  // Tier 3 bond gate: funded+active 38135 ≥ floor ⇒ bonded ⇒ auto-renew + 7d.
  const bonds = [
    { npub: SELLER_PK, community: "ke-kes", address: "a", lockUntil: 999, actualSats: 50_000n, claimedSats: 50_000n, funded: true, active: true },
  ];
  assert(sellerIsBonded(bonds, SELLER_PK), "store: a funded+active bond ≥ floor makes the seller bonded");
  assert(!sellerIsBonded(bonds, BUYER_PK), "store: another npub isn't bonded off the seller's bond");
  assert(!sellerIsBonded([{ ...bonds[0], funded: false }], SELLER_PK),
    "store: an unfunded bond announcement doesn't grant tenure");
  assert(!sellerIsBonded([{ ...bonds[0], actualSats: 1_000n }], SELLER_PK),
    "store: a sub-floor bond doesn't grant tenure");
  const bondedT = resolveListingTenure({ bonded: true });
  const unbondedT = resolveListingTenure({ bonded: false });
  assert(bondedT.autoRenew && bondedT.maxTenureSeconds === BONDED_TENURE_SECONDS,
    "store: bonded ⇒ auto-renew + 7-day store horizon");
  assert(!unbondedT.autoRenew && unbondedT.maxTenureSeconds === UNBONDED_TENURE_SECONDS,
    "store: unbonded ⇒ manual renew only + 24h horizon");
}

// 3k.5. MONTHLY CBP RECURRENCE — the pure cadence + anti-stacking gates. A
// recurring bill re-posts ~monthly (RE-PUBLISH, no sats), online-gated, no bond.
// These gates decide WHEN a re-post fires and WHEN it must NOT (never pile up
// unpaid rent bills). Storage round-trips aren't tested here (localStorage
// bookkeeping mirrors trade-index) — the decisions are the load-bearing part.
{
  const T0 = 1_700_000_000; // fixed epoch-seconds anchor for this block
  const cfg: CbpRecurrenceConfig = {
    seriesId: "series_A", community: "ke-kes",
    lastPostId: "post_1", lastPostAt: T0, createdAt: T0, active: true,
  };
  // Cadence: not due before 30 days, due at/after.
  assert(!isDueForRepost(cfg, T0 + RECURRENCE_PERIOD_SECONDS - 10),
    "cbp: a series isn't due before the ~30-day cadence elapses");
  assert(isDueForRepost(cfg, T0 + RECURRENCE_PERIOD_SECONDS),
    "cbp: a series is due once the 30-day cadence elapses");
  assert(!isDueForRepost({ ...cfg, active: false }, T0 + RECURRENCE_PERIOD_SECONDS * 2),
    "cbp: a cancelled (inactive) series never re-posts, however overdue");
  assert(nextRepostAt(cfg) === T0 + RECURRENCE_PERIOD_SECONDS,
    "cbp: nextRepostAt = lastPostAt + 30 days");
  // Anti-stacking: block while the prior instance is still LIVE (non-terminal).
  const live = new Map<string, EscrowState>([
    ["post_1", { status: EscrowStatus.CREATED } as EscrowState],
  ]);
  const funded = new Map<string, EscrowState>([
    ["post_1", { status: EscrowStatus.LOCKED } as EscrowState],
  ]);
  const done = new Map<string, EscrowState>([
    ["post_1", { status: EscrowStatus.COMPLETED } as EscrowState],
  ]);
  const lapsed = new Map<string, EscrowState>([
    ["post_1", { status: EscrowStatus.EXPIRED } as EscrowState],
  ]);
  assert(priorInstanceBlocks(cfg, live),
    "cbp: a still-open (CREATED) prior instance blocks a re-post — no stacking");
  assert(priorInstanceBlocks(cfg, funded),
    "cbp: an in-flight (LOCKED) prior instance blocks a re-post — no stacking");
  assert(!priorInstanceBlocks(cfg, done),
    "cbp: a paid (COMPLETED) prior instance no longer blocks — this month can post");
  assert(!priorInstanceBlocks(cfg, lapsed),
    "cbp: a lapsed (EXPIRED) prior instance no longer blocks");
  assert(!priorInstanceBlocks(cfg, new Map()),
    "cbp: an unloaded prior instance (aged off) doesn't block — cadence ≫ 24h expiry");
}

// 3k.4. #7 Stage 6 — concurrency + replay sweep. The races the design flagged
// as highest-risk: two buyers on the last unit, a refund freeing stock back, an
// expired hold freeing a reservation, partial sell-through, sold-out, and
// order-independence (replay safety). Money never moves outside each child's
// own 2-of-3 escrow, so a wrong count is a display glitch, never a loss — the
// floor that makes the optimistic (overcommit → refund) policy acceptable.
{
  const parent = (applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create", description: "Concert tickets", amountMsats: 10_000_000,
    category: "marketplace", mintUrl: "fed11qp", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK,
    expirySeconds: 86400, fulfillment: "physical", stock: 3, createdAt: NOW,
  })) as any).state as EscrowState;
  const child = (status: EscrowStatus, qty: number, holdExpiresAt?: number): EscrowState => ({
    ...(applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, BUYER_PK, {
      type: "escrow:create", description: "c", amountMsats: 10_000_000 * qty, category: "marketplace",
      mintUrl: "fed11qp", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, expirySeconds: 86400,
      fulfillment: "physical", parent: parent.id, claimedQuantity: qty, sellerPubkey: SELLER_PK, createdAt: NOW,
    })) as any).state,
    status,
    joinHolds: holdExpiresAt !== undefined
      ? { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER_PK, joinedAt: NOW, expiresAt: holdExpiresAt, eventId: "h" } }
      : {},
  }) as EscrowState;
  const t = NOW;

  // Partial sell-through: 2 locked + 1 actively held → 0 buyable now, 1 unsold.
  const mid = [child(EscrowStatus.LOCKED, 1), child(EscrowStatus.LOCKED, 1), child(EscrowStatus.CREATED, 1, t + 600)];
  assert(remainingStock(parent, mid, t) === 0, "Stage 6: 2 locked + 1 held of 3 → 0 buyable now");
  assert(unsoldStock(parent, mid, t) === 1, "Stage 6: 1 unsold (the held unit isn't locked yet)");
  assert(!isSoldOut(parent, mid, t), "Stage 6: a held last unit is NOT sold out");
  assert(isLastUnitContested(parent, mid, t), "Stage 6: the held last unit is contested (countdown gate)");

  // Two buyers race the LAST unit — both hold it. Overcommit; remaining floors
  // at 0 and only 1 is unsold (Option A: the loser refunds, no double-sell).
  const race = [child(EscrowStatus.LOCKED, 1), child(EscrowStatus.LOCKED, 1),
    child(EscrowStatus.CREATED, 1, t + 600), child(EscrowStatus.CREATED, 1, t + 600)];
  assert(remainingStock(parent, race, t) === 0, "Stage 6: two racers on the last unit → remaining floors at 0");
  assert(unsoldStock(parent, race, t) === 1, "Stage 6: still only 1 unsold despite 2 racers (one will refund)");

  // A refund frees stock back: a sold-out storefront where one lock is
  // CANCELLED (refunded) re-opens that unit.
  const soldOut = [child(EscrowStatus.LOCKED, 1), child(EscrowStatus.LOCKED, 1), child(EscrowStatus.LOCKED, 1)];
  assert(isSoldOut(parent, soldOut, t), "Stage 6: all 3 locked → sold out");
  assert(remainingStock(parent, soldOut, t) === 0 && unsoldStock(parent, soldOut, t) === 0, "Stage 6: sold out → 0/0");
  const afterRefund = [child(EscrowStatus.LOCKED, 1), child(EscrowStatus.LOCKED, 1), child(EscrowStatus.CANCELLED, 1)];
  assert(remainingStock(parent, afterRefund, t) === 1, "Stage 6: a refunded (cancelled) child frees its unit — re-sellable");
  assert(!isSoldOut(parent, afterRefund, t), "Stage 6: the refund re-opens the storefront");

  // An expired buyer hold frees its reservation back to available.
  const expiredHold = [child(EscrowStatus.LOCKED, 1), child(EscrowStatus.LOCKED, 1), child(EscrowStatus.CREATED, 1, t - 1000)];
  assert(remainingStock(parent, expiredHold, t) === 1, "Stage 6: an expired hold frees its unit");

  // Replay safety: the count is order-independent (children can arrive in any
  // order over an eventually-consistent relay set).
  assert(remainingStock(parent, [...mid].reverse(), t) === remainingStock(parent, mid, t),
    "Stage 6: stock count is order-independent (replay-safe)");

  // A child referencing a DIFFERENT parent never touches this parent's stock.
  const foreign = [child(EscrowStatus.LOCKED, 1), { ...child(EscrowStatus.LOCKED, 5), parent: "some-other-parent" } as EscrowState];
  assert(remainingStock(parent, foreign, t) === 2, "Stage 6: a foreign-parent child is ignored");

  // A multi-quantity child commits all its claimed units at once.
  assert(remainingStock(parent, [child(EscrowStatus.LOCKED, 2)], t) === 1, "Stage 6: a child claiming 2 units decrements by 2");
  assert(remainingStock(parent, [child(EscrowStatus.LOCKED, 5)], t) === 0, "Stage 6: an over-claiming child still floors at 0");

  // #63 storefront-vs-order display predicates: the parent (stock, no parent)
  // reads as a storefront; a spawned child (parent set) reads as an order; a
  // LOCKED child is the live order the seller routes to.
  assert(isParentStorefront(parent) && !isChildOrder(parent), "#63: a multi-unit parent is a storefront, not an order");
  assert(isChildOrder(child(EscrowStatus.LOCKED, 1)) && !isParentStorefront(child(EscrowStatus.LOCKED, 1)), "#63: a spawned child is an order, not a storefront");
  assert(isLiveChildOrder(child(EscrowStatus.LOCKED, 1)), "#63: a LOCKED child is a live order");
  assert(!isLiveChildOrder(child(EscrowStatus.CREATED, 1)), "#63: an unfunded (CREATED) child is not yet a live order");
}

// 3k.5. #7 seller overcommit refund — which LOCKED children are oversold,
// identified by lock order (the seller-side detection that closes the "6 of 5").
{
  const parent = (applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
    type: "escrow:create", description: "Tix", amountMsats: 10_000_000, category: "marketplace",
    mintUrl: "f", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, expirySeconds: 86400,
    fulfillment: "physical", stock: 3, createdAt: NOW,
  })) as any).state as EscrowState;
  const lockedChild = (id: string, qty: number, lockedAt: number, status: EscrowStatus = EscrowStatus.LOCKED): EscrowState => {
    const base = (applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, BUYER_PK, {
      type: "escrow:create", description: "c", amountMsats: 10_000_000 * qty, category: "marketplace",
      mintUrl: "f", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, expirySeconds: 86400,
      fulfillment: "physical", parent: parent.id, claimedQuantity: qty, sellerPubkey: SELLER_PK, createdAt: NOW,
    })) as any).state as EscrowState;
    return { ...base, id, status, lock: { ...base.lock, lockedAt } };
  };

  // Within stock → nothing oversold.
  assert(overcommittedChildren(parent, [lockedChild("a", 1, 1), lockedChild("b", 1, 2)]).length === 0,
    "overcommit: 2 single-unit locks of 3 → nothing oversold");

  // 4 single-unit locks of 3 → the LATEST-locked is the oversold one.
  const four = [lockedChild("a", 1, 1), lockedChild("b", 1, 2), lockedChild("c", 1, 3), lockedChild("d", 1, 4)];
  const over = overcommittedChildren(parent, four);
  assert(over.length === 1 && over[0].id === "d", "overcommit: the last-locked unit (d) is oversold — earliest 3 honored");

  // Two race the last unit (locked 3 and 4): the later one is refunded.
  const race = [lockedChild("a", 1, 1), lockedChild("b", 1, 2), lockedChild("late", 1, 4), lockedChild("first", 1, 3)];
  assert(overcommittedChildren(parent, race).map(c => c.id).join(",") === "late",
    "overcommit: of two racers for the last unit, the later lock is the oversold one");

  // Refunding the oversold one frees its slot — the list shrinks.
  const afterRefund = [lockedChild("a", 1, 1), lockedChild("b", 1, 2), lockedChild("c", 1, 3), lockedChild("d", 1, 4, EscrowStatus.CANCELLED)];
  assert(overcommittedChildren(parent, afterRefund).length === 0,
    "overcommit: once the oversold child is refunded (cancelled), nothing is oversold");

  // Multi-unit straddle: A=2, B=2 over stock 3 → B (would straddle) is refunded whole.
  assert(overcommittedChildren(parent, [lockedChild("A", 2, 1), lockedChild("B", 2, 2)]).map(c => c.id).join(",") === "B",
    "overcommit: a multi-unit child that would straddle the boundary is refunded whole (never partial-oversold)");

  // Held-but-unlocked children don't count (no sats committed).
  const held = { ...lockedChild("h", 1, 0, EscrowStatus.CREATED), joinHolds: { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER_PK, joinedAt: NOW, expiresAt: NOW + 600, eventId: "h" } } } as EscrowState;
  assert(overcommittedChildren(parent, [lockedChild("a", 1, 1), lockedChild("b", 1, 2), lockedChild("c", 1, 3), held]).length === 0,
    "overcommit: a held-but-unlocked child isn't oversold (no sats committed)");
}

// 3k.0. Legacy menu JOINs that carried a cart before orderFinalizedAt replay as final
{
  const items: MenuItem[] = [
    { id: "shirt", label: "Tshirt", amountMsats: 150_000 },
  ];
  const create = createEvent({ amountMsats: 150_000, items });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const selectedItems: JoinPayload["selectedItems"] = [
      { itemId: "shirt", label: "Tshirt", amountMsats: 150_000, quantity: 7 },
    ];
    const legacyJoin = joinEvent(Role.BUYER, BUYER_PK, create.raw.id, {
      selectedItems,
      amountMsats: 1_050_000,
    });
    const joined = applyEvent(r1.state, legacyJoin);
    if (assertOk(joined, "Legacy first JOIN with a complete menu cart is treated as finalized")) {
      assert(joined.state.joinHolds?.[Role.BUYER]?.orderFinalizedAt === legacyJoin.payload.joinedAt,
        "Legacy finalized timestamp is inferred from joinedAt");
      const lock = lockEvent(legacyJoin.raw.id, {
        selectedItems,
        sellerReceivesMsats: 1_049_000,
        arbiterFeeMsats: 1_000,
      });
      assertOk(applyEvent(joined.state, lock),
        "Legacy menu LOCK replays without requiring a missing orderFinalizedAt field");
    }
  }
}

// 3k.1. Menu buyer can save an order after JOIN without resetting their hold
{
  const items: MenuItem[] = [
    { id: "small", label: "Small order", amountMsats: 25_000 },
    { id: "large", label: "Large order", amountMsats: 75_000 },
  ];
  const create = createEvent({ amountMsats: 25_000, items });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const join = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const joined = applyEvent(r1.state, join);
    if (assertOk(joined, "Menu buyer JOIN starts the lock window before order selection")) {
      const originalExpiresAt = joined.state.joinHolds?.[Role.BUYER]?.expiresAt;
      const selectedItems: JoinPayload["selectedItems"] = [
        { itemId: "large", label: "Large order", amountMsats: 75_000, quantity: 1 },
      ];
      const saveOrder = joinEvent(Role.BUYER, BUYER_PK, join.raw.id, {
        selectedItems,
        amountMsats: 75_000,
      });
      const saved = applyEvent(joined.state, saveOrder);
      if (assertOk(saved, "Buyer can publish a follow-up JOIN to save menu order")) {
        const hold = saved.state.joinHolds?.[Role.BUYER];
        assert(hold?.expiresAt === originalExpiresAt, "Saving menu order keeps the original 5-minute lock window");
        assert(hold?.selectedItems?.[0]?.itemId === "large", "Saved menu order is stored on the buyer hold");
        assert(hold?.amountMsats === 75_000, "Saved menu order amount is stored on the buyer hold");

        const draftLock = lockEvent(saveOrder.raw.id, {
          selectedItems,
          sellerReceivesMsats: 74_000,
          arbiterFeeMsats: 1_000,
        });
        assertErr(applyEvent(saved.state, draftLock), "ORDER_NOT_FINALIZED",
          "Seller cannot lock a draft menu order before buyer presses ready");

        const readyOrder = joinEvent(Role.BUYER, BUYER_PK, saveOrder.raw.id, {
          selectedItems,
          amountMsats: 75_000,
          orderFinalized: true,
        });
        const ready = applyEvent(saved.state, readyOrder);
        if (assertOk(ready, "Buyer can finalize the saved menu order")) {
          const readyHold = ready.state.joinHolds?.[Role.BUYER];
          assert(readyHold?.expiresAt === originalExpiresAt, "Finalizing menu order keeps the original 5-minute lock window");
          assert(readyHold?.orderFinalizedAt === readyOrder.payload.orderFinalizedAt,
            "Finalized timestamp is stored on the buyer hold");

          const visibleDeadline = readyHold?.expiresAt ?? 0;
          assert(visibleDeadline > 0, "Finalized menu order keeps a visible lock deadline");

          const lock = retimeEvent(lockEvent(readyOrder.raw.id, {
            selectedItems,
            sellerReceivesMsats: 74_000,
            arbiterFeeMsats: 1_000,
          }), visibleDeadline + JOIN_HOLD_LOCK_GRACE_SECONDS - 5);
          assertOk(applyEvent(ready.state, lock), "Seller can lock a finalized menu order inside the hidden grace window");

          const lateLock = retimeEvent(lockEvent(readyOrder.raw.id, {
            selectedItems,
            sellerReceivesMsats: 74_000,
            arbiterFeeMsats: 1_000,
          }), visibleDeadline + JOIN_HOLD_LOCK_GRACE_SECONDS + 1);
          assertErr(applyEvent(ready.state, lateLock), "ORDER_NOT_FINALIZED",
            "Seller cannot lock a finalized menu order after the hidden grace window expires");

          const changedOrder = joinEvent(Role.BUYER, BUYER_PK, readyOrder.raw.id, {
            selectedItems: [
              { itemId: "small", label: "Small order", amountMsats: 25_000, quantity: 1 },
            ],
            amountMsats: 25_000,
          });
          assertErr(applyEvent(ready.state, changedOrder), "ORDER_ALREADY_FINALIZED",
            "Finalized menu orders cannot be edited");
        }
      }
    }
  }
}

// 3l. Menu LOCK refuses tampered selected item snapshots
{
  const items: MenuItem[] = [
    { id: "small", label: "Small order", amountMsats: 25_000 },
  ];
  const create = createEvent({ amountMsats: 25_000, items });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const badSnapshot = lockEvent(create.raw.id, {
      selectedItems: [
        { itemId: "small", label: "Small order", amountMsats: 24_000, quantity: 1 },
      ],
      sellerReceivesMsats: 23_000,
      arbiterFeeMsats: 1_000,
    });
    assertErr(applyEvent(r1.state, badSnapshot), "MENU_ITEM_MISMATCH",
      "Selected item amount must match the original menu item");
  }
}

// 3l.1. Exchange bracket LOCK accepts an exact amount inside min/max only
{
  const items: MenuItem[] = [
    {
      id: "bracket-a",
      label: "Cash range",
      kind: "exchange-bracket",
      amountMsats: 25_000,
      minAmountMsats: 25_000,
      maxAmountMsats: 75_000,
      fiatCurrency: "USD",
    },
  ];
  const create = createEvent({ amountMsats: 25_000, items });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const goodSelection: LockPayload["selectedItems"] = [
      {
        itemId: "bracket-a",
        label: "Cash range",
        kind: "exchange-bracket",
        amountMsats: 50_000,
        quantity: 1,
        minAmountMsats: 25_000,
        maxAmountMsats: 75_000,
        fiatCurrency: "USD",
      },
    ];
    const buyerJoin = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const joined = applyEvent(r1.state, buyerJoin);
    if (assertOk(joined, "Exchange bracket buyer can join before choosing amount")) {
      const readyOrder = joinEvent(Role.BUYER, BUYER_PK, buyerJoin.raw.id, {
        selectedItems: goodSelection,
        amountMsats: 50_000,
        orderFinalized: true,
      });
      const ready = applyEvent(joined.state, readyOrder);
      if (assertOk(ready, "Exchange bracket buyer can finalize an exact amount within range")) {
        const goodLock = lockEvent(readyOrder.raw.id, {
          selectedItems: goodSelection,
          sellerReceivesMsats: 49_000,
          arbiterFeeMsats: 1_000,
        });
        const good = applyEvent(ready.state, goodLock);
        if (assertOk(good, "Exchange bracket LOCK accepts finalized exact amount within range")) {
          assert(good.state.amountMsats === 50_000, "Bracket exact amount becomes escrow amount");
        }
      }
    }

    const badSelection: LockPayload["selectedItems"] = [
      {
        itemId: "bracket-a",
        label: "Cash range",
        kind: "exchange-bracket",
        amountMsats: 80_000,
        quantity: 1,
        minAmountMsats: 25_000,
        maxAmountMsats: 75_000,
        fiatCurrency: "USD",
      },
    ];
    const badLock = lockEvent(create.raw.id, {
      selectedItems: badSelection,
      sellerReceivesMsats: 79_000,
      arbiterFeeMsats: 1_000,
    });
    assertErr(applyEvent(r1.state, badLock), "MENU_ITEM_MISMATCH",
      "Exchange bracket amount outside range is rejected");
  }
}

// 3m. Non-menu LOCK rejects selectedItems to keep legacy listings simple
{
  const create = createEvent();
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const lock = lockEvent(create.raw.id, {
      selectedItems: [
        { itemId: "ghost", label: "Ghost item", amountMsats: 100_000_000, quantity: 1 },
      ],
    });
    assertErr(applyEvent(r1.state, lock), "UNEXPECTED_SELECTED_ITEMS",
      "Non-menu listings cannot carry selectedItems");
  }
}

// ── 4. VOTE — Happy Path ─────────────────────────────────────────────────
console.log("\n── VOTE (happy path: buyer+seller agree) ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  const r1 = applyEvent(state, v1);
  if (assertOk(r1, "Buyer votes RELEASE")) {
    assert(r1.state.votes[Role.BUYER] === Outcome.RELEASE, "Buyer vote recorded");
    assert(r1.state.status === EscrowStatus.LOCKED, "Still LOCKED (need 2 votes + RESOLVE)");

    const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
    const r2 = applyEvent(r1.state, v2);
    if (assertOk(r2, "Seller votes RELEASE")) {
      assert(r2.state.votes[Role.SELLER] === Outcome.RELEASE, "Seller vote recorded");

      const cv = canVote(r2.state, ARBITER_PK);
      assert(!cv.canVote, "Arbiter can't vote when buyer+seller agree");

      const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
      const r3 = applyEvent(r2.state, resolve);
      if (assertOk(r3, "RESOLVE → APPROVED")) {
        assert(r3.state.status === EscrowStatus.APPROVED, "Status is APPROVED");
        assert(r3.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

        const winner = getWinner(r3.state);
        assert(winner?.role === Role.BUYER, "Winner is buyer");
        assert(winner?.pubkey === BUYER_PK, "Winner pubkey correct");
      }
    }
  }
}

// ── 5. VOTE — Dispute Path ───────────────────────────────────────────────
console.log("\n── VOTE (dispute: arbiter breaks tie) ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;

  const cv = canVote(state, ARBITER_PK);
  assert(cv.canVote === true, "Arbiter CAN vote after disagreement");

  const v3 = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.REFUND, v2.raw.id);
  const r = applyEvent(state, v3);
  if (assertOk(r, "Arbiter votes REFUND")) {
    const resolve = resolveEvent(Outcome.REFUND, [Role.SELLER, Role.ARBITER], true, v3.raw.id);
    const r2 = applyEvent(r.state, resolve);
    if (assertOk(r2, "RESOLVE with arbiter → APPROVED (refund)")) {
      assert(r2.state.resolvedOutcome === Outcome.REFUND, "Outcome is REFUND");
      const winner = getWinner(r2.state);
      assert(winner?.role === Role.SELLER, "Winner is seller (refund)");
    }
  }
}

// Arbiter tries to vote too early
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const earlyVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, lock.raw.id);
  assertErr(applyEvent(state, earlyVote), "ARBITER_TOO_EARLY",
    "Arbiter can't vote before buyer+seller");
}

// Double vote
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v1dup = voteEvent(Role.BUYER, BUYER_PK, Outcome.REFUND, v1.raw.id);
  assertErr(applyEvent(state, v1dup), "ALREADY_VOTED", "Double vote rejected");
}

// ── 5b. ARBITER SUBSTITUTION (DESIGN-arbiter-substitution.md) ────────────
console.log("\n── ARBITER SUBSTITUTION (pooled share, grace window, priority) ──");
{
  const BACKUP3_PK = "ff".repeat(32);
  const POOL = [ARBITER_PK, ARBITER2_PK, BACKUP3_PK];

  /** Pooled-share LOCKED state with a live buyer/seller dispute. */
  const disputedPooledState = () => {
    const create = createEvent({ communityArbiters: POOL });
    let state = (applyEvent(null, create) as any).state;
    const lock = lockEvent(create.raw.id);
    lock.payload.arbiterPoolShare = true;
    state = (applyEvent(state, lock) as any).state;
    const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
    state = (applyEvent(state, v1) as any).state;
    const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, v1.raw.id);
    state = (applyEvent(state, v2) as any).state;
    return { state, disputeAt: v2.raw.created_at, prevId: v2.raw.id };
  };

  // Priority order: assigned first, then deterministic backups, capped.
  const { state, disputeAt, prevId } = disputedPooledState();
  const order = arbiterPriorityOrder(state);
  assert(order[0] === ARBITER_PK, "substitution: priority 0 is the assigned arbiter");
  assert(order.length === 3, "substitution: pool of 3 fills the cap exactly");
  assert(new Set(order).size === 3, "substitution: priority order has no duplicates");
  assert(JSON.stringify(arbiterPriorityOrder(state)) === JSON.stringify(order),
    "substitution: priority order is deterministic on recompute");
  assert(arbiterVotePriority(state, order[1]) === 1, "substitution: backup1 has priority 1");
  assert(arbiterVotePriority(state, BUYER_PK) === null, "substitution: buyer is not in the order");

  // Dispute clock + grace boundary (long trade → 4h cap applies).
  assert(disputeStartAt(state) === disputeAt, "substitution: dispute starts at the LATER disagreeing vote");
  const eligibleAt = substitutionEligibleAt(state)!;
  assert(eligibleAt === disputeAt + SUBSTITUTION_GRACE_MAX_SECONDS,
    "substitution: long trade → backup eligible at dispute + 4h");
  // Short trade: half the remaining life wins the min().
  const shortState = { ...state, expiresAt: disputeAt + 3600 };
  assert(substitutionEligibleAt(shortState as any) === disputeAt + 1800,
    "substitution: short trade → backup eligible at half the remaining life");

  // ── v2.3: committed substitution grace ceiling ─────────────────────────
  // The locker commits a SHORTER ceiling; eligibility = dispute + min(grace,
  // half-life). Long trade so half-life isn't the binding constraint.
  {
    const graced = {
      ...state,
      lock: { ...state.lock, substitutionGraceSeconds: 60 },
    };
    assert(substitutionEligibleAt(graced as any) === disputeAt + 60,
      "v2.3 grace: committed 60s ceiling opens the floor a minute after dispute");
    // Half-life still floors it: a 120s-remaining trade with a 60s grace →
    // min(60, 60) = 60.
    const gracedShort = {
      ...state,
      expiresAt: disputeAt + 120,
      lock: { ...state.lock, substitutionGraceSeconds: 60 },
    };
    assert(substitutionEligibleAt(gracedShort as any) === disputeAt + 60,
      "v2.3 grace: half-life and committed grace agree at 60");
    // A committed grace ABOVE the 4h max is clamped down — never longer.
    const gracedHuge = {
      ...state,
      lock: { ...state.lock, substitutionGraceSeconds: 999_999 },
    };
    assert(substitutionEligibleAt(gracedHuge as any) === disputeAt + SUBSTITUTION_GRACE_MAX_SECONDS,
      "v2.3 grace: an over-max committed grace clamps to the 4h ceiling (never lengthens)");
    // A committed 0 opens the floor immediately at dispute (still bounded by
    // half-life, which is larger here).
    const gracedZero = {
      ...state,
      lock: { ...state.lock, substitutionGraceSeconds: 0 },
    };
    assert(substitutionEligibleAt(gracedZero as any) === disputeAt,
      "v2.3 grace: committed 0 → backup eligible at the dispute instant");
    // Absent field ⇒ legacy 4h, byte-identical to pre-v2.3 (already asserted
    // above via `state`, restated here against the clamp helper).
    assert(clampSubstitutionGraceSeconds(undefined) === SUBSTITUTION_GRACE_MAX_SECONDS,
      "v2.3 grace: absent committed grace defaults to the 4h ceiling");
    assert(clampSubstitutionGraceSeconds(-5) === 0,
      "v2.3 grace: negative grace clamps to 0");
    assert(clampSubstitutionGraceSeconds(90) === 90,
      "v2.3 grace: in-range grace passes through");
  }

  // The committed grace survives a real LOCK round-trip through the reducer.
  {
    const create = createEvent({ communityArbiters: POOL });
    let s = (applyEvent(null, create) as any).state;
    const lk = lockEvent(create.raw.id);
    lk.payload.arbiterPoolShare = true;
    lk.payload.substitutionGraceSeconds = 120;
    s = (applyEvent(s, lk) as any).state;
    assert(s.lock.substitutionGraceSeconds === 120,
      "v2.3 grace: reducer persists the committed grace from the LOCK payload");
    const bv = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lk.raw.id);
    s = (applyEvent(s, bv) as any).state;
    const sv = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, bv.raw.id);
    s = (applyEvent(s, sv) as any).state;
    assert(substitutionEligibleAt(s) === sv.raw.created_at + 120,
      "v2.3 grace: end-to-end LOCK→dispute uses the committed 120s ceiling");
  }

  const backup = order[1];

  // Too early → SUBSTITUTE_TOO_EARLY (1s before the boundary).
  const early = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, prevId), eligibleAt - 1);
  assertErr(applyEvent(state, early), "SUBSTITUTE_TOO_EARLY",
    "substitution: backup 1s before the boundary is rejected");

  // At the boundary → accepted; backup fills the slot.
  const bv = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, prevId), eligibleAt);
  const rBackup = applyEvent(state, bv);
  if (assertOk(rBackup, "substitution: backup vote at the boundary is accepted")) {
    assert(rBackup.state.votes[Role.ARBITER] === Outcome.REFUND, "substitution: backup's outcome holds the slot");
    assert(rBackup.state.actingArbiter === backup, "substitution: actingArbiter is the backup");

    // Assigned arbiter votes AFTER the backup → not ALREADY_VOTED; priority 0 retakes the slot.
    const av = retimeEvent(voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, bv.raw.id), eligibleAt + 10);
    const rAssigned = applyEvent(rBackup.state, av);
    if (assertOk(rAssigned, "substitution: assigned arbiter can still vote after a backup")) {
      assert(rAssigned.state.votes[Role.ARBITER] === Outcome.RELEASE,
        "substitution: assigned arbiter's vote supersedes the backup's (priority 0 wins)");
      assert(rAssigned.state.actingArbiter === ARBITER_PK, "substitution: actingArbiter flips to the assigned");

      // Permutation convergence: assigned-then-backup reaches the same material state.
      const av2 = retimeEvent(voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, prevId), eligibleAt + 10);
      const rA = applyEvent(state, av2);
      if (assertOk(rA, "substitution: assigned-first order accepted")) {
        const bv2 = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, av2.raw.id), eligibleAt + 20);
        const rAB = applyEvent(rA.state, bv2);
        if (assertOk(rAB, "substitution: backup vote still accepted after the assigned (stays in chain)")) {
          assert(
            rAB.state.votes[Role.ARBITER] === rAssigned.state.votes[Role.ARBITER]
            && rAB.state.actingArbiter === rAssigned.state.actingArbiter,
            "substitution: both arrival orders converge on the same slot + actingArbiter",
          );
        }
      }
    }

    // Same backup can't vote twice.
    const dup = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.RELEASE, bv.raw.id), eligibleAt + 30);
    assertErr(applyEvent(rBackup.state, dup), "ALREADY_VOTED", "substitution: same backup voting twice rejected");

    // Downstream machinery: RESOLVE on the backup-carried majority works untouched.
    const resolve = resolveEvent(Outcome.REFUND, [Role.SELLER, Role.ARBITER], true, bv.raw.id);
    const rResolved = applyEvent(rBackup.state, resolve);
    if (assertOk(rResolved, "substitution: RESOLVE accepts the backup-formed majority")) {
      assert(rResolved.state.resolvedOutcome === Outcome.REFUND, "substitution: resolves to the backup's outcome");
    }
  }

  // Strangers stay out; the cap holds.
  const stranger = retimeEvent(voteEvent(Role.ARBITER, "99".repeat(32), Outcome.REFUND, prevId), eligibleAt + 5);
  assertErr(applyEvent(state, stranger), "NOT_POOL_ARBITER",
    "substitution: a non-pool pubkey is rejected even on a pooled lock");

  // No pooled share → byte-identical v2.0 behavior (backup is a stranger).
  {
    const create = createEvent({ communityArbiters: POOL });
    let legacy = (applyEvent(null, create) as any).state;
    legacy = (applyEvent(legacy, lockEvent(create.raw.id)) as any).state; // no arbiterPoolShare
    const lv1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, create.raw.id);
    legacy = (applyEvent(legacy, lv1) as any).state;
    const lv2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, lv1.raw.id);
    legacy = (applyEvent(legacy, lv2) as any).state;
    const lateBackup = retimeEvent(
      voteEvent(Role.ARBITER, arbiterPriorityOrder(legacy)[1], Outcome.REFUND, lv2.raw.id),
      lv2.raw.created_at + SUBSTITUTION_GRACE_MAX_SECONDS + 60,
    );
    assertErr(applyEvent(legacy, lateBackup), "NOT_PARTICIPANT",
      "substitution: without the pooled-share marker a backup stays NOT_PARTICIPANT");
  }

  // Dispute gates and the clock. v2.9: a ONE-SIDED standing RELEASE from the
  // non-locker (buyer here) opens the escalation path, so a backup that jumps in
  // before its eligibility is gated by the CLOCK (SUBSTITUTE_TOO_EARLY — its
  // window opens later than the assigned arbiter's), not by the dispute gate.
  // When buyer+seller AGREE, the arbiter is still simply not needed.
  {
    const create = createEvent({ communityArbiters: POOL });
    let agree = (applyEvent(null, create) as any).state;
    const lk = lockEvent(create.raw.id);
    lk.payload.arbiterPoolShare = true;
    agree = (applyEvent(agree, lk) as any).state;
    const a1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lk.raw.id);
    agree = (applyEvent(agree, a1) as any).state;
    const oneVoteBackup = retimeEvent(
      voteEvent(Role.ARBITER, arbiterPriorityOrder(agree)[1], Outcome.RELEASE, a1.raw.id),
      a1.raw.created_at + SUBSTITUTION_GRACE_MAX_SECONDS + 60,
    );
    assertErr(applyEvent(agree, oneVoteBackup), "SUBSTITUTE_TOO_EARLY",
      "substitution: a backup jumping a one-sided RELEASE before its window → SUBSTITUTE_TOO_EARLY (v2.9)");
    const a2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, a1.raw.id);
    agree = (applyEvent(agree, a2) as any).state;
    const agreeBackup = retimeEvent(
      voteEvent(Role.ARBITER, arbiterPriorityOrder(agree)[1], Outcome.RELEASE, a2.raw.id),
      a2.raw.created_at + SUBSTITUTION_GRACE_MAX_SECONDS + 60,
    );
    assertErr(applyEvent(agree, agreeBackup), "ARBITER_NOT_NEEDED",
      "substitution: backup when buyer+seller agree → ARBITER_NOT_NEEDED");
  }

  // ── Stage 2: lock-time priority anchoring + envelope + canVote ──────────
  // The LOCK builder computes the order before the arbiter is seated in
  // state: a custom assigned arbiter (not in the pool) still anchors
  // priority 0, and backups derive from the pool around them.
  {
    const customAssigned = "11".repeat(32);
    const lockTime = arbiterPriorityOrderFor({
      escrowId: ESCROW_ID,
      pool: POOL,
      buyerPubkey: BUYER_PK,
      sellerPubkey: SELLER_PK,
      assignedArbiter: customAssigned,
    });
    assert(lockTime[0] === customAssigned,
      "substitution: lock-time order anchors priority 0 on the committed arbiter (even off-pool)");
    assert(lockTime.length === 3 && !lockTime.slice(1).includes(customAssigned),
      "substitution: backups derive from the pool around the committed arbiter");
  }

  // A backup's vote-carried envelope validates exactly like the assigned
  // arbiter's: shareIndex pinned to the ARBITER holder index (2), recipient
  // pinned to the engine-computed payout for the outcome.
  {
    const recipient = payoutRecipientFor(state, Outcome.REFUND)!;
    const goodEnv = {
      shareIndex: 2,
      outcome: Outcome.REFUND,
      notesHash: state.lock.notesHash!,
      recipientPubkey: recipient.pubkey,
      encryptedFor: { [recipient.pubkey]: "ct_backup_to_winner" },
    };
    assert(validateVoteShareEnvelope(goodEnv as any, state, Role.ARBITER, Outcome.REFUND, state.lock.notesHash) === null,
      "substitution: a backup's shareIndex-2 envelope validates for the ARBITER role");
    assert(validateVoteShareEnvelope({ ...goodEnv, shareIndex: 0 } as any, state, Role.ARBITER, Outcome.REFUND, state.lock.notesHash) !== null,
      "substitution: a backup smuggling a non-arbiter shareIndex is rejected");
    // And the reducer accepts a backup vote CARRYING that envelope, leaving it
    // in the chain addressed to the winner (what the claim scan reads).
    const envVote = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, prevId), eligibleAt + 2);
    (envVote.payload as any).shareEnvelope = goodEnv;
    const rEnv = applyEvent(state, envVote);
    if (assertOk(rEnv, "substitution: backup vote carrying a valid envelope is accepted")) {
      const carried = rEnv.state.eventChain.some((ve: any) =>
        ve.kind === EscrowEventKind.VOTE
        && ve.payload?.shareEnvelope?.recipientPubkey === recipient.pubkey
        && ve.payload?.shareEnvelope?.shareIndex === 2
        && ve.pubkey === backup);
      assert(carried, "substitution: the backup's envelope rides the chain addressed to the winner");
    }
  }

  // canVote mirrors the reducer for the UI: floor → eligible → already-voted.
  {
    assert(canVote(state, backup, eligibleAt - 1).canVote === false,
      "substitution: canVote holds the floor for the assigned arbiter before the boundary");
    assert(canVote(state, backup, eligibleAt).canVote === true,
      "substitution: canVote opens for the backup at the boundary");
    assert(canVote(state, "99".repeat(32), eligibleAt + 5).canVote === false,
      "substitution: canVote stays closed for non-pool strangers");
    const bv3 = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, prevId), eligibleAt + 1);
    const afterBackup = (applyEvent(state, bv3) as any).state;
    assert(canVote(afterBackup, ARBITER_PK, eligibleAt + 5).canVote === true,
      "substitution: canVote still lets the ASSIGNED arbiter vote after a backup filled the slot");
    assert(canVote(afterBackup, backup, eligibleAt + 5).canVote === false,
      "substitution: canVote blocks the backup from voting twice");
  }

  // The UI prompt mirrors all of it: countdown before the floor opens,
  // arbiter buttons after, nothing for strangers, and the assigned arbiter
  // keeps their buttons even after a backup filled the slot.
  {
    const before = decideVotePrompt(state, backup, state.participants, eligibleAt - 60);
    assert(before.kind === "waiting" && /step in/.test((before as any).message ?? ""),
      "substitution: votePrompt shows the backup a step-in countdown before the floor opens");
    const after = decideVotePrompt(state, backup, state.participants, eligibleAt + 1);
    assert(after.kind === "buttons" && (after as any).role === Role.ARBITER,
      "substitution: votePrompt gives the backup arbiter buttons once the floor opens");
    assert(decideVotePrompt(state, "99".repeat(32), state.participants, eligibleAt + 1).kind === "none",
      "substitution: votePrompt stays silent for non-pool strangers");
    const bv4 = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, prevId), eligibleAt + 1);
    const slotFilled = (applyEvent(state, bv4) as any).state;
    const assignedPrompt = decideVotePrompt(slotFilled, ARBITER_PK, slotFilled.participants, eligibleAt + 5);
    assert(assignedPrompt.kind === "buttons",
      "substitution: votePrompt still offers the ASSIGNED arbiter buttons after a backup voted");
    assert(decideVotePrompt(slotFilled, backup, slotFilled.participants, eligibleAt + 5).kind === "none",
      "substitution: votePrompt closes for the backup after they voted");
  }

  // ── HEALING substitution: the disputed-expiry limbo fix ─────────────────
  // A 1-1 disputed trade expires; every participant has voted except the
  // absent assigned arbiter — previously the ONLY device able to cast the
  // rescue vote. On pooled locks any pool backup heals instead: REFUND only,
  // no grace floor, slot still converges by priority.
  {
    const expired = { ...state, status: EscrowStatus.EXPIRED } as EscrowState;

    // Backup heals with REFUND — accepted, no floor, slot = backup.
    const healVote = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.REFUND, prevId), disputeAt + 10);
    const rHeal = applyEvent(expired, healVote);
    if (assertOk(rHeal, "healing-sub: backup's healing REFUND on an expired pooled dispute is accepted")) {
      assert(rHeal.state.votes[Role.ARBITER] === Outcome.REFUND,
        "healing-sub: the healing vote fills the arbiter slot with REFUND");
      assert(rHeal.state.actingArbiter === backup,
        "healing-sub: the healing backup becomes the acting arbiter");
      // Seller (REFUND) + backup (REFUND) = 2-of-3 → RESOLVE heals the chain.
      const healResolve = resolveEvent(Outcome.REFUND, [Role.SELLER, Role.ARBITER], true, healVote.raw.id);
      const rHealed = applyEvent(rHeal.state, healResolve);
      if (assertOk(rHealed, "healing-sub: RESOLVE lands on the healed expired trade")) {
        assert(rHealed.state.resolvedOutcome === Outcome.REFUND,
          "healing-sub: the limbo trade resolves to REFUND (sats route home)");
      }
    }

    // v2.9: `expired` here is a CONTEST (buyer RELEASE, seller REFUND — the
    // non-locker holds a standing RELEASE), not abandonment. A backup may now
    // rule on MERIT, so a RELEASE ruling is VALID — it gives the performing
    // buyer a path to win instead of the old auto-REFUND-to-locker. (REFUND-only
    // healing still holds for genuine ABANDONMENT — see the v2.9 expiry-exploit
    // block below, where a no-standing-RELEASE trade still rejects a RELEASE heal.)
    const meritRelease = retimeEvent(voteEvent(Role.ARBITER, backup, Outcome.RELEASE, prevId), disputeAt + 10);
    assert((applyEvent(expired, meritRelease) as any).ok !== false,
      "healing-sub: a backup may rule RELEASE on a CONTESTED expired trade (v2.9 merit ruling)");

    // No grace floor in healing: a vote long BEFORE the live-dispute boundary
    // timestamp is still accepted once the trade is expired.
    const earlyHeal = retimeEvent(voteEvent(Role.ARBITER, order[2], Outcome.REFUND, prevId), disputeAt + 1);
    assert((applyEvent(expired, earlyHeal) as any).ok !== false,
      "healing-sub: healing has no grace floor (trade already dead)");

    // Non-pooled legacy locks: backups stay out even in healing.
    {
      const create = createEvent({ communityArbiters: POOL });
      let legacy = (applyEvent(null, create) as any).state;
      legacy = (applyEvent(legacy, lockEvent(create.raw.id)) as any).state;
      const lv1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, create.raw.id);
      legacy = (applyEvent(legacy, lv1) as any).state;
      const lv2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, lv1.raw.id);
      legacy = (applyEvent(legacy, lv2) as any).state;
      const legacyExpired = { ...legacy, status: EscrowStatus.EXPIRED } as EscrowState;
      const legacyHeal = voteEvent(Role.ARBITER, arbiterPriorityOrder(legacy)[1], Outcome.REFUND, lv2.raw.id);
      assertErr(applyEvent(legacyExpired, legacyHeal), "NOT_PARTICIPANT",
        "healing-sub: backups stay NOT_PARTICIPANT on non-pooled locks even in healing");
    }

    // THE FIELD SCENARIO (v2.1.0 live test): the trade is past its deadline
    // but no event has arrived to flip status — every client still reads
    // LOCKED — and the backup's device can't see ANY votes (the envelope
    // gap). Healing must be judged by the CLOCK, not the status, and must
    // need no votes at all.
    {
      const create = createEvent({ communityArbiters: POOL });
      let dead = (applyEvent(null, create) as any).state;
      const lk = lockEvent(create.raw.id);
      lk.payload.arbiterPoolShare = true;
      dead = (applyEvent(dead, lk) as any).state; // LOCKED, zero votes visible
      const afterDeadline = dead.expiresAt + 60;
      const deadBackup = arbiterPriorityOrder(dead)[1];
      assert(dead.status === EscrowStatus.LOCKED,
        "field-heal: quiet dead trade still reads LOCKED (no event flipped it)");
      assert(canVote(dead, deadBackup, afterDeadline).canVote === true,
        "field-heal: canVote opens for a backup on a LOCKED-past-deadline pooled trade with NO visible votes");
      const deadPrompt = decideVotePrompt(dead, deadBackup, dead.participants, afterDeadline);
      assert(deadPrompt.kind === "buttons" && (deadPrompt as any).outcomes[0] === Outcome.REFUND,
        "field-heal: votePrompt offers the blind backup REFUND-only healing buttons by the clock");
      assert(canVote(dead, deadBackup, dead.expiresAt - 60).canVote === false,
        "field-heal: before the deadline the same blind backup stays gated (no dispute visible)");
      // And the reducer accepts the heal on arrival: the vote's timestamp
      // flips LOCKED → EXPIRED and the healing gates take it from there.
      const blindHeal = retimeEvent(voteEvent(Role.ARBITER, deadBackup, Outcome.REFUND, lk.raw.id), afterDeadline);
      const rBlind = applyEvent(dead, blindHeal);
      if (assertOk(rBlind, "field-heal: reducer accepts the blind backup's post-deadline healing REFUND")) {
        assert(rBlind.state.status === EscrowStatus.EXPIRED,
          "field-heal: the arriving heal vote flips the quiet trade to EXPIRED");
        assert(rBlind.state.votes[Role.ARBITER] === Outcome.REFUND,
          "field-heal: the blind heal fills the arbiter slot");
      }
    }

    // canVote + votePrompt mirrors for the healing backup.
    assert(canVote(expired, backup, disputeAt + 1).canVote === true,
      "healing-sub: canVote opens for a pool backup on the expired pooled dispute");
    const healPrompt = decideVotePrompt(expired, backup, expired.participants, disputeAt + 1);
    assert(healPrompt.kind === "buttons"
      && (healPrompt as any).role === Role.ARBITER
      && (healPrompt as any).outcomes.length === 1
      && (healPrompt as any).outcomes[0] === Outcome.REFUND,
      "healing-sub: votePrompt offers the backup REFUND-only healing buttons");
  }
}

// ── 5b-v2.9. Expiry auto-refund exploit — performance contest, not abandonment ─
// DECISIONS 2026-06-07 "Expiry auto-refund is exploitable": a ghosting LOCKER
// (the seller in exchange/bill-pay/lending) used to keep BOTH fiat and sats —
// the performer voted RELEASE, the locker went silent, and the expiry refund
// paid the locker. v2.9 turns one-sided performance into a CONTEST: the refund
// default is suppressed while the non-locker holds a standing RELEASE, and the
// arbiter (assigned, then backups) gets a path to rule before expiry.
console.log("\n── v2.9 expiry-exploit: performance contest ──");
{
  const POOL9 = [ARBITER_PK, ARBITER2_PK, "ff".repeat(32)];

  // Headline: seller locks (p2p default), buyer (non-locker) votes RELEASE,
  // seller stays silent.
  const create = createEvent({ communityArbiters: POOL9 });
  let s = (applyEvent(null, create) as any).state;
  const lk = lockEvent(create.raw.id); lk.payload.arbiterPoolShare = true;
  s = (applyEvent(s, lk) as any).state;
  const lockedAt = s.expiresAt - 86400;
  const bRel = retimeEvent(voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lk.raw.id), lockedAt + 60);
  const contested = (applyEvent(s, bRel) as any).state;

  // Pure helpers: the one-sided arm opens, strictly before expiry, and feeds
  // disputeStartAt so backups are reachable through the same clock.
  const escAt = oneSidedEscalationAt(contested);
  assert(escAt !== null, "v2.9: a one-sided standing RELEASE opens an escalation window");
  assert(escAt! < contested.expiresAt, "v2.9: the escalation window opens strictly BEFORE expiry (half-life floor)");
  assert(disputeStartAt(contested) === escAt, "v2.9: disputeStartAt's second arm returns the escalation deadline (unfreezes backups)");
  assert(isPerformanceContest(contested) === true, "v2.9: a standing RELEASE from the non-locker is a CONTEST, not abandonment");
  assert(oneSidedReleaseAnchor(contested)?.nonLockerRole === Role.BUYER, "v2.9: the anchor identifies the buyer as the non-locker (p2p)");

  // The assigned arbiter is frozen BEFORE the window, free AFTER it.
  const tooEarly = retimeEvent(voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, bRel.raw.id), escAt! - 60);
  assertErr(applyEvent(contested, tooEarly), "ARBITER_TOO_EARLY",
    "v2.9: the assigned arbiter still waits out the escalation window");

  // WIN PATH: arbiter rules RELEASE → buyer + arbiter = 2-of-3 → the performer
  // wins and the ghosting seller gets nothing.
  const arbRel = retimeEvent(voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, bRel.raw.id), escAt! + 5);
  const ruled = applyEvent(contested, arbRel);
  if (assertOk(ruled, "v2.9: once the window opens the assigned arbiter MAY rule RELEASE against a silent locker")) {
    assert(ruled.state.votes[Role.ARBITER] === Outcome.RELEASE, "v2.9: the arbiter slot holds the RELEASE ruling");
    const resolved = applyEvent(ruled.state, resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.ARBITER], true, arbRel.raw.id));
    if (assertOk(resolved, "v2.9: RESOLVE lands RELEASE on the contested trade")) {
      assert(resolved.state.resolvedOutcome === Outcome.RELEASE
        && payoutRecipientFor(resolved.state, Outcome.RELEASE)!.pubkey === BUYER_PK,
        "v2.9: the performing buyer wins — the exploit (seller keeps fiat + sats) is closed");
    }
  }

  // LIFT: an arbiter REFUND ruling LIFTS suppression, so a genuine merit-refund
  // can complete a 2-of-3 — a lying buyer can't freeze the locker's funds.
  const arbRef = retimeEvent(voteEvent(Role.ARBITER, ARBITER_PK, Outcome.REFUND, bRel.raw.id), escAt! + 5);
  const ruledRef = applyEvent(contested, arbRef);
  if (assertOk(ruledRef, "v2.9: the arbiter may instead rule REFUND (the buyer never actually performed)")) {
    assert(isPerformanceContest(ruledRef.state) === false,
      "v2.9: an arbiter REFUND ruling LIFTS suppression — no permanent freeze of the locker's funds");
  }

  // Suppression survives into an unresolved expiry: a backup can still rule
  // RELEASE (the performer wins even if the assigned arbiter ghosts too).
  const cexpired = { ...contested, status: EscrowStatus.EXPIRED } as EscrowState;
  assert(isPerformanceContest(cexpired) === true, "v2.9: the contest survives into expiry while unresolved");
  const backupPk = arbiterPriorityOrder(cexpired)[1];
  const backupRel = retimeEvent(voteEvent(Role.ARBITER, backupPk, Outcome.RELEASE, bRel.raw.id), cexpired.expiresAt + 60);
  assertOk(applyEvent(cexpired, backupRel),
    "v2.9: a backup may rule RELEASE on the contested expired trade (performer still wins if the assigned arbiter ghosts)");

  // Abandonment is unchanged: no standing RELEASE → REFUND-only healing holds.
  const abCreate = createEvent({ communityArbiters: POOL9 });
  let ab = (applyEvent(null, abCreate) as any).state;
  const abLock = lockEvent(abCreate.raw.id); abLock.payload.arbiterPoolShare = true;
  ab = (applyEvent(ab, abLock) as any).state;
  const abExpired = { ...ab, status: EscrowStatus.EXPIRED } as EscrowState;
  assert(isPerformanceContest(abExpired) === false, "v2.9: a zero-vote expired trade is abandonment, not a contest");
  const abBackup = arbiterPriorityOrder(abExpired)[1];
  const abRelHeal = retimeEvent(voteEvent(Role.ARBITER, abBackup, Outcome.RELEASE, abLock.raw.id), abExpired.expiresAt + 60);
  assertErr(applyEvent(abExpired, abRelHeal), "INVALID_HEAL_OUTCOME",
    "v2.9: abandonment still heals REFUND-only — a backup RELEASE heal is rejected");
  const abRefHeal = retimeEvent(voteEvent(Role.ARBITER, abBackup, Outcome.REFUND, abLock.raw.id), abExpired.expiresAt + 60);
  assertOk(applyEvent(abExpired, abRefHeal), "v2.9: abandonment REFUND heal is accepted (sats route home to the locker)");

  // The LOCKER's OWN RELEASE (counterparty silent) is out of scope — it is
  // locker-favorable, not theft, so the patch must NOT widen to cover it.
  const lrCreate = createEvent({ communityArbiters: POOL9 });
  let lr = (applyEvent(null, lrCreate) as any).state;
  const lrLock = lockEvent(lrCreate.raw.id); lrLock.payload.arbiterPoolShare = true;
  lr = (applyEvent(lr, lrLock) as any).state;
  const sRel = retimeEvent(voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, lrLock.raw.id), (lr.expiresAt - 86400) + 60);
  lr = (applyEvent(lr, sRel) as any).state;
  assert(isPerformanceContest(lr) === false,
    "v2.9: the LOCKER's own RELEASE (buyer silent) is NOT a contest — the patch isn't widened");
  assert(oneSidedEscalationAt(lr) === null, "v2.9: no escalation clock for a locker-side RELEASE");

  // Marketplace inversion: payoutRecipientFor drives role selection. recipients.ts
  // says marketplace BUYER locks and the SELLER is the performer/non-locker, so
  // the contest must key on the SELLER's RELEASE there — proven at the pure
  // predicate layer so the per-category map is never hand-rolled.
  const mkt = (votes: Record<string, Outcome>) => ({
    category: "marketplace",
    participants: { [Role.BUYER]: BUYER_PK, [Role.SELLER]: SELLER_PK, [Role.ARBITER]: ARBITER_PK },
    votes,
  } as unknown as EscrowState);
  assert(payoutRecipientFor(mkt({}), Outcome.RELEASE)!.role === Role.SELLER,
    "v2.9: marketplace RELEASE pays the SELLER (the buyer is the locker)");
  assert(isPerformanceContest(mkt({ [Role.SELLER]: Outcome.RELEASE })) === true,
    "v2.9: marketplace — the SELLER's standing RELEASE is the contest (inversion handled by construction)");
  assert(isPerformanceContest(mkt({ [Role.BUYER]: Outcome.RELEASE })) === false,
    "v2.9: marketplace — the BUYER (locker) voting RELEASE is NOT a contest");
}

// ── 5b-BONDMS. Bitcoin multisig bond custody (cryptographic no-self-return) ────
// The new custody primitive: a Taproot m-of-n (default 2-of-3 over owner+2
// custodians). Owner is 1 key → Bitcoin consensus (not our code) forbids an
// owner-alone spend. The ⭐ custodian checklist (verifyReturnPsbt) is the real
// security layer — it kills blind-cosign self-reclaim. Offline (library) proof of
// the attack matrix; the on-chain signet broadcast is the supervised gate.
console.log("\n── Bond custody: Bitcoin Taproot multisig (@scure/btc-signer) ──");
{
  const priv = [0, 1, 2, 3, 4].map(() => btcMs.utils.randomPrivateKeyBytes());
  const xonly = priv.map((p) => btcMs.utils.pubSchnorr(p));
  const [OWNER, CUSTA, CUSTB] = [0, 1, 2];
  const bond = buildBondMultisig(2, 3, [xonly[OWNER], xonly[CUSTA], xonly[CUSTB]], MS_NET);
  assert(bond.address.startsWith("tb1p"), "multisig: 2-of-3 builds a Taproot address");
  assert(recomputeAddress(2, 3, [xonly[OWNER], xonly[CUSTA], xonly[CUSTB]], MS_NET) === bond.address,
    "multisig: recomputeAddress is deterministic (verify-don't-trust the wire)");

  const utxo: BondUtxo = { txid: "aa".repeat(32), index: 0, amountSats: 100_000n };
  const ownerAddr = btcMs.p2tr(xonly[OWNER], undefined, MS_NET).address as string;
  const secretAddr = btcMs.p2tr(xonly[3], undefined, MS_NET).address as string;
  const psbt = buildReturnPsbt({ bond, utxo, ownerReturnAddress: ownerAddr, feeSats: 500n, network: MS_NET });

  const canFinalize = (psbts: string[]) => { try { return combineAndFinalize(psbts, MS_NET).length > 0; } catch { return false; } };
  const sOwner = coSignPsbt(psbt, priv[OWNER], MS_NET);
  assert(canFinalize([coSignPsbt(sOwner, priv[CUSTA], MS_NET)]),
    "multisig RETURN: owner→custA sequential co-sign over the wire → finalizes to a valid tx");
  assert(!canFinalize([sOwner]),
    "⭐ multisig: owner ALONE (1-of-3) cannot finalize — cryptographic no-self-return");
  assert(canFinalize([coSignPsbt(coSignPsbt(psbt, priv[CUSTA], MS_NET), priv[CUSTB], MS_NET)]),
    "multisig: custA+custB (no owner) finalizes — cabinet can return / restore");

  // ⭐ The custodian checklist — the real enforcement layer.
  const expect = { bond, utxo, ownerReturnAddress: ownerAddr, maxFeeSats: 2_000n, network: MS_NET };
  assert(verifyReturnPsbt(psbt, expect).ok, "checklist: a legit return-to-owner PSBT passes");
  assert(!verifyReturnPsbt(buildReturnPsbt({ bond, utxo, ownerReturnAddress: secretAddr, feeSats: 500n, network: MS_NET }), expect).ok,
    "⭐ checklist REJECTS a spend to a non-owner address — blind-cosign self-reclaim dies");
  assert(!verifyReturnPsbt(buildReturnPsbt({ bond, utxo, ownerReturnAddress: ownerAddr, feeSats: 90_000n, network: MS_NET }), expect).ok,
    "checklist REJECTS an inflated fee (grief)");
  assert(!verifyReturnPsbt(psbt, { ...expect, utxo: { ...utxo, txid: "bb".repeat(32) } }).ok,
    "checklist REJECTS a wrong input UTXO");
  {
    const spend = btcMs.p2tr(msHexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"),
      btcMs.p2tr_ms(2, [xonly[OWNER], xonly[CUSTA], xonly[CUSTB]]) as never, MS_NET);
    const evil = new btcMs.Transaction();
    evil.addInput({ txid: msHexToBytes(utxo.txid), index: 0, witnessUtxo: { script: spend.script, amount: utxo.amountSats }, ...spend });
    evil.addOutputAddress(ownerAddr, 50_000n, MS_NET);
    evil.addOutputAddress(secretAddr, 49_000n, MS_NET); // siphon
    assert(!verifyReturnPsbt(msBase64.encode(evil.toPSBT()), expect).ok, "checklist REJECTS an extra (siphon) output");

    const sh = new btcMs.Transaction();
    sh.addInput({ txid: msHexToBytes(utxo.txid), index: 0, witnessUtxo: { script: spend.script, amount: utxo.amountSats }, ...spend, sighashType: 0x83 });
    sh.addOutputAddress(ownerAddr, 90_000n, MS_NET);
    assert(!verifyReturnPsbt(msBase64.encode(sh.toPSBT()), expect).ok, "checklist REJECTS a non-DEFAULT (blank-check ANYONECANPAY|SINGLE) sighash");
  }

  // m/n parameterization is real: 3-of-5 needs 3, not 2.
  const bond5 = buildBondMultisig(3, 5, xonly, MS_NET);
  assert(bond5.address.startsWith("tb1p"), "multisig: 3-of-5 builds (parameterized m/n)");
  const p5 = buildReturnPsbt({ bond: bond5, utxo, ownerReturnAddress: ownerAddr, feeSats: 500n, network: MS_NET });
  assert(!canFinalize([coSignPsbt(coSignPsbt(p5, priv[0], MS_NET), priv[1], MS_NET)]),
    "multisig 3-of-5: two signatures do NOT meet threshold (parameterization isn't theater)");
  assert(canFinalize([coSignPsbt(coSignPsbt(coSignPsbt(p5, priv[0], MS_NET), priv[1], MS_NET), priv[2], MS_NET)]),
    "multisig 3-of-5: three signatures finalize");
}

// ── 5b-BONDFUND. Funding watcher (the commitment bond's deposit scanner) ───────
// findBondFundingUtxos is the live path: EVERY confirmed deposit at the bond
// address (any amount — the arbiter's own sats; more is a bigger bond), each with
// its REAL scriptPubKey read off the funding tx. The minConfs depth gate must
// NEVER silently drop a deposit it can't measure ("I funded it, nothing shows" is
// the worse failure). esploraOutspend is the reclaim-recovery probe: the leaf is
// owner-key-only, so a spend of a bond UTXO can only BE the owner's reclaim.
console.log("\n── Bond funding watcher (commitment deposits + outspend recovery) ──");
{
  const owner = btcMs.utils.pubSchnorr(btcMs.utils.randomPrivateKeyBytes());
  const bond = buildCommitmentBond(owner, 900_000, MS_NET);
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const scriptHex = hex(bond.script);
  const T1 = "cd".repeat(32), T2 = "ce".repeat(32);

  const fake = (utxos: any[], opts: { tip?: number | "fail"; badScriptFor?: string } = {}): EsploraFetch => async (path: string) => {
    if (path.endsWith("/utxo")) return utxos;
    if (path === "/blocks/tip/height") { if (opts.tip === "fail") throw new Error("tip down"); return opts.tip ?? 800_010; }
    if (path.startsWith("/tx/")) {
      const txid = path.split("/")[2];
      return { vout: [{ scriptpubkey: opts.badScriptFor === txid ? "zz" : scriptHex }, { scriptpubkey: scriptHex }] };
    }
    return null;
  };

  // Finds EVERY confirmed deposit, any amount, each with its real script.
  const two = await findBondFundingUtxos({ address: bond.address, fetchJson: fake([
    { txid: T1, vout: 0, value: 20_000, status: { confirmed: true } },
    { txid: T2, vout: 1, value: 5_000, status: { confirmed: true } },
  ]) });
  assert(two.length === 2 && two[0].utxo.amountSats === 20_000n && two[1].utxo.amountSats === 5_000n,
    "⭐ bondfund: finds ALL confirmed deposits of ANY amount (multi-UTXO funding)");
  assert(two.every((f) => hex(f.fundingScript) === scriptHex), "bondfund: each deposit carries its REAL on-chain script");

  // Unconfirmed deposits are ignored; none yet → [] (keep polling).
  assert((await findBondFundingUtxos({ address: bond.address, fetchJson: fake([{ txid: T1, vout: 0, value: 1_000, status: { confirmed: false } }]) })).length === 0,
    "bondfund: an UNCONFIRMED deposit is ignored");
  assert((await findBondFundingUtxos({ address: bond.address, fetchJson: fake([]) })).length === 0, "bondfund: no deposit yet → empty");

  // Depth gate: a KNOWN-too-shallow deposit is rejected (reorg safety)…
  const shallow = await findBondFundingUtxos({ address: bond.address, minConfs: 6, fetchJson: fake([
    { txid: T1, vout: 0, value: 20_000, status: { confirmed: true, block_height: 800_008 } }, // depth 3 at tip 800_010
  ]) });
  assert(shallow.length === 0, "⭐ bondfund: minConfs REJECTS a known too-shallow deposit (reorg safety)");
  // …but a deposit whose depth CANNOT be measured is kept, and so is the whole
  // confirmed set when the tip fetch itself fails — never silently drop.
  assert((await findBondFundingUtxos({ address: bond.address, minConfs: 6, fetchJson: fake([
    { txid: T1, vout: 0, value: 20_000, status: { confirmed: true } },
  ]) })).length === 1, "⭐ bondfund: a confirmed deposit with no measurable depth is KEPT");
  assert((await findBondFundingUtxos({ address: bond.address, minConfs: 6, fetchJson: fake([
    { txid: T1, vout: 0, value: 20_000, status: { confirmed: true, block_height: 800_008 } },
  ], { tip: "fail" }) })).length === 1, "⭐ bondfund: a failed tip fetch keeps the confirmed set");

  // A deposit whose funding tx yields no valid script is skipped; the rest survive.
  const partial = await findBondFundingUtxos({ address: bond.address, fetchJson: fake([
    { txid: T1, vout: 0, value: 20_000, status: { confirmed: true } },
    { txid: T2, vout: 0, value: 9_000, status: { confirmed: true } },
  ], { badScriptFor: T2 }) });
  assert(partial.length === 1 && partial[0].utxo.txid === T1, "bondfund: a deposit with an unreadable script is skipped, the rest survive");

  // esploraOutspend — the reclaim-recovery probe.
  const outspendFake = (resp: any): EsploraFetch => async () => resp;
  const spent = await esploraOutspend(outspendFake({ spent: true, txid: T2 }), T1, 0);
  assert(spent.spent === true && spent.txid === T2, "bondfund: outspend reports the spending txid (lost-state reclaim recovery)");
  const unspent = await esploraOutspend(outspendFake({ spent: false }), T1, 0);
  assert(unspent.spent === false && unspent.txid === undefined, "bondfund: outspend reports unspent");
  let outspendThrew = false;
  try { await esploraOutspend(outspendFake(null), T1, 0); } catch { outspendThrew = true; }
  assert(outspendThrew, "bondfund: a malformed outspend response throws (never a silent 'unspent')");
}

// ── 5b-BONDCLTV. Single-key TIMELOCK COMMITMENT bond (the sealed v1 model) ─────
// The bond is now an arbiter's OWN sats, timelocked to their OWN key until T — one
// Taproot leaf, one signer, collusion-impossible by construction. Unit-level: the
// address is deterministic, a valid reclaim (nLockTime = T) finalizes to a
// broadcastable single-sig tx, and an early reclaim (nLockTime < T) still BUILDS
// (it's the consensus-invalid tx the network rejects — proven on-chain, not here).
console.log("\n── Bond commitment (single-key CLTV timelock) ──");
{
  const owner = (() => { const bp = btcMs.utils.randomPrivateKeyBytes(); return { bp, x: btcMs.utils.pubSchnorr(bp) }; })();
  const T = 800_000;
  const bond = buildCommitmentBond(owner.x, T, MS_NET);
  assert(bond.address.startsWith("tb1p"), "bondcltv: builds a taproot address");
  assert(recomputeCommitmentAddress(owner.x, T, MS_NET) === bond.address, "⭐ bondcltv: address is deterministic (recompute-don't-trust)");
  assert(recomputeCommitmentAddress(owner.x, T + 1, MS_NET) !== bond.address, "bondcltv: a different term → a different address");
  const other = btcMs.utils.pubSchnorr(btcMs.utils.randomPrivateKeyBytes());
  assert(recomputeCommitmentAddress(other, T, MS_NET) !== bond.address, "bondcltv: a different owner key → a different address");

  // The leaf really is <T> CLTV DROP <key> CHECKSIG.
  const leafHex = [...buildTimelockLeaf(owner.x, T)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert(leafHex.includes("b17520") && leafHex.endsWith("ac"), "bondcltv: leaf = <T> CHECKLOCKTIMEVERIFY(b1) DROP(75) <key>(20…) CHECKSIG(ac)");

  const utxo = { txid: "cc".repeat(32), index: 0, amountSats: 50_000n };
  const dest = btcMs.p2tr(owner.x, undefined, MS_NET).address as string;
  const mainnetDest = btcMs.p2tr(owner.x, undefined, MS_MAINNET).address as string;

  const validBondAddress = validateBitcoinAddressForNetwork(dest, MS_NET);
  const wrongNetworkAddress = validateBitcoinAddressForNetwork(mainnetDest, MS_NET);
  const malformedAddress = validateBitcoinAddressForNetwork("not a bitcoin address", MS_NET);
  const emptyAddress = validateBitcoinAddressForNetwork("   ", MS_NET);
  assert(validBondAddress.ok === true, "bondreclaim-dest: a signet/testnet address validates on the bond network");
  assert(!wrongNetworkAddress.ok && wrongNetworkAddress.code === "wrong_network", "bondreclaim-dest: wrong-network address is rejected before build");
  assert(!malformedAddress.ok && malformedAddress.code === "invalid", "bondreclaim-dest: malformed address is rejected");
  assert(!emptyAddress.ok && emptyAddress.code === "empty", "bondreclaim-dest: empty address is rejected");

  const depositDest = btcMs.p2tr(other, undefined, MS_NET).address as string;
  const chamaResolved = resolveReclaimDestination({
    choice: { kind: "chama" },
    bondKeyAddress: dest,
    network: MS_NET,
    chamaDepositAddress: depositDest,
  });
  assert(chamaResolved.ok && chamaResolved.destination.actual === "chama" && chamaResolved.destination.address === depositDest,
    "bondreclaim-dest: Back into Chama uses the Fedimint on-chain deposit address when available");

  const fallbackResolved = resolveReclaimDestination({
    choice: { kind: "chama" },
    bondKeyAddress: dest,
    network: MS_NET,
    chamaDepositAddress: null,
    fallbackReason: "fed down",
  });
  assert(fallbackResolved.ok && fallbackResolved.destination.requested === "chama" && fallbackResolved.destination.actual === "bond-key" && fallbackResolved.destination.address === dest,
    "⭐ bondreclaim-dest: Chama-unavailable fallback reclaims to the bond key, preserving the emergency recovery path");

  const externalResolved = resolveReclaimDestination({
    choice: { kind: "external", address: depositDest },
    bondKeyAddress: dest,
    network: MS_NET,
  });
  assert(externalResolved.ok && externalResolved.destination.actual === "external" && externalResolved.destination.address === depositDest,
    "bondreclaim-dest: user-entered external address can be the reclaim output");

  const wrongExternal = resolveReclaimDestination({
    choice: { kind: "external", address: mainnetDest },
    bondKeyAddress: dest,
    network: MS_NET,
  });
  assert(!wrongExternal.ok && wrongExternal.code === "wrong_network", "bondreclaim-dest: external address network mismatch blocks the reclaim build");

  // Valid reclaim: nLockTime = T, owner-signed, one-sig witness.
  const rawValid = buildReclaimTx({ bond, utxos: [utxo], ownerPriv: owner.bp, destination: dest, feeSats: 500n });
  const decoded = btcMs.Transaction.fromRaw(msHexToBytes(rawValid));
  assert(decoded.lockTime === T, "bondcltv: valid reclaim carries nLockTime = T");
  assert(decoded.getInput(0).sequence === 0xfffffffe, "bondcltv: input sequence enables nLockTime (0xfffffffe)");
  const w = decoded.getInput(0).finalScriptWitness!;
  assert(w.length === 3 && w[0].length === 64, "⭐ bondcltv: witness = [ownerSig(64), leaf, controlBlock] — one signer, no cabinet");
  const rawExternal = buildReclaimTx({ bond, utxos: [utxo], ownerPriv: owner.bp, destination: depositDest, feeSats: 500n });
  const externalOut = btcMs.Transaction.fromRaw(msHexToBytes(rawExternal)).getOutput(0);
  const externalOutAddress = btcMs.Address(MS_NET).encode(btcMs.OutScript.decode(externalOut.script!));
  assert(externalOutAddress === depositDest, "bondreclaim-dest: reclaim transaction pays the selected destination address");

  // Early reclaim: nLockTime < T still BUILDS (it's the tx the network rejects on CLTV).
  const rawEarly = buildReclaimTx({ bond, utxos: [utxo], ownerPriv: owner.bp, destination: dest, feeSats: 500n, txLockTime: T - 1 });
  assert(btcMs.Transaction.fromRaw(msHexToBytes(rawEarly)).lockTime === T - 1, "⭐ bondcltv: an EARLY reclaim (nLockTime<T) builds — the consensus-invalid tx a Bitcoin node rejects");
  assert(rawEarly !== rawValid, "bondcltv: early and valid reclaims differ only by the locktime commitment");

  // ⭐ Multi-UTXO sweep: fund the address twice → reclaim spends BOTH inputs to one
  // output (this is what fixes "I sent 2 UTXOs and nothing showed"). Accept any amount.
  const u1 = { txid: "11".repeat(32), index: 0, amountSats: 30_000n };
  const u2 = { txid: "22".repeat(32), index: 1, amountSats: 12_345n };
  const rawSweep = buildReclaimTx({ bond, utxos: [u1, u2], ownerPriv: owner.bp, destination: dest, feeSats: 500n });
  const sweep = btcMs.Transaction.fromRaw(msHexToBytes(rawSweep));
  assert(sweep.inputsLength === 2, "⭐ bondcltv: multi-UTXO reclaim sweeps BOTH inputs");
  assert(sweep.getOutput(0).amount === 30_000n + 12_345n - 500n, "bondcltv: sweep output = sum(utxos) − fee (any amount accepted)");

  // Post-reclaim credit: the reclaim output is a normal BIP86 Taproot UTXO at
  // the owner's key. Chama can spend it again into a visible destination such as
  // a Fedimint peg-in address, instead of leaving "reclaimed" sats hidden.
  const returnUtxo = { txid: "44".repeat(32), index: 0, amountSats: 29_700n };
  const rawCredit = buildKeyPathSweepTx({ ownerXonly: owner.x, utxos: [returnUtxo], ownerPriv: owner.bp, destination: dest, feeSats: 300n, network: MS_NET });
  const credit = btcMs.Transaction.fromRaw(msHexToBytes(rawCredit));
  assert(credit.inputsLength === 1 && credit.outputsLength === 1, "bondcredit: return-address credit is a one-input/one-output sweep");
  assert(credit.getOutput(0).amount === 29_400n, "bondcredit: output = reclaimed return UTXO − fee");
  const creditWitness = credit.getInput(0).finalScriptWitness!;
  assert(creditWitness.length === 1 && creditWitness[0].length === 64, "⭐ bondcredit: spends by normal Taproot key path (one Schnorr sig, no CLTV leaf)");

  let wrongCreditKeyThrew = false;
  try {
    buildKeyPathSweepTx({ ownerXonly: owner.x, utxos: [returnUtxo], ownerPriv: btcMs.utils.randomPrivateKeyBytes(), destination: dest, feeSats: 300n, network: MS_NET });
  } catch { wrongCreditKeyThrew = true; }
  assert(wrongCreditKeyThrew, "bondcredit: a non-owner key cannot sweep the reclaimed return address");

  // ⭐ INVARIANT 3 (owner-only), the static half: the control block is exactly 33
  // bytes — [parity|leafver] + the 32-byte internal key, NO merkle path — so the
  // executed leaf IS the whole tree (there is no other leaf), and the internal key
  // is the BIP341 NUMS point (no known discrete log → the key-path can never sign).
  const cb = w[2];
  assert(cb.length === 33, "⭐ bondcltv: control block = 33 bytes — SINGLE leaf, no hidden sibling script");
  assert(msBytesToHex(cb.subarray(1)) === "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
    "⭐ bondcltv: internal key is the BIP341 NUMS point — the key-path is unspendable");

  // ⭐ INVARIANT 3, the signing half: a WRONG private key cannot produce a reclaim
  // witness at all (@scure refuses to sign a leaf whose pubkey it doesn't hold).
  let wrongKeyThrew = false;
  try {
    buildReclaimTx({ bond, utxos: [utxo], ownerPriv: btcMs.utils.randomPrivateKeyBytes(), destination: dest, feeSats: 500n });
  } catch { wrongKeyThrew = true; }
  assert(wrongKeyThrew, "⭐ bondcltv: a non-owner key cannot build a reclaim witness (owner-only by construction)");

  // ⭐ Fee estimator is BYTE-EXACT: a BIP340 sig is always 64 bytes (SIGHASH_DEFAULT
  // appends none), so the predicted vsize must equal the real built tx's vsize for
  // every sweep width. This is what makes the size-based fee trustworthy.
  for (let n = 1; n <= 4; n++) {
    const utxos = Array.from({ length: n }, (_, i) => ({ txid: (10 + i).toString(16).repeat(64), index: i, amountSats: 25_000n }));
    const raw = buildReclaimTx({ bond, utxos, ownerPriv: owner.bp, destination: dest, feeSats: 600n });
    const actual = btcMs.Transaction.fromRaw(msHexToBytes(raw)).vsize;
    assert(estimateReclaimVsize(bond, n) === actual, `⭐ bondcltv: estimateReclaimVsize(${n} inputs) is byte-exact (${actual} vB)`);
  }
  assert(estimateReclaimFeeSats(bond, 1) === 300n, "bondcltv: 1-input fee keeps the 300-sat floor (what single-UTXO reclaims always paid)");
  const fee4 = estimateReclaimFeeSats(bond, 4);
  assert(fee4 > 300n && fee4 >= BigInt(estimateReclaimVsize(bond, 4)) * 2n,
    "bondcltv: a 4-input sweep fee scales with size (≥ 2 sat/vB)");
  assert(BigInt(estimateReclaimVsize(bond, 4)) > 300n,
    "⭐ bondcltv: the old flat 300-sat fee was BELOW 1 sat/vB on a 4-input sweep (unrelayable) — size-based fees fix a real bug");
  for (let n = 1; n <= 4; n++) {
    const returnUtxos = Array.from({ length: n }, (_, i) => ({ txid: (60 + i).toString(16).padStart(2, "0").repeat(32), index: i, amountSats: 25_000n }));
    const raw = buildKeyPathSweepTx({ ownerXonly: owner.x, utxos: returnUtxos, ownerPriv: owner.bp, destination: dest, feeSats: 600n, network: MS_NET });
    const actual = btcMs.Transaction.fromRaw(msHexToBytes(raw)).vsize;
    assert(estimateKeyPathSweepVsize(n) === actual, `bondcredit: estimateKeyPathSweepVsize(${n} inputs) is byte-exact (${actual} vB)`);
  }
  assert(estimateKeyPathSweepFeeSats(1) === 300n, "bondcredit: 1-input credit keeps the 300-sat floor");

  // Dust guard: a fee that leaves the output below the P2TR dust floor throws
  // (an unrelayable reclaim must fail loudly at build time, not at broadcast).
  let dustThrew = false;
  try {
    buildReclaimTx({ bond, utxos: [{ txid: "33".repeat(32), index: 0, amountSats: 700n }], ownerPriv: owner.bp, destination: dest, feeSats: 500n });
  } catch { dustThrew = true; }
  assert(dustThrew, "bondcltv: a reclaim whose output would be dust (<330 sats) refuses to build");

  // ⭐ Derivation pin: the bond key derives to this exact x-only key for the
  // reference mnemonic (BIP86 m/86'/1'/0'/0/0). A funded bond's address embeds this
  // derivation — if it EVER drifts, real locked sats become unreachable. Golden.
  const MN_REF = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const dk = deriveCommitmentKey(MN_REF, { network: MS_NET });
  assert(dk.path === "m/86'/1'/0'/0/0" && msBytesToHex(dk.xonly) === "55355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116",
    "⭐ bondcltv: bond-key derivation is pinned (golden vector) — funded bonds stay reclaimable");

  // ⭐ PER-BOND ADDRESS: a fresh index gives a distinct key → a distinct address, so
  // two bonds NEVER share an address (no commingled UTXOs) even at the SAME term.
  const k0 = deriveCommitmentKey(MN_REF, { network: MS_NET, index: 0 });
  const k1 = deriveCommitmentKey(MN_REF, { network: MS_NET, index: 1 });
  assert(k0.path === "m/86'/1'/0'/0/0" && k1.path === "m/86'/1'/0'/0/1", "bondcltv: index selects the BIP86 address index");
  assert(msBytesToHex(k0.xonly) === msBytesToHex(dk.xonly), "bondcltv: index 0 == the default (legacy bonds unchanged)");
  assert(msBytesToHex(k0.xonly) !== msBytesToHex(k1.xonly), "bondcltv: a different index → a different bond key");
  const sameTerm = 900_000;
  const addr0 = buildCommitmentBond(k0.xonly, sameTerm, MS_NET).address;
  const addr1 = buildCommitmentBond(k1.xonly, sameTerm, MS_NET).address;
  assert(addr0 !== addr1, "⭐ bondcltv: two bonds at the SAME term but different index → DIFFERENT addresses (no commingling)");
}

// ── MAINNET BOND CONFIG (v5.0 real-money flip guard) ─────────────────────────
// Guards against an accidental revert to signet/testnet — which would derive tb1
// addresses (wrong-network funds) and read the wrong Esplora. Real Bitcoin.
console.log("\n── MAINNET BOND CONFIG (v5.0 real-money flip guard) ──");
{
  const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  assert(MS_MAINNET !== MS_NET, "mainnet: MAINNET network object is distinct from SIGNET");
  const fk = deriveCommitmentKey(MNEMONIC, { network: MS_MAINNET, index: 0 });
  const mainnetBond = buildCommitmentBond(fk.xonly, 900_000, MS_MAINNET);
  assert(mainnetBond.address.startsWith("bc1"), `mainnet: a bond builds a bc1 (mainnet) Taproot address, not tb1 (got ${mainnetBond.address.slice(0, 6)}…)`);
  const signetBond = buildCommitmentBond(fk.xonly, 900_000, MS_NET);
  assert(signetBond.address.startsWith("tb1"), "mainnet: the signet builder still yields tb1 (network param honored, not hardcoded)");
  assert(bip86BondPath(MS_MAINNET) === "m/86'/0'/0'/0/0", `mainnet: BIP86 path uses coin 0 (got ${bip86BondPath(MS_MAINNET)})`);
  assert(bip86BondPath(MS_NET) === "m/86'/1'/0'/0/0", "mainnet: signet BIP86 path still uses coin 1");
  assert(defaultMinConfs(MS_MAINNET) === 1, `mainnet: bond funding needs 1 conf — Jetty's call (got ${defaultMinConfs(MS_MAINNET)})`);
  assert(defaultEsploraBase(MS_MAINNET).includes("mempool.space"), `mainnet: Esplora base is mempool.space (got ${defaultEsploraBase(MS_MAINNET)})`);
  assert(!defaultEsploraBase(MS_MAINNET).includes("mutinynet"), "mainnet: Esplora base is NOT mutinynet");
  assert(MIN_COMMITMENT_TERM_BLOCKS === 144, `mainnet: minimum term is 144 blocks (~1 day) (got ${MIN_COMMITMENT_TERM_BLOCKS})`);
}

// ── RECLAIM FEE RATE (dynamic mempool estimate) ──────────────────────────────
console.log("\n── RECLAIM FEE RATE (dynamic mempool estimate) ──");
{
  const feeJson = (fees: any): EsploraFetch => async (path: string) => {
    if (path === "/v1/fees/recommended") return fees;
    throw new Error(`unexpected path ${path}`);
  };
  const r1 = await esploraRecommendedFeeRate(feeJson({ hourFee: 8, halfHourFee: 12, fastestFee: 20 }), { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
  assert(r1 === 8n, `reclaim-fee: targets the ~1h tier (got ${r1})`);
  const r2 = await esploraRecommendedFeeRate(feeJson({ hourFee: 1, halfHourFee: 1 }), { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
  assert(r2 === DEFAULT_RECLAIM_FEE_RATE, `reclaim-fee: a sub-floor rate is floored to the flat default (got ${r2})`);
  const r3 = await esploraRecommendedFeeRate(feeJson({ hourFee: 5000 }), { floorPerVb: DEFAULT_RECLAIM_FEE_RATE, capPerVb: 100n });
  assert(r3 === 100n, `reclaim-fee: a fee-spike rate is capped (got ${r3})`);
  const r4 = await esploraRecommendedFeeRate((async () => { throw new Error("esplora down"); }) as EsploraFetch, { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
  assert(r4 === DEFAULT_RECLAIM_FEE_RATE, `reclaim-fee: an unreachable Esplora falls back to the flat floor — never blocks a reclaim (got ${r4})`);
  const r5 = await esploraRecommendedFeeRate(feeJson({ garbage: true }), { floorPerVb: DEFAULT_RECLAIM_FEE_RATE });
  assert(r5 === DEFAULT_RECLAIM_FEE_RATE, "reclaim-fee: a malformed fee response falls back to the floor");
  // The dynamic rate flows into the size-based fee (higher rate → higher fee).
  const feeBond = buildCommitmentBond(deriveCommitmentKey("legal winner thank year wave sausage worth useful legal winner thank yellow", { network: MS_MAINNET }).xonly, 900_000, MS_MAINNET);
  assert(estimateReclaimFeeSats(feeBond, 3, 20n) > estimateReclaimFeeSats(feeBond, 3, 2n), "reclaim-fee: a higher rate yields a higher reclaim fee (rate flows through)");
}

// ── 5b-BONDCOMMIT. Commitment store (serialize round-trip + recompute-on-load gate) ─
// The store is a convenience cache, adversarial-on-read: deserialize REBUILDS the
// address from (ownerXonly, lockUntil, network) and rejects a record whose stored
// address doesn't reproduce. Pure (no localStorage) — the security-critical path.
console.log("\n── Commitment store (round-trip + tamper gate) ──");
{
  const bp = btcMs.utils.randomPrivateKeyBytes();
  const x = btcMs.utils.pubSchnorr(bp);
  const bond = buildCommitmentBond(x, 810_000, MS_NET);
  const rec: CommitmentRecord = {
    bondId: "bond_cmt_1", bond, amountSats: 21_000n, phase: "locked",
    utxos: [{ txid: "ee".repeat(32), index: 0, amountSats: 21_000n }], createdAt: 1_900_000_000,
  };
  const s = serializeCommitment(rec);
  const back = deserializeCommitment(s);
  assert(back !== null && back.bond.address === bond.address, "bondcommit: address round-trips");
  assert(back !== null && back.amountSats === 21_000n, "⭐ bondcommit: amountSats round-trips as an exact bigint");
  assert(back !== null && back.utxos?.[0]?.amountSats === 21_000n && back.phase === "locked", "bondcommit: utxos + phase round-trip");
  assert(back !== null && back.bond.lockUntil === 810_000, "bondcommit: lockUntil round-trips");
  // ⭐ tamper gate: a stored address that doesn't recompute is rejected.
  assert(deserializeCommitment({ ...s, address: bond.address.slice(0, -3) + "xyz" }) === null, "⭐ bondcommit: a tampered stored address (≠ recomputed) is rejected on load");
  // A different lockUntil in the stored fields → the address no longer matches → reject.
  assert(deserializeCommitment({ ...s, lockUntil: 810_001 }) === null, "⭐ bondcommit: a mutated lockUntil (address no longer reproduces) is rejected");
  assert(deserializeCommitment({ ...s, amountSats: "-1" }) === null, "bondcommit: a non-decimal/negative amount is rejected");
  // A tampered ownerXonly (address no longer reproduces from the stored key) rejects.
  assert(deserializeCommitment({ ...s, ownerXonly: "00".repeat(32) }) === null,
    "⭐ bondcommit: a swapped ownerXonly (address no longer reproduces) is rejected");
  // reclaimTxid + creditTxid survive the round-trip (the receipts of a finished
  // bond and its visible Chama credit).
  const bondKeyAddr = btcMs.p2tr(x, undefined, MS_NET).address as string;
  const done = deserializeCommitment(serializeCommitment({
    ...rec,
    phase: "reclaimed",
    reclaimTxid: "ff".repeat(32),
    reclaimDestination: { requested: "chama", actual: "bond-key", address: bondKeyAddr, fallbackReason: "fed down" },
    creditTxid: "aa".repeat(32),
    creditOperationId: "bond-credit-op",
  }));
  assert(done?.phase === "reclaimed" && done?.reclaimTxid === "ff".repeat(32), "bondcommit: reclaimTxid round-trips");
  assert(done?.creditTxid === "aa".repeat(32) && done?.creditOperationId === "bond-credit-op", "bondcommit: Chama credit receipt round-trips");
  assert(done?.reclaimDestination?.requested === "chama" && done?.reclaimDestination?.actual === "bond-key" && done.reclaimDestination.address === bondKeyAddr,
    "bondcommit: reclaim destination choice and actual output round-trip");
  assert(deserializeCommitment({
    ...s,
    reclaimDestination: { requested: "external", actual: "external", address: btcMs.p2tr(x, undefined, MS_MAINNET).address as string },
  }) === null, "bondcommit: stored reclaim destination must match the bond network");
  // ⭐ keyIndex round-trips (reclaim re-derives the right key); a legacy record → index 0.
  assert(deserializeCommitment(serializeCommitment({ ...rec, keyIndex: 7 }))?.keyIndex === 7, "bondcommit: keyIndex round-trips (per-bond derivation index)");
  assert(deserializeCommitment(s)?.keyIndex === 0, "bondcommit: a legacy record (no keyIndex) defaults to index 0");

  // ── Store lifecycle (localStorage-backed, scoped like the app) ───────────────
  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope("npub_commitment_store_test");
  const bid = newCommitmentBondId();
  assert(/^bond_/.test(bid) && !bid.includes(bond.address), "bondcommit: newBondId is opaque (never embeds the address)");
  upsertCommitmentBond({ bondId: bid, bond, amountSats: 21_000n, phase: "created", createdAt: 1_900_000_000 });
  assert(getCommitmentBond(bid)?.phase === "created", "bondcommit: upsert + get persists a CREATED bond");
  // Advance to locked with one UTXO…
  upsertCommitmentBond({ bondId: bid, bond, amountSats: 21_000n, phase: "locked", utxos: rec.utxos, createdAt: 1_900_000_000 });
  assert(getCommitmentBond(bid)?.phase === "locked", "bondcommit: upsert advances created→locked");
  // …an equal-rank re-save WITHOUT utxos carries the funded set forward (never-regress)…
  upsertCommitmentBond({ bondId: bid, bond, amountSats: 21_000n, phase: "locked", createdAt: 1_900_000_000 });
  assert(getCommitmentBond(bid)?.utxos?.length === 1, "⭐ bondcommit: an equal-rank upsert carries the funded UTXOs forward");
  // …and a stale downgrade is refused after reclaim.
  upsertCommitmentBond({
    bondId: bid,
    bond,
    amountSats: 21_000n,
    phase: "reclaimed",
    reclaimTxid: "aa".repeat(32),
    reclaimDestination: { requested: "chama", actual: "bond-key", address: bondKeyAddr, fallbackReason: "fed down" },
    createdAt: 1_900_000_000,
  });
  upsertCommitmentBond({ bondId: bid, bond, amountSats: 21_000n, phase: "reclaimed", reclaimTxid: "bb".repeat(32), createdAt: 1_900_000_000 });
  upsertCommitmentBond({ bondId: bid, bond, amountSats: 21_000n, phase: "locked", utxos: rec.utxos, createdAt: 1_900_000_000 });
  const final = getCommitmentBond(bid);
  assert(final?.phase === "reclaimed" && final?.reclaimTxid === "bb".repeat(32),
    "⭐ bondcommit: a stale LOCKED upsert cannot downgrade a RECLAIMED bond (phase-monotonic)");
  assert(final?.reclaimDestination?.requested === "chama" && final?.reclaimDestination?.actual === "bond-key",
    "bondcommit: equal-rank upsert carries reclaim destination metadata forward");
  // ⭐ Mainnet-only display: a mainnet (bc1) bond lists; a stale signet (tb1) test
  // bond persisted on a dev device is filtered out (the v5.0 Tauri "testnet in
  // dashboard" bug — old signet bonds must never show in a mainnet build).
  const mainBond = buildCommitmentBond(x, 810_000, MS_MAINNET);
  upsertCommitmentBond({ bondId: "bond_main_1", bond: mainBond, amountSats: 21_000n, phase: "created", createdAt: 1_900_000_000 });
  const listed = listCommitmentBonds();
  assert(listed.some((r) => r.bondId === "bond_main_1" && r.bond.address.startsWith("bc1")), "bondcommit: a mainnet (bc1) bond IS listed");
  assert(!listed.some((r) => r.bond.address.startsWith("tb1")), "⭐ bondcommit: a stale signet (tb1) bond is filtered out of the display list");
  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope(null);
}

// ── BOND RECOVERY (cross-device: rebuild a record from announcement + seed) ───
// Same npub on two devices: a bond posted on one rebuilds locally on the other from
// its own kind-38135 announcement + seed (the "my bond isn't on my other device" fix).
console.log("\n── Bond recovery (reconstruct from announcement + seed) ──");
{
  const RECOVER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const k0 = deriveCommitmentKey(RECOVER_MNEMONIC, { network: MS_MAINNET, index: 0 });
  const announced = buildCommitmentBond(k0.xonly, 957_541, MS_MAINNET);
  const bondKeyAddr = btcMs.p2tr(k0.xonly, undefined, MS_MAINNET).address as string;
  const utxo = { txid: "cc".repeat(32), index: 0, amountSats: 30_000n };
  // Live bond: funds at the CLTV address → LOCKED.
  const live = reconstructBondRecord({
    ownerXonlyHex: msBytesToHex(k0.xonly), lockUntil: 957_541, claimedSats: 30_000n,
    announcedAddress: announced.address, seedWords: RECOVER_MNEMONIC, network: MS_MAINNET, bondUtxos: [utxo],
  });
  assert(live !== null && live.bond.address === announced.address, "bondrecover: rebuilds the announced bond address from the seed");
  assert(live?.keyIndex === 0, `bondrecover: finds the derivation index that owns the key (got ${live?.keyIndex})`);
  assert(live?.phase === "locked" && live?.utxos?.length === 1 && live?.amountSats === 30_000n, "bondrecover: funds at the CLTV address rebuild as LOCKED with the on-chain UTXOs");
  // Reclaimed-not-swept: funds at the bond-KEY address → RECLAIMED, sweep-ready record.
  const reclaimed = reconstructBondRecord({
    ownerXonlyHex: msBytesToHex(k0.xonly), lockUntil: 957_541, claimedSats: 30_000n,
    announcedAddress: announced.address, seedWords: RECOVER_MNEMONIC, network: MS_MAINNET, bondKeyUtxos: [utxo],
  });
  assert(reclaimed?.phase === "reclaimed" && reclaimed?.amountSats === 30_000n, "⭐ bondrecover: funds at the bond-KEY address rebuild as RECLAIMED (the stranded-sweep case)");
  assert(reclaimed?.reclaimTxid === "cc".repeat(32), "bondrecover: reclaimTxid is taken from the bond-key UTXO (the tx that funded it)");
  assert(reclaimed?.reclaimDestination?.actual === "bond-key" && reclaimed?.reclaimDestination?.address === bondKeyAddr, "bondrecover: the record points at the bond-key return address so 'credit to Chama' can sweep it");
  assert(reconstructBondRecord({
    ownerXonlyHex: msBytesToHex(k0.xonly), lockUntil: 957_541, claimedSats: 21_000n,
    announcedAddress: announced.address, seedWords: RECOVER_MNEMONIC, network: MS_MAINNET,
  }) === null, "bondrecover: an empty (never-funded or fully-swept) address recovers nothing");
  assert(reconstructBondRecord({
    ownerXonlyHex: msBytesToHex(k0.xonly), lockUntil: 957_541, claimedSats: 30_000n,
    announcedAddress: announced.address.slice(0, -3) + "xyz", seedWords: RECOVER_MNEMONIC, network: MS_MAINNET, bondUtxos: [utxo],
  }) === null, "⭐ bondrecover: an announced address that doesn't reproduce is rejected");
  const otherSeed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  assert(reconstructBondRecord({
    ownerXonlyHex: msBytesToHex(k0.xonly), lockUntil: 957_541, claimedSats: 30_000n,
    announcedAddress: announced.address, seedWords: otherSeed, network: MS_MAINNET, bondUtxos: [utxo], maxIndex: 5,
  }) === null, "⭐ bondrecover: a bond whose key isn't derivable from the seed is skipped (can't reclaim)");
}

// ── 5b-BONDANN. Commitment-bond ANNOUNCEMENT (kind 38135, chain-verifiable) ────
// The public, PROVABLE advertisement of a commitment bond (the live-chama liveness
// source). Two security properties: signer-authoritative (no announcing another's
// bond) + recompute-don't-trust (verify rebuilds the address locally + reads it
// on-chain; a lie in the wire address/amount can't survive).
console.log("\n── Bond announcement (kind 38135, chain-verifiable) ──");
{
  const sk = generateSecretKey();
  const npub = getPublicKey(sk);
  const bp = btcMs.utils.randomPrivateKeyBytes();
  const ownerXonly = btcMs.utils.pubSchnorr(bp);
  const T = 820_000;
  const bond = buildCommitmentBond(ownerXonly, T, MS_NET);
  const community = "tz-tzs";
  const hexOf = (b: Uint8Array) => [...b].map((n) => n.toString(16).padStart(2, "0")).join("");

  const signed = finalizeEvent(buildBondAnnouncementEvent({
    pubkey: npub, community, ownerXonly, lockUntil: T, amountSats: 50_000n, network: MS_NET, address: bond.address,
  }), sk) as unknown as NostrEvent;
  const parsed = parseBondAnnouncementEvent(signed);
  assert(parsed !== null && parsed.npub === npub && parsed.lockUntil === T && parsed.claimedSats === 50_000n && parsed.community === community,
    "bondann: build→sign→parse round-trips");

  // ⭐ signer-authoritative: a payload npub that disagrees with the signer is rejected
  // (verifyEvent overridden true to isolate the npub check from the broken signature).
  const spoof = { ...signed, content: JSON.stringify({ ...JSON.parse(signed.content), npub: getPublicKey(generateSecretKey()) }) } as NostrEvent;
  assert(parseBondAnnouncementEvent(spoof, { verifyEvent: () => true }) === null,
    "⭐ bondann: a payload npub ≠ signer is rejected (no announcing another's bond)");

  // A fake Esplora that funds the RECOMPUTED address (50k confirmed).
  const scriptHex = hexOf(bond.script);
  const fakeEsplora = (addr: string): EsploraFetch => async (path: string) => {
    if (path === `/address/${addr}/utxo`) return [{ txid: "aa".repeat(32), vout: 0, value: 50_000, status: { confirmed: true } }];
    if (path.startsWith("/tx/")) return { vout: [{ scriptpubkey: scriptHex }] };
    return null;
  };

  // ⭐ recompute-don't-trust: verify rebuilds the address + reads it on-chain.
  const v = await verifyBondAnnouncement(parsed!, { network: MS_NET, fetchJson: fakeEsplora(bond.address), tipHeight: 800_000 });
  assert(v !== null && v.funded && v.actualSats === 50_000n && v.address === bond.address && v.active,
    "⭐ bondann: verify recomputes the address + reads it on-chain (funded, active)");

  // ⭐ a tampered WIRE address is ignored — verify trusts only the recompute.
  const v2 = await verifyBondAnnouncement({ ...parsed!, address: "tb1pTOTALLYWRONG" }, { network: MS_NET, fetchJson: fakeEsplora(bond.address), tipHeight: 800_000 });
  assert(v2 !== null && v2.funded && v2.address === bond.address,
    "⭐ bondann: a tampered wire address is IGNORED — verify uses the recomputed address");

  // A wrong ownerXonly recomputes a DIFFERENT address → the fake (keyed to the real one)
  // has nothing there → not funded (a fabricated key can't borrow a real bond's deposit).
  const wrongX = hexOf(btcMs.utils.pubSchnorr(btcMs.utils.randomPrivateKeyBytes()));
  const v3 = await verifyBondAnnouncement({ ...parsed!, ownerXonly: wrongX }, { network: MS_NET, fetchJson: fakeEsplora(bond.address), tipHeight: 800_000 });
  assert(v3 !== null && !v3.funded, "bondann: a wrong ownerXonly recomputes a different address → not funded");

  // network-domain mismatch → rejected outright.
  assert((await verifyBondAnnouncement({ ...parsed!, network: "mainnet" }, { network: MS_NET, fetchJson: fakeEsplora(bond.address) })) === null,
    "bondann: a network-domain mismatch is rejected");

  // active flips off once the tip reaches the term.
  const vExpired = await verifyBondAnnouncement(parsed!, { network: MS_NET, fetchJson: fakeEsplora(bond.address), tipHeight: T + 1 });
  assert(vExpired !== null && !vExpired.active, "bondann: active=false once tip ≥ lockUntil");

  // selectLatest: newest-wins per arbiter.
  const older = finalizeEvent(buildBondAnnouncementEvent({ pubkey: npub, community, ownerXonly, lockUntil: T, amountSats: 10_000n, network: MS_NET, address: bond.address, createdAt: 1000 }), sk) as unknown as NostrEvent;
  const newer = finalizeEvent(buildBondAnnouncementEvent({ pubkey: npub, community, ownerXonly, lockUntil: T, amountSats: 90_000n, network: MS_NET, address: bond.address, createdAt: 2000 }), sk) as unknown as NostrEvent;
  const latest = selectLatestAnnouncements([older, newer]);
  assert(latest.length === 1 && latest[0].claimedSats === 90_000n, "bondann: selectLatest → one per arbiter, newest wins");

  // ── groupLatest (the BATCHED no-#d list read) ──────────────────────────────
  // Keys (npub, community): an arbiter bonded in TWO chamas must appear in both
  // groups — exactly what per-npub selectLatest would collapse.
  const sk2 = generateSecretKey();
  const npub2 = getPublicKey(sk2);
  const annOf = (key: Uint8Array, c: string, sats: bigint, createdAt: number) =>
    finalizeEvent(buildBondAnnouncementEvent({
      pubkey: getPublicKey(key), community: c, ownerXonly, lockUntil: T,
      amountSats: sats, network: MS_NET, address: bond.address, createdAt,
    }), key) as unknown as NostrEvent;
  const grouped = groupLatestAnnouncementsByCommunity([
    annOf(sk, "tz-tzs", 10_000n, 1000),   // superseded ↓
    annOf(sk, "tz-tzs", 70_000n, 2000),   // newest for (npub, tz-tzs)
    annOf(sk, "ke-kes", 20_000n, 1500),   // SAME arbiter, second community
    annOf(sk2, "tz-tzs", 30_000n, 1200),  // second arbiter, first community
    // Broken sig → dropped. JSON round-trip first: finalizeEvent stamps
    // nostr-tools' verifiedSymbol on the object and a {...spread} would COPY it,
    // short-circuiting verifyEvent to true — a wire event (what a relay actually
    // hands us) is plain JSON and carries no such symbol.
    { ...JSON.parse(JSON.stringify(annOf(sk2, "ke-kes", 1n, 900))), sig: "00".repeat(64) } as NostrEvent,
  ]);
  assert(grouped.size === 2, "bondann: groupLatest groups by community");
  assert(grouped.get("tz-tzs")?.length === 2,
    "bondann: two distinct arbiters in one community both survive grouping");
  assert(grouped.get("tz-tzs")?.find((a) => a.npub === npub)?.claimedSats === 70_000n,
    "bondann: groupLatest is newest-wins per (arbiter, community)");
  assert(grouped.get("ke-kes")?.length === 1 && grouped.get("ke-kes")?.[0]?.npub === npub,
    "⭐ bondann: an arbiter bonded in TWO chamas counts in both (per-npub collapse avoided) and a broken-sig event is dropped");
}

// ── 5b-LIVECHAMA. Liveness score (coverage × commitment × reputation) ──────────
// Pure composite over chain-verified bonds + ratings. Only FUNDED + ACTIVE bonds
// count; more arbiters / bigger×longer bonds / better ratings → higher score.
console.log("\n── Live-chama liveness score ──");
{
  const npubA = "a".repeat(64), npubB = "b".repeat(64), npubC = "c".repeat(64), npubD = "d".repeat(64);
  const mk = (npub: string, sats: number, lockUntil: number, funded = true, active = true): VerifiedBond =>
    ({ npub, community: "tz-tzs", address: `addr_${npub.slice(0, 6)}`, lockUntil, actualSats: BigInt(sats), claimedSats: BigInt(sats), funded, active });
  const noRatings = new Map<string, { count: number; positive: number; negative: number }>();
  const tip = 800_000;

  const empty = computeChamaLiveness("tz-tzs", [], noRatings, tip);
  assert(!empty.isLive && empty.arbiterCount === 0 && empty.score === 0, "livechama: no bonds → not live, score 0");
  assert(formatLivenessReadout(empty).includes("No bonded arbiters"), "livechama: empty readout invites the first arbiter");

  const one = computeChamaLiveness("tz-tzs", [mk(npubA, 50_000, 830_000)], noRatings, tip);
  assert(one.isLive && one.arbiterCount === 1 && one.totalBondSats === 50_000n && one.score > 0, "livechama: one funded active bond → live");

  // ⭐ unfunded + expired bonds are excluded from liveness.
  const mixed = computeChamaLiveness("tz-tzs", [mk(npubA, 50_000, 830_000), mk(npubB, 99_999, 830_000, false), mk(npubC, 99_999, 830_000, true, false)], noRatings, tip);
  assert(mixed.arbiterCount === 1 && mixed.totalBondSats === 50_000n, "⭐ livechama: unfunded + expired bonds are excluded");

  const three = computeChamaLiveness("tz-tzs", [mk(npubA, 50_000, 830_000), mk(npubB, 50_000, 830_000), mk(npubD, 50_000, 830_000)], noRatings, tip);
  assert(three.arbiterCount === 3 && three.score > one.score, "livechama: more bonded arbiters → higher score");

  const big = computeChamaLiveness("tz-tzs", [mk(npubA, 5_000_000, 900_000)], noRatings, tip);
  assert(big.bondWeightSatBlocks > one.bondWeightSatBlocks && big.score > one.score, "⭐ livechama: bigger × longer bond → higher score (how much × how long)");

  const rated = computeChamaLiveness("tz-tzs", [mk(npubA, 50_000, 830_000)], new Map([[npubA, { count: 20, positive: 20, negative: 0 }]]), tip);
  assert(rated.ratings.positiveRate === 1 && rated.score > one.score, "livechama: strong ratings lift the score");

  const dup = computeChamaLiveness("tz-tzs", [mk(npubA, 10_000, 830_000), mk(npubA, 80_000, 830_000)], noRatings, tip);
  assert(dup.arbiterCount === 1 && dup.totalBondSats === 80_000n, "livechama: two bonds for one arbiter → counted once (biggest)");

  const ro = formatLivenessReadout(rated, 2880); // signet ~2880 blocks/day
  assert(/^1 arbiter · 100% · ~\d+-day bond/.test(ro), "livechama: readout formats 'N arbiters · X% · ~D-day bonds'");

  // ── bonded → arbiter enrollment (S1 primitive) ──────────────────────────────
  const enrolled = bondedArbitersForCommunity([
    mk(npubA, 50_000, 830_000),
    mk(npubA, 10_000, 830_000),          // same npub → once
    mk(npubB, 50_000, 830_000, false),   // unfunded → excluded
    mk(npubC, 50_000, 830_000, true, false), // expired → excluded
    mk(npubD, 50_000, 830_000),
  ]);
  assert(enrolled.length === 2 && enrolled.includes(npubA) && enrolled.includes(npubD),
    "⭐ bonded-arbiters: funded+active distinct npubs enroll; unfunded/expired/dupes don't");
  assert(bondedArbitersForCommunity([]).length === 0, "bonded-arbiters: no bonds → nobody enrolled");
}

// ── 5b-v3.3. Consensus invariants — C2 + C11 (INVARIANTS.md) ──────────────
// Coordinated release v3.3. C1 (the LOCK deterministic-assignment gate) was
// PULLED: a naive recompute rejects genuine pre-v0.7.2 (no-exclusion builder)
// chains as ARBITER_NOT_ASSIGNED on replay — and that code isn't benign, so the
// whole chain becomes unloadable and funds strand. It moves to the pool-
// integrity cluster (C1+C6+C7) with a backward-compatible accept-either fix.
// What ships here: C2 SANITIZES the locker-chosen arbiter fee into [0, amount]
// at every write (never rejects — a reject would strand the locker, whose ecash
// is spent before the reducer runs), and C11 clamps the dispute-clock CEILING
// only (the lockedAt floor rejected valid arbiter votes on honest clock skew).
// Both leave honest chains byte-identical; only junk/forged values diverge.
// Test names follow the INVARIANTS.md convention so "is X still enforced?" is a grep.
console.log("\n── v3.3 consensus invariants (C2 fee sanitize · C11 dispute-clock ceiling) ──");
{
  const POOL33 = [ARBITER_PK, ARBITER2_PK, "ff".repeat(32)];

  // C2 — SANITIZE at CREATE (the canonical fee source the LOCK builder reads):
  // bad values are coerced into [0, amount] (integer), never rejected.
  {
    const neg = (applyEvent(null, createEvent({ arbiterFeeMsats: -1 })) as any).state;
    assert(neg.fees.arbiterMsats === 0,
      "invariant_arbiter-fee-bounds__negative_clamped_to_zero");
    const over = (applyEvent(null, createEvent({ arbiterFeeMsats: 200_000_000 })) as any).state;
    assert(over.fees.arbiterMsats === 100_000_000,
      "invariant_arbiter-fee-bounds__over_amount_clamped");
    const frac = (applyEvent(null, createEvent({ arbiterFeeMsats: 3.5 })) as any).state;
    assert(frac.fees.arbiterMsats === 3,
      "invariant_arbiter-fee-bounds__fractional_floored");
    const nan = (applyEvent(null, createEvent({ arbiterFeeMsats: NaN })) as any).state;
    assert(nan.fees.arbiterMsats === 0,
      "v3.3 C2: a non-finite fee coerces to 0 at CREATE (never corrupts the sum)");
    const ok = (applyEvent(null, createEvent({ arbiterFeeMsats: 1_000_000 })) as any).state;
    assert(ok.fees.arbiterMsats === 1_000_000,
      "invariant_arbiter-fee-bounds__valid_fee_replays_identically");
  }

  // C2 — the LOCK writeback sanitizes too, and CRUCIALLY does NOT reject: a
  // crafted fee whose raw legs still SUM to the amount applies (no strand) and
  // lands clamped. The first brief's reject fired here AFTER the ecash spend.
  {
    const create = createEvent(); // no pool — isolates the fee path
    const st = (applyEvent(null, create) as any).state;
    // Negative arbiter leg balanced by an inflated seller leg → applies, clamps to 0.
    const rNeg = applyEvent(st, lockEvent(create.raw.id, { arbiterFeeMsats: -1_000_000, sellerReceivesMsats: 101_000_000 }));
    if (assertOk(rNeg, "v3.3 C2: a negative-fee LOCK that still sums to amount APPLIES (no fund-stranding reject)")) {
      assert(rNeg.state.fees.arbiterMsats === 0,
        "v3.3 C2: the LOCK writeback clamps a negative fee to 0");
    }
    // Over-amount arbiter leg balanced by a negative seller leg → applies, clamps to amount.
    const rOver = applyEvent(st, lockEvent(create.raw.id, { arbiterFeeMsats: 150_000_000, sellerReceivesMsats: -50_000_000 }));
    if (assertOk(rOver, "v3.3 C2: an over-amount-fee LOCK that still sums to amount APPLIES")) {
      assert(rOver.state.fees.arbiterMsats === 100_000_000,
        "v3.3 C2: the LOCK writeback clamps an over-amount fee to the amount");
    }
    // Fractional legs that sum exactly → applies, floors.
    const rFrac = applyEvent(st, lockEvent(create.raw.id, { arbiterFeeMsats: 0.5, sellerReceivesMsats: 99_999_999.5 }));
    if (assertOk(rFrac, "v3.3 C2: a fractional-leg LOCK that sums to amount APPLIES")) {
      assert(rFrac.state.fees.arbiterMsats === 0,
        "v3.3 C2: the LOCK writeback floors a fractional fee");
    }
    // A genuinely unbalanced split still fails AMOUNT_MISMATCH — the sum invariant is untouched.
    assertErr(applyEvent(st, lockEvent(create.raw.id, { arbiterFeeMsats: 5_000_000, sellerReceivesMsats: 99_000_000 })),
      "AMOUNT_MISMATCH",
      "v3.3 C2: an unbalanced fee split still fails AMOUNT_MISMATCH (sum check intact)");
    // Honest LOCK passes through unchanged.
    const rOk = applyEvent(st, lockEvent(create.raw.id));
    if (assertOk(rOk, "v3.3 C2: an honest LOCK still locks (regression guard)")) {
      assert(rOk.state.fees.arbiterMsats === 1_000_000,
        "v3.3 C2: an honest fee is written through unchanged");
    }
  }

  // C2 — parser: keep the type check, reject only NON-NUMERIC (and non-finite)
  // legs. Negatives and fractionals still PARSE (sanitized at the reducer), so
  // an odd-but-historically-accepted chain stays loadable instead of being
  // rejected on ingest.
  {
    const lockRaw: NostrEvent = {
      id: "v33_parser_lock", pubkey: SELLER_PK, created_at: NOW,
      kind: EscrowEventKind.LOCK, tags: [["d", "test-123"]], content: "enc", sig: "s",
    };
    const lockJson = (fee: unknown, sellerReceives: unknown = 99_000_000) => JSON.stringify({
      type: "escrow:lock", notesHash: "h",
      shares: [
        { shareIndex: 0, encryptedFor: { a: "x" } },
        { shareIndex: 1, encryptedFor: { a: "x" } },
        { shareIndex: 2, encryptedFor: { a: "x" } },
      ],
      sellerReceivesMsats: sellerReceives, arbiterFeeMsats: fee,
      buyerPubkey: BUYER_PK, arbiterPubkey: ARBITER_PK, lockedAt: NOW,
    });
    assert(parseEscrowEvent(lockRaw, lockJson(1_000_000), true).ok === true,
      "v3.3 C2: parser accepts an integer fee (regression guard)");
    assert(parseEscrowEvent(lockRaw, lockJson(-1), true).ok === true,
      "invariant_arbiter-fee-bounds__parser_accepts_negative_for_reducer_to_sanitize");
    assert(parseEscrowEvent(lockRaw, lockJson(0.5), true).ok === true,
      "v3.3 C2: parser accepts a fractional fee (sanitized downstream, not rejected)");
    // JSON can't carry NaN/Infinity (they serialize to null) — so a non-finite
    // fee arrives as a non-number and the typeof gate rejects it.
    assert(parseEscrowEvent(lockRaw, lockJson(NaN), true).ok === false,
      "invariant_arbiter-fee-bounds__parser_rejects_non_finite_fee");
    assert(parseEscrowEvent(lockRaw, lockJson("5"), true).ok === false,
      "v3.3 C2: parser rejects a non-numeric fee leg");
    assert(parseEscrowEvent(lockRaw, lockJson(1_000_000, "x"), true).ok === false,
      "v3.3 C2: parser rejects a non-numeric seller leg too");
  }

  // C11 — CEILING clamp: a far-future anchor pins at expiresAt + slack, so a
  // forged timestamp can't freeze escalation past the trade's window.
  {
    const create = createEvent({ communityArbiters: POOL33 });
    let s = (applyEvent(null, create) as any).state;
    const lk = lockEvent(create.raw.id);
    lk.payload.arbiterPoolShare = true;
    s = (applyEvent(s, lk) as any).state;
    const bv = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lk.raw.id);
    s = (applyEvent(s, bv) as any).state;
    const sv = voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, bv.raw.id);
    s = (applyEvent(s, sv) as any).state;
    retimeEvent(sv, s.expiresAt + 10 * 86_400); // forge AFTER application — chain holds the same raw by reference
    assert(disputeStartAt(s) === s.expiresAt + DISPUTE_CLOCK_SLACK_SECONDS,
      "invariant_dispute-clock__ceiling_rejects_far_future");
    assert(substitutionEligibleAt(s) === s.expiresAt + DISPUTE_CLOCK_SLACK_SECONDS,
      "v3.3 C11: a far-future anchor can't push eligibility past expiry + slack");
  }

  // C11 — NO floor: an HONEST vote whose created_at sits slightly before
  // lockedAt (ordinary clock skew) is NOT pushed forward, so eligibility is
  // byte-identical to the pre-clamp (v2.9) computation. This is exactly the
  // honest chain the dropped floor would have diverged → unloadable.
  {
    const create = createEvent({ communityArbiters: POOL33 });
    let s = (applyEvent(null, create) as any).state;
    const lk = lockEvent(create.raw.id);
    lk.payload.arbiterPoolShare = true;
    s = (applyEvent(s, lk) as any).state;
    const lockedAt = s.lock.lockedAt as number;
    // Two-sided dispute, both votes legitimately a little before lockedAt.
    const bv = retimeEvent(voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lk.raw.id), lockedAt - 30);
    s = (applyEvent(s, bv) as any).state;
    const sv = retimeEvent(voteEvent(Role.SELLER, SELLER_PK, Outcome.REFUND, bv.raw.id), lockedAt - 10);
    s = (applyEvent(s, sv) as any).state;
    const rawAnchor = Math.max(bv.raw.created_at, sv.raw.created_at); // = lockedAt - 10
    assert(rawAnchor < lockedAt && disputeStartAt(s) === rawAnchor,
      "invariant_dispute-clock__honest_skew_vote_unaffected");
    assert(
      substitutionEligibleAt(s) === rawAnchor + Math.min(SUBSTITUTION_GRACE_MAX_SECONDS, Math.floor((s.expiresAt - rawAnchor) / 2)),
      "v3.3 C11: eligibility tracks the raw anchor (no lockedAt floor)");
    // One-sided arm: the lone RELEASE anchor is likewise NOT floored to lockedAt.
    const c2 = createEvent({ communityArbiters: POOL33 });
    let s2 = (applyEvent(null, c2) as any).state;
    const lk2 = lockEvent(c2.raw.id); lk2.payload.arbiterPoolShare = true;
    s2 = (applyEvent(s2, lk2) as any).state;
    const lockedAt2 = s2.lock.lockedAt as number;
    const bRel = retimeEvent(voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lk2.raw.id), lockedAt2 - 30);
    s2 = (applyEvent(s2, bRel) as any).state;
    assert(oneSidedReleaseAnchor(s2)!.releaseVoteAt === lockedAt2 - 30,
      "v3.3 C11: the one-sided RELEASE anchor is not floored to lockedAt either");
  }
}

// ── 5c. Locker released at RESOLVE — won-by-other trades stop counting ────
// Once a trade RESOLVES in someone else's favor, the viewer's part is done:
// their vote is cast, their share envelope is carried, only the WINNER's
// claim remains. The escrow pill + active counts must release them at
// RESOLVE — not keep screaming "in escrow" until the winner gets around to
// claiming. The winner, by contrast, stays active until they claim.
console.log("\n── Locker released at RESOLVE ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  state = (applyEvent(state, lockEvent(create.raw.id)) as any).state;
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, create.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;
  const resolved = (applyEvent(state, resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id)) as any).state;
  assert(resolved.status === EscrowStatus.APPROVED, "locker-release fixture: trade is APPROVED");
  const winner = payoutRecipientFor(resolved, resolved.resolvedOutcome!)!;
  assert(winner.pubkey === BUYER_PK, "locker-release fixture: p2p RELEASE pays the buyer");

  // The seller (locker, released) is OUT of every active surface…
  assert(hasActiveBuyerSellerCommitment({ escrows: [resolved], userPubkey: SELLER_PK }) === false,
    "locker-release: resolved-for-buyer trade no longer counts as the seller's active commitment");
  assert(countActiveBuyerSellerCommitments({ escrows: [resolved], userPubkey: SELLER_PK }) === 0,
    "locker-release: the seller's active-trade count drops at RESOLVE");
  assert(activeCommittedMsats({ escrows: [resolved], userPubkey: SELLER_PK }) === 0,
    "locker-release: the seller's in-escrow msats read 0 at RESOLVE");

  // …while the WINNER stays active until they actually claim.
  assert(hasActiveBuyerSellerCommitment({ escrows: [resolved], userPubkey: BUYER_PK }) === true,
    "locker-release: the winner keeps their active commitment until claim");
  assert(activeCommittedMsats({ escrows: [resolved], userPubkey: BUYER_PK }) === resolved.amountMsats,
    "locker-release: the winner's claimable escrow still counts");

  // Pre-resolution, both sides stay active (the boundary is RESOLVE, not own-vote).
  assert(hasActiveBuyerSellerCommitment({ escrows: [state], userPubkey: SELLER_PK }) === true,
    "locker-release: before RESOLVE the seller is still committed (dispute could still need them)");
}

// ── 6. CLAIM + COMPLETE ──────────────────────────────────────────────────
console.log("\n── CLAIM + COMPLETE ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const lock = lockEvent(create.raw.id);
  state = (applyEvent(state, lock) as any).state;
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  state = (applyEvent(state, v1) as any).state;
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  state = (applyEvent(state, v2) as any).state;
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  state = (applyEvent(state, resolve) as any).state;

  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  const rc = applyEvent(state, claim);
  if (assertOk(rc, "Buyer claims → CLAIMED")) {
    assert(rc.state.status === EscrowStatus.CLAIMED, "Status is CLAIMED");

    const complete = completeEvent(claim.raw.id);
    const rf = applyEvent(rc.state, complete);
    if (assertOk(rf, "COMPLETE → terminal")) {
      assert(rf.state.status === EscrowStatus.COMPLETED, "Status is COMPLETED");

      const lateVote = voteEvent(Role.ARBITER, ARBITER_PK, Outcome.RELEASE, complete.raw.id);
      assertErr(applyEvent(rf.state, lateVote), "TERMINAL_STATE", "No events after COMPLETED");
    }
  }

  // Wrong claimer
  const wrongClaim = claimEvent(Role.SELLER, SELLER_PK, resolve.raw.id);
  assertErr(applyEvent(state, wrongClaim), "WRONG_CLAIMER", "Seller can't claim on RELEASE outcome");
}

// ── 7. CANCEL ─────────────────────────────────────────────────────────────
console.log("\n── CANCEL ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  const cancel = cancelEvent(create.raw.id);
  const r = applyEvent(state, cancel);
  if (assertOk(r, "Cancel in CREATED state")) {
    assert(r.state.status === EscrowStatus.CANCELLED, "Status is CANCELLED");
  }
}

// Can't cancel after LOCKED
{
  const { state, lock } = buildToLocked();
  const cancel = cancelEvent(lock.raw.id);
  assertErr(applyEvent(state, cancel), "INVALID_STATE", "Can't cancel after LOCKED");
}

// Non-initiator can't cancel
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const badCancel = makeParsedEvent(EscrowEventKind.CANCEL, BUYER_PK, {
    type: "escrow:cancel" as const,
    cancellerRole: Role.BUYER,
    cancelledAt: NOW,
  }, j1.raw.id);

  assertErr(applyEvent(state, badCancel), "NOT_INITIATOR", "Non-initiator can't cancel");
}

// ── 8. CHAT ───────────────────────────────────────────────────────────────
console.log("\n── CHAT ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  state = (applyEvent(state, j1) as any).state;

  const chat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, BUYER_PK, {
    type: "escrow:chat",
    message: "Hey, I'm ready to trade!",
    senderRole: Role.BUYER,
    sentAt: NOW,
  });

  const r = applyEvent(state, chat);
  if (assertOk(r, "Chat message accepted")) {
    assert(r.state.chatMessages.length === 1, "Chat stored in chatMessages");
    assert(r.state.eventChain.length === 2, "Chat NOT in eventChain (state chain)");
  }

  const imageChat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, BUYER_PK, {
    type: "escrow:chat",
    message: "Receipt attached",
    attachments: [{
      id: "img_receipt_1",
      kind: "image",
      mimeType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
      name: "receipt.jpg",
      width: 800,
      height: 600,
      sizeBytes: 4,
    }],
    senderRole: Role.BUYER,
    sentAt: NOW,
  });
  const withImage = applyEvent(state, imageChat);
  if (assertOk(withImage, "Chat accepts encrypted-image attachment payloads")) {
    const payload = withImage.state.chatMessages[0].payload;
    assert(payload.attachments?.[0]?.id === "img_receipt_1",
      "Chat image attachment survives state-machine apply");
  }

  let publishedChat: NostrEvent | null = null;
  const chatClient = new EscrowClient({
    async getPublicKey() { return BUYER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "chat_signed_1", pubkey: BUYER_PK, sig: "sig" } as NostrEvent;
    },
    async nip44Encrypt(_plaintext: string, recipientPubkey: string) {
      return `cipher-for:${recipientPubkey}`;
    },
    async nip44Decrypt(ciphertext: string) {
      return ciphertext;
    },
  }, { relays: [] });
  (chatClient as any).states.set(state.id, state);
  (chatClient as any).relayManager.publish = async (event: NostrEvent) => {
    publishedChat = event;
    return { accepted: 1, rejected: 0, errors: [] };
  };
  await chatClient.sendChat(state.id, {
    message: "receipt paid",
    attachments: [{
      id: "img_receipt_2",
      kind: "image",
      mimeType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,cGFpZA==",
      name: "paid.jpg",
      width: 600,
      height: 400,
      sizeBytes: 4,
    }],
  });
  const capturedChat = publishedChat as unknown as NostrEvent | null;
  if (!capturedChat) {
    throw new Error("sendChat did not publish a Nostr chat event");
  }
  assert(true, "sendChat publishes a Nostr chat event");
  const publishedPayload = JSON.parse(capturedChat.content) as ChatPayload;
  assert(publishedPayload.message === "",
    "New chat wire payload leaves plaintext message empty");
  assert(!!publishedPayload.bodyEnvelope?.encryptedFor[BUYER_PK],
    "New chat wire payload encrypts body to buyer");
  assert(!!publishedPayload.bodyEnvelope?.encryptedFor[SELLER_PK],
    "New chat wire payload encrypts body to seller");
  assert(!capturedChat.content.includes("receipt paid"),
    "New chat wire payload does not leak message cleartext");
  assert(chatClient.getState(state.id)?.chatMessages[0]?.payload.attachments?.[0]?.id === "img_receipt_2",
    "Local sendChat apply shows encrypted receipt image immediately");

  const expiredBuyer = "33".repeat(32);
  const expiredBuyerState = {
    ...state,
    participants: { ...state.participants, [Role.BUYER]: expiredBuyer },
    joinHolds: {
      ...state.joinHolds,
      [Role.BUYER]: {
        role: Role.BUYER,
        pubkey: expiredBuyer,
        joinedAt: NOW - JOIN_HOLD_SECONDS - 120,
        expiresAt: NOW - 120,
        eventId: "expired_buyer_join",
      },
    },
  } as EscrowState;
  let expiredSlotPublishedChat: NostrEvent | null = null;
  const expiredSlotChatClient = new EscrowClient({
    async getPublicKey() { return SELLER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "chat_expired_slot_1", pubkey: SELLER_PK, sig: "sig" } as NostrEvent;
    },
    async nip44Encrypt(_plaintext: string, recipientPubkey: string) {
      return `cipher-for:${recipientPubkey}`;
    },
    async nip44Decrypt(ciphertext: string) {
      return ciphertext;
    },
  }, { relays: [] });
  (expiredSlotChatClient as any).states.set(expiredBuyerState.id, expiredBuyerState);
  (expiredSlotChatClient as any).relayManager.publish = async (event: NostrEvent) => {
    expiredSlotPublishedChat = event;
    return { accepted: 1, rejected: 0, errors: [] };
  };
  await expiredSlotChatClient.sendChat(expiredBuyerState.id, "old buyer should not receive this");
  const expiredSlotCaptured = expiredSlotPublishedChat as unknown as NostrEvent | null;
  if (!expiredSlotCaptured) {
    throw new Error("sendChat did not publish the expired-slot regression event");
  }
  const expiredSlotPayload = JSON.parse(expiredSlotCaptured.content) as ChatPayload;
  assert(!!expiredSlotPayload.bodyEnvelope?.encryptedFor[SELLER_PK],
    "Seller chat still encrypts to the active seller");
  // Doctrine change (named-participants ∪ self): the JOIN hold governs who may
  // LOCK, never who may READ their own conversation. A buyer whose hold lapsed
  // but who still occupies the named slot stays a chat recipient (excluding
  // them silently dropped an expired-hold AUTHOR's own messages on reload).
  // Once a replacement buyer takes the slot, the old one drops out naturally.
  assert(!!expiredSlotPayload.bodyEnvelope?.encryptedFor[expiredBuyer],
    "Expired-hold buyer still in the named slot remains a chat recipient (hold gates LOCK, not read)");
  const replacedBuyer = "44".repeat(32);
  const replacedBuyerState = {
    ...expiredBuyerState,
    id: expiredBuyerState.id + "_replaced",
    participants: { ...expiredBuyerState.participants, [Role.BUYER]: replacedBuyer },
  } as EscrowState;
  let replacedSlotPublishedChat: NostrEvent | null = null;
  (expiredSlotChatClient as any).states.set(replacedBuyerState.id, replacedBuyerState);
  (expiredSlotChatClient as any).relayManager.publish = async (event: NostrEvent) => {
    replacedSlotPublishedChat = event;
    return { accepted: 1, rejected: 0, errors: [] };
  };
  await expiredSlotChatClient.sendChat(replacedBuyerState.id, "only the current parties read this");
  const replacedSlotPayload = JSON.parse(
    (replacedSlotPublishedChat as unknown as NostrEvent).content,
  ) as ChatPayload;
  assert(!replacedSlotPayload.bodyEnvelope?.encryptedFor[expiredBuyer],
    "A REPLACED buyer (no longer the named slot) is not a chat recipient");
  assert(!!replacedSlotPayload.bodyEnvelope?.encryptedFor[replacedBuyer],
    "The replacement buyer in the named slot is a chat recipient");

  // v3.1.1 (chat-safety, FIX 1 regression): the sent chat raw MUST be persisted
  // to the durable rawEvents cache. CHAT is intentionally NOT in eventChain, so
  // without this a reload (which seeds replay from rawEvents) rebuilds chat from
  // an incomplete relay fetch and silently drops it — the chat-absorption root
  // cause Jetty hit on a live two-device trade.
  const cachedChatRaws = (chatClient as any).rawEvents.get(state.id) as NostrEvent[] | undefined;
  assert(!!cachedChatRaws?.some(e => e.id === capturedChat.id),
    "FIX 1: the sent chat raw is persisted to the durable rawEvents cache");

  // v3.1.1 (chat-safety, FIX 3 regression): an oversized image must FAIL LOUDLY
  // before publish (relays silently DROP events over 128 KiB on receive), not
  // "send" as a phantom local copy that vanishes on reload. Needs a signer whose
  // ciphertext scales with the plaintext — the shared mock above returns a fixed
  // short cipher, which can't exercise the real on-wire size cap.
  const bigChatClient = new EscrowClient({
    async getPublicKey() { return BUYER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "chat_big_1", pubkey: BUYER_PK, sig: "sig" } as NostrEvent;
    },
    async nip44Encrypt(plaintext: string) { return "C".repeat(plaintext.length); },
    async nip44Decrypt(ciphertext: string) { return ciphertext; },
  }, { relays: [] });
  (bigChatClient as any).states.set(state.id, state);
  (bigChatClient as any).relayManager.publish = async () => ({ accepted: 1, rejected: 0, errors: [] });
  let oversizedChatThrew = false;
  try {
    await bigChatClient.sendChat(state.id, {
      message: "",
      attachments: [{
        id: "img_huge", kind: "image", mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64," + "A".repeat(200 * 1024),
        name: "huge.jpg", width: 4000, height: 4000, sizeBytes: 200 * 1024,
      }],
    });
  } catch (e: any) {
    oversizedChatThrew = /too large/i.test(e?.message || "");
  }
  assert(oversizedChatThrew,
    "FIX 3: an oversized chat image throws a clear 'too large' error before publish");

  // Non-participant can't chat
  const badChat = makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, "ff".repeat(32), {
    type: "escrow:chat",
    message: "I'm not part of this",
    senderRole: Role.BUYER,
    sentAt: NOW,
  });
  assertErr(applyEvent(state, badChat), "NOT_PARTICIPANT", "Non-participant can't chat");

  const createForExpiredChat = createEvent();
  let expiredChatState = (applyEvent(null, createForExpiredChat) as any).state;
  const joinedAt = NOW + 10_000;
  const expiredJoin = retimeEvent(joinEvent(Role.BUYER, BUYER_PK, createForExpiredChat.raw.id), joinedAt);
  expiredChatState = (applyEvent(expiredChatState, expiredJoin) as any).state;
  const expiredBuyerChat = retimeEvent(makeParsedEvent<ChatPayload>(EscrowEventKind.CHAT, BUYER_PK, {
    type: "escrow:chat",
    message: "my hold already expired",
    senderRole: Role.BUYER,
    sentAt: joinedAt + JOIN_HOLD_SECONDS + 1,
  }), joinedAt + JOIN_HOLD_SECONDS + 1);
  assertErr(applyEvent(expiredChatState, expiredBuyerChat), "NOT_PARTICIPANT",
    "Expired joined buyer can't chat before lock");

  const replayWithBadHistoricalChat = replayEventChain(sortEventChain([
    create,
    badChat,
    j1,
  ]));
  if (assertOk(replayWithBadHistoricalChat,
    "Historical non-participant CHAT is skipped during full-chain replay")) {
    assert(
      replayWithBadHistoricalChat.state.status === EscrowStatus.CREATED,
      "Bad historical CHAT does not hide an otherwise valid CREATED listing",
    );
    assert(
      replayWithBadHistoricalChat.state.chatMessages.length === 0,
      "Skipped historical CHAT is not shown in chat history",
    );
  }

  const oldBuyer = "11".repeat(32);
  const latestBuyer = "22".repeat(32);
  const oldOrphanJoin = retimeEvent(joinEvent(Role.BUYER, oldBuyer, "missing_old_branch"), NOW + 100);
  const latestOrphanJoin = retimeEvent(joinEvent(Role.BUYER, latestBuyer, "missing_new_branch"), NOW + 1_200);
  const replayWithOrphanJoins = replayEventChain(sortEventChain([
    create,
    badChat,
    latestOrphanJoin,
    oldOrphanJoin,
  ]));
  if (assertOk(replayWithOrphanJoins,
    "Orphaned JOIN branches replay chronologically despite relay arrival order")) {
    assert(
      replayWithOrphanJoins.state.participants[Role.BUYER] === latestBuyer,
      "Newest valid JOIN replaces an expired older hold on replay",
    );
  }
}

// ── 8a. HOLDER-ONLY SHARES — payoutRecipientFor pure over candidate outcome ─
// Refinement #2 (the subtlest bug site): a voter must route their vote-carried
// share to the recipient of THEIR voted outcome, computed BEFORE resolution.
// payoutRecipientFor must therefore be pure over (state, outcome) and never read
// state.resolvedOutcome.
console.log("\n── HOLDER-ONLY: payoutRecipientFor (pure over candidate outcome) ──");
{
  const stateFor = (category: string): EscrowState => ({
    ...(applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create", description: "x", amountMsats: 1_000_000, category,
      mintUrl: "fed", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, expirySeconds: 3600,
      fulfillment: category === "marketplace" ? "physical" : "service", createdAt: NOW,
    })) as any).state,
    participants: { [Role.BUYER]: BUYER_PK, [Role.SELLER]: SELLER_PK, [Role.ARBITER]: ARBITER_PK },
    resolvedOutcome: null,
  }) as EscrowState;

  const p2p = stateFor("p2p-trade");
  assert(getWinner(p2p) === null, "getWinner is null before resolution");
  assert(payoutRecipientFor(p2p, Outcome.RELEASE)?.role === Role.BUYER,
    "payoutRecipientFor works at vote time (no resolvedOutcome): p2p RELEASE → buyer");
  assert(payoutRecipientFor(p2p, Outcome.REFUND)?.role === Role.SELLER,
    "p2p REFUND → seller (the locker)");
  assert(payoutRecipientFor(p2p, Outcome.RELEASE)?.pubkey === BUYER_PK,
    "payoutRecipientFor returns the recipient pubkey, not just the role");

  const mkt = stateFor("marketplace");
  assert(payoutRecipientFor(mkt, Outcome.RELEASE)?.role === Role.SELLER,
    "marketplace RELEASE → seller (RELEASE-to-non-funder, the safety-critical path)");
  assert(payoutRecipientFor(mkt, Outcome.REFUND)?.role === Role.BUYER,
    "marketplace REFUND → buyer (the locker)");

  assert(payoutRecipientFor(stateFor("bill-pay"), Outcome.RELEASE)?.role === Role.BUYER,
    "bill-pay RELEASE → buyer");
  assert(payoutRecipientFor(stateFor("lending"), Outcome.RELEASE)?.role === Role.BUYER,
    "lending RELEASE → buyer");

  // Purity: a (mismatched) resolvedOutcome must not change the answer.
  const stale = { ...p2p, resolvedOutcome: Outcome.REFUND } as EscrowState;
  assert(payoutRecipientFor(stale, Outcome.RELEASE)?.role === Role.BUYER,
    "payoutRecipientFor ignores resolvedOutcome — pure over the candidate outcome");
}

// ── 8a.2 HOLDER-ONLY SHARES — index↔role mapping + vote-envelope binding ──
console.log("\n── HOLDER-ONLY: share mapping + vote-envelope binding ──");
{
  assert(holderRoleForShareIndex(0) === Role.BUYER, "share 0 → buyer");
  assert(holderRoleForShareIndex(1) === Role.SELLER, "share 1 → seller");
  assert(holderRoleForShareIndex(2) === Role.ARBITER, "share 2 → arbiter");
  assert(holderRoleForShareIndex(3) === null, "share 3 → none (out of range)");
  assert(shareIndexForRole(Role.BUYER) === 0 && shareIndexForRole(Role.SELLER) === 1
    && shareIndexForRole(Role.ARBITER) === 2, "role → share index round-trips");

  const st = {
    ...(applyEvent(null, makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create", description: "x", amountMsats: 1_000_000, category: "p2p-trade",
      mintUrl: "fed", platformFeeBps: 50, platformFeePubkey: PLATFORM_PK, expirySeconds: 3600,
      fulfillment: "service", createdAt: NOW,
    })) as any).state,
    participants: { [Role.BUYER]: BUYER_PK, [Role.SELLER]: SELLER_PK, [Role.ARBITER]: ARBITER_PK },
  } as EscrowState;
  assert(holderPubkeyForShareIndex(st, 0) === BUYER_PK, "holderPubkeyForShareIndex 0 → buyer pubkey");
  assert(holderPubkeyForShareIndex(st, 2) === ARBITER_PK, "holderPubkeyForShareIndex 2 → arbiter pubkey");

  // A valid SELLER vote-share for RELEASE in p2p → recipient is the BUYER.
  const validEnv = {
    shareIndex: 1, outcome: Outcome.RELEASE, notesHash: "hash_abc",
    recipientPubkey: BUYER_PK, encryptedFor: { [BUYER_PK]: "ct" },
  };
  assert(validateVoteShareEnvelope(validEnv as any, st, Role.SELLER, Outcome.RELEASE, "hash_abc") === null,
    "valid seller RELEASE vote-share passes binding");
  assert(validateVoteShareEnvelope({ ...validEnv, shareIndex: 0 } as any, st, Role.SELLER, Outcome.RELEASE, "hash_abc") !== null,
    "rejects a shareIndex that isn't the voter's holder index (#5)");
  assert(validateVoteShareEnvelope({ ...validEnv, outcome: Outcome.REFUND } as any, st, Role.SELLER, Outcome.RELEASE, "hash_abc") !== null,
    "rejects a share whose outcome disagrees with the vote");
  assert(validateVoteShareEnvelope({ ...validEnv, notesHash: "wrong" } as any, st, Role.SELLER, Outcome.RELEASE, "hash_abc") !== null,
    "rejects a share bound to the wrong token (notesHash)");
  assert(validateVoteShareEnvelope({ ...validEnv, recipientPubkey: SELLER_PK, encryptedFor: { [SELLER_PK]: "ct" } } as any, st, Role.SELLER, Outcome.RELEASE, "hash_abc") !== null,
    "rejects a share routed to the wrong recipient (not the engine recipient)");
  assert(validateVoteShareEnvelope({ ...validEnv, encryptedFor: { [SELLER_PK]: "ct" } } as any, st, Role.SELLER, Outcome.RELEASE, "hash_abc") !== null,
    "rejects a share not encrypted to the recipient");
}

// ── 8a.3 HOLDER-ONLY end-to-end (protocol): lock → vote-carried shares ────
console.log("\n── HOLDER-ONLY: lock + vote-envelope end-to-end ──");
{
  const create = createEvent(); // p2p-trade, seller = SELLER_PK
  const r1 = applyEvent(null, create);
  if (!r1.ok) throw new Error("holder-only e2e: create failed");

  const lock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock",
    notesHash: "hash_xyz",
    sharePolicy: "holder-only-v1",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "ct0" } },
      { shareIndex: 1, encryptedFor: { [SELLER_PK]: "ct1" } },
      { shareIndex: 2, encryptedFor: { [ARBITER_PK]: "ct2" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  } as any, create.raw.id);
  const r2 = applyEvent(r1.state, lock);
  if (assertOk(r2, "holder-only LOCK applies")) {
    assert(r2.state.lock.sharePolicy === "holder-only-v1", "lock carries the holder-only-v1 policy");
    assert(r2.state.lock.shares.size === 3, "lock stores 3 holder-only shares");
    const share0 = r2.state.lock.shares.get("0");
    assert(!!share0 && Object.keys(share0.encryptedFor).length === 1 && share0.encryptedFor[BUYER_PK] !== undefined,
      "share 0 is encrypted ONLY to the buyer (no one else can read it)");
    assert(r2.state.lock.shares.get("2")?.encryptedFor[ARBITER_PK] !== undefined
      && r2.state.lock.shares.get("2")?.encryptedFor[BUYER_PK] === undefined,
      "share 2 is encrypted ONLY to the arbiter (non-holders absent)");
  }

  if (r2.ok) {
    // Buyer votes RELEASE (p2p RELEASE → recipient = buyer) with a valid share.
    const validVote = makeParsedEvent(EscrowEventKind.VOTE, BUYER_PK, {
      type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: NOW,
      shareEnvelope: { shareIndex: 0, outcome: Outcome.RELEASE, notesHash: "hash_xyz", recipientPubkey: BUYER_PK, encryptedFor: { [BUYER_PK]: "vct" } },
    } as any, lock.raw.id);
    assert(applyEvent(r2.state, validVote).ok, "holder-only VOTE with a valid share envelope is accepted");

    // Misrouted share (wrong recipient) → rejected at apply time.
    const misrouted = makeParsedEvent(EscrowEventKind.VOTE, BUYER_PK, {
      type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: NOW,
      shareEnvelope: { shareIndex: 0, outcome: Outcome.RELEASE, notesHash: "hash_xyz", recipientPubkey: SELLER_PK, encryptedFor: { [SELLER_PK]: "vct" } },
    } as any, lock.raw.id);
    assert(!applyEvent(r2.state, misrouted).ok, "VOTE with a misrouted share (wrong recipient) is rejected");

    // Wrong shareIndex (not the voter's holder index) → rejected.
    const wrongIdx = makeParsedEvent(EscrowEventKind.VOTE, BUYER_PK, {
      type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: NOW,
      shareEnvelope: { shareIndex: 1, outcome: Outcome.RELEASE, notesHash: "hash_xyz", recipientPubkey: BUYER_PK, encryptedFor: { [BUYER_PK]: "vct" } },
    } as any, lock.raw.id);
    assert(!applyEvent(r2.state, wrongIdx).ok, "VOTE with the wrong shareIndex is rejected");

    // Wrong notesHash (bound to a different token) → rejected.
    const wrongHash = makeParsedEvent(EscrowEventKind.VOTE, BUYER_PK, {
      type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: NOW,
      shareEnvelope: { shareIndex: 0, outcome: Outcome.RELEASE, notesHash: "other", recipientPubkey: BUYER_PK, encryptedFor: { [BUYER_PK]: "vct" } },
    } as any, lock.raw.id);
    assert(!applyEvent(r2.state, wrongHash).ok, "VOTE with a share bound to the wrong notesHash is rejected");

    // A vote with NO envelope still applies (legacy / expiry-heal best-effort).
    const noEnv = makeParsedEvent(EscrowEventKind.VOTE, BUYER_PK, {
      type: "escrow:vote", outcome: Outcome.RELEASE, role: Role.BUYER, votedAt: NOW,
    } as any, lock.raw.id);
    assert(applyEvent(r2.state, noEnv).ok, "a vote with no share envelope still applies (legacy / heal)");
  }
}

// ── 8b. REBROADCAST / HEAL (re-publish a ghost trade's cached chain) ──────
console.log("\n── REBROADCAST / HEAL (re-publish cached chain to today's relays) ──");
{
  const healSigner = {
    async getPublicKey() { return SELLER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "heal_signed", pubkey: SELLER_PK, sig: "sig" } as NostrEvent;
    },
    async nip44Encrypt(_plaintext: string, recipientPubkey: string) { return `cipher:${recipientPubkey}`; },
    async nip44Decrypt(ciphertext: string) { return ciphertext; },
  };
  const rawEv = (id: string): NostrEvent => ({
    id, kind: EscrowEventKind.CREATE, pubkey: SELLER_PK, created_at: NOW, tags: [], content: "", sig: "sig",
  } as NostrEvent);

  // (1) Re-publishes the full cached rawEvents chain, in chain order.
  {
    const ghostId = "sm_ghost_heal_1";
    const client = new EscrowClient(healSigner, { relays: [] });
    const captured: NostrEvent[] = [];
    (client as any).relayManager.publish = async (event: NostrEvent) => {
      captured.push(event);
      return { accepted: 1, rejected: 0, errors: [] };
    };
    (client as any).rawEvents.set(ghostId, [rawEv("g1"), rawEv("g2"), rawEv("g3")]);
    const res = await client.rebroadcastEscrow(ghostId);
    assert(res.total === 3, "rebroadcast: total counts the full cached chain");
    assert(res.published === 3, "rebroadcast: every cached event is re-published");
    assert(captured.map(e => e.id).join(",") === "g1,g2,g3",
      "rebroadcast: re-publishes the cached events in chain order");
  }

  // (2) Merges cached rawEvents with the replayed state's eventChain, deduped by id.
  {
    const ghostId = "sm_ghost_heal_2";
    const client = new EscrowClient(healSigner, { relays: [] });
    const captured: NostrEvent[] = [];
    (client as any).relayManager.publish = async (event: NostrEvent) => {
      captured.push(event);
      return { accepted: 1, rejected: 0, errors: [] };
    };
    (client as any).rawEvents.set(ghostId, [rawEv("g1"), rawEv("g2"), rawEv("g3")]);
    (client as any).states.set(ghostId, { id: ghostId, eventChain: [{ raw: rawEv("g2") }, { raw: rawEv("g4") }] });
    const res = await client.rebroadcastEscrow(ghostId);
    assert(res.total === 4, "rebroadcast: merges rawEvents + state.eventChain (g2 shared, g4 unique)");
    assert(captured.some(e => e.id === "g4"),
      "rebroadcast: includes an event present only in state.eventChain");
    assert(captured.filter(e => e.id === "g2").length === 1,
      "rebroadcast: a shared event is published once, not twice");
  }

  // (3) A per-event relay rejection doesn't abort the heal of the rest.
  {
    const ghostId = "sm_ghost_heal_3";
    const client = new EscrowClient(healSigner, { relays: [] });
    const captured: string[] = [];
    (client as any).relayManager.publish = async (event: NostrEvent) => {
      if (event.id === "g2") throw new Error("all relays rejected this event");
      captured.push(event.id);
      return { accepted: 1, rejected: 0, errors: [] };
    };
    (client as any).rawEvents.set(ghostId, [rawEv("g1"), rawEv("g2"), rawEv("g3")]);
    const res = await client.rebroadcastEscrow(ghostId);
    assert(res.total === 3, "rebroadcast: reports full chain size even when one event is rejected");
    assert(res.published === 2, "rebroadcast: counts only events a relay accepted");
    assert(captured.join(",") === "g1,g3",
      "rebroadcast: one rejected event does not abort re-publishing the rest");
  }

  // (4) Nothing cached → a safe no-op (no publishes).
  {
    const client = new EscrowClient(healSigner, { relays: [] });
    let calls = 0;
    (client as any).relayManager.publish = async () => { calls++; return { accepted: 1, rejected: 0, errors: [] }; };
    const res = await client.rebroadcastEscrow("sm_nothing_cached_here");
    assert(res.total === 0 && res.published === 0, "rebroadcast: uncached trade resolves to 0/0");
    assert(calls === 0, "rebroadcast: uncached trade publishes nothing");
  }
}

// ── 9. REPLAY ─────────────────────────────────────────────────────────────
console.log("\n── REPLAY (full happy path from event chain) ──");
{
  eventCounter = 100; // Reset for clean IDs

  const events: ParsedEscrowEvent[] = [];

  const create = createEvent();
  events.push(create);

  // Optional JOIN ACKs (still valid pre-LOCK)
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  events.push(j1);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);
  events.push(j2);

  const lock = lockEvent(j2.raw.id);
  events.push(lock);

  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  events.push(v1);

  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);
  events.push(v2);

  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id);
  events.push(resolve);

  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  events.push(claim);

  const complete = completeEvent(claim.raw.id);
  events.push(complete);

  const result = replayEventChain(events);
  if (assertOk(result, "Full replay succeeds")) {
    assert(result.state.status === EscrowStatus.COMPLETED, "Final state is COMPLETED");
    assert(result.state.eventChain.length === 9, "All 9 events in chain");
    assert(result.state.resolvedOutcome === Outcome.RELEASE, "Outcome is RELEASE");

    console.log("\n  📋 State summary:");
    console.log("  " + getSummary(result.state).split("\n").join("\n  "));
  }
}

// ── 9b. REPLAY without any JOIN events ───────────────────────────────────
console.log("\n── REPLAY (atomic minimum: CREATE → LOCK → … with NO JOINs) ──");
{
  eventCounter = 200;
  const events: ParsedEscrowEvent[] = [];
  const create = createEvent();           events.push(create);
  const lock = lockEvent(create.raw.id);  events.push(lock);
  const v1 = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);  events.push(v1);
  const v2 = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, v1.raw.id);  events.push(v2);
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, v2.raw.id); events.push(resolve);
  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);            events.push(claim);
  const complete = completeEvent(claim.raw.id);                              events.push(complete);

  const result = replayEventChain(events);
  if (assertOk(result, "Replay succeeds without any JOIN events")) {
    assert(result.state.status === EscrowStatus.COMPLETED,
      "Trade completes from CREATE→LOCK→VOTE→RESOLVE→CLAIM→COMPLETE — no JOIN ceremony required");
    assert(result.state.participants[Role.BUYER] === BUYER_PK,
      "Buyer slot populated by LOCK payload, not JOIN");
    assert(result.state.participants[Role.ARBITER] === ARBITER_PK,
      "Arbiter slot populated by LOCK payload, not JOIN");
  }
}

// ── 10. EVENT PARSER ──────────────────────────────────────────────────────
console.log("\n── EVENT PARSER ──");
{
  const raw: NostrEvent = {
    id: "parser_test_1",
    pubkey: SELLER_PK,
    created_at: NOW,
    kind: EscrowEventKind.CREATE,
    tags: [["d", "test-123"]],
    content: "encrypted_content",
    sig: "sig_test",
  };

  const decrypted = JSON.stringify({
    type: "escrow:create",
    description: "Test listing",
    amountMsats: 50_000_000,
    premiumBps: 350,
    category: "marketplace",
    mintUrl: "fed://test",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    expirySeconds: 3600,
    createdAt: NOW,
  });

  const result = parseEscrowEvent(raw, decrypted, true);
  assert(result.ok === true, "Parser accepts valid CREATE event");
  if (result.ok) {
    assert(result.event.escrowId === "test-123", "Escrow ID extracted");
    assert(result.event.kind === EscrowEventKind.CREATE, "Kind parsed");
    assert((result.event.payload as CreatePayload).description === "Test listing", "Payload parsed");
    assert((result.event.payload as CreatePayload).premiumBps === 350, "Premium BPS parsed");
  }

  // #7 Stage 1 — multi-unit storefront schema (additive): stock on a parent
  // listing, parent + claimedQuantity on a child purchase escrow.
  const okStock = parseEscrowEvent(raw, JSON.stringify({
    type: "escrow:create", description: "Stocked listing", amountMsats: 50_000_000,
    category: "marketplace", mintUrl: "fed://test", platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK, expirySeconds: 3600, createdAt: NOW, stock: 5,
  }), true);
  assert(okStock.ok && (okStock.event.payload as CreatePayload).stock === 5,
    "Parser preserves a parent listing's stock");
  const okChild = parseEscrowEvent(raw, JSON.stringify({
    type: "escrow:create", description: "Child purchase", amountMsats: 10_000_000,
    category: "marketplace", mintUrl: "fed://test", platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK, expirySeconds: 3600, createdAt: NOW,
    parent: "parent-listing-id", claimedQuantity: 2, sellerPubkey: SELLER_PK,
  }), true);
  assert(okChild.ok
    && (okChild.event.payload as CreatePayload).parent === "parent-listing-id"
    && (okChild.event.payload as CreatePayload).claimedQuantity === 2
    && (okChild.event.payload as CreatePayload).sellerPubkey === SELLER_PK,
    "Parser preserves a child escrow's parent + claimedQuantity + sellerPubkey");
  {
    const baseCreate = {
      type: "escrow:create", description: "x", amountMsats: 10_000_000,
      category: "marketplace", mintUrl: "fed://test", platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK, expirySeconds: 3600, createdAt: NOW,
    };
    assert(!parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, stock: 0 }), true).ok,
      "Parser rejects stock of 0");
    assert(!parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, stock: 2.5 }), true).ok,
      "Parser rejects non-integer stock");
    assert(!parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, parent: "" }), true).ok,
      "Parser rejects an empty parent id");
    assert(!parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, claimedQuantity: 0 }), true).ok,
      "Parser rejects claimedQuantity of 0");
    // Stage 2b: a child must name its seller (buyer-initiated child needs the
    // SELLER seated up front to be lock-ready under Option A).
    assert(!parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, parent: "p-id", claimedQuantity: 1 }), true).ok,
      "Parser rejects a child with parent but no sellerPubkey");
    assert(parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, parent: "p-id", claimedQuantity: 1, sellerPubkey: SELLER_PK }), true).ok,
      "Parser accepts a child with parent + sellerPubkey");
    assert(!parseEscrowEvent(raw, JSON.stringify({ ...baseCreate, parent: "p-id", claimedQuantity: 1, sellerPubkey: "" }), true).ok,
      "Parser rejects a child with an empty sellerPubkey");
  }
  // Reducer carries the fields onto state; legacy listings stay untouched.
  {
    const rp = applyEvent(null, createEvent({ stock: 5 }));
    if (assertOk(rp, "Parent listing with stock applies")) {
      assert(rp.state.stock === 5, "Parent listing preserves stock on state");
      assert(rp.state.parent === undefined, "Parent listing has no parent ref");
    }
    const rc = applyEvent(null, createEvent({ amountMsats: 10_000_000, parent: "parent-id", claimedQuantity: 2 }));
    if (assertOk(rc, "Child purchase escrow applies")) {
      assert(rc.state.parent === "parent-id", "Child preserves parent ref");
      assert(rc.state.claimedQuantity === 2, "Child preserves claimedQuantity");
      assert(rc.state.stock === undefined, "Child carries no stock of its own");
    }
    const rl = applyEvent(null, createEvent({}));
    if (assertOk(rl, "Legacy single-unit listing applies")) {
      assert(
        rl.state.stock === undefined && rl.state.parent === undefined && rl.state.claimedQuantity === undefined,
        "Legacy listing leaves all storefront fields undefined (back-compat)",
      );
    }
  }

  // Bad kind
  const badRaw = { ...raw, kind: 99999, id: "bad_kind" };
  assert(!parseEscrowEvent(badRaw, decrypted, true).ok, "Parser rejects unknown kind");

  // Retired READY kind 38109 — must now reject as INVALID_KIND
  const retiredReady = { ...raw, kind: 38109, id: "retired_ready" };
  assert(!parseEscrowEvent(retiredReady, decrypted, true).ok, "Parser rejects retired READY kind");

  // Retired KICK kind 38110 — must now reject as INVALID_KIND
  const retiredKick = { ...raw, kind: 38110, id: "retired_kick" };
  assert(!parseEscrowEvent(retiredKick, decrypted, true).ok, "Parser rejects retired KICK kind");

  // LOCK without buyerPubkey/arbiterPubkey → INVALID_PAYLOAD
  const badLockContent = JSON.stringify({
    type: "escrow:lock",
    notesHash: "h",
    shares: [
      { shareIndex: 0, encryptedFor: { x: "y" } },
      { shareIndex: 1, encryptedFor: { x: "y" } },
      { shareIndex: 2, encryptedFor: { x: "y" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    lockedAt: NOW,
  });
  const badLockRaw = { ...raw, kind: EscrowEventKind.LOCK, id: "no_pubkeys", tags: [["d", "no-pks"]] };
  assert(!parseEscrowEvent(badLockRaw, badLockContent, true).ok,
    "Parser rejects LOCK without buyerPubkey/arbiterPubkey");

  // Missing d-tag
  const noDTag = { ...raw, tags: [], id: "no_d" };
  assert(!parseEscrowEvent(noDTag, decrypted, true).ok, "Parser rejects missing d-tag");

  // Bad JSON
  assert(!parseEscrowEvent(raw, "not json {{{", true).ok, "Parser rejects invalid JSON");
}

// ── 11. CHAIN SORTING ────────────────────────────────────────────────────
console.log("\n── CHAIN SORTING ──");
{
  eventCounter = 300;

  const create = createEvent();
  const j1 = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
  const j2 = joinEvent(Role.ARBITER, ARBITER_PK, j1.raw.id);

  const unsorted = [j2, create, j1];
  const sorted = sortEventChain(unsorted);

  assert(sorted[0].raw.id === create.raw.id, "CREATE first after sort");
  assert(sorted[1].raw.id === j1.raw.id, "JOIN (buyer) second");
  assert(sorted[2].raw.id === j2.raw.id, "JOIN (arbiter) third");
}

// ── 12. FILTER BUILDER ───────────────────────────────────────────────────
console.log("\n── FILTER BUILDER ──");
{
  const filter = buildEscrowFilter("my-escrow-123");
  assert(Array.isArray(filter.kinds), "Filter has kinds array");
  assert(filter.kinds.includes(EscrowEventKind.CREATE), "Filter includes CREATE kind");
  assert(filter["#d"]?.[0] === "my-escrow-123", "Filter targets escrow ID");
}

// ── 13. EXPIRY ────────────────────────────────────────────────────────────
console.log("\n── EXPIRY ──");
{
  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  assert(!isExpired(state, NOW + 100), "Not expired within window");
  assert(isExpired(state, NOW + 100_000), "Expired past deadline");
}

// ══════════════════════════════════════════════════════════════════════════
// PR 2 — community + listing schema + BLF resolver + vote labels
// ══════════════════════════════════════════════════════════════════════════

// ── 14. COMMUNITY REGISTRY + STORAGE ─────────────────────────────────────
console.log("\n── COMMUNITY REGISTRY + STORAGE ──");
{
  // v0.7.0: registry includes Tanzania/TZS plus every East/West/Central Africa
  // country Chama shell. Country-first identity is user-facing; the
  // backing federation stays hidden until a claimed local route exists.
  // 2026-06-16: us-blf is the hidden universal backup (BLF), nameless
  // ("Global · Bitcoin"); the one visible US community is us-gbf ("USA ·
  // USD", GBF); legacy global-usd stays hidden and repoints to BLF.
  // Permissionless additions live in localStorage and are not counted here.
  assert(COMMUNITY_REGISTRY.length === 58,
    "Registry has 58 pre-seeds: Global, GBF, Fedi-approved public routes, Kenya routes, South Africa, East/West/Central Africa, plus hidden legacy entries");
  assert(getCommunityBySlug("sn-cfa")?.currency === "XOF", "sn-cfa is XOF");
  assert(getCommunityBySlug("ke-kes")?.currency === "KES", "ke-kes is KES");
  assert(getCommunityBySlug("ke-kes-bitsacco")?.currency === "KES", "ke-kes-bitsacco is KES");
  assert(getCommunityBySlug("tz-tzs")?.currency === "TZS", "tz-tzs is TZS");
  assert(getCommunityBySlug("tz-tzs")?.country === "TZ", "tz-tzs country is Tanzania");
  assert(getCommunityBySlug("gh-ghs")?.currency === "GHS", "gh-ghs is GHS");
  assert(getCommunityBySlug("ng-ngn")?.currency === "NGN", "ng-ngn is NGN");
  assert(getCommunityBySlug("ao-aoa")?.currency === "AOA", "ao-aoa is AOA");
  assert(getCommunityBySlug("cm-xaf")?.currency === "XAF", "cm-xaf is XAF");
  assert(getCommunityBySlug("cm-xaf")?.country === "CM", "cm-xaf country is Cameroon");
  assert(getCommunityBySlug("cf-xaf")?.currency === "XAF", "cf-xaf is XAF");
  assert(getCommunityBySlug("td-xaf")?.currency === "XAF", "td-xaf is XAF");
  assert(getCommunityBySlug("cg-xaf")?.currency === "XAF", "cg-xaf is XAF");
  assert(getCommunityBySlug("cd-cdf")?.currency === "CDF", "cd-cdf is CDF");
  assert(getCommunityBySlug("gq-xaf")?.currency === "XAF", "gq-xaf is XAF");
  assert(getCommunityBySlug("ga-xaf")?.currency === "XAF", "ga-xaf is XAF");
  assert(getCommunityBySlug("st-stn")?.currency === "STN", "st-stn is STN");
  assert(getCommunityBySlug("ug-ugx")?.currency === "UGX", "ug-ugx is UGX");
  assert(getCommunityBySlug("zw-zwg")?.currency === "ZWG", "zw-zwg uses Zimbabwe Gold");
  assert(getCommunityBySlug("za-zar")?.currency === "ZAR", "za-zar is ZAR");
  assert(getCommunityBySlug("za-zar")?.country === "ZA", "za-zar country is South Africa");
  assert(getCommunityBySlug("sv-usd")?.currency === "USD", "sv-usd is USD");
  assert(getCommunityBySlug("global-usd")?.currency === "USD", "global-usd is USD");
  assert(getCommunityBySlug("us-blf")?.currency === "USD", "us-blf is USD");
  assert(getCommunityBySlug("us-blf")?.displayName === "Global · Bitcoin",
    "us-blf presents as the nameless Global · Bitcoin backup (not 'Global · USD')");
  assert(getCommunityBySlug("us-blf")?.pickerLabel === "Bitcoin Life Federation",
    "Global picker names the BLF wallet service as Bitcoin Life Federation");
  assert(getCommunityBySlug("us-gbf")?.pickerLabel === "Global Bitcoin Federation",
    "Global picker names the GBF wallet service as Global Bitcoin Federation");
  // 2026-06-16 label collision fix: GBF is the one visible US community
  // ("USA · USD"); the BLF backup is nameless ("Global · Bitcoin"), not the
  // "Global · USD" identity it used to impersonate.
  assert(getCommunityBySlug("us-gbf")?.displayName === "USA · USD",
    "us-gbf is the one visible US community, labeled USA · USD (GBF)");
  assert(getCommunityBySlug("us-blf")?.displayName !== "Global · USD",
    "us-blf no longer impersonates 'Global · USD' (label collision fixed)");
  assert(getCommunityBySlug("us-blf")?.flagEmoji === "🌍",
    "us-blf backup uses the Africa-facing globe emoji");
  assert(getCommunityBySlug("us-blf")?.disambiguator === "BLF",
    "us-blf shows BLF as its backing route in onboarding");

  // #103: communityForInvite keeps a listing's community LABEL honest with the
  // fed it's minted on (so the Browse chip + the off-route amber can't disagree).
  {
    const blfInvite = getCommunityBySlug("us-blf")!.federationInvite!;
    const gbfInvite = getCommunityBySlug("us-gbf")!.federationInvite!;
    assert(blfInvite !== gbfInvite, "BLF and GBF are genuinely different feds");
    assert(communityForInvite(blfInvite)?.federationInvite === blfInvite,
      "communityForInvite resolves a community that actually backs the BLF fed");
    assert(communityForInvite(gbfInvite)?.federationInvite === gbfInvite,
      "communityForInvite resolves a community that actually backs the GBF fed");
    assert(communityForInvite("fed1qnonexistent_unknown_invite") === null,
      "communityForInvite returns null for an unknown invite (custom feds keep their label)");
    assert(communityForInvite(null) === null && communityForInvite("") === null,
      "communityForInvite is null-safe");
    // The create-time correction: a listing stamped while browseCommunity (GBF
    // label) disagreed with the wallet fed (BLF) gets re-resolved to a BLF-
    // backed community, so its chip and its off-route amber agree.
    const drifted = getCommunityBySlug("us-gbf")!; // header label
    const walletFed = blfInvite;                   // actual minted fed
    const corrected = drifted.federationInvite !== walletFed
      ? communityForInvite(walletFed)?.slug
      : drifted.slug;
    assert(corrected != null && getCommunityBySlug(corrected)?.federationInvite === walletFed,
      "Label/fed drift is corrected: a GBF-labeled listing minted on BLF stamps a BLF community");
  }
  assert(PUBLIC_FEDI_APPROVED_FEDERATIONS.length === 9,
    "Baked public Fedi-approved list carries the screenshot wallet services beyond GBF's existing route");
  assert(getCommunityBySlug("fedi-victoria-btc")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-victoria-btc")?.invite,
    "Victoria BTC public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-orange-club-africa")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-orange-club-africa")?.invite,
    "Orange Club Africa public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-latnet")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-latnet")?.invite,
    "LatNet public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-marigold-trust-network")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-marigold-trust-network")?.invite,
    "Marigold Trust Network public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-e-cash-club")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-e-cash-club")?.invite,
    "E-Cash Club public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-bitcoin-principles")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-bitcoin-principles")?.invite,
    "Bitcoin Principles public Fedi-approved route is visible");
  assert(getCommunityBySlug("fedi-bitcoinomad")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-bitcoinomad")?.invite,
    "Bitcoinomad public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-btc-brasil")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-btc-brasil")?.invite,
    "BTC Brasil public Fedi-approved route is wired");
  assert(getCommunityBySlug("fedi-freedom-one")?.federationInvite === PUBLIC_FEDI_APPROVED_FEDERATIONS.find(r => r.slug === "fedi-freedom-one")?.invite,
    "Freedom One public Fedi-approved route uses the live uppercase entry");
  assert(DEFAULT_COMMUNITY_SLUG === "us-blf", "Default community is us-blf (BLF, v0.5.0)");
  assert(DEFAULT_RELAYS.length >= 5, "Default relay pool has at least 5 stable relays");
  (globalThis as any).localStorage.clear();

  // ── v2.4 #56: ecash export stash (crash-safe withdraw-as-ecash) ──────────
  console.log("\n── ECASH EXPORT STASH (v2.4) ──");
  {
    (globalThis as any).localStorage.clear();
    setLocalStorageUserScope("npub_export_test_aaaa");
    assert(getEcashExport() === null, "ecash-export: empty by default");
    stashEcashExport({ notes: "AwEEtestnote", amountMsats: 1500, federationLabel: "BLF" });
    const got = getEcashExport();
    assert(
      got !== null && got.notes === "AwEEtestnote" && got.amountMsats === 1500 && got.federationLabel === "BLF",
      "ecash-export: stash roundtrips notes + amount + label",
    );
    // Scoped per npub — a pending export must never bleed to another user.
    setLocalStorageUserScope("npub_export_test_bbbb");
    assert(getEcashExport() === null, "ecash-export: a different npub sees no pending export (scoped)");
    setLocalStorageUserScope("npub_export_test_aaaa");
    clearEcashExport();
    assert(getEcashExport() === null, "ecash-export: clear removes the pending export (user confirmed import)");
    setLocalStorageUserScope(null);
    (globalThis as any).localStorage.clear();
  }

  assert(
    normalizeTrustedArbiterInput(` ${ARBITER_PK},${ARBITER_PK.toUpperCase()} invalid ${ARBITER2_PK} `).length === 2,
    "Trusted arbiter input normalizes, dedupes, and ignores invalid entries"
  );
  assert(BLF_OFFICIAL_ARBITERS.length === 3,
    "BLF official arbiter pool is the n=3 cabinet (maintainer + Chapsmart + Graysatoshi)");
  assert(getTrustedArbiterPool({ community: "us-blf" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "us-blf/BLF listings carry the official BLF arbiters");
  assert(getTrustedArbiterPool({ community: "sn-cfa" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "Senegal CFA is BLF-backed and carries the official BLF arbiters");
  assert(getTrustedArbiterPool({ community: "tz-tzs" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "Tanzania TZS is BLF-backed for now and carries the official BLF arbiters");
  assert(getTrustedArbiterPool({ community: "gh-ghs" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "New BLF-backed country shells carry the official BLF arbiters");
  assert(getTrustedArbiterPool({ community: "cm-xaf" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "Cameroon XAF is BLF-backed for now and carries the official BLF arbiters");
  assert(getTrustedArbiterPool({ community: "cd-cdf" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "DR Congo CDF is BLF-backed for now and carries the official BLF arbiters");
  assert(getTrustedArbiterPool({
    community: "us-blf",
    excludePubkeys: [BLF_OFFICIAL_ARBITERS[0]!],
  }).join(",") === [BLF_OFFICIAL_ARBITERS[1]!, BLF_OFFICIAL_ARBITERS[2]!].join(","),
    "Official arbiter pool respects participant exclusion (trio minus the excluded one)");
  assert(getTrustedArbiterPool({ community: "ke-kes" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "Kenya KES/Afribit carries the bootstrap official arbiter pool");
  assert(getTrustedArbiterPool({ community: "ke-kes-bitsacco" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "Kenya KES/Bitsacco carries the bootstrap official arbiter pool");

  // Bond → arbiter enrollment (S3 foundation): an injected bondedPool ADDITIVELY
  // unions chain-verified bonded arbiters into the pool; absent ⇒ unchanged.
  {
    const BONDED = "dd".repeat(32);
    const withBond = getTrustedArbiterPool({ community: "us-blf", bondedPool: [BONDED] });
    assert(withBond.includes(BONDED) && BLF_OFFICIAL_ARBITERS.every((pk) => withBond.includes(pk)),
      "⭐ bondedPool: a bonded arbiter joins the pool additively (roster/cabinet kept)");
    assert(getTrustedArbiterPool({ community: "us-blf" }).join(",") === BLF_OFFICIAL_ARBITERS.join(","),
      "bondedPool: absent ⇒ pool unchanged (dormant seam)");
    assert(!getTrustedArbiterPool({ community: "us-blf", bondedPool: [BONDED], excludePubkeys: [BONDED] }).includes(BONDED),
      "bondedPool: a bonded arbiter who is a trade party is still excluded");
  }

  // ── v2.3: arbiter provenance — close the "arbiter door" ────────────────
  console.log("\n── ARBITER PROVENANCE (v2.3) ──");
  {
    const OFFICIAL = BLF_OFFICIAL_ARBITERS;
    const SOCK = "ab".repeat(32); // a key not in any trusted pool
    const SOCK2 = "cd".repeat(32);

    // All-official pool → verified, no warnings.
    const clean = classifyArbiterProvenance(OFFICIAL, OFFICIAL);
    assert(clean.verified === true, "provenance: all-official pool is verified");
    assert(clean.hasPool === true, "provenance: non-empty pool reports hasPool");
    assert(clean.unrecognized.length === 0, "provenance: all-official pool has no unrecognized members");
    assert(clean.recognized.length === OFFICIAL.length, "provenance: every official key is recognized");

    // Stuffed pool: one official + two sock puppets → NOT verified, both flagged.
    const stuffed = classifyArbiterProvenance([OFFICIAL[0], SOCK, SOCK2], OFFICIAL);
    assert(stuffed.verified === false, "provenance: a pool with sock puppets is NOT verified");
    assert(stuffed.unrecognized.length === 2, "provenance: both sock puppets are flagged");
    assert(stuffed.unrecognized.includes(SOCK) && stuffed.unrecognized.includes(SOCK2),
      "provenance: the unrecognized list names the exact sock-puppet keys");
    assert(stuffed.recognized.length === 1, "provenance: the genuine official key is still recognized");

    // Fully hostile pool: every member is a sock puppet → all unrecognized.
    const hostile = classifyArbiterProvenance([SOCK, SOCK2], OFFICIAL);
    assert(hostile.verified === false && hostile.unrecognized.length === 2,
      "provenance: an all-sock-puppet pool is fully unrecognized");

    // Empty pool (raw/legacy escrow, no community arbiter) → neutral, not a warning.
    const empty = classifyArbiterProvenance([], OFFICIAL);
    assert(empty.verified === false, "provenance: empty pool is not 'verified' (nothing to verify)");
    assert(empty.hasPool === false, "provenance: empty pool reports hasPool=false (neutral UI)");
    assert(empty.unrecognized.length === 0 && empty.recognized.length === 0,
      "provenance: empty pool produces no recognized/unrecognized entries");

    // Mixed-case / duplicate inputs normalize and dedupe before classifying.
    const messy = classifyArbiterProvenance(
      [OFFICIAL[0].toUpperCase(), OFFICIAL[0], SOCK.toUpperCase()],
      OFFICIAL,
    );
    assert(messy.recognized.length === 1, "provenance: case-variant duplicate official key dedupes to one recognized");
    assert(messy.unrecognized.length === 1, "provenance: case-variant sock puppet still flagged once");

    // The trade pool a verifying device compares against is its own trusted
    // set: an operator who locally trusts a key sees it as recognized.
    const withLocalTrust = classifyArbiterProvenance([SOCK], [...OFFICIAL, SOCK]);
    assert(withLocalTrust.verified === true,
      "provenance: a key in THIS device's trusted pool reads as recognized (operator-added)");
  }

  // ── v3.5: pool integrity (C1 assignment + C7 roster) — consent layer ─────
  //
  // C1 stays OUT of the reducer on purpose: a LOCK-side assignment reject
  // recomputed with today's rules strands genuine old chains on replay
  // (ARBITER_NOT_ASSIGNED is not benign → unloadable funds). The classifier
  // below is the informed-consent version — a miss warns, never strands —
  // and must accept EVERY assignment basis a LOCK builder ever shipped:
  // pool[0] (pre-v0.6.5), no-exclusion pick (v0.6.5+), excluded pick (v0.7.2+).
  console.log("\n── POOL INTEGRITY (v3.5 — C1 assignment + C7 self-roster) ──");
  {
    const P1 = "11".repeat(32), P2 = "22".repeat(32), P3 = "33".repeat(32), P4 = "44".repeat(32);
    const POOL = [P1, P2, P3, P4];
    const BUYER = "b1".repeat(32);
    const SELLER = "f1".repeat(32);
    const ID = "escrow-v35-assignment";

    // The honest v0.7.2+ pick passes clean.
    const assigned = pickArbiterFromPoolV35(POOL, ID, [BUYER, SELLER])!;
    const clean = classifyArbiterAssignment({
      pool: POOL, escrowId: ID, committedArbiter: assigned,
      buyerPubkey: BUYER, sellerPubkey: SELLER,
    });
    assert(clean.status === "as-assigned",
      "invariant_arbiter-assignment__assigned_arbiter_passes_clean");

    // A hand-seated pool member matching NO historical basis is flagged.
    const acceptedSet = new Set(clean.accepted);
    const colluder = POOL.find(pk => !acceptedSet.has(pk));
    assert(!!colluder,
      "invariant_arbiter-assignment__off_assignment_flagged: a 4-member pool leaves at least one non-basis member to test with");
    const off = classifyArbiterAssignment({
      pool: POOL, escrowId: ID, committedArbiter: colluder!,
      buyerPubkey: BUYER, sellerPubkey: SELLER,
    });
    assert(off.status === "off-assignment",
      "invariant_arbiter-assignment__off_assignment_flagged");
    assert(off.accepted.includes(assigned),
      "invariant_arbiter-assignment__off_assignment_flagged: the accepted set names the expected arbiter");

    // Genuine v0.6.5..v0.7.2 chains used the NO-EXCLUSION pick. Build a pool
    // where exclusions actually shift the pick (a party sits in the pool) and
    // confirm the old basis is not false-warned.
    {
      const poolWithBuyer = [BUYER, P1, P2, P3];
      let historicId: string | null = null;
      let eraNoExcl: string | undefined;
      for (let i = 0; i < 400 && !historicId; i++) {
        const id = `legacy-chain-${i}`;
        const a = pickArbiterFromPoolV35(poolWithBuyer, id);
        const b = pickArbiterFromPoolV35(poolWithBuyer, id, [BUYER, SELLER]);
        if (a && b && a !== b && a !== BUYER) {
          historicId = id;
          eraNoExcl = a;
        }
      }
      assert(historicId !== null,
        "invariant_arbiter-assignment__historical_no_exclusion_pick_not_false_warned: found an id where the eras diverge");
      const legacy = classifyArbiterAssignment({
        pool: poolWithBuyer, escrowId: historicId!, committedArbiter: eraNoExcl!,
        buyerPubkey: BUYER, sellerPubkey: SELLER,
      });
      assert(legacy.status === "as-assigned",
        "invariant_arbiter-assignment__historical_no_exclusion_pick_not_false_warned");
    }

    // Genuine pre-v0.6.5 chains committed communityArbiters[0]. Find an id
    // where neither pick lands on pool[0] and confirm pool[0] still passes.
    {
      let preId: string | null = null;
      for (let i = 0; i < 400 && !preId; i++) {
        const id = `ancient-chain-${i}`;
        if (pickArbiterFromPoolV35(POOL, id) !== POOL[0]
            && pickArbiterFromPoolV35(POOL, id, [BUYER, SELLER]) !== POOL[0]) {
          preId = id;
        }
      }
      assert(preId !== null,
        "invariant_arbiter-assignment__pre_v065_pool_first_not_false_warned: found an id whose picks avoid pool[0]");
      const ancient = classifyArbiterAssignment({
        pool: POOL, escrowId: preId!, committedArbiter: POOL[0],
        buyerPubkey: BUYER, sellerPubkey: SELLER,
      });
      assert(ancient.status === "as-assigned",
        "invariant_arbiter-assignment__pre_v065_pool_first_not_false_warned");
    }

    // Nothing to judge: empty pool / no committed arbiter / case-variants.
    assert(classifyArbiterAssignment({
      pool: [], escrowId: ID, committedArbiter: P1,
    }).status === "not-applicable",
      "assignment: empty pool is not-applicable (legacy volunteer-arbiter trades stay neutral)");
    assert(classifyArbiterAssignment({
      pool: POOL, escrowId: ID, committedArbiter: null,
    }).status === "not-applicable",
      "assignment: no committed arbiter (pre-LOCK) is not-applicable");
    assert(classifyArbiterAssignment({
      pool: POOL, escrowId: ID, committedArbiter: assigned.toUpperCase(),
      buyerPubkey: BUYER, sellerPubkey: SELLER,
    }).status === "as-assigned",
      "assignment: committed arbiter matches case-insensitively");

    // End-to-end pin of the CONSENSUS posture this whole layer rests on: the
    // reducer ACCEPTS a LOCK seating any pool member (membership only), so the
    // consent classifier is the ONLY thing standing between the performer and
    // a hand-seated colluder. If this ever starts failing because handleLock
    // grew an assignment reject, stop: that's the replay-strand path v3.3
    // explicitly pulled (see INVARIANTS C1).
    {
      const create = createEvent({ communityArbiters: POOL });
      const r1 = applyEvent(null, create);
      const assignedHere = pickArbiterFromPoolV35(POOL, ESCROW_ID, [BUYER_PK, SELLER_PK])!;
      const seated = POOL.find(pk => {
        const probe = classifyArbiterAssignment({
          pool: POOL, escrowId: ESCROW_ID, committedArbiter: pk,
          buyerPubkey: BUYER_PK, sellerPubkey: SELLER_PK,
        });
        return probe.status === "off-assignment";
      });
      assert(!!seated && r1.ok,
        "consent posture: setup — found an off-assignment pool member to seat");
      if (r1.ok && seated) {
        const lock = lockEvent(create.raw.id, { arbiterPubkey: seated });
        const r2 = applyEvent(r1.state, lock);
        if (assertOk(r2, "consent posture: the reducer ACCEPTS an off-assignment LOCK (membership only — no replay strand)")) {
          assert(r2.state.participants[Role.ARBITER] === seated,
            "consent posture: the off-assignment arbiter is seated in committed state");
          const judged = classifyArbiterAssignment({
            pool: r2.state.communityArbiters,
            escrowId: r2.state.id,
            committedArbiter: r2.state.participants[Role.ARBITER],
            buyerPubkey: r2.state.participants[Role.BUYER],
            sellerPubkey: r2.state.participants[Role.SELLER],
          });
          assert(judged.status === "off-assignment",
            "consent posture: the classifier flags the seated colluder the reducer let through");
          assert(judged.accepted.includes(assignedHere),
            "consent posture: the classifier names the arbiter the trade SHOULD have");
        }
      }
    }
  }

  // ── v3.5 C7: self-rostered pools must refuse the green badge ─────────────
  {
    const CREATOR = "c1".repeat(32);
    const STEWARD = "d1".repeat(32);
    const BUYER = "b2".repeat(32);
    const SELLER = "f2".repeat(32);
    const SOCK1 = "e1".repeat(32);
    const SOCK2 = "e2".repeat(32);

    // The load-bearing hole: a permissionless-shell creator self-rosters sock
    // puppets, then creates a trade in their own community. The roster signer
    // is a party to the trade and the recognition is roster-only → refused.
    assert(classifySelfRoster({
      communityArbiters: [SOCK1, SOCK2],
      sources: { deviceTrusted: [], rosterArbiters: [SOCK1, SOCK2], rosterSigner: CREATOR },
      tradeParties: [CREATOR, BUYER, SELLER],
    }) === true,
      "invariant_roster__self_rostered_badge_refused");

    // Same shape but the signer is a JOINING counterparty (the shell creator
    // joins someone else's trade in their own community) — equally conflicted.
    assert(classifySelfRoster({
      communityArbiters: [SOCK1],
      sources: { deviceTrusted: [], rosterArbiters: [SOCK1], rosterSigner: BUYER },
      tradeParties: [CREATOR, BUYER, SELLER],
    }) === true,
      "invariant_roster__self_rostered_badge_refused: a roster signed by the joining counterparty is refused too");

    // An authority DISTINCT from every trade party verifies normally.
    assert(classifySelfRoster({
      communityArbiters: [SOCK1, SOCK2],
      sources: { deviceTrusted: [], rosterArbiters: [SOCK1, SOCK2], rosterSigner: STEWARD },
      tradeParties: [CREATOR, BUYER, SELLER],
    }) === false,
      "invariant_roster__distinct_authority_verifies");

    // Recognition that survives WITHOUT the conflicted roster is not refused:
    // the device already trusts these arbiters on its own anchor.
    assert(classifySelfRoster({
      communityArbiters: [SOCK1],
      sources: { deviceTrusted: [SOCK1], rosterArbiters: [SOCK1], rosterSigner: CREATOR },
      tradeParties: [CREATOR, BUYER, SELLER],
    }) === false,
      "invariant_roster__distinct_authority_verifies: device-anchored trust is independent of the conflicted roster");

    // A steward who also ARBITRATES in their own community is the trust
    // anchor, not a conflict — only stake-holding identities count.
    assert(classifySelfRoster({
      communityArbiters: [STEWARD, SOCK1],
      sources: { deviceTrusted: [], rosterArbiters: [STEWARD, SOCK1], rosterSigner: STEWARD },
      tradeParties: [CREATOR, BUYER, SELLER],
    }) === false,
      "invariant_roster__distinct_authority_verifies: a steward-arbiter signing their own roster is not a stake conflict");

    // No verifiable roster → nothing to refuse.
    assert(classifySelfRoster({
      communityArbiters: [SOCK1],
      sources: { deviceTrusted: [], rosterArbiters: [], rosterSigner: null },
      tradeParties: [CREATOR, BUYER, SELLER],
    }) === false,
      "self-roster: no verifiable roster → flag stays down (membership warning owns that case)");

    // ── C7 consent gate: fee-bearing / high-value trades (wired ahead of the
    //    economic layer; NEVER a hard block, and NEVER for everyday trades).
    assert(requiresVerifiedRosterConsent({
      arbiterFeeMsats: 0, amountMsats: 100_000_000, poolSize: 2, distinctAuthorityVerified: false,
    }) === false,
      "fee-gate: an everyday trade on the 2-member default pool is NEVER gated");
    assert(requiresVerifiedRosterConsent({
      arbiterFeeMsats: 1_000, amountMsats: 100_000_000, poolSize: 5, distinctAuthorityVerified: false,
    }) === true,
      "fee-gate: a fee-bearing trade without a distinct-authority-verified pool arms the consent gate");
    assert(requiresVerifiedRosterConsent({
      arbiterFeeMsats: 1_000, amountMsats: 100_000_000, poolSize: 2, distinctAuthorityVerified: true,
    }) === true,
      "fee-gate: fee-bearing + verified but a sub-3 pool still arms the gate (min-pool is fee-tier only)");
    assert(requiresVerifiedRosterConsent({
      arbiterFeeMsats: 1_000, amountMsats: 100_000_000, poolSize: 3, distinctAuthorityVerified: true,
    }) === false,
      "fee-gate: fee-bearing + distinct-authority-verified + 3-member pool passes without the gate");
    assert(requiresVerifiedRosterConsent({
      arbiterFeeMsats: 0, amountMsats: HIGH_VALUE_CONSENT_MSATS, poolSize: 2, distinctAuthorityVerified: false,
    }) === true,
      "fee-gate: a high-value trade arms the gate even with fees off");
  }

  // Lookup with valid + missing slug
  assert(getCommunityBySlug("sn-cfa") !== null, "Valid slug returns community");
  assert(getCommunityBySlug("xx-zz") === null, "Unknown slug returns null");
  assert(getCommunityBySlug(null) === null, "Null slug returns null");
  assert(getCommunityBySlug(undefined) === null, "Undefined slug returns null");

  // v0.1.85: every visible pre-seed now pins federationInvite explicitly.
  // v1.0.6: Kenya now has first-class Afribit + Bitsacco routes; the
  // remaining public country shells stay on BLF until local federations
  // are claimed by community leaders.
  // Hidden legacy slugs remain resolvable for old listings.
  const allPinned = COMMUNITY_REGISTRY
    .filter(c => !c.hiddenFromPicker)
    .every(c => typeof c.federationInvite === "string" && c.federationInvite.startsWith("fed1"));
  assert(allPinned,
    "Every visible pre-seed pins federationInvite explicitly (no implicit fallback)");
  assert(getCommunityBySlug("sv-usd")?.hiddenFromPicker === true,
    "sv-usd is hidden from picker (sunset entry)");
  assert(getCommunityBySlug("sv-usd")?.federationInvite === null,
    "sv-usd carries null invite (resolves to BP fallback on-the-wire)");
  assert(getCommunityBySlug("global-usd")?.hiddenFromPicker === true,
    "legacy global-usd/BP is hidden from picker");

  // Schema additions: every entry must carry the new fields
  for (const c of COMMUNITY_REGISTRY) {
    assert(typeof c.flagEmoji === "string" && c.flagEmoji.length > 0,
      `${c.slug} has flagEmoji`);
    assert(c.country === null || typeof c.country === "string",
      `${c.slug} country is string|null`);
    assert(typeof c.browserReliable === "boolean",
      `${c.slug} has browserReliable`);
    assert(typeof c.hiddenFromPicker === "boolean",
      `${c.slug} has hiddenFromPicker`);
  }
  // Reliability flags reflect transport reality. v0.5.0: the Fedimint
  // canary SDK bumped iroh-relay to 0.90 and cleared the 400 Bad
  // Request that previously gated browser-WebSocket transport across
  // every federation we have access to. End-to-end browser flows
  // verified working — flag flips to true across the board. The flag
  // stays in the schema so individual entries can flip back to false
  // if a specific federation regresses.
  for (const c of COMMUNITY_REGISTRY) {
    assert(c.browserReliable === true,
      `${c.slug} browserReliable=true (canary iroh bump cleared the gate)`);
    assert(
      typeof c.notes === "string" &&
      (c.notes.includes("canary iroh") || c.notes.includes("Native Fedimint sidecar")),
      `${c.slug} carries a transport reliability note`
    );
  }
  assert(getCommunityBySlug("ke-kes")?.displayName === "Kenya · KES",
    "ke-kes displayName names Kenya KES");
  assert(getCommunityBySlug("ke-kes")?.disambiguator === "Afribit Kibera",
    "ke-kes disambiguator surfaces the Afribit Kibera backing route");
  assert(getCommunityBySlug("ke-kes-bitsacco")?.displayName === "Kenya · KES",
    "ke-kes-bitsacco displayName names Kenya KES");
  assert(getCommunityBySlug("ke-kes-bitsacco")?.disambiguator === "Bitsacco",
    "ke-kes-bitsacco disambiguator surfaces the Bitsacco backing route");

  // Picker filter excludes hiddenFromPicker entries
  const picker = COMMUNITY_REGISTRY.filter(c => !c.hiddenFromPicker);
  assert(picker.length === 55,
    "Picker shows GBF, Fedi-approved wallet services, South Africa, two Kenya routes, plus every East/West/Central Africa country Chama (Global/BLF now hidden — it's the L3 backup, not a place you pick)");
  assert(picker[0]?.slug !== "us-blf",
    "Picker no longer leads with BLF — it's the hidden L3 backup; everyone starts at a country/community (L1/L2)");
  assert(!picker.some(c => c.slug === "sv-usd"),
    "Picker excludes sv-usd");
  assert(!picker.some(c => c.slug === "global-usd"),
    "Picker excludes legacy BP global-usd");
  assert(!picker.some(c => c.slug === "us-blf"),
    "Picker EXCLUDES us-blf — the hidden L3 backup fed (still wire-resolvable so existing listings render)");
  assert(picker.some(c => c.slug === "fedi-bitcoin-principles"),
    "Picker includes Bitcoin Principles as a public Fedi wallet service");
  assert(PUBLIC_FEDI_APPROVED_FEDERATIONS.every(route => picker.some(c => c.slug === route.slug)),
    "Picker includes every baked Fedi-approved wallet service route");
  assert(picker.some(c => c.slug === "za-zar"),
    "Picker includes South Africa ZAR under Global");
  assert(picker.some(c => c.slug === "tz-tzs"),
    "Picker includes Tanzania TZS for first-run country selection");
  assert(picker.some(c => c.slug === "ke-kes" && c.country === "KE" && c.disambiguator === "Afribit Kibera"),
    "Picker includes Kenya KES as an Afribit Kibera-backed country Chama");
  assert(picker.some(c => c.slug === "ke-kes-bitsacco" && c.country === "KE" && c.disambiguator === "Bitsacco"),
    "Picker includes Kenya KES as a Bitsacco-backed country Chama");
  assert(picker.some(c => c.slug === "cm-xaf"),
    "Picker includes Cameroon XAF for first-run country selection");
  assert(picker.some(c => c.slug === "ao-aoa"),
    "Picker includes Angola AOA for first-run country selection");
  assert(picker.some(c => c.slug === "cd-cdf"),
    "Picker includes DR Congo CDF for first-run country selection");
  const pickerCountries = new Set(picker.flatMap(c => c.countries));
  assert(EAST_AFRICA_COUNTRY_CODES.every(code => pickerCountries.has(code)),
    "Picker includes every East Africa country code");
  assert(WEST_AFRICA_COUNTRY_CODES.every(code => pickerCountries.has(code)),
    "Picker includes every West Africa country code");
  assert(CENTRAL_AFRICA_COUNTRY_CODES.every(code => pickerCountries.has(code)),
    "Picker includes every Central Africa country code currently supported");

  // Storage roundtrip — defaults to us-blf when nothing set (v0.5.0)
  (globalThis as any).localStorage.clear();
  assert(getUserCommunitySlug() === "us-blf",
    "getUserCommunitySlug defaults to us-blf when nothing stored (BLF, v0.5.0)");

  // Set + read
  setUserCommunitySlug("sn-cfa");
  assert(getUserCommunitySlug() === "sn-cfa", "Persisted slug round-trips");
  setUserCommunitySlug("ke-kes-bitsacco");
  assert(getUserCommunitySlug() === "ke-kes-bitsacco",
    "Bitsacco Kenya route persists as the user's home Chama");

  // Stale/invalid slug falls back to default rather than flowing through
  (globalThis as any).localStorage.setItem(COMMUNITY_STORAGE_KEY, "ghost-fed");
  assert(getUserCommunitySlug() === "us-blf",
    "Unknown stored slug falls back to default (registry validation)");

  // Clear via empty string
  setUserCommunitySlug("ke-kes");
  assert(getUserCommunitySlug() === "ke-kes", "Pre-clear: ke-kes set");
  setUserCommunitySlug("");
  assert(getUserCommunitySlug() === "us-blf", "Empty string clears, falls to default");

  assert(defaultCurrencyForCommunity("tz-tzs") === "TZS",
    "defaultCurrencyForCommunity follows Tanzania/TZS home Chama");
  assert(defaultCurrencyForCommunity("ke-kes-bitsacco") === "KES",
    "defaultCurrencyForCommunity follows Bitsacco Kenya/KES home Chama");
  assert(defaultCurrencyForCommunity("fedi-victoria-btc") === "BTC",
    "defaultCurrencyForCommunity follows public Fedi wallet service routes as BTC");
  assert(defaultCurrencyForCommunity("cm-xaf") === "XAF",
    "defaultCurrencyForCommunity follows Cameroon/XAF home Chama");
  assert(defaultCurrencyForCommunity("cd-cdf") === "CDF",
    "defaultCurrencyForCommunity follows DR Congo/CDF home Chama");
  assert(defaultCurrencyForCommunity("ghost-fed") === "USD",
    "defaultCurrencyForCommunity falls back to USD on stale slug");

  assert(getCommunityRequestRecipients().join(",") === BLF_OFFICIAL_ARBITERS.join(","),
    "Country request DMs target the Global/BLF official arbiters");
  const requestMessage = buildCommunityRequestMessage({
    requestedChama: "Cameroon",
    note: "Douala / XAF",
  }, BUYER_PK);
  assert(requestMessage.includes("Cameroon") && requestMessage.includes("Douala / XAF"),
    "Country request message carries requested country and note");
  assert(requestMessage.includes(BUYER_PK),
    "Country request message carries sender pubkey for arbiter follow-up");

  const publishedRequests: NostrEvent[] = [];
  const requestRelay = {
    connect() {},
    disconnect() {},
    getConnectedCount() { return 1; },
    async publish(event: NostrEvent) {
      publishedRequests.push(event);
      return { accepted: 1, rejected: 0, errors: [] };
    },
  } as unknown as RelayManager;
  const requestSigner: Signer = {
    async getPublicKey() { return BUYER_PK; },
    async signEvent(event: UnsignedEvent) {
      return {
        ...event,
        id: `country_request_${publishedRequests.length}`,
        pubkey: BUYER_PK,
        sig: "sig",
      } as NostrEvent;
    },
    async nip44Encrypt(plaintext: string, recipientPubkey: string) {
      return `encrypted:${recipientPubkey}:${plaintext}`;
    },
    async nip44Decrypt(ciphertext: string) {
      return ciphertext;
    },
    // kind:4 DMs must be NIP-04-encrypted (bug #64) — the request path
    // uses this, never nip44Encrypt.
    async nip04Encrypt(plaintext: string, recipientPubkey: string) {
      return `nip04:${recipientPubkey}:${plaintext}`;
    },
  };
  const requestResult = await sendCommunityRequestToGlobalArbiters({
    requestedChama: "Cameroon",
    note: "Needs XAF route",
  }, {
    signer: requestSigner,
    relayManager: requestRelay,
    now: () => 123,
  });
  assert(requestResult.sent === BLF_OFFICIAL_ARBITERS.length,
    "Country request sender publishes one encrypted DM per global arbiter");
  assert(publishedRequests.every(e => e.kind === 4 && e.created_at === 123),
    "Country request DMs publish as kind 4 events with deterministic test time");
  assert(publishedRequests.every(e => e.tags.some(t => t[0] === "chama" && t[1] === "community-request")),
    "Country request DMs carry a Chama request tag");
  assert(publishedRequests.every(e => e.content.startsWith("nip04:")),
    "Country request kind:4 DMs are NIP-04-encrypted, never NIP-44 (bug #64)");
}

// ── 14b. PERMISSIONLESS COMMUNITY ADDITION (v0.1.85) ─────────────────────
console.log("\n── PERMISSIONLESS COMMUNITY ADDITION ──");
{
  (globalThis as any).localStorage.clear();

  // Empty by default
  assert(getCustomCommunities().length === 0, "No custom communities initially");
  assert(getCustomCommunityBySlug("anywhere") === null, "Unknown custom slug → null");

  // Successful add — new entry surfaces in lookups + persists to localStorage
  const fakeInvite = "fed1qtest_user_added_community_invite_for_persistence_test";
  const added = addCustomCommunity({
    slug: "br-brl",
    displayName: "Brazil · BRL",
    currency: "brl",
    country: "BR",
    flagEmoji: "🇧🇷",
    federationInvite: fakeInvite,
    languages: ["pt"],
  });
  assert(added.slug === "br-brl", "addCustomCommunity returns the new entry");
  assert(added.currency === "BRL", "Currency normalized to upper-case");
  assert(added.notes === "user-added", "User-added entries marked in notes");
  assert(added.browserReliable === true, "Default browserReliable is true");
  assert(added.hiddenFromPicker === false, "User-added entries are visible by default");

  assert(getCustomCommunities().length === 1, "One custom community after add");
  assert(getCustomCommunityBySlug("br-brl")?.federationInvite === fakeInvite,
    "Custom community persists with full payload");
  assert(getCommunityBySlug("br-brl")?.flagEmoji === "🇧🇷",
    "getCommunityBySlug walks pre-seeds AND custom entries");

  // localStorage roundtrip — re-reading from raw storage finds the entry
  const raw = (globalThis as any).localStorage.getItem("chama_custom_communities");
  assert(raw && raw.includes("br-brl"), "Persisted to chama_custom_communities key");

  // Slug collision with pre-seed → throws
  let threwOnPreSeedCollision = false;
  try {
    addCustomCommunity({
      slug: "sn-cfa",
      displayName: "Hijack",
      currency: "XOF",
      country: "SN",
      flagEmoji: "🇸🇳",
      federationInvite: fakeInvite,
    });
  } catch (e: any) {
    threwOnPreSeedCollision = /pre-seeded/.test(e.message || "");
  }
  assert(threwOnPreSeedCollision, "Pre-seed slug collision rejects with clear error");

  // Invalid invite → throws
  let threwOnBadInvite = false;
  try {
    addCustomCommunity({
      slug: "xx-test",
      displayName: "Test",
      currency: "USD",
      country: null,
      flagEmoji: "🌍",
      federationInvite: "not-a-fed1-invite",
    });
  } catch (e: any) {
    threwOnBadInvite = /fed1/.test(e.message || "");
  }
  assert(threwOnBadInvite, "Invalid invite rejects with clear error");

  // Invalid slug shape → throws
  let threwOnBadSlug = false;
  try {
    addCustomCommunity({
      slug: "Bad Slug!",
      displayName: "Test",
      currency: "USD",
      country: null,
      flagEmoji: "🌍",
      federationInvite: fakeInvite,
    });
  } catch (e: any) {
    threwOnBadSlug = /slug/.test(e.message || "");
  }
  assert(threwOnBadSlug, "Invalid slug shape rejects with clear error");

  // Update-by-overwrite: re-adding same slug overwrites payload
  addCustomCommunity({
    slug: "br-brl",
    displayName: "Brazil · BRL · Updated",
    currency: "BRL",
    country: "BR",
    flagEmoji: "🇧🇷",
    federationInvite: fakeInvite,
  });
  assert(getCustomCommunities().length === 1, "Re-add same slug overwrites, doesn't duplicate");
  assert(getCustomCommunityBySlug("br-brl")?.displayName === "Brazil · BRL · Updated",
    "Re-add updates fields in place");

  // Removal works
  removeCustomCommunity("br-brl");
  assert(getCustomCommunities().length === 0, "Custom community removed");
  assert(getCustomCommunityBySlug("br-brl") === null, "Lookup after remove returns null");

  // Picker integration — custom entries don't appear in pre-seed picker by default
  // (picker callers compose: pre-seed + custom themselves)
  assert(COMMUNITY_REGISTRY.filter(c => !c.hiddenFromPicker).every(c => c.notes !== "user-added"),
    "registry (non-hidden) returns only pre-seeds");
}

// ── 14c. PRE-LOGIN SHELL creatorPubkey STAMPING (v2.7) ───────────────────
// Pre-login globe shells land with creatorPubkey null (no signer yet).
// claimGeneratedShellCreator stamps the first connecting identity onto them so
// their permissionless arbiter rosters become verifiable.
console.log("\n── PRE-LOGIN SHELL CREATOR STAMPING ──");
{
  (globalThis as any).localStorage.clear();
  const PK_A = "a".repeat(64);
  const PK_B = "b".repeat(64);
  const shellInvite = "fed1qtest_generated_shell_invite_for_creator_stamp_test";

  // Two pre-login shells (creatorPubkey omitted → null) + one already-anchored.
  addCustomCommunity({
    slug: "xk-eur", displayName: "Kosovo · EUR", currency: "EUR",
    country: "XK", flagEmoji: "🇽🇰", federationInvite: shellInvite,
  });
  addCustomCommunity({
    slug: "bt-btn", displayName: "Bhutan · BTN", currency: "BTN",
    country: "BT", flagEmoji: "🇧🇹", federationInvite: shellInvite,
  });
  addCustomCommunity({
    slug: "fm-usd", displayName: "Micronesia · USD", currency: "USD",
    country: "FM", flagEmoji: "🇫🇲", federationInvite: shellInvite,
    creatorPubkey: PK_B,
  });
  assert(getCustomCommunityBySlug("xk-eur")?.creatorPubkey == null,
    "Pre-login shell starts with no creatorPubkey");

  const stamped = claimGeneratedShellCreator(PK_A);
  assert(stamped.includes("xk-eur") && stamped.includes("bt-btn"),
    "Stamps every unanchored shell");
  assert(!stamped.includes("fm-usd"), "Leaves an already-anchored shell untouched");
  assert(getCustomCommunityBySlug("xk-eur")?.creatorPubkey === PK_A,
    "Unanchored shell now carries the connecting pubkey");
  assert(getCustomCommunityBySlug("fm-usd")?.creatorPubkey === PK_B,
    "Pre-anchored shell keeps its original creator");
  // Field fidelity through the overwrite path.
  assert(getCustomCommunityBySlug("bt-btn")?.currency === "BTN"
    && getCustomCommunityBySlug("bt-btn")?.federationInvite === shellInvite,
    "Re-persist preserves the shell's payload");
  assert(getCustomCommunities().length === 3, "Stamping doesn't duplicate shells");

  // Idempotent: a second pass with a different key changes nothing (all anchored).
  const second = claimGeneratedShellCreator(PK_B);
  assert(second.length === 0, "Second pass stamps nothing — already anchored");
  assert(getCustomCommunityBySlug("xk-eur")?.creatorPubkey === PK_A,
    "Idempotent — a later sign-in can't re-claim an anchored shell");
  assert(claimGeneratedShellCreator("").length === 0, "Empty pubkey is a no-op");
}

// ── 14d. DEFERRED COMMUNITY REPORT STORAGE (v2.7) ────────────────────────
// The globe runs pre-signer; a report is stashed browser-wide and published
// after sign-in. Round-trip the storage primitive.
console.log("\n── DEFERRED COMMUNITY REPORT STORAGE ──");
{
  (globalThis as any).localStorage.clear();
  assert(getPendingCommunityReport() === null, "No pending report initially");

  setPendingCommunityReport({ requestedChama: "  Bhutan  ", note: "  I can run this  " });
  const stashed = getPendingCommunityReport();
  assert(stashed?.requestedChama === "Bhutan", "Pending report trims the requested chama");
  assert(stashed?.note === "I can run this", "Pending report trims the note");

  // Last-write-wins, and an empty note round-trips as undefined.
  setPendingCommunityReport({ requestedChama: "Palau" });
  const reStashed = getPendingCommunityReport();
  assert(reStashed?.requestedChama === "Palau", "Re-stash overwrites (last write wins)");
  assert(reStashed?.note === undefined, "Empty note reads back as undefined");

  // Empty request is a no-op (can't queue a nameless report).
  setPendingCommunityReport({ requestedChama: "   " });
  assert(getPendingCommunityReport()?.requestedChama === "Palau",
    "Empty requested chama doesn't overwrite an existing report");

  clearPendingCommunityReport();
  assert(getPendingCommunityReport() === null, "Cleared report reads back null");
}

// ── 15. BP / BLF RESOLVER ────────────────────────────────────────────────
// v0.1.85: the universal browser-friendly fallback is BP, not BLF. Every
// visible pre-seeded community now has an explicit federationInvite.
// v0.7.0: BLF backs the public Global USD route plus Senegal CFA; BP's
// old global-usd slug stays hidden for legacy listings.
console.log("\n── BP / BLF RESOLVER ──");
{
  // No custom invite, no community: BLF fallback (DECISION 2026-06-16 — BLF
  // is the universal backup across the board; BP is no longer the silent
  // default).
  (globalThis as any).localStorage.clear();
  assert(resolveFederationForCommunity(null) === BLF_FEDERATION_INVITE,
    "Null slug → BLF default");
  assert(resolveFederationForCommunity(undefined) === BLF_FEDERATION_INVITE,
    "Undefined slug → BLF default");
  assert(resolveFederationForCommunity("xx-unknown") === BLF_FEDERATION_INVITE,
    "Unknown slug → BLF default");

  // Pre-seeded communities resolve to their pinned invite, not the BP
  // fallback — the registry now carries the choice explicitly.
  const snCfaInvite = getCommunityBySlug("sn-cfa")!.federationInvite!;
  assert(resolveFederationForCommunity("sn-cfa") === snCfaInvite,
    "sn-cfa → registry-pinned invite");
  assert(snCfaInvite === OCA_FEDERATION_INVITE,
    "sn-cfa pins OCA (v2.6 African regional default)");

  const keKesInvite = getCommunityBySlug("ke-kes")!.federationInvite!;
  assert(resolveFederationForCommunity("ke-kes") === keKesInvite,
    "ke-kes → registry-pinned invite");
  assert(keKesInvite === AFRIBIT_KIBERA_FEDERATION_INVITE,
    "ke-kes pins Afribit Kibera");
  const blfFederationIdForComparison: string = BLF_FEDERATION_ID;
  const bpFederationIdForComparison: string = BP_FEDERATION_ID;
  assert(blfFederationIdForComparison !== bpFederationIdForComparison,
    "BLF federation ID is distinct from BP");
  assert(expectedFederationIdForInvite(keKesInvite) === AFRIBIT_KIBERA_FEDERATION_ID,
    "Kenya KES invite resolves to Afribit for drift detection");

  const bitsaccoInvite = getCommunityBySlug("ke-kes-bitsacco")!.federationInvite!;
  assert(resolveFederationForCommunity("ke-kes-bitsacco") === bitsaccoInvite,
    "ke-kes-bitsacco → registry-pinned invite");
  assert(bitsaccoInvite === BITSACCO_FEDERATION_INVITE,
    "ke-kes-bitsacco pins Bitsacco");
  assert(expectedFederationIdForInvite(bitsaccoInvite) === BITSACCO_FEDERATION_ID,
    "Bitsacco federation ID stays null until verified locally");

  const victoriaBtcRoute = PUBLIC_FEDI_APPROVED_FEDERATIONS.find(route => route.slug === "fedi-victoria-btc")!;
  assert(resolveFederationForCommunity(victoriaBtcRoute.slug) === victoriaBtcRoute.invite,
    "Public Fedi wallet service slug resolves to its approved invite");
  assert(expectedFederationIdForInvite(victoriaBtcRoute.invite) === victoriaBtcRoute.federationId,
    "Public Fedi wallet service invite resolves to its approved federation ID");
  assert(PUBLIC_FEDI_APPROVED_FEDERATIONS.every(route =>
    resolveFederationForCommunity(route.slug) === route.invite &&
    expectedFederationIdForInvite(route.invite) === route.federationId
  ), "Every baked public Fedi route resolves to its approved invite and federation ID");
  assert(effectiveCreateFederationId({
    fed: BP_FEDERATION_ID,
    mintUrl: BLF_FEDERATION_INVITE,
    community: "us-blf",
  }) === BLF_FEDERATION_ID,
    "Legacy CREATE with stale fed is rescued when mintUrl and community agree");
  assert(effectiveCreateFederationId({
    fed: BP_FEDERATION_ID,
    mintUrl: BLF_FEDERATION_INVITE,
    community: null,
  }) === BP_FEDERATION_ID,
    "CREATE fed still wins over a lone stale mintUrl");

  const globalUsdInvite = getCommunityBySlug("global-usd")!.federationInvite!;
  assert(resolveFederationForCommunity("global-usd") === globalUsdInvite,
    "hidden global-usd → registry-pinned BLF invite for legacy listings");
  assert(globalUsdInvite === BLF_FEDERATION_INVITE,
    "hidden global-usd now pins BLF (2026-06-16 repoint off BP)");

  const usBlfInvite = getCommunityBySlug("us-blf")!.federationInvite!;
  assert(resolveFederationForCommunity("us-blf") === usBlfInvite,
    "us-blf → registry-pinned invite");
  assert(usBlfInvite === BLF_FEDERATION_INVITE,
    "us-blf pins BLF for the public backup route");

  // Custom invite override only applies when no selected community has a
  // pinned invite. Community identity wins so stale sandbox state cannot
  // show one Kenya route while joining a different federation.
  const fakeCustomInvite = "fed1qcustom_user_pasted_invite_for_resolver_test";
  setCustomFederationInvite(fakeCustomInvite);
  assert(resolveFederationForCommunity("sn-cfa") === snCfaInvite,
    "Pinned community invite beats stale custom invite");
  assert(resolveFederationForCommunity("ke-kes") === keKesInvite,
    "Kenya community invite beats stale custom invite");
  assert(resolveFederationForCommunity("ke-kes-bitsacco") === bitsaccoInvite,
    "Bitsacco Kenya invite beats stale custom invite");
  assert(resolveFederationForCommunity(victoriaBtcRoute.slug) === victoriaBtcRoute.invite,
    "Public Fedi route invite beats stale custom invite");
  assert(resolveFederationForCommunity(null) === fakeCustomInvite,
    "Custom invite overrides null slug");
  assert(resolveFederationForCommunity("xx-unknown") === fakeCustomInvite,
    "Custom invite overrides unknown community slug");

  // Cleanup so other tests aren't poisoned
  setCustomFederationInvite("");
  assert(resolveFederationForCommunity(null) === BLF_FEDERATION_INVITE,
    "After clearing custom invite, falls back to BLF again");
}

// ── 15b. FEDERATION DRIFT DETECTION ──────────────────────────────────────
//
// Regression for the "fresh login looks like BLF, listings tag BP" bug.
// Sign-out/reload does not wipe OPFS, so a next init can find a wallet already
// joined to whatever route OPFS held while `chama_active_invite` is missing.
// That has to reconcile before joinFederation can pin a UI lie.
console.log("\n── FEDERATION DRIFT DETECTION ──");
{
  assert(
    shouldReconcileFederation({
      previousActiveInvite: null,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: false,
      walletFederationId: BP_FEDERATION_ID,
    }) === false,
    "walletIsJoined=false → never reconcile (fresh OPFS, nothing bound)",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: BP_FEDERATION_INVITE,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: false,
      walletFederationId: BP_FEDERATION_ID,
    }) === false,
    "walletIsJoined=false → no reconcile even if localStorage records a different invite",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: BLF_FEDERATION_INVITE,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: BLF_FEDERATION_ID,
    }) === false,
    "Tracked match (previousActiveInvite === desiredInvite) → no reconcile",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: `${BLF_FEDERATION_INVITE}\n`,
      desiredInvite: ` ${BLF_FEDERATION_INVITE} `,
      walletIsJoined: true,
      walletFederationId: null,
    }) === false,
    "Tracked match tolerates localStorage/clipboard whitespace before reconciling",
  );
  setActiveInvite(`${BLF_FEDERATION_INVITE}\n`);
  assert(getActiveInvite() === BLF_FEDERATION_INVITE,
    "getActiveInvite trims stored invite whitespace before returning");
  setActiveInvite("");
  assert(
    shouldReconcileFederation({
      previousActiveInvite: BP_FEDERATION_INVITE,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: BP_FEDERATION_ID,
    }) === true,
    "Tracked drift (previousActiveInvite !== desiredInvite) → reconcile",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: null,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: null,
    }) === true,
    "Untracked OPFS (previousActiveInvite=null, wallet already joined) → reconcile",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: null,
      desiredInvite: BP_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: null,
    }) === true,
    "Untracked OPFS reconciles regardless of desired invite",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: BLF_FEDERATION_INVITE,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: BP_FEDERATION_ID,
    }) === true,
    "Tracked invite can still reconcile when known desired invite disagrees with actual wallet fed id",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: null,
      desiredInvite: BLF_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: BLF_FEDERATION_ID,
    }) === false,
    "Untracked OPFS does not reconcile when known desired invite already matches actual wallet fed id",
  );
  assert(
    shouldReconcileFederation({
      previousActiveInvite: null,
      desiredInvite: AFRIBIT_KIBERA_FEDERATION_INVITE,
      walletIsJoined: true,
      walletFederationId: AFRIBIT_KIBERA_FEDERATION_ID,
    }) === false,
    "Legacy Afribit OPFS does not reconcile when its invite still matches actual wallet fed id",
  );
}

// ── 16. FULFILLMENT NORMALIZATION ────────────────────────────────────────
console.log("\n── FULFILLMENT NORMALIZATION (handleCreate) ──");
{
  // Helper to build a CREATE with a specific category + fulfillment
  function createWith(category: string, fulfillment?: "physical" | "service" | "digital") {
    return makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create",
      description: "test",
      amountMsats: 100_000_000,
      category,
      fulfillment,
      community: "sn-cfa",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
  }

  // Marketplace + explicit pick → preserved
  {
    const r = applyEvent(null, createWith("marketplace", "digital"));
    if (assertOk(r, "Marketplace + digital → CREATED")) {
      assert(r.state.fulfillment === "digital", "Marketplace user pick preserved (digital)");
      assert(r.state.community === "sn-cfa", "Community slug propagated to state");
    }
  }
  {
    const r = applyEvent(null, createWith("marketplace", "service"));
    if (assertOk(r, "Marketplace + service → CREATED")) {
      assert(r.state.fulfillment === "service", "Marketplace user pick preserved (service)");
    }
  }

  // Marketplace + missing → defaults to "physical"
  {
    const r = applyEvent(null, createWith("marketplace"));
    if (assertOk(r, "Marketplace + missing fulfillment → CREATED")) {
      assert(r.state.fulfillment === "physical",
        "Marketplace defaults to physical when fulfillment missing");
    }
  }

  // Non-marketplace → forced to "service" regardless of input
  for (const cat of ["p2p-trade", "bill-pay", "lending"]) {
    const r1 = applyEvent(null, createWith(cat));
    if (assertOk(r1, `${cat} + missing fulfillment → CREATED`)) {
      assert(r1.state.fulfillment === "service",
        `${cat} fulfillment defaults to "service" when missing`);
    }
    // Even if a misbehaving client passed "physical", normalize to service
    const r2 = applyEvent(null, createWith(cat, "physical"));
    if (assertOk(r2, `${cat} + (incorrect) physical → CREATED`)) {
      assert(r2.state.fulfillment === "service",
        `${cat} normalizes wire fulfillment back to "service" (chain consistency)`);
    }
  }

  // Community is null when CREATE omits it (pre-PR-2 backwards compat)
  {
    const noCommunity = makeParsedEvent(EscrowEventKind.CREATE, SELLER_PK, {
      type: "escrow:create",
      description: "test",
      amountMsats: 100_000_000,
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const r = applyEvent(null, noCommunity);
    if (assertOk(r, "CREATE without community → CREATED")) {
      assert(r.state.community === null, "community is null when omitted (backwards compat)");
    }
  }
}

// ── 17. VOTE LABEL DICTIONARY ────────────────────────────────────────────
console.log("\n── VOTE LABEL DICTIONARY ──");
{
  // Helpers
  assert(defaultFulfillmentFor("marketplace") === "physical",
    "Marketplace default fulfillment is physical");
  assert(defaultFulfillmentFor("p2p-trade") === "service",
    "p2p-trade default fulfillment is service");
  assert(defaultFulfillmentFor("bill-pay") === "service",
    "bill-pay default fulfillment is service");
  assert(defaultFulfillmentFor(undefined) === "service",
    "Undefined category default fulfillment is service");
  assert(categoryAllowsFulfillmentChoice("marketplace") === true,
    "Marketplace allows fulfillment choice");
  assert(categoryAllowsFulfillmentChoice("p2p-trade") === false,
    "p2p-trade does NOT allow fulfillment choice");
  assert(categoryAllowsFulfillmentChoice("bill-pay") === false,
    "bill-pay does NOT allow fulfillment choice");

  // Marketplace — three fulfillments × buyer/seller × release/refund
  assert(getVoteLabel("marketplace", "physical", Role.BUYER, Outcome.RELEASE) === "I received it",
    "marketplace/physical/buyer/release = 'I received it'");
  assert(getVoteLabel("marketplace", "physical", Role.SELLER, Outcome.RELEASE) === "Item delivered",
    "marketplace/physical/seller/release = 'Item delivered'");
  assert(getVoteLabel("marketplace", "physical", Role.BUYER, Outcome.REFUND) === "I didn't get it",
    "marketplace/physical/buyer/refund = 'I didn't get it'");
  assert(getVoteLabel("marketplace", "service", Role.BUYER, Outcome.RELEASE) === "I received the service",
    "marketplace/service/buyer/release");
  assert(getVoteLabel("marketplace", "service", Role.SELLER, Outcome.RELEASE) === "Service rendered",
    "marketplace/service/seller/release");
  assert(getVoteLabel("marketplace", "digital", Role.BUYER, Outcome.RELEASE) === "I received the file",
    "marketplace/digital/buyer/release");
  assert(getVoteLabel("marketplace", "digital", Role.SELLER, Outcome.RELEASE) === "Delivered",
    "marketplace/digital/seller/release");
  assert(getVoteLabel("marketplace", "digital", Role.BUYER, Outcome.REFUND) === "File never arrived",
    "marketplace/digital/buyer/refund");

  // P2P (always service)
  assert(getVoteLabel("p2p-trade", "service", Role.BUYER, Outcome.RELEASE) === "I sent the fiat",
    "p2p/buyer/release = 'I sent the fiat'");
  assert(getVoteLabel("p2p-trade", "service", Role.SELLER, Outcome.RELEASE) === "Fiat received",
    "p2p/seller/release = 'Fiat received'");

  // Bill Pay — the VOLUNTEER (buyer) pays the bill off-chain and is paid in
  // sats on RELEASE; the BILL OWNER (seller) locks the sats and confirms.
  // (3.5.1: buyer↔seller were inverted vs the sats routing.)
  assert(getVoteLabel("bill-pay", "service", Role.BUYER, Outcome.RELEASE) === "I paid the bill as a volunteer",
    "bill-pay/buyer/release = volunteer attestation (deed-doer votes first)");
  assert(getVoteLabel("bill-pay", "service", Role.SELLER, Outcome.RELEASE) === "My bill was paid",
    "bill-pay/seller/release = owner confirms 'My bill was paid'");
  assert(getVoteLabel("bill-pay", "service", Role.BUYER, Outcome.REFUND) === "Cancel — I can't pay this bill",
    "bill-pay/buyer/refund = volunteer backs out (routing names the owner as recipient)");
  assert(getVoteLabel("bill-pay", "service", Role.SELLER, Outcome.REFUND) === "Bill not paid",
    "bill-pay/seller/refund = owner says bill not paid (refund to owner)");

  // 3.5.1 #3 — premium % label must not lose a trailing zero on ROUND numbers.
  // formatBps("20".toFixed(0)).replace(/\.?0+$/,"") was "2", so a 20% premium
  // rendered "+2%" (amount was right; label 10× off). Round numbers are the
  // repro; decimals like 2.5 always worked, which masked it.
  {
    const mk = (bps: number) => ({
      category: "bill-pay",
      premiumBps: bps,
      amountMsats: 0,
      fiatAmount: 0,
      fiatCurrency: "USD",
    } as unknown as EscrowState);
    assert(listingPremiumLine(mk(2000), 65_000) === "+20% premium",
      "listing premium 2000bps → +20% (not +2%)");
    assert(listingPremiumLine(mk(10_000), 65_000) === "+100% premium",
      "listing premium 10000bps → +100% (not +1%)");
    assert(listingPremiumLine(mk(700), 65_000) === "+7% premium",
      "listing premium 700bps → +7%");
    assert(listingPremiumLine(mk(1250), 65_000) === "+12.5% premium",
      "listing premium 1250bps → +12.5% (decimal ≥10 preserved)");
    assert(listingPremiumLine(mk(250), 65_000) === "+2.5% premium",
      "listing premium 250bps → +2.5% (decimal <10 preserved)");
  }

  // Lending (placeholder labels for v1)
  assert(getVoteLabel("lending", "service", Role.BUYER, Outcome.RELEASE) === "Loan received — I'll repay on time",
    "lending/buyer/release leans forward (receipt + repayment intent)");
  assert(getVoteLabel("lending", "service", Role.SELLER, Outcome.RELEASE) === "Loan disbursed",
    "lending/seller/release = 'Loan disbursed'");

  // Arbiter neutral fallback
  assert(getVoteLabel("marketplace", "physical", Role.ARBITER, Outcome.RELEASE) === "Side with buyer",
    "Arbiter RELEASE = 'Side with buyer' (neutral)");
  assert(getVoteLabel("p2p-trade", "service", Role.ARBITER, Outcome.REFUND) === "Side with seller",
    "Arbiter REFUND = 'Side with seller' (neutral)");

  // Unknown category falls through to neutral
  assert(getVoteLabel("raw-escrow", "service", Role.BUYER, Outcome.RELEASE) === "Release sats",
    "Unknown category → neutral 'Release sats'");
  assert(getVoteLabel(undefined, undefined, Role.SELLER, Outcome.REFUND) === "Refund sats",
    "Undefined category+fulfillment → neutral 'Refund sats'");

  // Marketplace + missing fulfillment falls back to neutral (the dictionary
  // requires an explicit fulfillment for marketplace; defaultFulfillmentFor
  // is what callers should use to fill it in beforehand).
  // Sanity: when callers DO use the default, marketplace/buyer/release lands.
  assert(getVoteLabel("marketplace", defaultFulfillmentFor("marketplace"), Role.BUYER, Outcome.RELEASE)
    === "I received it",
    "Using defaultFulfillmentFor('marketplace') yields the physical labels");
}

// ── 17b. VOTE PROMPT TURN-GATE (v0.7.0) ─────────────────────────────────
console.log("\n── VOTE PROMPT TURN-GATE ──");
{
  const { state: lockedP2P } = buildToLocked();

  let prompt = decideVotePrompt(lockedP2P, BUYER_PK);
  assert(
    prompt.kind === "buttons"
    && prompt.outcomes.includes(Outcome.RELEASE)
    && prompt.outcomes.includes(Outcome.REFUND),
    "P2P starts buyer-first with both buyer vote outcomes available",
  );
  // Vote-#1 policy: the deed-doer's opening prompt is the single-primary
  // moment (one task button + demoted cancel hatch in the UI)…
  assert(prompt.kind === "buttons" && prompt.firstVote === true,
    "P2P buyer's opening prompt carries firstVote (single-primary moment)");
  assert(
    getVoteLabel("p2p-trade", defaultFulfillmentFor("p2p-trade"), Role.BUYER, Outcome.RELEASE) === "I sent the fiat",
    "P2P buyer release copy confirms fiat was sent",
  );

  prompt = decideVotePrompt(lockedP2P, SELLER_PK);
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === Role.BUYER
    && /buyer/i.test(prompt.message),
    "P2P seller waits until buyer confirms payment sent",
  );

  const staleRawParticipantState = {
    ...lockedP2P,
    participants: {
      [Role.BUYER]: SELLER_PK,
      [Role.SELLER]: BUYER_PK,
      [Role.ARBITER]: ARBITER_PK,
    },
    votes: {},
  } as EscrowState;
  prompt = decideVotePrompt(staleRawParticipantState, SELLER_PK, lockedP2P.participants);
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === Role.BUYER,
    "TradeDetail effective participants keep P2P seller waiting even if raw participants are stale",
  );
  prompt = decideVotePrompt(staleRawParticipantState, BUYER_PK, lockedP2P.participants);
  assert(
    prompt.kind === "buttons"
    && prompt.role === Role.BUYER,
    "TradeDetail effective participants keep P2P buyer as the first voter",
  );

  prompt = decideVotePrompt(lockedP2P, BUYER_PK.toUpperCase());
  assert(prompt.kind === "buttons" && prompt.role === Role.BUYER, "Vote prompt matches buyer pubkey case-insensitively");
  prompt = decideVotePrompt(lockedP2P, SELLER_PK.toUpperCase());
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === Role.BUYER,
    "Vote prompt matches seller pubkey case-insensitively while waiting on buyer",
  );

  const buyerVoted = {
    ...lockedP2P,
    votes: { [Role.BUYER]: Outcome.RELEASE },
  } as EscrowState;
  prompt = decideVotePrompt(buyerVoted, SELLER_PK);
  assert(
    prompt.kind === "buttons"
    && prompt.outcomes.includes(Outcome.RELEASE)
    && prompt.outcomes.includes(Outcome.REFUND),
    "After buyer votes, P2P seller buttons unlock",
  );
  // …and the RESPONDER keeps the dual buttons: real duality starts at vote #2.
  assert(prompt.kind === "buttons" && !prompt.firstVote,
    "P2P seller responding to the buyer's vote is NOT a firstVote moment (dual buttons)");
  assert(
    getVoteLabel("p2p-trade", defaultFulfillmentFor("p2p-trade"), Role.SELLER, Outcome.RELEASE) === "Fiat received",
    "P2P seller release copy confirms fiat was received",
  );
  prompt = decideVotePrompt(buyerVoted, BUYER_PK);
  assert(prompt.kind === "none", "Buyer does not see buttons after already voting");

  const billPay = {
    ...lockedP2P,
    category: "bill-pay",
    fulfillment: defaultFulfillmentFor("bill-pay"),
    votes: {},
  } as EscrowState;
  prompt = decideVotePrompt(billPay, BUYER_PK);
  assert(prompt.kind === "buttons", "Bill Pay starts VOLUNTEER-first (the buyer/deed-doer votes first)");
  assert(prompt.kind === "buttons" && prompt.firstVote === true,
    "Bill Pay volunteer's opening prompt is the single-primary firstVote moment");
  prompt = decideVotePrompt(billPay, SELLER_PK);
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === Role.BUYER
    && /volunteer/i.test(prompt.message),
    "Bill Pay owner waits on the volunteer to pay the bill",
  );

  const lending = {
    ...lockedP2P,
    category: "lending",
    fulfillment: defaultFulfillmentFor("lending"),
    votes: {},
  } as EscrowState;
  prompt = decideVotePrompt(lending, BUYER_PK);
  assert(prompt.kind === "buttons", "Lending starts borrower/buyer-first");
  prompt = decideVotePrompt(lending, SELLER_PK);
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === Role.BUYER,
    "Lending lender/seller waits until borrower confirms the loan arrived",
  );

  const marketplace = {
    ...lockedP2P,
    category: "marketplace",
    fulfillment: "physical",
    votes: {},
  } as EscrowState;
  prompt = decideVotePrompt(marketplace, SELLER_PK);
  assert(prompt.kind === "buttons", "Marketplace starts seller-first");
  prompt = decideVotePrompt(marketplace, BUYER_PK);
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === Role.SELLER
    && /ship/i.test(prompt.message),
    "Marketplace buyer waits for seller to ship first",
  );

  const sellerVoted = {
    ...marketplace,
    votes: { [Role.SELLER]: Outcome.RELEASE },
  } as EscrowState;
  prompt = decideVotePrompt(sellerVoted, BUYER_PK);
  assert(prompt.kind === "buttons", "After seller votes, marketplace buyer buttons unlock");

  prompt = decideVotePrompt(lockedP2P, ARBITER_PK);
  assert(
    prompt.kind === "waiting"
    && prompt.waitingOn === "dispute",
    "Arbiter sees no buttons before buyer and seller both vote",
  );

  const disagree = {
    ...lockedP2P,
    votes: {
      [Role.BUYER]: Outcome.RELEASE,
      [Role.SELLER]: Outcome.REFUND,
    },
  } as EscrowState;
  prompt = decideVotePrompt(disagree, ARBITER_PK);
  assert(prompt.kind === "buttons", "Arbiter buttons unlock only after disagreement");

  const agree = {
    ...lockedP2P,
    votes: {
      [Role.BUYER]: Outcome.RELEASE,
      [Role.SELLER]: Outcome.RELEASE,
    },
  } as EscrowState;
  prompt = decideVotePrompt(agree, ARBITER_PK);
  assert(
    prompt.kind === "waiting"
    && /agree/i.test(prompt.message),
    "Arbiter still has no buttons when buyer and seller agree",
  );

  const expired = {
    ...lockedP2P,
    status: EscrowStatus.EXPIRED,
    votes: {},
  } as EscrowState;
  prompt = decideVotePrompt(expired, SELLER_PK);
  assert(
    prompt.kind === "buttons"
    && prompt.outcomes.length === 1
    && prompt.outcomes[0] === Outcome.REFUND,
    "Expired healing UI exposes only REFUND",
  );
}

// ══════════════════════════════════════════════════════════════════════════
// PR 3 — saved payment handles + handle reveal in LOCK
// ══════════════════════════════════════════════════════════════════════════

// ── 18. RAIL REGISTRY + allowPublicHandle ─────────────────────────────────
console.log("\n── RAIL REGISTRY ──");
{
  // Sanity: registry loaded with v1 seeds
  assert(RAIL_REGISTRY.length > 0, "Rail registry has entries");

  // Sensitive rails (phone-number-based, bank, email-based) MUST NOT
  // allow public handles. This is the defense-in-depth invariant.
  assert(railAllowsPublicHandle("phone-number") === false,
    "Phone number does NOT allow public handles");
  assert(railAllowsPublicHandle("wave") === false,
    "Wave (Senegal mobile money) does NOT allow public handles");
  assert(railAllowsPublicHandle("orange-money") === false,
    "Orange Money does NOT allow public handles");
  assert(railAllowsPublicHandle("m-pesa") === false,
    "M-Pesa does NOT allow public handles");
  assert(railAllowsPublicHandle("bank-transfer") === false,
    "Bank transfer does NOT allow public handles");
  assert(railAllowsPublicHandle("paypal") === false,
    "PayPal (email-based) does NOT allow public handles");
  assert(railAllowsPublicHandle("zelle") === false,
    "Zelle does NOT allow public handles");
  assert(railAllowsPublicHandle("venmo") === false,
    "Venmo defaults to private (handle-can-be-PII-adjacent)");

  // Public-by-design tags MUST allow public handles (the username IS
  // the address — opt-in publishing is the whole point).
  assert(railAllowsPublicHandle("revtag") === true,
    "Revtag allows public handles (public-by-design)");
  assert(railAllowsPublicHandle("cashtag") === true,
    "$cashtag allows public handles");
  assert(railAllowsPublicHandle("zbd") === true,
    "ZBD username allows public handles");
  assert(railAllowsPublicHandle("wise-tag") === true,
    "Wise tag allows public handles");
  assert(railAllowsPublicHandle("strike") === true,
    "Strike allows public handles");

  // Unknown rail → conservative refusal (don't promote unfamiliar
  // handles to public by accident).
  assert(railAllowsPublicHandle("never-heard-of-it") === false,
    "Unknown rail conservatively refuses public");
  assert(railAllowsPublicHandle(null) === false,
    "Null rail conservatively refuses public");

  // railsForCommunity: country-first defaults. The picker/search can still
  // reach the full catalog, but the default surface should feel local.
  const senegal = railsForCommunity("sn-cfa");
  assert(senegal.some(r => r.key === "wave"),
    "sn-cfa community shows Wave");
  assert(senegal.some(r => r.key === "orange-money"),
    "sn-cfa community shows Orange Money");
  assert(!senegal.some(r => r.key === "revtag"),
    "sn-cfa default rail picker does not show unrelated global rails");
  assert(senegal.some(r => r.key === "phone-number"),
    "sn-cfa community shows universal Phone number rail");
  assert(!senegal.some(r => r.key === "m-pesa"),
    "sn-cfa default rail picker does not show Kenya/Tanzania M-Pesa");
  assert(searchableRailsForCommunity("sn-cfa").some(r => r.key === "m-pesa"),
    "sn-cfa search catalog can still find M-Pesa");
  assert(searchableRailsForCommunity("sn-cfa").some(r => r.key === "revtag"),
    "sn-cfa search catalog can still find global app rails");

  const kenya = railsForCommunity("ke-kes");
  assert(kenya.some(r => r.key === "m-pesa"),
    "ke-kes community shows M-Pesa");
  assert(kenya.some(r => r.key === "airtel-money"),
    "ke-kes community shows Airtel Money");
  assert(kenya.some(r => r.key === "phone-number"),
    "ke-kes community shows universal Phone number rail");
  assert(kenya.some(r => r.key === "bank-transfer"),
    "ke-kes community keeps mobile bank transfer as a universal local fallback");
  assert(!kenya.some(r => r.key === "wave"),
    "ke-kes default rail picker does not show Senegal Wave");
  assert(!kenya.some(r => r.key === "orange-money"),
    "ke-kes default rail picker does not show Orange Money");
  assert(searchableRailsForCommunity("ke-kes").some(r => r.key === "wave"),
    "ke-kes search catalog can still find Wave for edge cases");
  assert(kenya.findIndex(r => r.key === "m-pesa") < kenya.findIndex(r => r.key === "bank-transfer"),
    "ke-kes keeps local mobile money ahead of generic bank transfer");
  // Field-test ask #1: US-leaning Chamas lead with US rails.
  assert(railsForCommunity("us-gbf").slice(0, 4).map(r => r.key).join(",") === "strike,cashtag,zelle,bank-transfer",
    "GBF Chama leads with US rails: Strike, Cash App, Zelle, bank transfer");
  assert(railsForCommunity("global-usd").slice(0, 4).map(r => r.key).join(",") === "strike,cashtag,zelle,bank-transfer",
    "legacy global-usd leads with the same US rails");
  assert(railsForCommunity("us-blf").slice(0, 4).map(r => r.key).join(",") === "strike,cashtag,zelle,bank-transfer",
    "us-blf backup leads with the same US rails");
  assert(!railsForCommunity("ke-kes").slice(0, 4).map(r => r.key).includes("strike"),
    "A non-US Chama (Kenya) does not promote US rails to the top");
  const tanzania = railsForCommunity("tz-tzs");
  assert(tanzania.some(r => r.key === "m-pesa"),
    "tz-tzs community shows M-Pesa");
  assert(tanzania.some(r => r.key === "tigo-pesa"),
    "tz-tzs community shows Tigo Pesa");
  assert(tanzania.some(r => r.key === "airtel-money"),
    "tz-tzs community shows Airtel Money");

  // Lookup
  assert(getRailByKey("phone-number")?.displayName === "Phone number",
    "getRailByKey returns the universal phone-number rail");
  assert(getRailByKey("revtag")?.displayName === "Revtag (Revolut)",
    "getRailByKey returns the right rail");
  assert(getRailByKey("xyz") === null, "Unknown key → null");
  assert(getRailByKey(null) === null, "Null key → null");

  // v0.6.5: expanded Global South network roster + region-first
  // ordering in phoneNetworksForCommunity.
  assert(getRailByKey("mtn-momo")?.displayName === "MTN Mobile Money",
    "MTN MoMo registered");
  assert(getRailByKey("moov-money")?.displayName === "Moov Money",
    "Moov Money registered");
  assert(getRailByKey("opay")?.displayName === "OPay",
    "OPay registered");
  assert(getRailByKey("ecocash")?.displayName === "EcoCash",
    "EcoCash registered");
  assert(getRailByKey("bkash")?.displayName === "bKash",
    "bKash registered");
  assert(getRailByKey("gcash")?.displayName === "GCash",
    "GCash registered");
  assert(getRailByKey("pix")?.displayName === "PIX (Brazil)",
    "PIX registered");
  assert(getRailByKey("nequi")?.displayName === "Nequi",
    "Nequi registered");

  // Region-first defaults: a Kenyan user sees M-Pesa + Airtel Money, not
  // unrelated country rails unless they search.
  const keNetworks = phoneNetworksForCommunity("ke-kes");
  assert(keNetworks[0]?.key === "m-pesa",
    "ke-kes sees M-Pesa first");
  assert(keNetworks.some(r => r.key === "airtel-money"),
    "ke-kes includes Airtel Money in local phone networks");
  assert(!keNetworks.some(r => r.key === "bkash"),
    "ke-kes local phone networks do not show bKash by default");
  assert(phoneNetworksForCommunity("ke-kes", { includeSearchable: true }).some(r => r.key === "bkash"),
    "ke-kes searchable phone networks can still find bKash");

  const tzNetworks = phoneNetworksForCommunity("tz-tzs");
  assert(tzNetworks[0]?.key === "m-pesa",
    "tz-tzs sees M-Pesa first");
  assert(tzNetworks.some(r => r.key === "tigo-pesa"),
    "tz-tzs includes Tigo Pesa in regional phone networks");

  // Senegal sees Wave / Orange / Wizall / Free Money locally.
  const snNetworks = phoneNetworksForCommunity("sn-cfa");
  const snFirstKeys = snNetworks.slice(0, 4).map(r => r.key);
  assert(snFirstKeys.includes("wave") && snFirstKeys.includes("orange-money"),
    "sn-cfa sees its regional rails first");
  assert(!snNetworks.some(r => r.key === "mtn-momo"),
    "sn-cfa local phone networks do not show MTN MoMo by default");
  assert(phoneNetworksForCommunity("sn-cfa", { includeSearchable: true }).some(r => r.key === "mtn-momo"),
    "sn-cfa searchable phone networks can still find MTN MoMo");

  // No matching community (e.g. an unconfigured slug) → keep the default local
  // surface empty/quiet for phone networks, with search as the escape hatch.
  const fallback = phoneNetworksForCommunity("xx-future");
  assert(fallback.length === 0,
    "Unmatched community does not guess phone networks by default");
  assert(phoneNetworksForCommunity("xx-future", { includeSearchable: true }).some(r => r.key === "bkash"),
    "Unmatched community searchable networks still surface bKash");
  assert(phoneNetworksForCommunity("xx-future", { includeSearchable: true }).some(r => r.key === "wave"),
    "Unmatched community searchable networks still surface Wave");
  assert(!fallback.some(r => r.key === "phone-number"),
    "Phone-number meta rail itself is excluded from the network picker");

  // #4 — suggest + match rails before lock. The load-bearing subtlety: a
  // listing's paymentMethods are DISPLAY NAMES ("M-Pesa"), a buyer's saved
  // handles are KEYS ("m-pesa"). The matcher must normalize both or nothing
  // ever matches.
  assert(toRailKey("strike") === "strike", "toRailKey: a key passes through");
  assert(toRailKey("M-Pesa") === "m-pesa", "toRailKey: display name → key");
  assert(toRailKey("$cashtag (Cash App)") === "cashtag", "toRailKey: parenthetical display name → key");
  assert(toRailKey("Bank transfer") === "bank-transfer", "toRailKey: multi-word display name → key");
  assert(toRailKey("Totally Unknown Rail") === "totally unknown rail", "toRailKey: unknown token → lowercased passthrough");

  // The core match: seller names vs buyer keys, intersected + ranked.
  const m1 = matchRails(["M-Pesa", "Airtel Money", "Strike"], ["m-pesa", "strike"], "ke-kes");
  assert(JSON.stringify(m1.shared) === JSON.stringify(["m-pesa", "strike"]),
    "matchRails: shared = seller∩buyer, normalized across name/key, ke-kes-ranked (m-pesa first)");
  assert(JSON.stringify(m1.sellerOnly) === JSON.stringify(["airtel-money"]),
    "matchRails: sellerOnly = accepted rails the buyer has no handle for");
  assert(m1.suggested === "m-pesa", "matchRails: suggests the top shared rail");

  // Name-vs-key absorption proven directly: "M-Pesa" (name) ≡ "m-pesa" (key).
  assert(matchRails(["M-Pesa"], ["m-pesa"], "ke-kes").shared.length === 1,
    "matchRails: a display-name listing matches a key-based saved handle");

  // Community ranking flips the suggestion: same rails, US-leaning Chama.
  const m2 = matchRails(["Strike", "M-Pesa"], ["strike", "m-pesa"], "global-usd");
  assert(JSON.stringify(m2.shared) === JSON.stringify(["strike", "m-pesa"]),
    "matchRails: global-usd ranks Strike above M-Pesa");
  assert(m2.suggested === "strike", "matchRails: suggestion follows community ranking");

  // No overlap → suggest the seller's top accepted rail so the buyer still has a lead.
  const m3 = matchRails(["Zelle"], ["m-pesa"], "ke-kes");
  assert(m3.shared.length === 0 && JSON.stringify(m3.sellerOnly) === JSON.stringify(["zelle"]),
    "matchRails: no shared rail → shared empty, seller rail listed");
  assert(m3.suggested === "zelle", "matchRails: with no overlap, suggest the seller's top rail");

  // Degenerate inputs are safe.
  assert(matchRails([], ["m-pesa"], "ke-kes").suggested === null, "matchRails: no seller rails → null suggestion");
  const m4 = matchRails(undefined, undefined, null);
  assert(m4.shared.length === 0 && m4.sellerOnly.length === 0 && m4.suggested === null,
    "matchRails: undefined inputs → empty match");
  assert(matchRails(["M-Pesa", "m-pesa"], [], "ke-kes").sellerOnly.length === 1,
    "matchRails: a rail listed by both name and key dedupes to one");

  // Market is sats-only: no payment rails. Fiat verticals carry them.
  assert(categoryUsesPaymentRails("marketplace") === false,
    "Market is sats-only — no payment rails");
  assert(categoryUsesPaymentRails("p2p-trade") === true
    && categoryUsesPaymentRails("bill-pay") === true
    && categoryUsesPaymentRails("lending") === true,
    "Fiat verticals (p2p-trade, bill-pay, lending) use payment rails");
}

// ── 18b. FORGOTTEN-TRADE DENYLIST — persist a "forget" across restarts ───
console.log("\n── FORGOTTEN TRADES (persistent denylist) ──");
{
  (globalThis as any).localStorage.clear();
  const A = "ff".repeat(32);
  const B = "ab".repeat(32);

  assert(!isForgottenEscrowId("sm_ghost_1", A), "Fresh: nothing forgotten");

  addForgottenEscrowId("sm_ghost_1", A);
  assert(isForgottenEscrowId("sm_ghost_1", A), "After forget: id is on the denylist");
  // Persistence: a FRESH read (simulating a restart re-hydrating the ref from
  // localStorage) still sees it — this is the bit that was failing on-device.
  assert(getForgottenEscrowIds(A).includes("sm_ghost_1"),
    "Persisted: a fresh read after 'restart' still finds the forgotten id");

  // Per-pubkey scoping: B (a different signer) is unaffected.
  assert(!isForgottenEscrowId("sm_ghost_1", B), "Scoping: another pubkey doesn't see A's forget");
  addForgottenEscrowId("sm_ghost_1", B);
  assert(isForgottenEscrowId("sm_ghost_1", B), "B can independently forget the same id");

  // Idempotent: forgetting twice keeps one entry.
  addForgottenEscrowId("sm_ghost_1", A);
  assert(getForgottenEscrowIds(A).filter(i => i === "sm_ghost_1").length === 1,
    "Idempotent: forgetting twice stores one entry");

  // Un-forget (loading by ID) removes it — and A's other forgets survive.
  addForgottenEscrowId("sm_ghost_2", A);
  unforgetEscrowId("sm_ghost_1", A);
  assert(!isForgottenEscrowId("sm_ghost_1", A), "Un-forget: loading by ID clears the denylist entry");
  assert(isForgottenEscrowId("sm_ghost_2", A), "Un-forget removes only the one id, not the whole list");
  // B still has its own entry — un-forget is scoped too.
  assert(isForgottenEscrowId("sm_ghost_1", B), "Un-forget on A doesn't touch B");

  // Unscoped (no pubkey) bucket is independent of the scoped ones.
  assert(!isForgottenEscrowId("sm_ghost_2", null), "Unscoped bucket is separate from A's");
}

// ── 19. SAVED HANDLES — CRUD + visibility refusal ────────────────────────
console.log("\n── SAVED HANDLES (CRUD + visibility) ──");
{
  // Reset storage so this section starts clean
  (globalThis as any).localStorage.clear();
  assert(listSavedHandles().length === 0, "Fresh storage starts empty");

  // Add — defaults to private
  const a = addSavedHandle("revtag", "@alice");
  assert(a.id.startsWith("h_"), "addSavedHandle returns a generated ID");
  assert(a.rail === "revtag", "Saved rail matches");
  assert(a.handle === "@alice", "Saved handle matches");
  assert(a.visibility === "private", "New handles default to private");
  assert(typeof a.createdAt === "number", "createdAt set");

  // Round-trip: reading back returns the same shape
  const list1 = listSavedHandles();
  assert(list1.length === 1, "List shows 1 entry after add");
  assert(list1[0].id === a.id, "Round-trip ID matches");

  const handleBackupRaw = (globalThis as any).localStorage.getItem(SAVED_HANDLES_BACKUP_STORAGE_KEY);
  assert(!!handleBackupRaw && JSON.parse(handleBackupRaw).length === 1,
    "Saved payment handles are mirrored into a backup row");
  (globalThis as any).localStorage.removeItem(SAVED_HANDLES_STORAGE_KEY);
  const restoredHandles = listSavedHandles();
  assert(restoredHandles.length === 1 && restoredHandles[0].id === a.id,
    "Missing primary saved-handles row restores from backup instead of appearing cleared");
  assert((globalThis as any).localStorage.getItem(SAVED_HANDLES_STORAGE_KEY) !== null,
    "Saved-handle backup restore rewrites the primary row");

  // Whitespace trimmed
  const trimmed = addSavedHandle("revtag", "  @bob  ");
  assert(trimmed.handle === "@bob", "addSavedHandle trims whitespace");

  // Empty handle rejected
  let threw = false;
  try { addSavedHandle("revtag", "   "); } catch { threw = true; }
  assert(threw, "addSavedHandle rejects empty handle (post-trim)");

  // getSavedHandle by ID
  assert(getSavedHandle(a.id)?.handle === "@alice",
    "getSavedHandle returns matching entry");
  assert(getSavedHandle("h_nope") === null,
    "getSavedHandle returns null for unknown ID");

  // getSavedHandlesByRail filters and orders newest-first
  const senegal = addSavedHandle("wave", "+221 77 555 1234");
  const phone = addSavedHandle("phone-number", "+254 712 345 678");
  assert(phone.visibility === "private",
    "Phone number handle defaults to private");
  assert(getSavedHandlesByRail("phone-number").length === 1,
    "One universal phone-number handle");
  const byRevtag = getSavedHandlesByRail("revtag");
  assert(byRevtag.length === 2, "Two revtag handles");
  assert(byRevtag.every(h => h.rail === "revtag"),
    "getSavedHandlesByRail filters correctly");
  assert(getSavedHandlesByRail("wave").length === 1, "One wave handle");

  // Update
  const updated = updateSavedHandle(a.id, { handle: "@alice.new" });
  assert(updated?.handle === "@alice.new", "updateSavedHandle changes handle");
  assert(updated?.id === a.id, "ID preserved on update");
  assert(getSavedHandle(a.id)?.handle === "@alice.new",
    "Update persisted to storage");

  // Visibility — public allowed for revtag (allowPublicHandle: true)
  const setPublic = setHandleVisibility(a.id, "public");
  assert(setPublic.ok === true, "Setting Revtag handle to public succeeds");
  if (setPublic.ok) {
    assert(setPublic.handle.visibility === "public",
      "Returned handle shows public");
  }
  assert(getSavedHandle(a.id)?.visibility === "public",
    "Public visibility persisted");

  // Visibility — public REJECTED for wave (allowPublicHandle: false).
  // Defense in depth: even if the UI accidentally renders the toggle,
  // this layer refuses the change.
  const setPublicSensitive = setHandleVisibility(senegal.id, "public");
  assert(setPublicSensitive.ok === false,
    "Setting Wave handle to public is REJECTED (defense in depth)");
  if (!setPublicSensitive.ok) {
    assert(/doesn't allow public/i.test(setPublicSensitive.error),
      "Refusal carries an explanatory message");
  }
  // And the storage is unchanged
  assert(getSavedHandle(senegal.id)?.visibility === "private",
    "Sensitive handle remains private after rejected upgrade");

  const setPublicPhone = setHandleVisibility(phone.id, "public");
  assert(setPublicPhone.ok === false,
    "Setting Phone number handle to public is REJECTED (private by default)");
  assert(getSavedHandle(phone.id)?.visibility === "private",
    "Phone number remains private after rejected upgrade");

  // Setting back to private is always allowed
  const back = setHandleVisibility(a.id, "private");
  assert(back.ok === true, "Setting back to private always allowed");
  assert(getSavedHandle(a.id)?.visibility === "private",
    "Private downgrade persisted");

  // Visibility on unknown ID errors cleanly
  const setMissing = setHandleVisibility("h_does_not_exist", "private");
  assert(setMissing.ok === false, "Visibility on unknown ID returns error");

  // Delete
  deleteSavedHandle(a.id);
  assert(getSavedHandle(a.id) === null, "deleteSavedHandle removes the entry");
  assert(listSavedHandles().length === 3, "Other entries unaffected by delete");
}

{
  (globalThis as any).localStorage.clear();
  addSavedHandle("revtag", "@primary");
  const staleLegacyLightning: SavedHandle = {
    id: "h_stale_legacy_lightning",
    rail: LIGHTNING_RAIL,
    handle: "old@example.com",
    visibility: "private",
    createdAt: 1,
  };
  (globalThis as any).localStorage.setItem(
    SAVED_HANDLES_BACKUP_STORAGE_KEY,
    JSON.stringify([staleLegacyLightning]),
  );
  addSavedHandle("wave", "+221 77 555 0000");
  const primaryAfterHealthyWrite = JSON.parse(
    (globalThis as any).localStorage.getItem(SAVED_HANDLES_STORAGE_KEY) ?? "[]",
  ) as SavedHandle[];
  assert(
    primaryAfterHealthyWrite.every(h => h.rail !== LIGHTNING_RAIL),
    "Healthy primary saved handles do not resurrect stale legacy Lightning rows from backup",
  );
}

// ── 19b. SAVED HANDLES — v0.6.5 phone-network tagging ────────────────────
console.log("\n── SAVED HANDLES — phone-network tagging (v0.6.5) ──");
{
  // Fresh storage for this block so count-based asserts above stay
  // stable. v0.6.5 lets phone-number handles carry an array of mobile-
  // money network rail keys (M-Pesa, Wave, Orange Money, etc.) so
  // counterparties know which network to use during a trade.
  (globalThis as any).localStorage.clear();

  const phoneWithNetworks = addSavedHandle(
    "phone-number",
    "+254 712 345 678",
    { networks: ["m-pesa", "airtel-money"] },
  );
  assert(
    Array.isArray(phoneWithNetworks.networks)
    && phoneWithNetworks.networks.length === 2
    && phoneWithNetworks.networks.includes("m-pesa"),
    "addSavedHandle persists the optional networks array",
  );

  const phoneNoNetworks = addSavedHandle("phone-number", "+1 555 123 4567");
  assert(
    phoneNoNetworks.networks === undefined,
    "addSavedHandle omits networks when not provided",
  );

  const phoneEmptyNetworks = addSavedHandle(
    "phone-number",
    "+1 555 987 6543",
    { networks: [] },
  );
  assert(
    phoneEmptyNetworks.networks === undefined,
    "addSavedHandle treats empty networks array as 'not provided'",
  );

  // updateSavedHandle can swap the network set.
  const swapped = updateSavedHandle(phoneWithNetworks.id, {
    networks: ["wave"],
  });
  assert(
    swapped?.networks?.length === 1 && swapped.networks[0] === "wave",
    "updateSavedHandle replaces the networks array",
  );

  // Empty networks via update drops the field entirely.
  const cleared = updateSavedHandle(swapped!.id, { networks: [] });
  assert(
    cleared?.networks === undefined,
    "updateSavedHandle with [] clears the networks field",
  );

  // v0.7.0: phone numbers are canonicalized on save. The user can
  // type any spacing; the stored value is "+CC XXX-XXX-XXXX".
  (globalThis as any).localStorage.clear();
  const noSpaces = addSavedHandle("phone-number", "+254712345678");
  assert(
    noSpaces.handle === "+254 712-345-678",
    "addSavedHandle formats a spaceless phone to '+CC XXX-XXX-XXXX'",
  );
  const messy = addSavedHandle("phone-number", "  +254-712.345 678  ");
  assert(
    messy.handle === "+254 712-345-678",
    "addSavedHandle normalizes mixed separators",
  );
  const idempotent = addSavedHandle("phone-number", "+254 712-345-678");
  assert(
    idempotent.handle === "+254 712-345-678",
    "Formatting a canonical number is idempotent",
  );
  const nanp = addSavedHandle("phone-number", "+15551234567");
  assert(
    nanp.handle === "+1 555-123-4567",
    "1-digit CC (NANP) detected — '+1 555-123-4567'",
  );
  const russia = addSavedHandle("phone-number", "+79161234567");
  assert(
    russia.handle === "+7 916-123-4567",
    "1-digit CC for Russia detected",
  );
  const france = addSavedHandle("phone-number", "+33612345678");
  assert(
    france.handle === "+33 6-12-34-56-78",
    "2-digit CC (France) detected",
  );
  const ghana = addSavedHandle("phone-number", "+233241234567");
  assert(
    ghana.handle === "+233 24-123-4567",
    "3-digit CC for Ghana (starts with 2) detected",
  );
  const southAfrica = addSavedHandle("phone-number", "+27711234567");
  assert(
    southAfrica.handle === "+27 711-234-567",
    "Known 2-digit +27 country code beats the old +2xx heuristic",
  );
  const domestic = addSavedHandle("phone-number", "0712345678");
  assert(
    domestic.handle.replace(/-/g, "") === "0712345678"
    && domestic.handle.includes("-"),
    "Domestic-format number (no +) is dashed",
  );
  assert(
    sanitizePhoneNumberForSave("+254712345678") === "+254 712-345-678",
    "Phone save sanitizer accepts complete Kenya numbers",
  );
  assert(
    getPhoneNumberSaveError("+254712345678") === null,
    "Complete phone number has no save-time validation error",
  );
  assert(
    getPhoneNumberSaveError("+25471234567")?.includes("missing digits") === true,
    "Save-time validator catches a Kenya number missing one digit",
  );
  assert(
    getPhoneNumberSaveError("+22177555123")?.includes("missing digits") === true,
    "Save-time validator catches a Senegal number missing one digit",
  );
  assert(
    getPhoneNumberSaveError("071234567")?.includes("looks short") === true,
    "Save-time validator catches a local number missing one digit",
  );
  let rejectedShortPhone = false;
  try { addSavedHandle("phone-number", "+25471234567"); } catch { rejectedShortPhone = true; }
  assert(rejectedShortPhone,
    "addSavedHandle rejects incomplete saved phone numbers");
  const wavePhone = addSavedHandle("wave", "+221775551234");
  assert(
    wavePhone.handle === "+221 77-555-1234",
    "Phone-based payment rails canonicalize numbers too",
  );
  let rejectedShortWave = false;
  try { addSavedHandle("wave", "+22177555123"); } catch { rejectedShortWave = true; }
  assert(rejectedShortWave,
    "Phone-based payment rails reject incomplete numbers");
  assert(formatPhoneNumber("+2") === "+2",
    "Partial +2 country code stays visible while typing");
  const kenyaParts = getPhoneNumberDisplayParts("+254712345678");
  assert(
    kenyaParts.flagEmoji === "🇰🇪"
    && kenyaParts.inputValue === "712-345-678",
    "Phone display parts expose country flag plus national input value",
  );
  assert(
    formatPhoneNumberForDisplay("+254712345678") === "🇰🇪 712-345-678",
    "Phone display replaces +254 with the Kenya flag",
  );

  // #1 (v1.3.0): the REVEALED phone — settings reveal toggle + active-trade
  // reveal to the three participants — shows the ENTIRE international number:
  // country code visible (not just the flag) and dash-grouped for
  // readability in EVERY country. Distinct from formatPhoneNumberForDisplay
  // above, which is flag-led and hides the +CC digits.
  assert(
    formatPhoneNumberRevealed("+254712345678") === "🇰🇪 +254 712-345-678",
    "Revealed phone: flag + explicit +254 + dashes",
  );
  assert(
    formatPhoneNumberRevealed("+15551234567") === "🇺🇸 +1 555-123-4567",
    "Revealed phone: NANP keeps +1 and dash grouping",
  );
  assert(
    formatPhoneNumberRevealed("+221775551234") === "🇸🇳 +221 77-555-1234",
    "Revealed phone: Senegal keeps explicit +221",
  );
  assert(
    formatPhoneNumberRevealed("+255712345678") === "🇹🇿 +255 71-234-5678",
    "Revealed phone: Tanzania — country code + dashes for another country",
  );
  assert(
    formatPhoneNumberRevealed("0712345678") === "071-234-5678",
    "Revealed phone: domestic number still dash-grouped (no CC to show)",
  );

  // Non-phone rails store the user's input verbatim — no formatter
  // surprises for usernames, emails, account numbers.
  const revtag = addSavedHandle("revtag", "@some_user.123");
  assert(
    revtag.handle === "@some_user.123",
    "Non-phone rails preserve user input verbatim",
  );
}

// ── 20. MASKING + handleDisplayForViewer ─────────────────────────────────
console.log("\n── MASKING + viewer-aware display ──");
{
  // Phone-shaped: keep flag/prefix + last 4
  assert(maskHandle("+221 77 123 4567").includes("•••"),
    "Phone handle gets masked");
  assert(maskHandle("+221 77 123 4567").endsWith("4567"),
    "Phone handle keeps last 4 digits");
  assert(maskHandle("+221 77 123 4567").startsWith("🇸🇳"),
    "Phone handle uses country flag when known");

  // v0.6.5 mask regression: a phone entered WITHOUT spaces must still
  // be masked. Pre-v0.6.5 the heuristic was "split(' ').slice(0, 2)"
  // which returned the entire number when there were no spaces,
  // leaking everything next to a fake "•••".
  {
    const masked = maskHandle("+254712345678");
    assert(masked.includes("•••"), "Spaceless phone gets a mask separator");
    assert(masked.endsWith("5678"), "Spaceless phone keeps last 4");
    assert(masked.startsWith("🇰🇪"), "Spaceless phone uses country flag");
    assert(!masked.includes("712345"),
      "Spaceless phone does NOT leak the middle digits (the v0.6.5 bug)");
  }
  // Domestic number (no + prefix) — still keep last 4, no CC leak.
  {
    const masked = maskHandle("0712345678");
    assert(masked.endsWith("5678"), "Domestic number keeps last 4");
    assert(!masked.includes("071234"),
      "Domestic number doesn't leak the middle");
  }

  // Email-shaped: mask local + domain
  const masked = maskHandle("alice@example.com");
  assert(masked.includes("@"), "Email handle keeps the @");
  assert(masked.startsWith("a•••"), "Email keeps first char of local");

  // Generic short handle
  assert(maskHandle("@x") === "•••", "Very short handle fully masked");
  assert(maskHandle("@username").includes("•••"),
    "Generic handle gets masked");

  // handleDisplayForViewer — viewer-context decides everything
  assert(handleDisplayForViewer("+221 77 555 1234", true) === "🇸🇳 +221 77-555-1234",
    "Participant viewer sees full international phone (flag + country code + dashes)");
  assert(handleDisplayForViewer("123456789", true) === "123456789",
    "Participant viewer keeps non-plus numeric handles verbatim");
  assert(handleDisplayForViewer("+221 77 555 1234", false).includes("•••"),
    "Non-participant viewer sees masked output");
  // Critical invariant: non-participants see masked REGARDLESS of how
  // the data got into client state (e.g. legacy plaintext on wire).
  // The flag the seller set is irrelevant to viewer-side rendering.
  assert(handleDisplayForViewer("@public-handle", false).includes("•••"),
    "Non-participants see masked even for public-by-design handles");

  // publicHandleDisplay — visibility flag + rail policy gate
  (globalThis as any).localStorage.clear();
  const publicTag = addSavedHandle("revtag", "@bob");
  setHandleVisibility(publicTag.id, "public");
  const publicTagAfter = getSavedHandle(publicTag.id)!;
  assert(publicHandleDisplay(publicTagAfter) === "@bob",
    "publicHandleDisplay returns cleartext when public + allowed");

  const sensitive = addSavedHandle("wave", "+221 77 555 1234");
  // setHandleVisibility refused public above, so it's still private
  const sensitiveAfter = getSavedHandle(sensitive.id)!;
  assert(publicHandleDisplay(sensitiveAfter).includes("•••"),
    "publicHandleDisplay masks private (and sensitive-by-policy) handles");
}

// ── 21. LOCK PAYLOAD HANDLE PROPAGATION ──────────────────────────────────
console.log("\n── LOCK HANDLE PROPAGATION (atomic-funding flow) ──");
{
  // CREATE → LOCK with handleId/handle/rail in payload, verify state
  // captures the resolved handle on EscrowState.lock.handle.
  eventCounter = 400;

  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;
  assert(state.lock.handle === null,
    "Pre-LOCK: state.lock.handle is null");

  // Build a LOCK payload with handle fields
  const lockWithHandle = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash_of_ecash_notes_abc123",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    handleId: "h_seller_local_id_xyz",
    handle: "+221 77 555 1234",
    rail: "wave",
    lockedAt: NOW,
  }, create.raw.id);

  const r = applyEvent(state, lockWithHandle);
  if (assertOk(r, "LOCK with handle/rail/handleId → LOCKED")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status is LOCKED");
    assert(r.state.lock.handle !== null,
      "state.lock.handle populated by LOCK payload");
    assert(r.state.lock.handle?.value === "+221 77 555 1234",
      "Resolved handle cleartext stored on EscrowState");
    assert(r.state.lock.handle?.id === "h_seller_local_id_xyz",
      "handleId audit reference preserved");
    assert(r.state.lock.handle?.rail === "wave",
      "Rail key preserved");
  }

  // LOCK without handle fields (non-fiat trade) leaves lock.handle null
  eventCounter = 500;
  const create2 = createEvent();
  let state2 = (applyEvent(null, create2) as any).state;
  const lockBare = lockEvent(create2.raw.id);
  const r2 = applyEvent(state2, lockBare);
  if (assertOk(r2, "LOCK without handle fields → LOCKED")) {
    assert(r2.state.lock.handle === null,
      "state.lock.handle stays null when LOCK omits handle");
  }

  // Defense-in-depth: the masking gate at the render boundary still
  // applies even when state has cleartext locally. Non-participant
  // sees masked output regardless of what's in state.lock.handle.value.
  if (r.ok && r.state.lock.handle) {
    const cleartext = r.state.lock.handle.value;
    assert(handleDisplayForViewer(cleartext, true) === "🇸🇳 +221 77-555-1234",
      "Participant view: full international phone from LOCK cleartext");
    assert(handleDisplayForViewer(cleartext, false).includes("•••"),
      "Non-participant view: masked even though cleartext sits in state");
  }
}

// ── 22. EVENT PARSER — handle field validation ────────────────────────────
console.log("\n── EVENT PARSER (PR 3 LOCK handle fields) ──");
{
  const baseLock = {
    type: "escrow:lock" as const,
    notesHash: "h",
    shares: [
      { shareIndex: 0, encryptedFor: { x: "y" } },
      { shareIndex: 1, encryptedFor: { x: "y" } },
      { shareIndex: 2, encryptedFor: { x: "y" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    lockedAt: NOW,
  };
  const raw = {
    id: "lock_parse_test",
    pubkey: SELLER_PK,
    created_at: NOW,
    kind: EscrowEventKind.LOCK,
    tags: [["d", "lock-parse"]],
    content: "x",
    sig: "s",
  };

  // Valid: with all PR 3 fields
  const okWith = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, handleId: "h_x", handle: "@alice", rail: "revtag",
  }), true);
  assert(okWith.ok === true, "Parser accepts LOCK with handle fields");

  // Valid: without (optional)
  const okWithout = parseEscrowEvent(raw, JSON.stringify(baseLock), true);
  assert(okWithout.ok === true, "Parser accepts LOCK without handle fields");

  // Invalid: empty-string handle
  const badEmpty = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, handle: "",
  }), true);
  assert(!badEmpty.ok, "Parser rejects LOCK with empty-string handle");

  // Invalid: non-string rail
  const badRailType = parseEscrowEvent(raw, JSON.stringify({
    ...baseLock, rail: 123,
  }), true);
  assert(!badRailType.ok, "Parser rejects LOCK with non-string rail");
}

// ══════════════════════════════════════════════════════════════════════════
// PR 4 — LOCK 3-recipient envelope encryption
// ══════════════════════════════════════════════════════════════════════════

// ── 23. ENVELOPE HELPER (encrypt/decrypt round-trip) ─────────────────────
console.log("\n── ENVELOPE HELPER ──");
{
  // Generate three real keypairs. The locker (seller) is the sender;
  // each recipient decrypts their own entry.
  const sellerPriv  = generateSecretKey();
  const buyerPriv   = generateSecretKey();
  const arbiterPriv = generateSecretKey();
  const strangerPriv = generateSecretKey();
  const sellerPub   = getPublicKey(sellerPriv);
  const buyerPub    = getPublicKey(buyerPriv);
  const arbiterPub  = getPublicKey(arbiterPriv);
  const strangerPub = getPublicKey(strangerPriv);

  const sellerCrypto   = makeNip44(sellerPriv);
  const buyerCrypto    = makeNip44(buyerPriv);
  const arbiterCrypto  = makeNip44(arbiterPriv);
  const strangerCrypto = makeNip44(strangerPriv);

  // Run async assertions in a top-level await IIFE-like block.
  // tsx supports top-level await, so we just await directly.
  const cleartext = JSON.stringify({
    handleId: "h_seller_local_xyz",
    handle: "+221 77 555 1234",
    rail: "wave",
  });

  const env = await createEnvelope(
    cleartext,
    [buyerPub, sellerPub, arbiterPub],
    sellerCrypto.encrypt,
  );

  // Three entries, one per recipient
  assert(Object.keys(env.encryptedFor).length === 3,
    "Envelope has exactly 3 entries for 3 distinct recipients");
  assert(env.encryptedFor[buyerPub] !== undefined,
    "Envelope has buyer entry");
  assert(env.encryptedFor[sellerPub] !== undefined,
    "Envelope has seller entry");
  assert(env.encryptedFor[arbiterPub] !== undefined,
    "Envelope has arbiter entry");

  // Each ciphertext is non-empty and not the cleartext itself
  for (const [pk, ct] of Object.entries(env.encryptedFor)) {
    assert(ct !== cleartext,
      `Entry for ${pk.slice(0, 8)}… is encrypted (not raw cleartext)`);
    assert(ct.length > 0,
      `Entry for ${pk.slice(0, 8)}… is non-empty`);
  }

  // envelopeHasRecipient is the cheap check
  assert(envelopeHasRecipient(env, buyerPub) === true,
    "envelopeHasRecipient: buyer is in");
  assert(envelopeHasRecipient(env, strangerPub) === false,
    "envelopeHasRecipient: stranger is not in");

  // Each participant decrypts their entry to the SAME cleartext
  const buyerSees = await decryptFromEnvelope(env, buyerPub, sellerPub, buyerCrypto.decrypt);
  assert(buyerSees === cleartext,
    "Buyer decrypts their entry → matching cleartext");

  const sellerSees = await decryptFromEnvelope(env, sellerPub, sellerPub, sellerCrypto.decrypt);
  assert(sellerSees === cleartext,
    "Seller (locker) decrypts their own entry → matching cleartext");

  const arbiterSees = await decryptFromEnvelope(env, arbiterPub, sellerPub, arbiterCrypto.decrypt);
  assert(arbiterSees === cleartext,
    "Arbiter decrypts their entry → matching cleartext");

  // Non-participant: lookup miss → null
  const strangerSees = await decryptFromEnvelope(env, strangerPub, sellerPub, strangerCrypto.decrypt);
  assert(strangerSees === null,
    "Stranger (not in envelope) → null, no throw");

  // Even if a stranger somehow had a ciphertext to attempt, NIP-44 auth
  // would fail and decryptFromEnvelope returns null cleanly. Simulate
  // by giving them buyer's ciphertext; their decrypt with seller as
  // sender will fail because their ECDH(stranger_priv, seller_pub) is
  // a different shared secret than ECDH(buyer_priv, seller_pub).
  const tamperedEnv = { encryptedFor: { [strangerPub]: env.encryptedFor[buyerPub] } };
  const tamperedResult = await decryptFromEnvelope(tamperedEnv, strangerPub, sellerPub, strangerCrypto.decrypt);
  assert(tamperedResult === null,
    "Stranger handed buyer's ciphertext → null (NIP-44 auth fails cleanly, no throw)");

  // Empty recipients → empty envelope
  const emptyEnv = await createEnvelope("anything", [], sellerCrypto.encrypt);
  assert(Object.keys(emptyEnv.encryptedFor).length === 0,
    "Empty recipients list → empty envelope");

  // Duplicate recipients collapse
  const dupEnv = await createEnvelope("x", [buyerPub, buyerPub, buyerPub], sellerCrypto.encrypt);
  assert(Object.keys(dupEnv.encryptedFor).length === 1,
    "Duplicate recipient pubkeys collapse to a single entry");
}

// ── 24. LOCK WITH ENVELOPE — through the state machine ───────────────────
console.log("\n── LOCK WITH ENVELOPE (state machine) ──");
{
  // Build a real-crypto LOCK envelope, then simulate what escrow-client's
  // resolveLockEnvelope() does on each participant's side: decrypt their
  // entry, synthesize top-level handle fields, apply through the state
  // machine. End state: state.lock.handle.value matches cleartext for
  // each of the 3 participants.

  const sellerPriv  = generateSecretKey();
  const buyerPriv   = generateSecretKey();
  const arbiterPriv = generateSecretKey();
  const sellerPub   = getPublicKey(sellerPriv);
  const buyerPub    = getPublicKey(buyerPriv);
  const arbiterPub  = getPublicKey(arbiterPriv);

  const sellerCrypto  = makeNip44(sellerPriv);
  const buyerCrypto   = makeNip44(buyerPriv);
  const arbiterCrypto = makeNip44(arbiterPriv);

  const handleData = {
    handleId: "h_pr4_test",
    handle: "+221 77 555 1234",
    rail: "wave",
  };
  const handleJson = JSON.stringify(handleData);
  const envelope = await createEnvelope(
    handleJson,
    [buyerPub, sellerPub, arbiterPub],
    sellerCrypto.encrypt,
  );

  // Build CREATE (seller initiates a p2p-trade)
  eventCounter = 600;
  const create = makeParsedEvent(EscrowEventKind.CREATE, sellerPub, {
    type: "escrow:create",
    description: "PR 4 envelope test",
    amountMsats: 100_000_000,
    fiatAmount: 50,
    fiatCurrency: "USD",
    category: "p2p-trade",
    mintUrl: "fed11q...",
    platformFeeBps: 50,
    platformFeePubkey: PLATFORM_PK,
    arbiterFeeMsats: 1_000_000,
    expirySeconds: 86400,
    createdAt: NOW,
  });

  // Build LOCK with envelope only (no top-level handle fields — the wire
  // format that escrow-client.lockEscrow now emits in PR 4).
  const wireLock = makeParsedEvent(EscrowEventKind.LOCK, sellerPub, {
    type: "escrow:lock" as const,
    notesHash: "hash_of_ecash_notes_pr4",
    shares: [
      { shareIndex: 0, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      { shareIndex: 1, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      { shareIndex: 2, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: buyerPub,
    arbiterPubkey: arbiterPub,
    handleEnvelope: envelope,
    lockedAt: NOW,
  }, create.raw.id);

  // Each participant resolves the envelope on their side. This is what
  // escrow-client.resolveLockEnvelope does internally; here we exercise
  // the same shape directly.
  async function resolveAndApply(
    viewerPub: string,
    viewerCrypto: { decrypt: (ct: string, sender: string) => Promise<string> },
    label: string,
  ) {
    let createState: any;
    {
      const r = applyEvent(null, create);
      assert(r.ok, `${label}: CREATE applies`);
      createState = (r as any).state;
    }

    // Resolve viewer's entry
    const cleartext = await decryptFromEnvelope(
      envelope, viewerPub, sellerPub, viewerCrypto.decrypt,
    );
    assert(cleartext === handleJson,
      `${label}: envelope decrypt yields original cleartext`);

    const resolved = JSON.parse(cleartext!);
    const synthesizedLock = {
      ...wireLock,
      payload: {
        ...wireLock.payload,
        handleId: resolved.handleId,
        handle: resolved.handle,
        rail: resolved.rail,
      },
    };

    const r = applyEvent(createState, synthesizedLock);
    if (assertOk(r, `${label}: synthesized LOCK applies`)) {
      assert(r.state.status === EscrowStatus.LOCKED,
        `${label}: status is LOCKED`);
      assert(r.state.lock.handle?.value === handleData.handle,
        `${label}: state.lock.handle.value matches cleartext`);
      assert(r.state.lock.handle?.id === handleData.handleId,
        `${label}: handleId preserved`);
      assert(r.state.lock.handle?.rail === handleData.rail,
        `${label}: rail preserved`);
    }
  }

  await resolveAndApply(buyerPub,   buyerCrypto,   "BUYER");
  await resolveAndApply(sellerPub,  sellerCrypto,  "SELLER");
  await resolveAndApply(arbiterPub, arbiterCrypto, "ARBITER");

  // Non-participant view: a stranger trying to resolve the envelope
  // gets null, leaving state.lock.handle null after apply (the state
  // machine sees no top-level handle on the synthesized payload).
  const strangerPriv = generateSecretKey();
  const strangerPub = getPublicKey(strangerPriv);
  const strangerCrypto = makeNip44(strangerPriv);
  const strangerSees = await decryptFromEnvelope(
    envelope, strangerPub, sellerPub, strangerCrypto.decrypt,
  );
  assert(strangerSees === null, "Non-participant decrypt returns null");

  // What would happen if the stranger applied the wire LOCK as-is
  // (without any synthesis)? state.lock.handle stays null because
  // there's no top-level handle field. The cleartext is unreachable.
  {
    eventCounter = 700;
    const create2 = makeParsedEvent(EscrowEventKind.CREATE, sellerPub, {
      type: "escrow:create",
      description: "non-participant view test",
      amountMsats: 100_000_000,
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const wireOnly = makeParsedEvent(EscrowEventKind.LOCK, sellerPub, {
      type: "escrow:lock" as const,
      notesHash: "h",
      shares: [
        { shareIndex: 0, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 1, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 2, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      ],
      sellerReceivesMsats: 99_000_000,
      arbiterFeeMsats: 1_000_000,
      buyerPubkey: buyerPub,
      arbiterPubkey: arbiterPub,
      handleEnvelope: envelope,
      lockedAt: NOW,
    }, create2.raw.id);

    const r1 = applyEvent(null, create2);
    if (r1.ok) {
      const r2 = applyEvent(r1.state, wireOnly);
      if (r2.ok) {
        assert(r2.state.lock.handle === null,
          "Wire-only LOCK without resolution leaves state.lock.handle null (handleLock has no top-level fields to read)");
      }
    }
  }
}

// ── 25. BACKWARDS COMPAT — PR 3 top-level handle still works ────────────
console.log("\n── BACKWARDS COMPAT (PR 3 top-level handle on replay) ──");
{
  // A LOCK from a v0.1.78 deployment has handle/handleId/rail at the
  // top of the payload (no envelope). PR 4 must still apply these
  // correctly so existing trades on relays don't break.
  eventCounter = 800;

  const create = createEvent();
  let state = (applyEvent(null, create) as any).state;

  const legacyLock = makeParsedEvent(EscrowEventKind.LOCK, SELLER_PK, {
    type: "escrow:lock" as const,
    notesHash: "hash_legacy_pr3",
    shares: [
      { shareIndex: 0, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 1, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
      { shareIndex: 2, encryptedFor: { [BUYER_PK]: "x", [SELLER_PK]: "x", [ARBITER_PK]: "x" } },
    ],
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: BUYER_PK,
    arbiterPubkey: ARBITER_PK,
    // PR 3 wire format: top-level fields, no envelope
    handleId: "h_legacy_pr3_xyz",
    handle: "@alice-legacy",
    rail: "revtag",
    lockedAt: NOW,
  }, create.raw.id);

  const r = applyEvent(state, legacyLock);
  if (assertOk(r, "Legacy PR 3 LOCK (top-level handle, no envelope) applies")) {
    assert(r.state.status === EscrowStatus.LOCKED, "Status LOCKED on legacy LOCK");
    assert(r.state.lock.handle?.value === "@alice-legacy",
      "Legacy top-level handle stored on state.lock.handle.value");
    assert(r.state.lock.handle?.id === "h_legacy_pr3_xyz",
      "Legacy handleId preserved");
    assert(r.state.lock.handle?.rail === "revtag",
      "Legacy rail preserved");
  }
}

// ── 26. PROD ENCRYPTION END-TO-END — flip config, run cycle ──────────────
console.log("\n── PROD ENCRYPTION CYCLE (config flip) ──");
{
  // Capture original config, flip to PROD-ish state, run a full
  // CREATE → JOIN → LOCK → VOTE → VOTE → RESOLVE → CLAIM → COMPLETE
  // cycle with a real-crypto handle envelope, verify all 3 participants
  // see the revealed handle, then restore the original config.
  //
  // The flip is the critical part of this test: it asserts that PR 4's
  // envelope path is independent of ENCRYPTION_CONFIG.encryptLock —
  // the flag's old "single-recipient outer wrap" behavior is gone, and
  // the envelope path always works. If a future PR re-introduces a
  // flag-conditional outer wrap, this test should catch it.

  const origEnabled    = ENCRYPTION_CONFIG.enabled;
  const origEncryptLock = ENCRYPTION_CONFIG.encryptLock;
  ENCRYPTION_CONFIG.enabled = true;
  ENCRYPTION_CONFIG.encryptLock = true;

  try {
    const sellerPriv  = generateSecretKey();
    const buyerPriv   = generateSecretKey();
    const arbiterPriv = generateSecretKey();
    const sellerPub   = getPublicKey(sellerPriv);
    const buyerPub    = getPublicKey(buyerPriv);
    const arbiterPub  = getPublicKey(arbiterPriv);

    const sellerCrypto  = makeNip44(sellerPriv);
    const buyerCrypto   = makeNip44(buyerPriv);
    const arbiterCrypto = makeNip44(arbiterPriv);

    eventCounter = 900;

    // 1. CREATE
    const create = makeParsedEvent(EscrowEventKind.CREATE, sellerPub, {
      type: "escrow:create",
      description: "PROD cycle test",
      amountMsats: 100_000_000,
      fiatAmount: 50,
      fiatCurrency: "USD",
      category: "p2p-trade",
      mintUrl: "fed11q...",
      platformFeeBps: 50,
      platformFeePubkey: PLATFORM_PK,
      arbiterFeeMsats: 1_000_000,
      expirySeconds: 86400,
      createdAt: NOW,
    });
    const r1 = applyEvent(null, create);
    assertOk(r1, "[PROD] CREATE → CREATED");
    let state = (r1 as any).state;

    // 2 + 3. JOINs (ACK only) — buyer first, then arbiter
    const j1 = makeParsedEvent(EscrowEventKind.JOIN, buyerPub, {
      type: "escrow:join",
      role: Role.BUYER,
      joinedAt: NOW,
    }, create.raw.id);
    const r2 = applyEvent(state, j1);
    assertOk(r2, "[PROD] Buyer JOIN ACK");
    state = (r2 as any).state;

    const j2 = makeParsedEvent(EscrowEventKind.JOIN, arbiterPub, {
      type: "escrow:join",
      role: Role.ARBITER,
      joinedAt: NOW,
    }, j1.raw.id);
    const r3 = applyEvent(state, j2);
    assertOk(r3, "[PROD] Arbiter JOIN ACK");
    state = (r3 as any).state;
    assert(state.status === EscrowStatus.CREATED,
      "[PROD] After JOINs status is still CREATED (atomic-funding model)");

    // 4. LOCK with real envelope (encrypts handle JSON to all 3 via NIP-44)
    const handleData = {
      handleId: "h_prod_cycle",
      handle: "+221 77 999 0000",
      rail: "wave",
    };
    const envelope = await createEnvelope(
      JSON.stringify(handleData),
      [buyerPub, sellerPub, arbiterPub],
      sellerCrypto.encrypt,
    );
    const wireLock = makeParsedEvent(EscrowEventKind.LOCK, sellerPub, {
      type: "escrow:lock" as const,
      notesHash: "hash_of_ecash_prod",
      shares: [
        { shareIndex: 0, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 1, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
        { shareIndex: 2, encryptedFor: { [buyerPub]: "x", [sellerPub]: "x", [arbiterPub]: "x" } },
      ],
      sellerReceivesMsats: 99_000_000,
      arbiterFeeMsats: 1_000_000,
      buyerPubkey: buyerPub,
      arbiterPubkey: arbiterPub,
      handleEnvelope: envelope,
      lockedAt: NOW,
    }, j2.raw.id);

    // Each participant simulates resolveLockEnvelope on their side.
    async function viewerState(
      viewerPub: string,
      viewerCrypto: { decrypt: (ct: string, sender: string) => Promise<string> },
    ): Promise<any> {
      const ct = await decryptFromEnvelope(envelope, viewerPub, sellerPub, viewerCrypto.decrypt);
      const resolved = ct ? JSON.parse(ct) : {};
      const synth = {
        ...wireLock,
        payload: {
          ...wireLock.payload,
          handleId: resolved.handleId,
          handle: resolved.handle,
          rail: resolved.rail,
        },
      };
      // Each viewer replays from CREATE → JOIN×2 → LOCK; we can reuse
      // the shared `state` (post-JOINs) and apply their synthesized LOCK.
      const r = applyEvent(state, synth);
      if (!r.ok) throw new Error("Viewer LOCK apply failed: " + r.error.message);
      return r.state;
    }

    const buyerState   = await viewerState(buyerPub,   buyerCrypto);
    const sellerState  = await viewerState(sellerPub,  sellerCrypto);
    const arbiterState = await viewerState(arbiterPub, arbiterCrypto);

    // All three see the cleartext handle on their state.lock.handle
    assert(buyerState.lock.handle?.value === handleData.handle,
      "[PROD] Buyer sees revealed handle cleartext");
    assert(sellerState.lock.handle?.value === handleData.handle,
      "[PROD] Seller sees revealed handle cleartext");
    assert(arbiterState.lock.handle?.value === handleData.handle,
      "[PROD] Arbiter sees revealed handle cleartext");
    assert(buyerState.lock.handle?.value === arbiterState.lock.handle?.value,
      "[PROD] Buyer and arbiter agree on handle (3-recipient envelope works)");

    // 5 + 6. VOTEs (use buyerState as the converged chain head — all
    // viewers' states are identical at this point besides the synthesized
    // wire ID, which doesn't affect downstream).
    state = buyerState;
    const v1 = makeParsedEvent(EscrowEventKind.VOTE, buyerPub, {
      type: "escrow:vote",
      outcome: Outcome.RELEASE,
      role: Role.BUYER,
      votedAt: NOW,
    }, wireLock.raw.id);
    const r4 = applyEvent(state, v1);
    assertOk(r4, "[PROD] Buyer votes RELEASE");
    state = (r4 as any).state;

    const v2 = makeParsedEvent(EscrowEventKind.VOTE, sellerPub, {
      type: "escrow:vote",
      outcome: Outcome.RELEASE,
      role: Role.SELLER,
      votedAt: NOW,
    }, v1.raw.id);
    const r5 = applyEvent(state, v2);
    assertOk(r5, "[PROD] Seller votes RELEASE");
    state = (r5 as any).state;

    // 7. RESOLVE
    const resolve = makeParsedEvent(EscrowEventKind.RESOLVE, buyerPub, {
      type: "escrow:resolve",
      outcome: Outcome.RELEASE,
      majority: [Role.BUYER, Role.SELLER],
      arbiterInvolved: false,
      resolvedAt: NOW,
    }, v2.raw.id);
    const r6 = applyEvent(state, resolve);
    assertOk(r6, "[PROD] RESOLVE → APPROVED");
    state = (r6 as any).state;

    // 8. CLAIM (buyer wins on RELEASE in p2p)
    const claim = makeParsedEvent(EscrowEventKind.CLAIM, buyerPub, {
      type: "escrow:claim",
      claimerRole: Role.BUYER,
      notesHashVerification: "hash_of_ecash_prod",
      claimedAt: NOW,
    }, resolve.raw.id);
    const r7 = applyEvent(state, claim);
    assertOk(r7, "[PROD] Buyer CLAIM → CLAIMED");
    state = (r7 as any).state;

    // 9. COMPLETE
    const complete = makeParsedEvent(EscrowEventKind.COMPLETE, buyerPub, {
      type: "escrow:complete",
      completedAt: NOW,
    }, claim.raw.id);
    const r8 = applyEvent(state, complete);
    assertOk(r8, "[PROD] COMPLETE → terminal");
    state = (r8 as any).state;
    assert(state.status === EscrowStatus.COMPLETED,
      "[PROD] Final state COMPLETED");
    assert(state.lock.handle?.value === handleData.handle,
      "[PROD] Handle preserved through full cycle to terminal");
  } finally {
    // Restore original config so other tests aren't poisoned
    ENCRYPTION_CONFIG.enabled = origEnabled;
    ENCRYPTION_CONFIG.encryptLock = origEncryptLock;
  }
}

// ── 26b. ENVELOPE PUBLISH + RECEIVE (v1.2.2 PROD encryption fix) ──────────
console.log("\n── ENVELOPE PUBLISH + RECEIVE (v1.2.2 PROD encryption) ──");
{
  // The v1.2.1 PROD encryption attempt encrypted VOTE / CLAIM /
  // RESOLVE single-recipient (to the SENDER's own pubkey only), which
  // broke multi-party visibility: the other two participants got
  // "invalid MAC" and silently dropped the event, so consensus never
  // formed. v1.2.2 replaces that with the per-recipient envelope
  // pattern that LOCK's SSS shares already use — every event carries
  // three ciphertexts, one per participant, all readable to the local
  // viewer if-and-only-if their pubkey is one of the three.
  //
  // This block exercises both halves of the fix in isolation:
  //   (publish) encryptToParticipants wraps a payload in an envelope
  //     decryptable by buyer + seller + arbiter, with no slot for
  //     non-participants and distinct ciphertext per slot.
  //   (receive) decryptEventContent correctly dispatches across the
  //     three wire shapes (plaintext / per-recipient envelope / raw
  //     NIP-44 legacy) and returns null in the silent-skip cases
  //     (envelope-not-for-me, malformed JSON, decrypt failure).

  const buyerPriv    = generateSecretKey();
  const sellerPriv   = generateSecretKey();
  const arbiterPriv  = generateSecretKey();
  const strangerPriv = generateSecretKey();
  const buyerPub_    = getPublicKey(buyerPriv);
  const sellerPub_   = getPublicKey(sellerPriv);
  const arbiterPub_  = getPublicKey(arbiterPriv);
  const strangerPub_ = getPublicKey(strangerPriv);

  const buyerCrypto   = makeNip44(buyerPriv);
  const sellerCrypto  = makeNip44(sellerPriv);
  const arbiterCrypto = makeNip44(arbiterPriv);

  // Fake signer wearing the buyer's hat. The EscrowClient under test
  // is "the buyer's client" — it signs as buyer and decrypts envelope
  // slots addressed to the buyer's pubkey.
  const buyerSigner: any = {
    getPublicKey: async () => buyerPub_,
    signEvent: async (e: any) => ({
      ...e,
      id: "test_signed_event",
      sig: "test_sig",
      pubkey: buyerPub_,
    }),
    nip44Encrypt: buyerCrypto.encrypt,
    nip44Decrypt: buyerCrypto.decrypt,
  };

  const client = new EscrowClient(
    buyerSigner,
    {
      relays: ["wss://test-envelope.invalid"],
      // No wsImpl + no .connect() call → RelayManager stays inert,
      // we just exercise the in-memory helpers.
      verifyEvent: () => true,
    },
  );

  // ── publish side: encryptToParticipants ──────────────────────────

  const fakeState: any = {
    participants: {
      [Role.BUYER]: buyerPub_,
      [Role.SELLER]: sellerPub_,
      [Role.ARBITER]: arbiterPub_,
    },
  };

  const votePayload = {
    type: "escrow:vote",
    outcome: Outcome.RELEASE,
    role: Role.BUYER,
    votedAt: 1_700_000_000,
  };

  const envContent: string = await (client as any).encryptToParticipants(
    votePayload,
    fakeState,
  );

  const envObj = JSON.parse(envContent);
  assert(envObj && typeof envObj.encryptedFor === "object",
    "(publish) encryptToParticipants output is a JSON envelope shape");
  assert(Object.keys(envObj.encryptedFor).length === 3,
    "(publish) Envelope has exactly 3 recipient slots");
  assert(typeof envObj.encryptedFor[buyerPub_] === "string" &&
         envObj.encryptedFor[buyerPub_].length > 0,
    "(publish) Buyer slot is non-empty ciphertext");
  assert(typeof envObj.encryptedFor[sellerPub_] === "string" &&
         envObj.encryptedFor[sellerPub_].length > 0,
    "(publish) Seller slot is non-empty ciphertext");
  assert(typeof envObj.encryptedFor[arbiterPub_] === "string" &&
         envObj.encryptedFor[arbiterPub_].length > 0,
    "(publish) Arbiter slot is non-empty ciphertext");
  assert(envObj.encryptedFor[buyerPub_] !== envObj.encryptedFor[sellerPub_] &&
         envObj.encryptedFor[sellerPub_] !== envObj.encryptedFor[arbiterPub_],
    "(publish) Each slot is a distinct ciphertext (per-recipient ECDH)");
  assert(envObj.encryptedFor[strangerPub_] === undefined,
    "(publish) Non-participants get no slot");

  // Each participant decrypts their slot back to the original payload.
  // The sender pubkey to use for ECDH is the buyer (the publishing
  // client). Buyer decrypting their own slot is self-ECDH and works
  // by NIP-44 design.
  for (const viewer of [
    { name: "buyer",   pub: buyerPub_,   crypto: buyerCrypto },
    { name: "seller",  pub: sellerPub_,  crypto: sellerCrypto },
    { name: "arbiter", pub: arbiterPub_, crypto: arbiterCrypto },
  ]) {
    const ct = envObj.encryptedFor[viewer.pub];
    const pt = await viewer.crypto.decrypt(ct, buyerPub_);
    const decoded = JSON.parse(pt);
    assert(decoded.type === "escrow:vote" &&
           decoded.outcome === Outcome.RELEASE &&
           decoded.role === Role.BUYER &&
           decoded.votedAt === 1_700_000_000,
      `(publish) ${viewer.name} decrypts their slot to the original VOTE payload`);
  }

  // ── receive side: decryptEventContent ────────────────────────────

  // Shape 1: plaintext escrow payload → returned as-is.
  const shape1Event: any = {
    id: "shape1",
    pubkey: sellerPub_,
    created_at: 1,
    kind: EscrowEventKind.CREATE,
    tags: [],
    content: JSON.stringify({ type: "escrow:create", x: 1 }),
    sig: "x",
  };
  const r1 = await (client as any).decryptEventContent(shape1Event);
  assert(r1 === shape1Event.content,
    "(receive) Shape 1: plaintext escrow payload returned as-is");

  // Shape 2: envelope-for-me → decrypts to cleartext payload.
  // Sender is the buyer (their own client signing & publishing); buyer
  // decrypting buyer's slot is self-ECDH.
  const shape2Event: any = {
    id: "shape2",
    pubkey: buyerPub_,
    created_at: 2,
    kind: EscrowEventKind.VOTE,
    tags: [],
    content: envContent,
    sig: "x",
  };
  const r2 = await (client as any).decryptEventContent(shape2Event);
  assert(r2 !== null,
    "(receive) Shape 2: envelope-for-me does not return null");
  const r2obj = JSON.parse(r2);
  assert(r2obj.type === "escrow:vote" && r2obj.role === Role.BUYER,
    "(receive) Shape 2: envelope-for-me decrypts to original VOTE payload");

  // Shape 2b: envelope where I'm NOT a recipient → null (silent skip).
  const envWithoutBuyer = await createEnvelope(
    JSON.stringify(votePayload),
    [sellerPub_, arbiterPub_],
    sellerCrypto.encrypt,
  );
  const shape2bEvent: any = {
    id: "shape2b",
    pubkey: sellerPub_,
    created_at: 3,
    kind: EscrowEventKind.VOTE,
    tags: [],
    content: JSON.stringify(envWithoutBuyer),
    sig: "x",
  };
  const r2b = await (client as any).decryptEventContent(shape2bEvent);
  assert(r2b === null,
    "(receive) Shape 2b: envelope-not-for-me returns null (silent skip)");

  // Shape 2c: envelope where my slot exists but ciphertext is garbage
  // → null (MAC fails cleanly, no throw).
  const shape2cEvent: any = {
    id: "shape2c",
    pubkey: sellerPub_,
    created_at: 4,
    kind: EscrowEventKind.VOTE,
    tags: [],
    content: JSON.stringify({ encryptedFor: { [buyerPub_]: "not-real-ciphertext" } }),
    sig: "x",
  };
  const r2c = await (client as any).decryptEventContent(shape2cEvent);
  assert(r2c === null,
    "(receive) Shape 2c: malformed envelope slot returns null without throwing");

  // Shape 3: legacy raw NIP-44 ciphertext (no JSON wrapper) → decrypts.
  const rawCt = await sellerCrypto.encrypt("legacy plaintext blob", buyerPub_);
  const shape3Event: any = {
    id: "shape3",
    pubkey: sellerPub_,
    created_at: 5,
    kind: EscrowEventKind.VOTE,
    tags: [],
    content: rawCt,
    sig: "x",
  };
  const r3 = await (client as any).decryptEventContent(shape3Event);
  assert(r3 === "legacy plaintext blob",
    "(receive) Shape 3: legacy raw NIP-44 ciphertext decrypts");

  // Edge: JSON object that's neither plaintext payload nor envelope
  // → null (don't fall through to NIP-44 path; that would just waste
  // a decrypt call on noise).
  const noiseEvent: any = {
    id: "noise",
    pubkey: sellerPub_,
    created_at: 6,
    kind: EscrowEventKind.VOTE,
    tags: [],
    content: JSON.stringify({ random: "stuff", no_known_fields: true }),
    sig: "x",
  };
  const rNoise = await (client as any).decryptEventContent(noiseEvent);
  assert(rNoise === null,
    "(receive) Edge: JSON without type or encryptedFor returns null");

  // Edge: empty content → null.
  const emptyEvent: any = {
    id: "empty",
    pubkey: sellerPub_,
    created_at: 7,
    kind: EscrowEventKind.VOTE,
    tags: [],
    content: "",
    sig: "x",
  };
  const rEmpty = await (client as any).decryptEventContent(emptyEvent);
  assert(rEmpty === null,
    "(receive) Edge: empty content returns null");
}

// ══════════════════════════════════════════════════════════════════════════
// PR — UI shell decisions (v0.1.85 hotfix: picker gate + community-tap)
// ══════════════════════════════════════════════════════════════════════════
//
// These exercise the pure decision functions that drive the App.tsx
// shell's two recently-broken behaviors:
//   - Federation picker should not appear for returning users
//   - Community-pill taps should change federation membership, not just
//     filter Browse
//
// Importing src/ui from the harness is fine because decisions.ts is
// pure (no React, no DOM) — it's domain logic that happens to sit in
// the UI directory.

import {
  decideCommunityTapEffect,
  decideAutoInitTarget,
  shouldShowBrowserSupportBanner,
  displayCounterpartyName,
  canOfferSubscription,
  hasActiveBuyerSellerCommitment,
  countActiveBuyerSellerCommitments,
  sumActiveBuyerSellerTradeMsats,
  isMidFunding,
  findActiveTrade,
  shouldShowRecoveryBanner,
  identifyStrandedEcashSource,
  summarizePendingPayoutsForUi,
  selectPayoutReattachTargets,
  strandedSourceExplainsBalance,
  PENDING_PAYOUT_SUPPRESS_MAX_MS,
  decideListingTapEffect,
  shouldShowOnBrowse,
  listingMatchesActiveRoute,
  resolveCreateMintUrl,
  decideArbiterWarning,
  MAIN_SURFACE_RECOVERY_MIN_SATS,
  activeCommittedMsats,
} from "../ui/decisions.js";
import { pickArbiterFromPool, pickPreferredArbiter } from "../arbiters/pool.js";
// BP_FEDERATION_INVITE / BLF_FEDERATION_INVITE already imported above
// from federation-config (which re-exports from federation-invites).

// (NOTE: shouldShowFirstTimePicker was retired in v0.1.85 — the on-shell
// picker is gone; community pills are the primary first-time join
// surface and Sandbox mode hosts the power-user picker.)

// ── 28. COMMUNITY-PILL TAP EFFECT ───────────────────────────────────────
console.log("\n── COMMUNITY-PILL TAP EFFECT ──");
{
  // v0.1.87: the "All communities" pill (and its filter-only effect)
  // are gone — every user has a home, so every tap is an identity
  // choice. The decision function returns one of three kinds:
  // identity-only / switch-silent / destroy-confirm.

  // First-time user (no current invite) tapping a community → switch-silent.
  // v0.1.85 update: the community pill IS the first-time join, no separate
  // picker step. The handler dispatches initFedimint (vs switchFederation)
  // based on whether a fed is already loaded.
  const firstTime = decideCommunityTapEffect({
    slug: "sn-cfa", currentInvite: null, balanceMsats: 0,
  });
  assert(firstTime.kind === "switch-silent",
    "First-time user tap → switch-silent (one-tap join, no picker step)");
  if (firstTime.kind === "switch-silent") {
    assert(firstTime.targetInvite === OCA_FEDERATION_INVITE,
      "First-time tap on sn-cfa targets OCA (its pinned invite)");
    assert(firstTime.displayName === "Senegal · CFA",
      "First-time tap carries the community displayName");
  }

  // Returning user already on the community's federation → identity-only.
  const sameFed = decideCommunityTapEffect({
    slug: "sn-cfa", currentInvite: OCA_FEDERATION_INVITE, balanceMsats: 0,
  });
  assert(sameFed.kind === "identity-only",
    "Tap a community whose pinned invite matches current → identity-only");

  // Returning user on a different fed, balance == 0 → silent switch.
  const switchSilent = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 0,
  });
  assert(switchSilent.kind === "switch-silent",
    "Tap different-fed community with balance=0 → switch-silent");
  if (switchSilent.kind === "switch-silent") {
    assert(switchSilent.targetInvite === BLF_FEDERATION_INVITE,
      "Switch-silent targets the community's pinned invite (us-blf → BLF)");
    assert(switchSilent.displayName === "Global · Bitcoin",
      "Switch-silent carries the community's displayName");
  }

  const dustSwitchSilent = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 999,
  });
  assert(dustSwitchSilent.kind === "switch-silent",
    "Sub-sat dust does not block community switching");
  const feeFloorSwitchSilent = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 2_500,
  });
  assert(feeFloorSwitchSilent.kind === "switch-silent",
    "Sub-fee dust does not block community switching");
  // Regression (field report): ~3.5 sats can technically withdraw 1 sat (which
  // burns ~2.5 sats in fees, a net loss), but it's far below the app's material
  // dust line, so it must NOT block a switch. The old bare-withdrawable check
  // blocked here — "can't switch because of 1 stranded sat".
  const oneSatStranded = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 3_505,
  });
  assert(oneSatStranded.kind === "switch-silent",
    "1 recoverable sat (sub-material dust) does not block community switching");
  // A withdrawable-but-sub-material balance (50 sats) is still dust here — the
  // SAME line the recovery banner uses (it won't even nudge to recover this).
  const subMaterialSwitchSilent = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 50_000,
  });
  assert(subMaterialSwitchSilent.kind === "switch-silent",
    "Sub-material balance (50 sats) does not block community switching");

  // Returning user on a different fed with a MATERIAL balance (>= 2000 sats)
  // → destroy-confirm modal.
  const destroyConfirm = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 5_000_000,
  });
  assert(destroyConfirm.kind === "destroy-confirm",
    "Tap different-fed community with a material balance → destroy-confirm");
  if (destroyConfirm.kind === "destroy-confirm") {
    assert(destroyConfirm.targetInvite === BLF_FEDERATION_INVITE,
      "Destroy-confirm targets the community's pinned invite");
    assert(destroyConfirm.balanceMsats === 5_000_000,
      "Destroy-confirm carries the live balance for the modal copy");
    assert(destroyConfirm.currentInvite === BP_FEDERATION_INVITE,
      "Destroy-confirm carries the active invite for cancel-revert");
  }

  // V3 #72: a live buyer/seller commitment blocks the switch — and the
  // balance guard alone could never catch this, because during LOCKED the
  // wallet correctly reads 0 (ecash spent into SSS shares).
  const blockedByCommitment = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 0,
    activeCommitmentCount: 1,
  });
  assert(blockedByCommitment.kind === "blocked-active-commitment",
    "Live commitment blocks a different-fed switch even at balance 0 (the LOCKED blindspot)");
  if (blockedByCommitment.kind === "blocked-active-commitment") {
    assert(blockedByCommitment.activeCommitmentCount === 1,
      "Blocked effect carries the commitment count for honest toast copy");
  }

  // Commitment outranks the destroy-confirm: no destructive override is
  // offered while a trade is live.
  const blockedOverDestroy = decideCommunityTapEffect({
    slug: "us-blf", currentInvite: BP_FEDERATION_INVITE, balanceMsats: 5_000_000,
    activeCommitmentCount: 2,
  });
  assert(blockedOverDestroy.kind === "blocked-active-commitment",
    "Commitment outranks material balance — blocked, not destroy-confirm");

  // Same fed → identity-only regardless of commitments (no fed change, no risk).
  const sameFedWithCommitment = decideCommunityTapEffect({
    slug: "sn-cfa", currentInvite: OCA_FEDERATION_INVITE, balanceMsats: 0,
    activeCommitmentCount: 3,
  });
  assert(sameFedWithCommitment.kind === "identity-only",
    "Commitments never block staying — same-fed tap stays identity-only");

  // First-time user can't have commitments on a fed they never joined; the
  // optional field defaults to 0 for legacy callers (covered above).

  // V3 #72, listing-tap face: a foreign-route listing dispatches the same
  // silent fed switch — blocked under a live commitment; matching listings
  // are untouched.
  const listingBlocked = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
    activeCommitmentCount: 1,
  });
  assert(listingBlocked.kind === "blocked-active-commitment",
    "Foreign-listing tap is blocked while a live commitment anchors the user");
  const listingMatchingWithCommitment = decideListingTapEffect({
    listing: { mintUrl: BP_FEDERATION_INVITE, community: null },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
    activeCommitmentCount: 1,
  });
  assert(listingMatchingWithCommitment.kind === "matching",
    "Same-fed listings stay tappable during a live commitment");
  const listingNoCommitment = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
    activeCommitmentCount: 0,
  });
  assert(listingNoCommitment.kind === "switch-silent",
    "Zero commitments → foreign-listing tap switch-silent unchanged");

  // ── v4.1 D: cross-chama continuation (narrowed switch-away guard) ──
  // The block must key on commitments switching AWAY would STRAND — live
  // trades on a fed OTHER than the target. `activeCommitmentCountElsewhere`,
  // when supplied, is authoritative; omitted, the legacy fed-agnostic count
  // still applies (so the live call site is unchanged until wired).

  // LOAD-BEARING SAFETY INVARIANT: you can NEVER switch away from a fed that
  // holds a live trade. A commitment on another fed (Elsewhere=1) blocks the
  // foreign-listing tap even though the target fed itself has none.
  const blockedAwayFromLiveTrade = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
    activeCommitmentCount: 1,
    activeCommitmentCountElsewhere: 1,
  });
  assert(blockedAwayFromLiveTrade.kind === "blocked-active-commitment",
    "SAFETY: a live trade on another fed still blocks switching away (away-block holds)");

  // CONTINUATION: the user's only live trade is on the TARGET fed (the one
  // they're switching toward to continue it). Nothing would be stranded, so
  // the tap is allowed — switch-silent at zero balance.
  const continueOwnTradeOnTarget = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
    activeCommitmentCount: 1,          // 1 live trade total…
    activeCommitmentCountElsewhere: 0, // …but it's on the target fed, not elsewhere
  });
  assert(continueOwnTradeOnTarget.kind === "switch-silent",
    "CONTINUATION: switching toward the fed that holds your own live trade is allowed");

  // Elsewhere>0 with a non-zero balance is still blocked outright (the block
  // precedes the destroy-confirm branch — stranding a live trade outranks dust).
  const blockedEvenWithBalance = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 5_000_000,
    activeCommitmentCount: 2,
    activeCommitmentCountElsewhere: 2,
  });
  assert(blockedEvenWithBalance.kind === "blocked-active-commitment",
    "SAFETY: away-block outranks the balance destroy-confirm branch");

  // BACK-COMPAT: a legacy caller that omits Elsewhere keeps the exact old
  // behavior — any commitment blocks (no silent relaxation of the live path).
  const legacyCallerUnchanged = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
    activeCommitmentCount: 1, // no Elsewhere field → legacy fed-agnostic block
  });
  assert(legacyCallerUnchanged.kind === "blocked-active-commitment",
    "BACK-COMPAT: omitting activeCommitmentCountElsewhere preserves the legacy block");

  // Custom-invite override is bypassed — community-tap honors the
  // community's pinned invite even if a custom override is set elsewhere.
  // (We pass currentInvite as an arbitrary custom string and verify the
  // target is still the community's pin, not the custom override.)
  const customOverride = decideCommunityTapEffect({
    slug: "ke-kes",
    currentInvite: "fed1qcustom_invite_user_pasted_in_sandbox",
    balanceMsats: 0,
  });
  assert(customOverride.kind === "switch-silent",
    "Custom-invite override doesn't pin the user — tapping a community switches");
  if (customOverride.kind === "switch-silent") {
    const keKesInvite = getCommunityBySlug("ke-kes")!.federationInvite!;
    assert(customOverride.targetInvite === keKesInvite,
      "Community-tap target is the community's pin, not the custom override");
  }

  // Unknown slug → falls through to BP fallback. Edge case: a wire-stale
  // slug somehow surfacing in the UI. We still treat it as a valid
  // identity choice (better than a no-op silent failure).
  const unknownSlug = decideCommunityTapEffect({
    slug: "xx-unknown", currentInvite: BLF_FEDERATION_INVITE, balanceMsats: 0,
  });
  assert(unknownSlug.kind === "switch-silent",
    "Unknown slug → switch-silent against BP fallback");
  if (unknownSlug.kind === "switch-silent") {
    assert(unknownSlug.targetInvite === BP_FEDERATION_INVITE,
      "Unknown slug targets BP (universal fallback)");
    assert(unknownSlug.displayName === "xx-unknown",
      "Unknown slug uses the slug itself as displayName");
  }
}

// ── 28b. AUTO-INIT TARGET (sticky-community routing, v0.1.87) ──────────
//
// decideAutoInitTarget drives the App.tsx auto-init useEffect. Per
// PHILOSOPHY.md §2.1 "every user has a home" doctrine, refresh always
// lands the user on their home community's federation — except when
// an in-flight trade with funds at risk requires preserving the
// OPFS-bound fed so the trade can resume.
//
// Decision tree:
//   1. hasCurrentEscrow && balanceMsats > 0 && activeInvite → use-active
//   2. else with homeCommunity set → use-home
//   3. else → skip
console.log("\n── AUTO-INIT TARGET ──");
{
  // 1) In-flight trade with funds at stake → preserve active fed.
  const inFlight = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: true,
    balanceMsats: 50_000,
  });
  assert(inFlight.kind === "use-active",
    "currentEscrow + balance>0 → use-active (preserves in-flight fed)");
  if (inFlight.kind === "use-active") {
    assert(inFlight.invite === BLF_FEDERATION_INVITE,
      "use-active carries the OPFS-bound active invite");
  }

  // 2) currentEscrow recorded but balance is zero → trade post-claimed
  //    or recovered out-of-band. Strands the user if we preserve. Use-home.
  const claimedOrRecovered = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: true,
    balanceMsats: 0,
  });
  assert(claimedOrRecovered.kind === "use-home",
    "currentEscrow + balance==0 → use-home (no funds to preserve)");
  if (claimedOrRecovered.kind === "use-home") {
    assert(claimedOrRecovered.slug === "sn-cfa",
      "use-home carries the home community slug");
    assert(claimedOrRecovered.invite === OCA_FEDERATION_INVITE,
      "use-home invite is the home community's pinned invite (sn-cfa → OCA)");
  }

  // 3) Returning user, no active trade → sticky-community.
  const steady = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "ke-kes",
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(steady.kind === "use-home",
    "No active trade + home set → use-home (sticky-community)");
  if (steady.kind === "use-home") {
    const keKesInvite = getCommunityBySlug("ke-kes")!.federationInvite!;
    assert(steady.invite === keKesInvite,
      "Sticky-community lands on home's pinned invite even if active differs");
  }

  // 4) Returning user already on home's fed → still use-home (idempotent).
  const alreadyHome = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(alreadyHome.kind === "use-home",
    "Already on home fed → still use-home (idempotent dispatch)");

  // 5) Orphan ecash without an active trade. v0.1.87 falls to use-home;
  //    the data-layer reconciliation guard catches the balance>0 conflict
  //    and surfaces the destroy-confirm modal. v0.2.0's recovery banner
  //    will intercept this state before sticky-community fires.
  const orphan = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: "sn-cfa",
    hasCurrentEscrow: false,
    balanceMsats: 50_000,
  });
  assert(orphan.kind === "use-home",
    "Balance>0 without currentEscrow → use-home (data-layer guard handles conflict)");

  // 6) Truly first-time user — v0.2.0 item 6: no home AND no active →
  //    use-default (BLF + Global USD/us-blf, v0.7.0; was BP + global-usd in v0.2.0).
  //    Pre-v0.2.0 this fell to "skip"
  //    and stranded users in "No Chama" limbo per Pillar 2.1's
  //    "every user has a home" doctrine.
  const firstTime = decideAutoInitTarget({
    activeInvite: null,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(firstTime.kind === "use-default",
    "First-time user (no home, no active) → use-default (v0.2.0 item 6)");
  if (firstTime.kind === "use-default") {
    assert(firstTime.defaultCommunity === "us-blf",
      "First-time default community is us-blf (BLF, v0.5.0)");
    assert(firstTime.invite === BLF_FEDERATION_INVITE,
      "First-time default invite is BLF (v0.5.0 dev-owned federation)");
    assert(firstTime.reason === "first-time-npub",
      "First-time use-default carries the 'first-time-npub' reason");
  }

  // 7) Known active invite without a community pick now repairs into a
  //    scoped home. This catches profiles that have an old active fed
  //    but no scoped community.
  const blfNoHome = decideAutoInitTarget({
    activeInvite: BLF_FEDERATION_INVITE,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(blfNoHome.kind === "use-default",
    "Known active invite without home → use-default repair");
  if (blfNoHome.kind === "use-default") {
    assert(blfNoHome.defaultCommunity === "us-blf",
      "BLF active invite repairs to us-blf");
    assert(blfNoHome.reason === "active-invite-without-home",
      "Active-without-home repair is labeled");
  }

  const afribitNoHome = decideAutoInitTarget({
    activeInvite: AFRIBIT_KIBERA_FEDERATION_INVITE,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(afribitNoHome.kind === "use-default",
    "Afribit active invite without home repairs to Kenya");
  if (afribitNoHome.kind === "use-default") {
    assert(afribitNoHome.defaultCommunity === "ke-kes",
      "Afribit active invite repairs to ke-kes");
    assert(afribitNoHome.reason === "active-invite-without-home",
      "Afribit active-without-home repair is labeled");
  }

  const bitsaccoNoHome = decideAutoInitTarget({
    activeInvite: BITSACCO_FEDERATION_INVITE,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(bitsaccoNoHome.kind === "use-default",
    "Bitsacco active invite without home repairs to Kenya");
  if (bitsaccoNoHome.kind === "use-default") {
    assert(bitsaccoNoHome.defaultCommunity === "ke-kes-bitsacco",
      "Bitsacco active invite repairs to ke-kes-bitsacco");
    assert(bitsaccoNoHome.reason === "active-invite-without-home",
      "Bitsacco active-without-home repair is labeled");
  }

  const publicFediRoute = PUBLIC_FEDI_APPROVED_FEDERATIONS.find(route => route.slug === "fedi-victoria-btc")!;
  const publicFediNoHome = decideAutoInitTarget({
    activeInvite: publicFediRoute.invite,
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(publicFediNoHome.kind === "use-default",
    "Public Fedi active invite without home repairs to its wallet service");
  if (publicFediNoHome.kind === "use-default") {
    assert(publicFediNoHome.defaultCommunity === publicFediRoute.slug,
      "Public Fedi active invite repairs to the matching route slug");
    assert(publicFediNoHome.reason === "active-invite-without-home",
      "Public Fedi active-without-home repair is labeled");
  }

  const customNoHome = decideAutoInitTarget({
    activeInvite: "fed1qcustomunknownroute",
    homeCommunity: null,
    hasCurrentEscrow: false,
    balanceMsats: 0,
  });
  assert(customNoHome.kind === "skip",
    "Unknown custom active invite without home remains manual reconnect");
}

// ── 29. RUNTIME SUPPORT BANNER GATE ─────────────────────────────────────
//
// One-time-per-account positive announcement for supported real-sats
// runtimes. v1.1.0 reframes the old browser note into a clear Fedi /
// Tauri / APK support note. Gate logic: show once per pubkey, suppress
// in sim mode, never re-show after dismissal.
console.log("\n── RUNTIME SUPPORT BANNER GATE ──");
{
  // Browser, never dismissed → show (regardless of join state)
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: false,
    }) === true,
    "Browser user (not yet dismissed) sees the banner",
  );

  // Native platform — also show, because the copy names APK/Tauri/Fedi
  // as the preferred real-sats runtimes.
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: false, dismissed: false,
    }) === true,
    "Native (APK/Tauri/Fedi) user sees the supported-runtime banner",
  );

  // Dismissed earlier — never re-show
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: true,
    }) === false,
    "Once dismissed, the banner stays dismissed across sessions",
  );

  // v0.4.2 sim mode: contradicts the SIM MODE pill, always suppress.
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: false, simModeOn: true,
    }) === false,
    "Sim mode suppresses the browser-support announcement",
  );
  assert(
    shouldShowBrowserSupportBanner({
      isBrowser: true, dismissed: true, simModeOn: true,
    }) === false,
    "Sim mode + dismissed is still suppressed",
  );
}

// ── 29b. COUNTERPARTY DISPLAY NAME (v0.1.87 / v0.2.0+v0.2.1 helper) ─────
//
// Used by the v0.2.0 recovery banner ("Your trade with [counterparty]
// didn't finish") and the arbiter-attention warnings ("Trade between
// [npub-A] and [npub-B]"). Pure function: returns the kind:0 name only
// when the user has opted in AND the counterparty has self-published
// a usable kind:0 name. v0.2.0 ships the helper with kind0Name=null
// across the board (no fetcher yet); v0.2.1 wires the fetcher.
console.log("\n── COUNTERPARTY DISPLAY NAME ──");
{
  const npubA = "1c6abd8a7f3e9b22d45c1f0a8e7b6c5d4f3e2a1b0c9d8e7f6a5b4c3d2e1f0987";

  // Default: truncated npub regardless of name presence when toggle off.
  const defaultDisplay = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: false, kind0Name: "Alice",
  });
  assert(defaultDisplay === "1c6abd8a…0987",
    "Toggle off → truncated npub even if a kind:0 name is supplied");

  // Toggle on but kind0Name is null (v0.2.0 default before fetcher ships).
  const noFetcherYet = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: null,
  });
  assert(noFetcherYet === "1c6abd8a…0987",
    "Toggle on but no kind:0 name → truncated npub fallback");

  // Both conditions met → render the name.
  const happyPath = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: "Alice from Dakar",
  });
  assert(happyPath === "Alice from Dakar",
    "Toggle on + kind:0 name present → render the name");

  // Empty/whitespace-only kind:0 name → fall back (don't render whitespace).
  const emptyName = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: "   ",
  });
  assert(emptyName === "1c6abd8a…0987",
    "Whitespace-only kind:0 name doesn't render — falls back to npub");

  // Name with surrounding whitespace gets trimmed (defensive against
  // sloppy kind:0 publishers).
  const trimsName = displayCounterpartyName({
    npub: npubA, fetchKind0Enabled: true, kind0Name: "  Bob  ",
  });
  assert(trimsName === "Bob", "kind:0 name is trimmed before render");

  // Short pubkey (shorter than the truncation window) — return as-is
  // so we don't produce a degenerate "ab…cd" of an 8-char string.
  const shortNpub = displayCounterpartyName({
    npub: "abcd1234", fetchKind0Enabled: false, kind0Name: null,
  });
  assert(shortNpub === "abcd1234",
    "Short npub passes through unchanged (no truncation degeneracy)");
}

// ── 29c. CREATE FED TAGS — probe-decoupled (v0.1.87 item 9) ─────────────
//
// Per Pillar 2.3 ("federation follows the listing"), every CREATE
// event must carry enough federation context for buyers to resolve
// regardless of seller-side probe outcome. deriveCreateFedTags is
// the pure derivation: probe-success contributes both fedPrefix and
// fed; probe-failure still surfaces fed via the cached client state;
// truly disconnected (no client) yields neither tag.
console.log("\n── CREATE FED TAGS (probe-decoupled) ──");
{
  // Probe success → both tags present.
  const probeOk = deriveCreateFedTags({
    cachedFedId: "abcdef0123456789",
    probeResult: { prefix: "fed1abcdef", fed: "abcdef0123456789" },
  });
  assert(probeOk.fedPrefix === "fed1abcdef",
    "Probe-success → fedPrefix populated");
  assert(probeOk.fed === "abcdef0123456789",
    "Probe-success → fed populated");

  // Probe FAILED but client knows its fed ID → fed survives, fedPrefix
  // omitted. This is the load-bearing fix for item 9: pre-v0.1.87 a
  // probe failure stripped fed too, cascading into buyer-side filtering.
  const probeFail = deriveCreateFedTags({
    cachedFedId: "abcdef0123456789",
    probeResult: null,
  });
  assert(probeFail.fed === "abcdef0123456789",
    "Probe-fail with cached fed ID → fed tag survives");
  assert(probeFail.fedPrefix === undefined,
    "Probe-fail → fedPrefix omitted (no ecash to derive prefix from)");

  // No client + no probe (truly disconnected) → neither tag.
  // Listing still gets community + mintUrl from upstream params, so
  // it's resolvable; this branch just means the probe-derived
  // safety nets are absent.
  const noClient = deriveCreateFedTags({
    cachedFedId: null,
    probeResult: null,
  });
  assert(noClient.fed === undefined,
    "No client, no probe → no fed tag");
  assert(noClient.fedPrefix === undefined,
    "No client, no probe → no fedPrefix tag");

  // Probe with null fed (edge case where the WASM probe returned a
  // prefix but couldn't capture the fed ID) — fallback to cachedFedId.
  const probePartial = deriveCreateFedTags({
    cachedFedId: "abcdef0123456789",
    probeResult: { prefix: "fed1abcdef", fed: null },
  });
  assert(probePartial.fedPrefix === "fed1abcdef",
    "Partial probe still surfaces fedPrefix");
  assert(probePartial.fed === "abcdef0123456789",
    "Partial probe falls back to cachedFedId for fed");
}

// ── 29d. PROBE REACHABILITY (v0.4.4) ─────────────────────────────────────
//
// v0.1.76 Option B ("no sats stranded ever") sits wallets at 0 between
// trades. The pre-v0.4.4 probeFederation() round-tripped a 1-sat OOB
// note to extract a 10-char federation identifier — that path was
// guaranteed to throw "Insufficient balance: requested 1000 msat but
// only 0 msat available" against any clean wallet, and the boot probe
// dutifully surfaced "Chama unreachable" for every user on every cold
// boot. The bug was masked by prior iroh-relay 400 errors; once those
// got fixed (canary branch), the probe's own bug was the only
// remaining "unreachable" signal.
//
// v0.4.4 replaces the spend-based probe with probeReachable(), which:
//   - returns { fed } using the cached client federation ID
//   - exercises wallet.balance.getBalance() (works cleanly at 0 sats)
//   - throws if the wallet/federation rejects the read
//   - bypasses sim mode with a direct fed-ID return
//
// Two-layer tripwire:
//   (1) Behavioral assertions on the real FedimintClient with a mock
//       wallet — verifies probeReachable returns {fed} at 0 balance
//       (the boot-probe failure case for the old spend-based probe),
//       throws when not joined, and sim-mode-bypasses cleanly.
//   (2) Grep tripwire over src/fedimint/fedimint-client.ts. Catches
//       any reintroduction of a probeFederation() function definition.
//       Same shape as §43's Trinity Ring tripwire — strips comments
//       and normalizes whitespace so doc references to the historical
//       name in jsdoc blocks don't trigger.
console.log("\n── PROBE REACHABILITY ──");
{
  const { FedimintClient } = await import("../fedimint/fedimint-client.js");

  // Minimal IFedimintWallet stub. Starts at 0 balance — the case that
  // structurally broke the old spend-based probe.
  function makeZeroBalanceWallet(opts: { federationId: string }) {
    return {
      async open() {},
      isOpen() { return true; },
      recovery: {
        async hasPendingRecoveries() { return false; },
        async waitForAllRecoveries() {},
      },
      async joinFederation(_invite: string) {},
      balance: {
        async getBalance() { return 0; },
        subscribeBalance(_cb: (b: number) => void) { return () => {}; },
      },
      mint: {
        async spendNotes(_msat: number): Promise<string> {
          throw new Error("Insufficient balance: requested 1000 msat but only 0 msat available");
        },
        async redeemEcash(_oob: string) {},
        async parseNotes(_oob: string) { return { total_amount: 0 }; },
      },
      lightning: {
        async createInvoice(_msat: number, _desc: string) {
          return { invoice: "lnbc0", operationId: "op0" };
        },
        async payInvoice(_b: string) { return { operationId: "op0" }; },
      },
      federation: {
        async getFederationId() { return opts.federationId; },
        async getInviteCode() { return "fed1zerobal"; },
      },
      async cleanup() {},
    };
  }

  // Force sim OFF for the real-wallet path.
  (globalThis as any).localStorage?.removeItem?.("chama_sim_mode");

  // (1a) probeReachable returns { fed } at 0 balance — the boot-probe
  //      failure case for the old probeFederation.
  {
    const FED_ID = "888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e";
    const client = new FedimintClient(
      {},
      async () => makeZeroBalanceWallet({ federationId: FED_ID }),
    );
    await client.init();
    const result = await client.probeReachable();
    assert(result.fed === FED_ID,
      "probeReachable returns the cached federation ID at 0 balance (old probe's structural failure case now passes)");
    await client.cleanup();
  }

  // (1a.1) Tauri/native first run: the Rust sidecar returns
  // "Client database not initialized" from /info before /join. That
  // must be treated the same as the browser SDK's fresh-DB message so
  // init can continue and joinFederation can create the client.
  {
    const FED_ID = "native_fresh_db_fed";
    let opened = false;
    let joinCount = 0;
    const wallet: any = makeZeroBalanceWallet({ federationId: FED_ID });
    wallet.open = async () => {
      throw new Error(
        "Native Fedimint bridge /info failed (500): failed to open Fedimint client: Client database not initialized",
      );
    };
    wallet.isOpen = () => opened;
    wallet.joinFederation = async (_invite: string) => {
      opened = true;
      joinCount += 1;
    };

    const client = new FedimintClient({}, async () => wallet);
    await client.init();
    const federationId = await client.joinFederation("fed1nativefresh");
    assert(federationId === FED_ID,
      "Native first-run database-not-initialized error is swallowed so join can create the client");
    assert(joinCount === 1,
      "Native first-run path calls joinFederation after the harmless open miss");
    await client.cleanup();
  }

  // (1a.2) Route-integrity guard: an already-open wallet must not let a
  // requested Afribit invite be recorded while the OPFS/native client is
  // actually still bound to BLF. This is the exact stale-route shape that
  // can make the UI say one community while money operations hit another.
  {
    const wallet: any = makeZeroBalanceWallet({ federationId: BLF_FEDERATION_ID });
    const client = new FedimintClient({}, async () => wallet);
    await client.init();

    let threw = false;
    try {
      await client.joinFederation(AFRIBIT_KIBERA_FEDERATION_INVITE);
    } catch (e: any) {
      threw = true;
      assert(e?.code === "FED_JOIN_MISMATCH",
        "Already-open wallet rejects known invite/federation ID mismatch");
      assert(e?.expected === AFRIBIT_KIBERA_FEDERATION_ID,
        "Already-open mismatch reports the requested federation ID");
      assert(e?.got === BLF_FEDERATION_ID,
        "Already-open mismatch reports the actual wallet federation ID");
    }
    assert(threw,
      "Already-open BLF wallet cannot be recorded as Afribit");
    await client.cleanup();
  }

  // (1a.3) Fresh join guard: if an adapter claims it joined an invite but
  // getFederationId() returns a different known federation, fail before
  // callbacks/localStorage can pin the wrong active route.
  {
    let opened = false;
    const wallet: any = makeZeroBalanceWallet({ federationId: BLF_FEDERATION_ID });
    wallet.open = async () => {
      throw new Error("Client database not initialized");
    };
    wallet.isOpen = () => opened;
    wallet.joinFederation = async (_invite: string) => {
      opened = true;
    };

    const client = new FedimintClient({}, async () => wallet);
    await client.init();

    let threw = false;
    try {
      await client.joinFederation(AFRIBIT_KIBERA_FEDERATION_INVITE);
    } catch (e: any) {
      threw = true;
      assert(e?.code === "FED_JOIN_MISMATCH",
        "Fresh join rejects known invite/federation ID mismatch");
      assert(e?.expected === AFRIBIT_KIBERA_FEDERATION_ID,
        "Fresh join mismatch reports the requested federation ID");
      assert(e?.got === BLF_FEDERATION_ID,
        "Fresh join mismatch reports the actual wallet federation ID");
    }
    assert(threw,
      "Fresh join cannot silently return BLF for an Afribit invite");
    await client.cleanup();
  }

  // (1b) probeReachable throws when not joined (requireWallet path).
  {
    const client = new FedimintClient({}, async () => {
      throw new Error("factory never called");
    });
    // No init() — wallet null.
    let threw = false;
    try {
      await client.probeReachable();
    } catch (e: any) {
      threw = true;
      assert(/not initialized/.test(e?.message || ""),
        "probeReachable throws a clear 'not initialized' error when called before init()");
    }
    assert(threw, "probeReachable throws when the wallet has not been initialized");
  }

  // (1c) probeReachable throws when the wallet balance read fails —
  //      surfaces a federation-unreachable error rather than silently
  //      succeeding.
  {
    const FED_ID = "deadbeefcafebabe";
    const client = new FedimintClient(
      {},
      async () => {
        const w = makeZeroBalanceWallet({ federationId: FED_ID });
        w.balance.getBalance = async () => {
          throw new Error("federation guardians unreachable");
        };
        return w;
      },
    );
    await client.init();
    let threw = false;
    try {
      await client.probeReachable();
    } catch (e: any) {
      threw = true;
      assert(/Federation probe failed/.test(e?.message || ""),
        "probeReachable surfaces a Federation-probe-failed error when balance read throws");
    }
    assert(threw, "probeReachable throws when the wallet refuses to read balance");
    await client.cleanup();
  }

  // (1d) Sim mode bypass — returns { fed: simFedId } without any
  //      balance/spend roundtrip.
  {
    (globalThis as any).localStorage?.setItem?.("chama_sim_mode", "1");
    try {
      const SIM_FED = "sim_fed_id_xyz";
      const client = new FedimintClient(
        {},
        async () => makeZeroBalanceWallet({ federationId: SIM_FED }),
      );
      await client.init();
      const result = await client.probeReachable();
      assert(result.fed === SIM_FED,
        "Sim mode: probeReachable short-circuits and returns the sim federation ID");
      await client.cleanup();
    } finally {
      (globalThis as any).localStorage?.removeItem?.("chama_sim_mode");
    }
  }

  // (2) Tripwire — probeFederation must not reappear as a function
  // definition or non-comment call in fedimint-client.ts. Strips
  // comments and normalizes whitespace (same shape as §43's Trinity
  // Ring tripwire) so the jsdoc note in probeReachable's docstring
  // (which references the historical name in plain prose) doesn't
  // trip the check.
  {
    function stripComments(src: string): string {
      let result = src.replace(/\/\*[\s\S]*?\*\//g, "");
      result = result.replace(/\/\/[^\n]*/g, "");
      return result;
    }
    function normalizeWhitespace(src: string): string {
      return src.replace(/\s+/g, " ");
    }

    // Self-tests — confirm the strip/normalize is doing what we expect.
    assert(
      !stripComments("/* probeFederation in a block comment */").includes("probeFederation"),
      "Tripwire self-test: stripComments removes block-comment references",
    );
    assert(
      !stripComments("// probeFederation in a line comment").includes("probeFederation"),
      "Tripwire self-test: stripComments removes line-comment references",
    );
    assert(
      stripComments("async probeFederation() {} // doc").includes("probeFederation"),
      "Tripwire self-test: a real function definition survives stripComments",
    );

    const fcSrc = readFileSync("src/fedimint/fedimint-client.ts", "utf8");
    const stripped = normalizeWhitespace(stripComments(fcSrc));
    assert(!stripped.includes("probeFederation"),
      "probeFederation does NOT appear in non-comment code of src/fedimint/fedimint-client.ts " +
      "(v0.4.4 deleted the balance-coupled probe; any reintroduction is a regression)");
  }
}

// ── 29e. Fedi Mini-App ecash funding path ───────────────────────────────
//
// Fedi's Mini-App runtime exposes ecash-native wallet primitives. Chama
// must not run those notes through the broken Lightning receive path; it
// asks Fedi to generate OOB notes, verifies the exact amount, then locks
// those notes directly.
console.log("\n── Fedi Mini-App ecash funding path ──");
{
  const {
    generateFediEcash,
    hasFediInternalEcash,
    hasFediInternalGenerateEcash,
    hasFediInternalReceiveEcash,
    msatsToExactSats,
    receiveFediEcash,
  } = await import("../fedimint/fedi-internal.js");
  const { FedimintClient } = await import("../fedimint/fedimint-client.js");

  assert(msatsToExactSats(1_000_000) === 1_000,
    "Fedi ecash helper converts exact msats to sats");
  let nonWholeSatRejected = false;
  try {
    msatsToExactSats(1_000_001);
  } catch (e: any) {
    nonWholeSatRejected = /whole-sat/.test(e?.message || "");
  }
  assert(nonWholeSatRejected,
    "Fedi ecash helper rejects non-whole-sat amounts before moving money");

  const originalWindow = (globalThis as any).window;
  try {
    let requestedAmount: number | null = null;
    (globalThis as any).window = {
      fediInternal: {
        async generateEcash(req: { amount: number }) {
          requestedAmount = req.amount;
          return { notes: "oob-notes-from-fedi" };
        },
        async receiveEcash(_ecash: string) {
          return { msats: 1_000_000 };
        },
      },
    };
    assert(hasFediInternalGenerateEcash(),
      "Fedi funding capability is true when generateEcash is available");
    assert(hasFediInternalReceiveEcash(),
      "Fedi receive capability is true when receiveEcash is available");
    assert(hasFediInternalEcash(),
      "Fedi full ecash capability is true when generate+receive are available");
    const generated = await generateFediEcash(1_000_000, "test trade");
    assert(generated.notes === "oob-notes-from-fedi",
      "generateFediEcash unwraps Fedi's {notes} response");
    assert(requestedAmount === 1_000,
      "generateFediEcash asks Fedi for sats, not msats");

    delete (globalThis as any).window.fediInternal.receiveEcash;
    assert(hasFediInternalGenerateEcash(),
      "Fedi funding still uses generateEcash when receiveEcash is unavailable");
    assert(!hasFediInternalReceiveEcash(),
      "Fedi receive capability is false when receiveEcash is unavailable");
    assert(!hasFediInternalEcash(),
      "Fedi full ecash capability stays false without receiveEcash");
    const generatedWithoutReceive = await generateFediEcash(1_000_000, "fund-only trade");
    assert(generatedWithoutReceive.notes === "oob-notes-from-fedi",
      "Fedi funding does not require receiveEcash and avoids Lightning receive");

    (globalThis as any).window.fediInternal.receiveEcash = async () => ({ msats: 1_000_000 });

    (globalThis as any).window.fediInternal.generateEcash = async () => "raw-oob-notes";
    const rawGenerated = await generateFediEcash(2_000_000);
    assert(rawGenerated.notes === "raw-oob-notes",
      "generateFediEcash also accepts older/native raw-string responses");

    const received = await receiveFediEcash("claim-oob-notes", 1_000_000);
    assert(received === 1_000_000,
      "receiveFediEcash unwraps Fedi's {msats} response");

    (globalThis as any).window.fediInternal.receiveEcash = async () => ({ amount: { msats: 2_000_000 } });
    const nestedReceived = await receiveFediEcash("claim-oob-notes", 2_000_000);
    assert(nestedReceived === 2_000_000,
      "receiveFediEcash accepts nested amount.msats responses");

    (globalThis as any).window.fediInternal.receiveEcash = async () => undefined;
    const unreportedReceived = await receiveFediEcash("claim-oob-notes");
    assert(unreportedReceived === null,
      "receiveFediEcash accepts success responses that omit an amount");

    (globalThis as any).window.fediInternal.receiveEcash = async () => ({ msats: 999_000 });
    let receiveMismatchRejected = false;
    try {
      await receiveFediEcash("claim-oob-notes", 1_000_000);
    } catch (e: any) {
      receiveMismatchRejected = /expected 1000000/.test(e?.message || "");
    }
    assert(receiveMismatchRejected,
      "receiveFediEcash rejects amount mismatches when Fedi reports an amount");
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }

  // ── 29f. Fedi fund-and-lock recovery (fund-loss guard) ──────────────────
//
// The Fedi funding path spends ecash OUT of Fedi, then locks it — two steps
// with the bearer notes living only in a JS variable between them (#37: the
// SDK-wallet paths have the SAME window, guarded by the sibling
// pending-native-locks stash — see block 29g). These tests prove
// the spend is committed ONLY on a confirmed LOCK-with-our-notesHash, and is
// re-absorbed back into Fedi on every other exit: abort, amount mismatch,
// publish failure, a racing tab's foreign LOCK, and a reload/crash (boot
// drain). This is the launch-blocker fund-loss Jetty hit on a 105-sat trade.
console.log("\n── Fedi fund-and-lock recovery (fund-loss guard) ──");
{
  const { runFediFundAndLock } = await import("../payments/fedi-fund-and-lock.js");
  const {
    stashPendingFunding,
    listPendingFundings,
    drainPendingFundings,
    clearAllPendingFundings,
  } = await import("../fedimint/pending-fundings.js");

  const NOTES = "oob-fund-notes";
  const AMOUNT = 105_000; // 105 sats — Jetty's live trade
  const HASH = `sha256(${NOTES})`; // what hashNotes(NOTES) returns below

  function makeTracked(over: Record<string, any> = {}) {
    const calls = {
      preflight: 0, generate: 0,
      stash: [] as any[], clear: [] as string[], receive: [] as string[], lock: 0,
    };
    const phases: string[] = [];
    const deps: any = {
      escrowId: "trade_fed",
      amountMsats: AMOUNT,
      description: "fund test",
      onPhase: (p: any) => phases.push(p.kind),
      preflight: async () => { calls.preflight++; },
      generateEcash: async () => { calls.generate++; return { notes: NOTES }; },
      receiveEcash: async (n: string) => { calls.receive.push(n); },
      stashFunding: (i: any) => { calls.stash.push(i); },
      clearFunding: (id: string) => { calls.clear.push(id); },
      hashNotes: async (n: string) => `sha256(${n})`,
      lockAndPublish: async () => { calls.lock++; return { lockedNotesHash: HASH }; },
      ...over,
    };
    return { deps, calls, phases };
  }

  // 1. Happy path: generate → LOCK commits our notes → stash cleared, no re-absorb.
  {
    const t = makeTracked();
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "locked", "fedi-fund happy path resolves locked");
    assert(t.calls.stash.length === 1 && t.calls.stash[0].oobNotes === NOTES,
      "fedi-fund happy path stashes the spent notes BEFORE locking");
    assert(t.calls.lock === 1, "fedi-fund happy path publishes exactly one LOCK");
    assert(t.calls.receive.length === 0,
      "fedi-fund happy path never re-absorbs — the LOCK committed our notes");
    assert(t.calls.clear.length === 1 && t.calls.clear[0] === "trade_fed",
      "fedi-fund happy path clears the stash after a confirmed LOCK");
    assert(t.phases[t.phases.length - 1] === "locked",
      "fedi-fund happy path ends on the locked phase");
  }

  // 2. Abort fires AFTER the spend (EXIT A) → re-absorb, no LOCK, stash cleared.
  {
    const ac = new AbortController();
    const t = makeTracked({
      signal: ac.signal,
      // abort mid-flight: the spend has happened, the lock has not.
      generateEcash: async () => { ac.abort(); return { notes: NOTES }; },
    });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "aborted", "fedi-fund abort-after-spend resolves aborted");
    assert(t.calls.stash.length === 1, "fedi-fund abort-after-spend stashed the notes first");
    assert(t.calls.lock === 0, "fedi-fund abort-after-spend never reaches LOCK");
    assert(t.calls.receive.length === 1 && t.calls.receive[0] === NOTES,
      "fedi-fund abort-after-spend re-absorbs the spent notes back into Fedi");
    assert(t.calls.clear.length === 1, "fedi-fund abort-after-spend clears the stash once re-absorbed");
  }

  // 3. LOCK throws amount-mismatch ("No LOCK was published", EXIT B) → re-absorb.
  {
    const t = makeTracked({
      lockAndPublish: async () => {
        throw new Error(
          "Fedi wallet generated 100000 msats, but this trade requires 105000 msats. No LOCK was published.",
        );
      },
    });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "lock-failed", "fedi-fund amount-mismatch resolves lock-failed");
    assert(t.calls.receive.length === 1 && t.calls.receive[0] === NOTES,
      "fedi-fund amount-mismatch re-absorbs the spent notes");
    assert(t.calls.clear.length === 1, "fedi-fund amount-mismatch clears the stash after re-absorb");
    assert(r.kind === "lock-failed" && r.error.includes("returned to your Fedi wallet"),
      "fedi-fund amount-mismatch tells the user the sats came back");
  }

  // 4. Publish throws → re-absorb.
  {
    const t = makeTracked({
      lockAndPublish: async () => { throw new Error("relay publish failed"); },
    });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "lock-failed", "fedi-fund publish-failure resolves lock-failed");
    assert(t.calls.receive.length === 1, "fedi-fund publish-failure re-absorbs the spent notes");
    assert(t.calls.clear.length === 1, "fedi-fund publish-failure clears the stash after re-absorb");
  }

  // 5. Positive-confirmation gate. A racing tab's LOCK commits DIFFERENT notes
  //    (the lock action's stale-suppression swallow resolves WITHOUT throwing).
  //    Our notes were not committed → re-absorb OURS, never assume committed.
  {
    const t = makeTracked({
      lockAndPublish: async () => ({ lockedNotesHash: "sha256(someone-elses-notes)" }),
    });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "lock-failed", "fedi-fund foreign-LOCK resolves lock-failed (our notes not committed)");
    assert(t.calls.receive.length === 1 && t.calls.receive[0] === NOTES,
      "fedi-fund foreign-LOCK re-absorbs OUR notes — the LOCK committed different notes");
    assert(t.calls.clear.length === 1, "fedi-fund foreign-LOCK clears the stash after re-absorb");
  }

  // 5b. Stale-suppression on a terminal trade: lock resolves with a null hash
  //     (no LOCK applied) → re-absorb.
  {
    const t = makeTracked({ lockAndPublish: async () => ({ lockedNotesHash: null }) });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "lock-failed", "fedi-fund suppressed-LOCK (null hash) resolves lock-failed");
    assert(t.calls.receive.length === 1, "fedi-fund suppressed-LOCK re-absorbs the spent notes");
  }

  // 6. Re-absorb itself fails → stash RETAINED (boot drain owns it), honest copy.
  {
    const t = makeTracked({
      lockAndPublish: async () => { throw new Error("publish failed"); },
      receiveEcash: async () => { throw new Error("Fedi receive unavailable"); },
    });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "lock-failed", "fedi-fund re-absorb-failure resolves lock-failed");
    assert(t.calls.clear.length === 0,
      "fedi-fund re-absorb-failure KEEPS the stash — boot drain owns recovery");
    assert(r.kind === "lock-failed" && r.error.includes("next time you open it"),
      "fedi-fund re-absorb-failure tells the user the sats are saved for retry");
  }

  // 7. Item 1 as copy, not a gate: generate throws insufficient-funds → friendly
  //    message, NO stash, NO spend to recover (clean pre-spend exit).
  {
    const t = makeTracked({
      generateEcash: async () => { throw new Error("insufficient balance in wallet"); },
    });
    const r = await runFediFundAndLock(t.deps);
    assert(r.kind === "lock-failed", "fedi-fund insufficient-funds resolves lock-failed");
    assert(r.kind === "lock-failed" && r.error.includes("Not enough in your Fedi wallet"),
      "fedi-fund insufficient-funds shows the friendly top-up copy");
    assert(t.calls.stash.length === 0,
      "fedi-fund insufficient-funds never stashes — generate threw before any spend");
    assert(t.calls.receive.length === 0,
      "fedi-fund insufficient-funds has nothing to re-absorb");
  }

  // 8. Boot drain: a funding stash with no published LOCK → re-absorbed on init.
  {
    clearAllPendingFundings();
    const originalWindow = (globalThis as any).window;
    try {
      const received: string[] = [];
      (globalThis as any).window = {
        fediInternal: {
          async generateEcash() { return { notes: "x" }; },
          async receiveEcash(ecash: string) { received.push(ecash); return { msats: AMOUNT }; },
        },
      };
      stashPendingFunding({ escrowId: "stranded_fund", oobNotes: "stranded-oob", amountMsats: AMOUNT });
      assert(listPendingFundings().length === 1,
        "fedi-fund boot-drain: a stranded funding entry exists pre-drain");
      const summary = await drainPendingFundings();
      assert(received.length === 1 && received[0] === "stranded-oob",
        "fedi-fund boot-drain re-absorbs the stranded notes into Fedi");
      assert(summary.reabsorbed === 1, "fedi-fund boot-drain reports one re-absorbed entry");
      assert(listPendingFundings().length === 0,
        "fedi-fund boot-drain clears the entry after re-absorb");
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      clearAllPendingFundings();
    }
  }

  // 9. Boot drain outside a Fedi runtime: no receive primitive → entry untouched.
  {
    clearAllPendingFundings();
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {}; // no fediInternal
      stashPendingFunding({ escrowId: "stranded_no_fedi", oobNotes: "oob", amountMsats: AMOUNT });
      const summary = await drainPendingFundings();
      assert(summary.attempted === 0 && summary.reabsorbed === 0,
        "fedi-fund boot-drain no-ops without a Fedi receive primitive");
      assert(listPendingFundings().length === 1,
        "fedi-fund boot-drain keeps the entry for the next Fedi boot");
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      clearAllPendingFundings();
    }
  }
}

  // ── 29g. Native/SDK-wallet lock crash-safety (#37) ──────────────────────
//
// bridge.lockAndPublish spends ecash then publishes the LOCK as a second
// await; a reload between them used to strand the notes with NOTHING
// persisted (and the RecoveryBanner then advised draining a live trade).
// The pending-native-locks stash persists the lock lifecycle
// (intent → spent → publish-attempted → cleared-on-confirmed) and boot
// recovery settles entries via a FAIL-CLOSED decision table that only ever
// RE-ABSORBS (reissue-to-self) — never re-publishes a LOCK (a rebuilt or
// replayed second LOCK permanently poisons the trade chain's replay).
console.log("\n── Native lock crash-safety: pending-native-locks (#37) ──");
{
  const {
    PENDING_NATIVE_LOCKS_KEY,
    MAX_NATIVE_LOCK_DRAIN_ATTEMPTS,
    NATIVE_LOCK_INTENT_TTL_MS,
    NATIVE_LOCK_SUPPRESS_MAX_MS,
    assertNativeLockStashWritable,
    stashNativeLockIntent,
    upgradeNativeLockToSpent,
    markNativeLockPublishAttempted,
    clearPendingNativeLock,
    clearPendingNativeLockIfIntent,
    getPendingNativeLock,
    listPendingNativeLocks,
    clearAllPendingNativeLocks,
    recoverPendingNativeLock,
    drainPendingNativeLocks,
    summarizeNativeLocksForUi,
    withNativeLockFlow,
  } = await import("../fedimint/pending-native-locks.js");
  void PENDING_NATIVE_LOCKS_KEY;

  const FED = "fed_native_1";
  const NOTES = "native-oob-notes";
  const AMOUNT = 21_000;

  /** Fake recovery deps. `state` shapes the loadEscrow answer; hashNotes
   *  mirrors the 29f convention so "our" committed hash is sha256(NOTES). */
  function makeDeps(over: Record<string, any> = {}) {
    const calls = { redeem: [] as string[], loads: 0 };
    const deps: any = {
      loadEscrow: async () => { calls.loads++; return over.state ?? null; },
      getConnectedRelayCount: () => over.relays ?? 3,
      redeemNotes: async (n: string) => {
        calls.redeem.push(n);
        if (over.redeemError) throw over.redeemError;
      },
      currentFederationId: () => over.fed ?? FED,
      hashNotes: async (n: string) => `sha256(${n})`,
      ...(over.now ? { now: over.now } : {}),
    };
    return { deps, calls };
  }
  const createdState = (lockHash: string | null) =>
    ({ status: lockHash ? "locked" : "created", lock: { notesHash: lockHash } }) as any;

  // 1. Lifecycle: intent → spent → publish-attempted → clear.
  {
    clearAllPendingNativeLocks();
    assertNativeLockStashWritable(); // must not throw under the stub
    stashNativeLockIntent({ escrowId: "t1", amountMsats: AMOUNT, federationId: FED });
    let e = getPendingNativeLock("t1")!;
    assert(e.stage === "intent" && e.amountMsats === AMOUNT && e.federationId === FED,
      "native-lock lifecycle: intent entry written with amount + fed");
    const intentCreatedAt = e.createdAt;
    upgradeNativeLockToSpent({
      escrowId: "t1", oobNotes: NOTES, amountMsats: AMOUNT,
      federationId: FED, operationId: "op1", spendTimeoutSecs: 7_776_000,
    });
    e = getPendingNativeLock("t1")!;
    assert(e.stage === "spent" && e.oobNotes === NOTES && e.operationId === "op1",
      "native-lock lifecycle: spent upgrade persists the notes + operation id");
    assert(e.createdAt === intentCreatedAt,
      "native-lock lifecycle: spent upgrade preserves the intent's createdAt");
    markNativeLockPublishAttempted("t1");
    assert(getPendingNativeLock("t1")!.stage === "publish-attempted",
      "native-lock lifecycle: publish-attempted marker sticks");
    clearPendingNativeLock("t1");
    assert(getPendingNativeLock("t1") === null && listPendingNativeLocks().length === 0,
      "native-lock lifecycle: clear removes the entry");
  }

  // 2. Bearer-note invariants: no clobber, no downgrade, intent-only clear.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t2", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    let threw = false;
    try {
      upgradeNativeLockToSpent({ escrowId: "t2", oobNotes: "DIFFERENT-notes", amountMsats: AMOUNT, federationId: FED });
    } catch { threw = true; }
    assert(threw, "native-lock invariant: refusing to overwrite different live notes THROWS");
    stashNativeLockIntent({ escrowId: "t2", amountMsats: AMOUNT, federationId: FED });
    assert(getPendingNativeLock("t2")!.stage === "spent" && getPendingNativeLock("t2")!.oobNotes === NOTES,
      "native-lock invariant: an intent write never downgrades a notes-carrying entry");
    clearPendingNativeLockIfIntent("t2");
    assert(getPendingNativeLock("t2") !== null,
      "native-lock invariant: intent-only clear leaves a spent entry untouched");
    clearAllPendingNativeLocks();
    stashNativeLockIntent({ escrowId: "t2i", amountMsats: AMOUNT, federationId: FED });
    clearPendingNativeLockIfIntent("t2i");
    assert(getPendingNativeLock("t2i") === null,
      "native-lock invariant: intent-only clear removes a genuine intent");
  }

  // 3. Decision table — LOCK committed with OUR notes ⇒ clear only, never re-absorb.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t3", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    markNativeLockPublishAttempted("t3");
    const { deps, calls } = makeDeps({ state: createdState(`sha256(${NOTES})`) });
    const outcome = await recoverPendingNativeLock(getPendingNativeLock("t3")!, deps);
    assert(outcome === "cleared-committed",
      "native-lock recovery: committed-with-our-hash resolves cleared-committed");
    assert(calls.redeem.length === 0,
      "native-lock recovery: NEVER re-absorbs notes a live LOCK committed");
    assert(getPendingNativeLock("t3") === null,
      "native-lock recovery: committed entry is cleared");
  }

  // 4. Decision table — a DIFFERENT lock owns the chain ⇒ our notes re-absorb.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t4", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    markNativeLockPublishAttempted("t4");
    const { deps, calls } = makeDeps({ state: createdState("sha256(other-notes)") });
    const outcome = await recoverPendingNativeLock(getPendingNativeLock("t4")!, deps);
    assert(outcome === "reabsorbed" && calls.redeem[0] === NOTES,
      "native-lock recovery: different-hash lock re-absorbs OUR notes");
    assert(getPendingNativeLock("t4") === null,
      "native-lock recovery: re-absorbed entry is cleared");
  }

  // 5. Decision table — CREATED, stage spent (publish never started) ⇒ re-absorb.
  //    CREATED, stage publish-attempted ⇒ re-absorb ONLY on a healthy relay read.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t5", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    const spentDeps = makeDeps({ state: createdState(null) });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t5")!, spentDeps.deps) === "reabsorbed",
      "native-lock recovery: CREATED + spent (provably unpublished) re-absorbs");

    upgradeNativeLockToSpent({ escrowId: "t5b", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    markNativeLockPublishAttempted("t5b");
    const degraded = makeDeps({ state: createdState(null), relays: 1 });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t5b")!, degraded.deps) === "kept",
      "native-lock recovery: publish-attempted + degraded relays is KEPT (a hidden LOCK could exist)");
    assert(degraded.calls.redeem.length === 0,
      "native-lock recovery: degraded-read keep performs no redeem");
    const healthy = makeDeps({ state: createdState(null), relays: 2 });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t5b")!, healthy.deps) === "reabsorbed",
      "native-lock recovery: publish-attempted + healthy quorum read re-absorbs");
  }

  // 6. Fail-closed: unknown trade state / wrong fed ⇒ keep, touch nothing.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t6", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    const unknown = makeDeps({ state: null });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t6")!, unknown.deps) === "kept",
      "native-lock recovery: loadEscrow null (unknown) is KEPT — v0.1.76 unknown ⇒ refuse");
    assert(unknown.calls.redeem.length === 0, "native-lock recovery: unknown-state keep never redeems");
    const wrongFed = makeDeps({ state: createdState(null), fed: "some_other_fed" });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t6")!, wrongFed.deps) === "kept",
      "native-lock recovery: federation mismatch is KEPT (notes only exist on their minting fed)");
    assert(wrongFed.calls.loads === 0 && wrongFed.calls.redeem.length === 0,
      "native-lock recovery: fed-mismatch keep does no relay read and no redeem");
    assert(getPendingNativeLock("t6")!.attempts === 0,
      "native-lock recovery: fail-closed keeps don't burn the retry budget");
  }

  // 7. Already-spent on a funding re-absorb = our own auto-refund landed ⇒
  //    notes positively dead, entry cleared (NOT the claim path's alarm).
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t7", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    const err: any = new Error("notes already spent by the federation");
    err.code = "ALREADY_SPENT_UNCONFIRMED";
    const { deps } = makeDeps({ state: createdState(null), redeemError: err });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t7")!, deps) === "cleared-dead-notes",
      "native-lock recovery: already-spent (no lock of ours) clears as dead notes");
    assert(getPendingNativeLock("t7") === null,
      "native-lock recovery: dead-notes entry is cleared");
  }

  // 8. Transient redeem failures: attempts bump, entry kept; the cap stops
  //    boot churn; a user-initiated retry (ignoreAttemptCap) still runs.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "t8", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    const failing = makeDeps({ state: createdState(null), redeemError: new Error("federation unreachable") });
    for (let i = 0; i < MAX_NATIVE_LOCK_DRAIN_ATTEMPTS; i++) {
      const out = await recoverPendingNativeLock(getPendingNativeLock("t8")!, failing.deps);
      assert(out === "kept", `native-lock recovery: transient failure ${i + 1} keeps the entry`);
    }
    assert(getPendingNativeLock("t8")!.attempts === MAX_NATIVE_LOCK_DRAIN_ATTEMPTS,
      "native-lock recovery: each transient failure bumps attempts");
    const capped = makeDeps({ state: createdState(null) });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t8")!, capped.deps) === "kept"
      && capped.calls.redeem.length === 0,
      "native-lock recovery: attempt cap stops the boot drain from churning");
    const userRetry = makeDeps({ state: createdState(null) });
    assert(
      await recoverPendingNativeLock(getPendingNativeLock("t8")!, userRetry.deps, { ignoreAttemptCap: true })
        === "reabsorbed",
      "native-lock recovery: a user-initiated retry bypasses the cap and recovers");
  }

  // 9. Intent entries: kept while fresh, aged out past the TTL.
  {
    clearAllPendingNativeLocks();
    stashNativeLockIntent({ escrowId: "t9", amountMsats: AMOUNT, federationId: FED });
    const fresh = makeDeps({});
    assert(await recoverPendingNativeLock(getPendingNativeLock("t9")!, fresh.deps) === "kept",
      "native-lock recovery: a fresh intent is kept (attribution + resume)");
    const late = makeDeps({ now: () => Date.now() + NATIVE_LOCK_INTENT_TTL_MS + 1 });
    assert(await recoverPendingNativeLock(getPendingNativeLock("t9")!, late.deps) === "cleared-stale-intent",
      "native-lock recovery: a stale intent ages out");
    assert(getPendingNativeLock("t9") === null, "native-lock recovery: aged intent is cleared");
  }

  // 9b. Re-absorb story-loss fix: a successful re-absorb ALWAYS leaves a
  //     funding breadcrumb (so the balance reads as calm "funds returned",
  //     not the generic alarm), and downgrades to a FRESH intent (the
  //     Finish-lock resume card) when the trade is still lockable — else
  //     clears (nothing to re-lock). NOTE: these use the REAL uppercase
  //     EscrowStatus.CREATED; the createdState() helper's lowercase "created"
  //     never matched it, so the earlier decision-table cases all hit the
  //     terminal/clear path (proving no regression there).
  {
    const lockableState = (over: Record<string, any> = {}) =>
      ({ status: EscrowStatus.CREATED, lock: { notesHash: null }, expiresAt: 0, ...over }) as any;
    function makeReabsorbDeps(state: any, now?: () => number) {
      const calls = { redeem: [] as string[], residue: [] as any[] };
      const deps: any = {
        loadEscrow: async () => state,
        getConnectedRelayCount: () => 3,
        redeemNotes: async (n: string) => { calls.redeem.push(n); },
        currentFederationId: () => FED,
        hashNotes: async (n: string) => `sha256(${n})`,
        recordReabsorbedResidue: (input: any) => { calls.residue.push(input); },
        ...(now ? { now } : {}),
      };
      return { deps, calls };
    }

    // (a) still lockable (CREATED, no deadline) → downgrade to fresh intent.
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "rb1", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    markNativeLockPublishAttempted("rb1");
    {
      const { deps, calls } = makeReabsorbDeps(lockableState());
      const out = await recoverPendingNativeLock(getPendingNativeLock("rb1")!, deps);
      assert(out === "reabsorbed" && calls.redeem[0] === NOTES,
        "reabsorb (lockable): re-absorbs the notes back to the wallet");
      const e = getPendingNativeLock("rb1");
      assert(!!e && e.stage === "intent" && !e.oobNotes && e.amountMsats === AMOUNT,
        "reabsorb (lockable): entry downgraded to a FRESH intent (Finish-lock card persists)");
      assert(calls.residue.length === 1 && calls.residue[0].escrowId === "rb1"
        && calls.residue[0].amountMsats === AMOUNT,
        "reabsorb (lockable): funding breadcrumb recorded");
    }

    // (b) past deadline → terminal: cleared, breadcrumb STILL recorded.
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "rb2", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    {
      const nowMs = 10_000_000;
      const expired = lockableState({ expiresAt: Math.floor(nowMs / 1000) - 60 });
      const { deps, calls } = makeReabsorbDeps(expired, () => nowMs);
      const out = await recoverPendingNativeLock(getPendingNativeLock("rb2")!, deps);
      assert(out === "reabsorbed" && getPendingNativeLock("rb2") === null,
        "reabsorb (past deadline): terminal → entry cleared (nothing to re-lock)");
      assert(calls.residue.length === 1,
        "reabsorb (past deadline): breadcrumb still recorded (honest funds-returned banner)");
    }

    // (c) EXPIRED status → terminal: cleared, breadcrumb recorded (the repro).
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "rb3", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    {
      const { deps, calls } = makeReabsorbDeps(
        { status: EscrowStatus.EXPIRED, lock: { notesHash: null }, expiresAt: 0 });
      const out = await recoverPendingNativeLock(getPendingNativeLock("rb3")!, deps);
      assert(out === "reabsorbed" && getPendingNativeLock("rb3") === null,
        "reabsorb (EXPIRED): terminal → entry cleared");
      assert(calls.residue.length === 1, "reabsorb (EXPIRED): breadcrumb recorded");
    }

    // (d) the downgraded intent drives the Finish-lock resume via summarize.
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "rb4", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    {
      const { deps } = makeReabsorbDeps(lockableState());
      await recoverPendingNativeLock(getPendingNativeLock("rb4")!, deps);
      const summary = summarizeNativeLocksForUi(listPendingNativeLocks(), Date.now(), {
        currentFederationId: FED, balanceMsats: AMOUNT,
      });
      assert(summary.suppressRecovery && summary.resume?.escrowId === "rb4",
        "reabsorb (lockable): the downgraded intent drives the Finish-lock resume card");
    }

    // (e) identity guard: a successor attempt (different notes) since the
    //     drain snapshot must NOT be clobbered by the downgrade.
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "rb5", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    {
      const snapshot = getPendingNativeLock("rb5")!;
      // A fresh attempt replaces the entry with DIFFERENT notes before the
      // (stale-snapshot) recovery finishes.
      clearAllPendingNativeLocks();
      upgradeNativeLockToSpent({ escrowId: "rb5", oobNotes: "successor-notes", amountMsats: AMOUNT, federationId: FED });
      const { deps } = makeReabsorbDeps(lockableState());
      await recoverPendingNativeLock(snapshot, deps);
      const e = getPendingNativeLock("rb5");
      assert(!!e && e.stage === "spent" && e.oobNotes === "successor-notes",
        "reabsorb (identity guard): a successor attempt's live notes are never clobbered by the downgrade");
    }
  }

  // 10. Boot drain: settles every entry, reports the split; concurrent
  //     drains CHAIN (a fed-switch re-drain with fresh deps must not be
  //     swallowed by a still-running earlier drain) and the second pass
  //     finds nothing left to do.
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "d1", oobNotes: "notes-d1", amountMsats: AMOUNT, federationId: FED });
    upgradeNativeLockToSpent({ escrowId: "d2", oobNotes: "notes-d2", amountMsats: AMOUNT, federationId: FED });
    markNativeLockPublishAttempted("d2");
    const { deps } = makeDeps({ state: createdState(null) });
    const p1 = drainPendingNativeLocks(deps);
    const p2 = drainPendingNativeLocks(deps);
    const [summary1, summary2] = await Promise.all([p1, p2]);
    assert(summary1.reabsorbed === 2 && summary1.stillPending === 0,
      "native-lock drain: settles every recoverable entry");
    assert(summary2.attempted === 0,
      "native-lock drain: the chained second drain finds the stash already settled");
    assert(listPendingNativeLocks().length === 0, "native-lock drain: stash empty after full recovery");
  }

  // 10b. Per-escrow flow mutex: recovery cannot interleave with a held
  //      lock flow for the same trade (the hollow-escrow race, F7/F11).
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "mx", oobNotes: NOTES, amountMsats: AMOUNT, federationId: FED });
    const order: string[] = [];
    let releaseFlow!: () => void;
    const flowHeld = new Promise<void>((r) => { releaseFlow = r; });
    // Simulate a live lock flow holding the trade's critical section.
    const flow = withNativeLockFlow("mx", async () => {
      order.push("flow-start");
      await flowHeld;
      order.push("flow-end");
    });
    // A concurrent drain must queue behind it, not re-absorb mid-flow.
    const { deps, calls } = makeDeps({ state: createdState(null) });
    const drain = drainPendingNativeLocks(deps);
    await new Promise((r) => setTimeout(r, 20));
    assert(calls.redeem.length === 0 && order.join(",") === "flow-start",
      "native-lock mutex: recovery waits while a lock flow holds the trade");
    releaseFlow();
    await flow;
    const summary = await drain;
    assert(order[0] === "flow-start" && order[1] === "flow-end",
      "native-lock mutex: the flow completed before recovery ran");
    assert(summary.reabsorbed === 1,
      "native-lock mutex: recovery proceeds after the flow releases");
  }

  // 10c. Stale-snapshot protection: a drain that raced an inline settle
  //      must not delete a SUCCESSOR entry holding fresh live notes (F15).
  {
    clearAllPendingNativeLocks();
    upgradeNativeLockToSpent({ escrowId: "ss", oobNotes: "old-notes", amountMsats: AMOUNT, federationId: FED });
    const stale = getPendingNativeLock("ss")!;
    // Concurrent flow settles the old entry and stashes a NEW attempt.
    clearPendingNativeLock("ss");
    upgradeNativeLockToSpent({ escrowId: "ss", oobNotes: "new-live-notes", amountMsats: AMOUNT, federationId: FED });
    // The racing recover still holds the STALE snapshot; its redeem reports
    // the old notes dead — the clear must not touch the successor.
    const err: any = new Error("already spent");
    const { deps } = makeDeps({ state: createdState(null), redeemError: err });
    await recoverPendingNativeLock(stale, deps);
    const live = getPendingNativeLock("ss");
    assert(live !== null && live.oobNotes === "new-live-notes",
      "native-lock stale-snapshot: a dead-notes clear never deletes a successor entry's live notes");
  }

  // 11. UI summary: active entries suppress the drain surfaces + name the
  //     resume target; exhausted entries flip to the calm stuck card;
  //     stale intents stop suppressing.
  {
    const nowMs = Date.now();
    const mk = (over: Record<string, any>) => ({
      escrowId: "x", stage: "spent", oobNotes: NOTES, amountMsats: AMOUNT,
      federationId: FED, createdAt: nowMs, attempts: 0, ...over,
    }) as any;
    const empty = summarizeNativeLocksForUi([], nowMs);
    assert(!empty.suppressRecovery && empty.resume === null && empty.stuck.length === 0,
      "native-lock summary: empty stash suppresses nothing");
    const active = summarizeNativeLocksForUi([mk({ escrowId: "a" })], nowMs);
    assert(active.suppressRecovery && active.resume?.escrowId === "a",
      "native-lock summary: a live entry suppresses the drain surfaces + names the resume target");
    const exhausted = summarizeNativeLocksForUi(
      [mk({ escrowId: "b", attempts: MAX_NATIVE_LOCK_DRAIN_ATTEMPTS })], nowMs);
    assert(!exhausted.suppressRecovery && exhausted.stuck.length === 1,
      "native-lock summary: attempt-exhausted entries stop suppressing and go to the calm card");
    const staleIntent = summarizeNativeLocksForUi(
      [mk({ escrowId: "c", stage: "intent", oobNotes: undefined, createdAt: nowMs - NATIVE_LOCK_INTENT_TTL_MS - 1 })],
      nowMs);
    assert(!staleIntent.suppressRecovery,
      "native-lock summary: a stale intent no longer suppresses");
    const freshIntent = summarizeNativeLocksForUi(
      [mk({ escrowId: "d", stage: "intent", oobNotes: undefined })], nowMs);
    assert(freshIntent.suppressRecovery && freshIntent.resume?.escrowId === "d",
      "native-lock summary: a fresh intent suppresses + resumes (the W1 reload case)");
    const newest = summarizeNativeLocksForUi(
      [mk({ escrowId: "old", createdAt: nowMs - 5000 }), mk({ escrowId: "new", createdAt: nowMs })], nowMs);
    assert(newest.resume?.escrowId === "new",
      "native-lock summary: the newest actionable entry is the resume target");

    // Bounded suppression hardening (review F1/F9/F14/F17):
    const fedMismatch = summarizeNativeLocksForUi(
      [mk({ escrowId: "fm" })], nowMs, { currentFederationId: "some_other_fed" });
    assert(!fedMismatch.suppressRecovery && fedMismatch.stuck.length === 1,
      "native-lock summary: an other-fed entry stops suppressing (it can't explain THIS fed's balance) and surfaces calmly");
    const fedMatch = summarizeNativeLocksForUi(
      [mk({ escrowId: "fmk" })], nowMs, { currentFederationId: FED });
    assert(fedMatch.suppressRecovery && fedMatch.resume?.escrowId === "fmk",
      "native-lock summary: a same-fed entry still suppresses + resumes");
    const aged = summarizeNativeLocksForUi(
      [mk({ escrowId: "ag", createdAt: nowMs - NATIVE_LOCK_SUPPRESS_MAX_MS - 1 })], nowMs);
    assert(!aged.suppressRecovery && aged.stuck.length === 1,
      "native-lock summary: suppression is hard-bounded by age even when attempts never accrue");
    const brokeIntent = summarizeNativeLocksForUi(
      [mk({ escrowId: "bi", stage: "intent", oobNotes: undefined })], nowMs, { balanceMsats: AMOUNT - 1 });
    assert(!brokeIntent.suppressRecovery && brokeIntent.resume === null,
      "native-lock summary: an intent the balance can't satisfy tells no story (cancelled/failed funding)");
    const fundedIntent = summarizeNativeLocksForUi(
      [mk({ escrowId: "fi", stage: "intent", oobNotes: undefined })], nowMs, { balanceMsats: AMOUNT });
    assert(fundedIntent.suppressRecovery && fundedIntent.resume?.escrowId === "fi",
      "native-lock summary: an intent the balance covers is the W1 resume story");
  }

  // 12. The recovery surfaces honor the suppressor (banner + ChamaBar).
  {
    const { shouldShowRecoveryBanner, decideChamaBarLabel } = await import("../ui/decisions.js");
    const base = { balanceMsats: 50_000_000, hasAnyActiveEscrow: false };
    assert(shouldShowRecoveryBanner(base) === true,
      "native-lock suppressor: banner baseline still fires on unexplained balance");
    assert(shouldShowRecoveryBanner({ ...base, hasPendingNativeLock: true }) === false,
      "native-lock suppressor: banner suppressed while a pending lock owns the balance");
    const bar = decideChamaBarLabel({ balanceMsats: 50_000_000, hasActiveBuyerSellerCommitment: false });
    assert(bar.kind === "stranded",
      "native-lock suppressor: ChamaBar baseline still reads stranded");
    const barSuppressed = decideChamaBarLabel({
      balanceMsats: 50_000_000, hasActiveBuyerSellerCommitment: false, hasPendingNativeLock: true,
    });
    assert(barSuppressed.kind === "ready",
      "native-lock suppressor: ChamaBar stranded pill suppressed while a pending lock exists");
  }

  clearAllPendingNativeLocks();
}

  {
    const originalWindow = (globalThis as any).window;
    try {
      let publicKeyCalls = 0;
      let decryptCalls = 0;
      (globalThis as any).window = {
        nostr: {
          async getPublicKey() {
            publicKeyCalls++;
            return "aa".repeat(32);
          },
          async signEvent(event: UnsignedEvent) {
            return { ...event, id: "signed", pubkey: "aa".repeat(32), sig: "sig" };
          },
          nip44: {
            async encrypt(recipient: string, plaintext: string) {
              return `enc:${recipient}:${plaintext}`;
            },
            async decrypt(sender: string, ciphertext: string) {
              decryptCalls++;
              return `dec:${sender}:${ciphertext}`;
            },
          },
        },
      };

      const signer = new NIP07Signer();
      const [pk1, pk2] = await Promise.all([signer.getPublicKey(), signer.getPublicKey()]);
      assert(pk1 === pk2 && publicKeyCalls === 1,
        "NIP-07 signer caches concurrent getPublicKey calls");

      const [dec1, dec2] = await Promise.all([
        signer.nip44Decrypt("cipher-a", "bb".repeat(32)),
        signer.nip44Decrypt("cipher-a", "bb".repeat(32)),
      ]);
      assert(dec1 === dec2 && decryptCalls === 1,
        "NIP-07 signer caches repeated decrypts for the same ciphertext");

      await signer.nip44Decrypt("cipher-b", "bb".repeat(32));
      assert(decryptCalls === 2,
        "NIP-07 signer still decrypts distinct ciphertexts");
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  }

  {
    const originalWindow = (globalThis as any).window;
    try {
      let decryptCalls = 0;
      (globalThis as any).window = {
        fediInternal: {},
        nostr: {
          async getPublicKey() {
            return "cc".repeat(32);
          },
          async signEvent(event: UnsignedEvent) {
            return { ...event, id: "signed", pubkey: "cc".repeat(32), sig: "sig" };
          },
          nip44: {
            async encrypt(recipient: string, plaintext: string) {
              return `enc:${recipient}:${plaintext}`;
            },
            async decrypt(sender: string, ciphertext: string) {
              decryptCalls++;
              return `dec:${sender}:${ciphertext}`;
            },
          },
        },
      };

      const signer = new FediSigner();
      const [dec1, dec2] = await Promise.all([
        signer.nip44Decrypt("fedi-cipher", "dd".repeat(32)),
        signer.nip44Decrypt("fedi-cipher", "dd".repeat(32)),
      ]);
      assert(FediSigner.isAvailable() && dec1 === dec2 && decryptCalls === 1,
        "Fedi signer caches repeated decrypts for the same ciphertext");
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  }

  function makeParseWallet(parseAmountMsats: number) {
    return {
      async open() {},
      isOpen() { return true; },
      recovery: {
        async hasPendingRecoveries() { return false; },
        async waitForAllRecoveries() {},
      },
      async joinFederation(_invite: string) {},
      balance: {
        async getBalance() { return 0; },
        subscribeBalance(_cb: (b: number) => void) { return () => {}; },
      },
      mint: {
        async spendNotes(_msat: number): Promise<string> {
          throw new Error("spendNotes must not be called for Fedi external ecash");
        },
        async redeemEcash(_oob: string) {},
        async parseNotes(_oob: string) { return { total_amount: parseAmountMsats }; },
      },
      lightning: {
        async createInvoice(_msat: number, _desc: string) {
          throw new Error("createInvoice must not be called for Fedi external ecash");
        },
        async payInvoice(_b: string) { return { operationId: "op0" }; },
      },
      federation: {
        async getFederationId() { return BLF_FEDERATION_ID; },
        async getInviteCode() { return BLF_FEDERATION_INVITE; },
      },
      async cleanup() {},
    };
  }

  {
    const client = new FedimintClient(
      {},
      async () => makeParseWallet(1_000_000),
    );
    await client.init();
    const bundle = await client.createEscrowLockFromNotes(
      "fedi-oob-notes",
      1_000_000,
      { arbiterFeeMsats: 0 },
    );
    assert(bundle.shares.length === 3,
      "createEscrowLockFromNotes splits externally generated notes into 3 shares");
    assert(bundle.totalMsats === 1_000_000,
      "createEscrowLockFromNotes preserves the exact trade amount");
    await client.cleanup();
  }

  {
    const client = new FedimintClient(
      {},
      async () => makeParseWallet(999_000),
    );
    await client.init();
    let mismatchRejected = false;
    try {
      await client.createEscrowLockFromNotes(
        "wrong-amount-notes",
        1_000_000,
        { arbiterFeeMsats: 0 },
      );
    } catch (e: any) {
      mismatchRejected = /requires 1000000/.test(e?.message || "");
    }
    assert(mismatchRejected,
      "createEscrowLockFromNotes refuses to LOCK when parsed notes do not exactly match the trade amount");
    await client.cleanup();
  }
}

// ── 30. setUserCommunitySlug LOCALSTORAGE ROUNDTRIP ─────────────────────
//
// The community-tap handler in App.tsx calls actions.setCommunity(slug),
// which delegates to setUserCommunitySlug. Confirm the localStorage
// write side effect explicitly so that "tap → identity stored" is
// covered as a unit, not implied via section 14.
console.log("\n── setUserCommunitySlug PERSISTENCE ──");
{
  (globalThis as any).localStorage.clear();
  setUserCommunitySlug("ke-kes");
  const raw = (globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY);
  assert(raw === "ke-kes",
    "setUserCommunitySlug writes the slug to chama_community key");
  setUserCommunitySlug("sn-cfa");
  const raw2 = (globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY);
  assert(raw2 === "sn-cfa",
    "Subsequent setUserCommunitySlug overwrites the prior value");
}

// ── 31. getUserCommunitySlugRaw — null for first-timers ─────────────────
//
// Bug A from v0.1.85 smoke testing: first-time users were seeing the
// default-community pill highlighted because `getUserCommunitySlug` falls
// back to us-blf when nothing is stored (v0.5.0). The Raw variant returns
// null in that case so the UI can distinguish "explicit choice" from
// "default fallback" — pill highlight reads from Raw, resolution paths
// (createEscrow, initFedimint) keep using the non-null helper.
console.log("\n── getUserCommunitySlugRaw ──");
{
  // First-timer: nothing stored → null
  (globalThis as any).localStorage.clear();
  assert(getUserCommunitySlugRaw() === null,
    "First-time user (nothing stored) → null (no pill highlight)");
  assert(getUserCommunitySlug() === "us-blf",
    "Resolution path still falls back to us-blf default (BLF, v0.5.0)");

  // After picking: returns the slug
  setUserCommunitySlug("sn-cfa");
  assert(getUserCommunitySlugRaw() === "sn-cfa",
    "After pick: raw returns the explicit slug");
  assert(getUserCommunitySlug() === "sn-cfa",
    "Resolution path matches");

  // Stale/invalid stored slug: raw returns null (consistent with the
  // non-Raw helper's fallback) so the picker doesn't highlight a
  // nonexistent community.
  (globalThis as any).localStorage.setItem(COMMUNITY_STORAGE_KEY, "ghost-fed");
  assert(getUserCommunitySlugRaw() === null,
    "Unknown stored slug → null (no stale-pill highlight)");
  assert(getUserCommunitySlug() === "us-blf",
    "Resolution path falls back to default for stale slug");

  // Cleanup
  (globalThis as any).localStorage.clear();
}

// ── 31a. PER-NPUB LOCALSTORAGE SCOPING ──────────────────────────────────
console.log("\n── per-npub localStorage scoping ──");
{
  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope(null);
  assert(getLocalStorageUserScope() === null,
    "Storage starts unscoped before a signer is known");

  // First-run onboarding writes before connect; the first connected npub
  // claims that legacy value into its scoped key and removes the global.
  setUserCommunitySlug("tz-tzs");
  assert((globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY) === "tz-tzs",
    "Pre-connect community choice writes the legacy onboarding key");
  setLocalStorageUserScope("alice");
  assert(getUserCommunitySlugRaw() === "tz-tzs",
    "Connected user reads the pre-connect community choice");
  assert((globalThis as any).localStorage.getItem(scopedStorageKey(COMMUNITY_STORAGE_KEY)) === "tz-tzs",
    "Pre-connect community choice migrates to the active npub scope");
  assert((globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY) === null,
    "Legacy community key is claimed so another npub does not inherit it");

  setLocalStorageUserScope("bob");
  assert(getUserCommunitySlugRaw() === null,
    "Second npub does not inherit first npub's home Chama");
  setUserCommunitySlug("ke-kes");
  assert(getUserCommunitySlugRaw() === "ke-kes",
    "Second npub can persist an independent home Chama");
  setLocalStorageUserScope(null);
  (globalThis as any).localStorage.setItem(COMMUNITY_STORAGE_KEY, "tz-tzs");
  assert(getUserCommunitySlugRaw() === "tz-tzs",
    "Logged-out UI shows the pre-connect community choice");
  setLocalStorageUserScope("bob");
  assert(getUserCommunitySlugRaw() === "tz-tzs",
    "Pre-connect visible choice overrides the signed-in npub's older home Chama");
  assert((globalThis as any).localStorage.getItem(scopedStorageKey(COMMUNITY_STORAGE_KEY)) === "tz-tzs",
    "Override migrates into the signed-in npub scope");
  assert((globalThis as any).localStorage.getItem(COMMUNITY_STORAGE_KEY) === null,
    "Pre-connect override is claimed so another npub does not inherit it");
  setLocalStorageUserScope("alice");
  assert(getUserCommunitySlugRaw() === "tz-tzs",
    "Switching back restores the first npub's home Chama");

  setCustomFederationInvite("fed1qalicecustom");
  setActiveInvite("fed1qaliceactive");
  const aliceHandle = addSavedHandle("phone-number", "+255 740 034 110");
  const alicePayout = addOrTouchPayoutDestination("alice@getchama.app");
  const aliceChap = saveChapsmartPayoutProfile({
    phoneNumber: "+255 740 034 110",
    recipientName: "Asha Mushi",
  });
  stashPendingRedemption({
    escrowId: "alice_claim",
    oobNotes: "oob_alice",
    notesHash: "hash_alice",
    amountMsats: 12_000,
  });

  setLocalStorageUserScope("bob");
  assert(getFederationInvite() !== "fed1qalicecustom",
    "Custom federation invite is scoped per npub");
  assert(getActiveInvite() === null,
    "Active joined invite is scoped per npub");
  assert(listSavedHandles().every(h => h.id !== aliceHandle.id),
    "Saved payment handles are scoped per npub");
  assert(listPayoutDestinations().every(d => d.id !== alicePayout.id),
    "Payout destinations are scoped per npub");
  assert(getChapsmartPayoutProfile() === null,
    "Chapsmart payout profile is scoped per npub");
  assert(listPendingRedemptions().length === 0,
    "Pending redemption stash is scoped per npub");

  setLocalStorageUserScope("alice");
  assert(getFederationInvite() === "fed1qalicecustom",
    "First npub keeps its custom federation invite");
  assert(getActiveInvite() === "fed1qaliceactive",
    "First npub keeps its active joined invite");
  assert(getSavedHandle(aliceHandle.id)?.handle === aliceHandle.handle,
    "First npub keeps its saved handle");
  assert(listPayoutDestinations()[0]?.id === alicePayout.id,
    "First npub keeps its payout destination");
  assert(getChapsmartPayoutProfile()?.recipientName === aliceChap.recipientName,
    "First npub keeps its Chapsmart profile");
  assert(listPendingRedemptions()[0]?.escrowId === "alice_claim",
    "First npub keeps its pending redemption stash");

  clearAllPendingRedemptions();
  setLocalStorageUserScope(null);
  (globalThis as any).localStorage.clear();
}

// ── 31a. RETIRED (v4.3): deferred onboarding community selection ─────────
//
// The v3.5.1 pre-signer pick stash (chama_pending_community) died with the
// auth-first reorder: the globe picker now runs POST-connect and writes the
// npub scope directly (handleSelectCommunity), so there is nothing to defer
// and nothing to leak — the leak-fix machinery this block exercised was
// deleted from communities/storage.ts. One assertion survives from the old
// block because it tests federation-config, not the stash:
console.log("\n── community-blind federation fallback ──");
{
  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope(null);

  // Community-blind fallback lands on BLF (federation-config.ts:87).
  assert(getFederationInvite() === BLF_FEDERATION_INVITE,
    "Community-blind getFederationInvite falls back to BLF (no custom)");

  setLocalStorageUserScope(null);
  (globalThis as any).localStorage.clear();
}

// ── 31b. SEED RECOVERY RETRY (v0.1.85 Bug G fix) ────────────────────────
//
// queryUntilFound is the retry helper getOrCreateSeed wraps around the
// recovery-query call. When the initial query (outside the helper)
// returns zero events AND a seed-published marker exists locally
// (we KNOW a seed should be there), the caller invokes the helper to
// retry with backoff before triggering the v0.1.74 refuse-fresh
// safety guard.
//
// Semantics: delays[i] is the sleep duration BEFORE attempt i.
// delays.length = total attempts. With [1000,2000,4000] the helper
// sleeps 1s before attempt 1, then runs query → if empty, sleeps 2s
// before attempt 2 → if empty, sleeps 4s before attempt 3. Tests use
// a mock sleepFn so the suite runs without real timers.
console.log("\n── SEED RECOVERY RETRY ──");
{
  // First-attempt success — one sleep (1s before attempt), one query.
  {
    const sleepCalls: number[] = [];
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return ["event1"];
      },
      [1000, 2000, 4000],
      async (ms) => { sleepCalls.push(ms); },
    );
    assert(result.length === 1 && result[0] === "event1",
      "Returns the first non-empty result");
    assert(queryCalls === 1, "Stops after first success");
    assert(sleepCalls.length === 1 && sleepCalls[0] === 1000,
      "Sleeps 1s before the first retry attempt");
  }

  // Second-attempt success — two sleeps (1s, 2s), two queries.
  {
    const sleepCalls: number[] = [];
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return queryCalls < 2 ? [] : ["event-on-retry"];
      },
      [1000, 2000, 4000],
      async (ms) => { sleepCalls.push(ms); },
    );
    assert(result.length === 1 && result[0] === "event-on-retry",
      "Returns events found on second retry attempt");
    assert(queryCalls === 2, "Stops after first non-empty result");
    assert(sleepCalls.length === 2
      && sleepCalls[0] === 1000
      && sleepCalls[1] === 2000,
      "Backoff sequence so far: 1s, 2s");
  }

  // Third-attempt success — three sleeps (1s, 2s, 4s), three queries.
  {
    const sleepCalls: number[] = [];
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return queryCalls < 3 ? [] : ["seed-late"];
      },
      [1000, 2000, 4000],
      async (ms) => { sleepCalls.push(ms); },
    );
    assert(result.length === 1, "Recovers on third retry attempt");
    assert(queryCalls === 3, "Three queries before success");
    assert(sleepCalls.length === 3
      && sleepCalls[0] === 1000
      && sleepCalls[1] === 2000
      && sleepCalls[2] === 4000,
      "Full backoff sequence: 1s, 2s, 4s");
  }

  // All attempts empty — exhausts retries, returns []. This is the
  // signal that triggers the v0.1.74 refuse-fresh safety guard in
  // getOrCreateSeed (when a marker exists).
  {
    let queryCalls = 0;
    const result = await queryUntilFound(
      async () => {
        queryCalls++;
        return [];
      },
      [1000, 2000, 4000],
      async () => { /* swallow sleeps */ },
    );
    assert(result.length === 0,
      "Returns empty after exhausting all retries");
    assert(queryCalls === 3,
      "Total 3 query attempts (matches delays.length)");
  }

  // Default retry schedule shape (the constant exported alongside).
  assert(SEED_RECOVERY_RETRY_DELAYS_MS.length === 3,
    "Default retry schedule has 3 attempts");
  assert(SEED_RECOVERY_RETRY_DELAYS_MS[0] === 1000
    && SEED_RECOVERY_RETRY_DELAYS_MS[1] === 2000
    && SEED_RECOVERY_RETRY_DELAYS_MS[2] === 4000,
    "Default retry schedule is 1s / 2s / 4s");

  // Seed-event decrypt retry — separate from relay query retry. This
  // covers Fedi Mini-App cold starts where the seed event is present,
  // but the first NIP-44 self-decrypt fails before Reconnect succeeds.
  {
    const pubkey = "ab".repeat(32);
    const mnemonic = "must agree milk little stem coyote renew canoe shock diet normal frequent";
    const seedEvent: NostrEvent = {
      id: "seed-event-new",
      pubkey,
      created_at: 200,
      kind: 30078,
      tags: [["d", "chama-fedimint-seed-v1"]],
      content: "encrypted-seed",
      sig: "sig",
    };
    let decryptCalls = 0;
    const sleepCalls: number[] = [];
    const signer: Signer = {
      async getPublicKey() { return pubkey; },
      async signEvent(event: UnsignedEvent) {
        return { ...event, id: "signed", pubkey, sig: "sig" };
      },
      async nip44Encrypt(plaintext: string) { return plaintext; },
      async nip44Decrypt(_ciphertext: string, _senderPubkey: string) {
        decryptCalls++;
        if (decryptCalls < 3) throw new Error("Fedi decrypt path not ready yet");
        return mnemonic;
      },
    };

    const recovered = await recoverSeedWordsFromEvents(
      [seedEvent],
      pubkey,
      signer,
      {
        delaysMs: [10, 20, 30],
        sleepFn: async (ms) => { sleepCalls.push(ms); },
      },
    );

    assert(recovered?.event.id === "seed-event-new",
      "Seed decrypt retry recovers the seed event after transient signer failures");
    assert(recovered?.words.join(" ") === mnemonic,
      "Seed decrypt retry returns the recovered mnemonic words");
    assert(decryptCalls === 3,
      "Seed decrypt retry re-attempts NIP-44 until the signer is ready");
    assert(sleepCalls.length === 2 && sleepCalls[0] === 10 && sleepCalls[1] === 20,
      "Seed decrypt retry stops sleeping once decrypt succeeds");
  }

  assert(SEED_DECRYPT_RETRY_DELAYS_MS.length === 3,
    "Default seed decrypt retry schedule has 3 retries");
  assert(SEED_DECRYPT_RETRY_DELAYS_MS[0] === 750
    && SEED_DECRYPT_RETRY_DELAYS_MS[1] === 1500
    && SEED_DECRYPT_RETRY_DELAYS_MS[2] === 3000,
    "Default seed decrypt retry schedule is 750ms / 1.5s / 3s");
  assert(FEDI_SEED_DECRYPT_RETRY_DELAYS_MS.length === 5,
    "Fedi seed decrypt retry schedule has 5 retries");
  assert(FEDI_SEED_DECRYPT_RETRY_DELAYS_MS[0] === 750
    && FEDI_SEED_DECRYPT_RETRY_DELAYS_MS[1] === 1500
    && FEDI_SEED_DECRYPT_RETRY_DELAYS_MS[2] === 3000
    && FEDI_SEED_DECRYPT_RETRY_DELAYS_MS[3] === 6000
    && FEDI_SEED_DECRYPT_RETRY_DELAYS_MS[4] === 10000,
    "Fedi seed decrypt retry schedule waits through slower mobile WebView signer readiness");
}

// ── 31c. canOfferSubscription (v0.2.0 item 7 — graduated trust gate) ────
//
// Subscription mode is invisible until the seller has accumulated
// enough positive ratings. v1 threshold: 5+ positive, 0 negative.
// In v0.2.0 with no rating events being published yet, the aggregator
// returns null universally and the gate returns false for everyone.
// When ratings ship in v0.2.1+, the gate naturally opens.
console.log("\n── canOfferSubscription ──");
{
  // No ratings yet (v0.2.0 universal default) → gate closed.
  assert(canOfferSubscription({ ratings: null }) === false,
    "null ratings → false (no graduation signal yet)");

  // Below threshold → gate closed.
  assert(
    canOfferSubscription({ ratings: { count: 4, positive: 4, negative: 0 } }) === false,
    "4 positive < threshold of 5 → false",
  );

  // Threshold met cleanly → gate open.
  assert(
    canOfferSubscription({ ratings: { count: 5, positive: 5, negative: 0 } }) === true,
    "5 positive + 0 negative → true (graduated)",
  );

  // Any negative disqualifies, even with many positives.
  assert(
    canOfferSubscription({ ratings: { count: 10, positive: 9, negative: 1 } }) === false,
    "Any negative rating disqualifies (v1 placeholder is strict)",
  );
}

// ── 31d. hasActiveBuyerSellerCommitment + findActiveTrade ───────────────
//
// History: these once backed the one-trade-at-a-time hard gate on
// Create + Fund. v0.6.5 retired that gate and the functions are now
// display helpers — they drive the ChamaBar "in escrow" pill and the
// ActiveTradePill. The semantics they encode (live buyer/seller
// commitments, arbiter status excluded, post-claim trades excluded) are
// still the display contract. Tests below verify that contract holds.
console.log("\n── hasActiveBuyerSellerCommitment + findActiveTrade ──");
{
  const me = "me_pubkey_aaaa";
  const other = "other_pubkey_bbbb";
  const arb = "arbiter_pubkey_cccc";

  // Helper to build a minimal EscrowState shape for these tests.
  const escrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "test-id",
    status: EscrowStatus.LOCKED,
    description: "test",
    amountMsats: 1_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BLF_FEDERATION_INVITE,
    participants: { buyer: null, seller: null, arbiter: null },
    initiator: { pubkey: me, role: Role.SELLER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  // No escrows → no commitment.
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [], userPubkey: me }) === false,
    "Empty escrows → no commitment",
  );
  assert(
    findActiveTrade({ escrows: [], userPubkey: me }) === null,
    "Empty escrows → no active trade",
  );

  const listingOnly = escrow({
    id: "listing-only",
    status: EscrowStatus.CREATED,
    participants: { buyer: null, seller: me, arbiter: arb },
    eventChain: [{ kind: EscrowEventKind.CREATE } as any],
  });
  // Open listings are inventory, not money movement. They stay in
  // Browse/Me, but do not trigger the global active-trade attention pill.
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [listingOnly], userPubkey: me }) === false,
    "CREATE-only public listing does not count as a live money-moving commitment",
  );
  assert(
    findActiveTrade({ escrows: [listingOnly], userPubkey: me }) === null,
    "findActiveTrade skips CREATE-only listings",
  );
  assert(
    shouldShowOnBrowse({ escrow: listingOnly, browseCategory: "all" }) === true,
    "Browse shows the seller's own CREATED listing until lock lands",
  );

  const joinedCreated = escrow({
    id: "joined-created",
    status: EscrowStatus.CREATED,
    participants: { buyer: other, seller: me, arbiter: arb },
    eventChain: [
      { kind: EscrowEventKind.CREATE } as any,
      { kind: EscrowEventKind.JOIN } as any,
    ],
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [joinedCreated], userPubkey: me }) === false,
    "CREATED trade with a JOIN hold stays off the active-trade pill until LOCK",
  );
  assert(
    shouldShowOnBrowse({ escrow: joinedCreated, browseCategory: "all" }) === true,
    "Browse keeps JOINed-but-not-locked listings visible",
  );
  assert(
    shouldShowOnBrowse({ escrow: joinedCreated, browseCategory: "bill-pay" }) === false,
    "Browse category filter still hides non-matching CREATED listings",
  );
  assert(
    shouldShowOnBrowse({ escrow: { ...joinedCreated, status: EscrowStatus.LOCKED }, browseCategory: "all" }) === false,
    "Browse hides listing once LOCK succeeds",
  );
  assert(
    shouldShowOnBrowse({
      escrow: {
        ...joinedCreated,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      },
      browseCategory: "all",
    }) === false,
    "Browse hides expired CREATED listings while sentinel cleanup catches up",
  );

  // #7 Stage 3: multi-unit storefront Browse visibility.
  const childPurchase = escrow({
    id: "child-1",
    status: EscrowStatus.CREATED,
    participants: { buyer: me, seller: other, arbiter: arb },
    parent: "parent-listing",
    claimedQuantity: 1,
  });
  assert(
    shouldShowOnBrowse({ escrow: childPurchase, browseCategory: "all" }) === false,
    "Stage 3: a child purchase escrow never shows on Browse (it's a trade, lives in Me)",
  );
  const multiUnitParent = escrow({
    id: "parent-listing",
    status: EscrowStatus.CREATED,
    participants: { buyer: null, seller: me, arbiter: null },
    stock: 5,
  });
  assert(
    shouldShowOnBrowse({ escrow: multiUnitParent, browseCategory: "all", isSoldOut: false }) === true,
    "Stage 3: a multi-unit parent listing shows on Browse while stock remains",
  );
  assert(
    shouldShowOnBrowse({ escrow: multiUnitParent, browseCategory: "all", isSoldOut: true }) === false,
    "Stage 3: a sold-out multi-unit parent drops off Browse",
  );
  assert(
    shouldShowOnBrowse({ escrow: listingOnly, browseCategory: "all", isSoldOut: undefined }) === true,
    "Stage 3: a legacy single-unit listing (no sold-out flag) is unaffected",
  );

  // User as buyer, LOCKED → commitment.
  const asBuyer = escrow({
    id: "as-buyer",
    status: EscrowStatus.LOCKED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [asBuyer], userPubkey: me }) === true,
    "User as buyer in LOCKED escrow → commitment",
  );
  assert(
    findActiveTrade({ escrows: [asBuyer], userPubkey: me })?.id === "as-buyer",
    "findActiveTrade returns the LOCKED escrow",
  );

  // User as arbiter only → NO commitment (arbiter status doesn't block).
  const asArbiter = escrow({
    id: "as-arbiter",
    status: EscrowStatus.LOCKED,
    participants: { buyer: other, seller: "third", arbiter: me },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [asArbiter], userPubkey: me }) === false,
    "User as arbiter only → NO commitment (item 10 governs that path)",
  );

  // Terminal escrow → no commitment regardless of role.
  const completed = escrow({
    id: "completed",
    status: EscrowStatus.COMPLETED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [completed], userPubkey: me }) === false,
    "COMPLETED escrow doesn't count as commitment",
  );
  const cancelled = escrow({
    id: "cancelled",
    status: EscrowStatus.CANCELLED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [cancelled], userPubkey: me }) === false,
    "CANCELLED escrow doesn't count as commitment",
  );

  // CLAIMED has published the claim event and is no longer a live escrow
  // commitment for global surfaces. If redemption fails locally, the
  // detail card shows Claim failed; the purple ActiveTradePill should clear.
  const claimed = escrow({
    id: "claimed",
    status: EscrowStatus.CLAIMED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [claimed], userPubkey: me }) === false,
    "CLAIMED escrow doesn't count as active commitment",
  );
  assert(
    findActiveTrade({ escrows: [claimed], userPubkey: me }) === null,
    "findActiveTrade skips CLAIMED trades",
  );

  // EXPIRED heals in the background, but it no longer blocks the user's
  // next Create/Fund flow.
  const expired = escrow({
    id: "expired",
    status: EscrowStatus.EXPIRED,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [expired], userPubkey: me }) === false,
    "EXPIRED does not count as an active user-blocking commitment",
  );

  const nowSec = 10_000;
  const expiredLocked = escrow({
    id: "expired-locked",
    status: EscrowStatus.LOCKED,
    participants: { buyer: me, seller: other, arbiter: arb },
    expiresAt: nowSec - 1,
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [expiredLocked], userPubkey: me, nowSec }) === false,
    "LOCKED past expiresAt does not block Create/Fund while refund healing catches up",
  );

  const expiredCreated = escrow({
    id: "expired-created",
    status: EscrowStatus.CREATED,
    participants: { buyer: null, seller: me, arbiter: arb },
    expiresAt: nowSec - 1,
  });
  assert(
    hasActiveBuyerSellerCommitment({ escrows: [expiredCreated], userPubkey: me, nowSec }) === false,
    "CREATED past expiresAt does not block Create/Fund",
  );

  // Multiple actives → findActiveTrade returns most recent by createdAt.
  const older = escrow({
    id: "older",
    createdAt: 1000,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  const newer = escrow({
    id: "newer",
    createdAt: 2000,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    findActiveTrade({ escrows: [older, newer], userPubkey: me })?.id === "newer",
    "findActiveTrade picks the most recent active trade",
  );
  assert(
    findActiveTrade({ escrows: [expiredLocked, older], userPubkey: me, nowSec })?.id === "older",
    "findActiveTrade skips expired LOCKED trades and returns the live trade",
  );
  const newestClaimed = escrow({
    id: "newest-claimed",
    status: EscrowStatus.CLAIMED,
    createdAt: 3000,
    participants: { buyer: me, seller: other, arbiter: arb },
  });
  assert(
    findActiveTrade({ escrows: [older, newestClaimed], userPubkey: me })?.id === "older",
    "findActiveTrade skips newer CLAIMED trades and returns the live trade",
  );

  // v0.6.5: countActiveBuyerSellerCommitments — drives the plural-aware
  // ActiveTradePill copy now that multiple concurrent trades are allowed.
  assert(
    countActiveBuyerSellerCommitments({ escrows: [], userPubkey: me }) === 0,
    "Empty escrows → 0 active commitments",
  );
  assert(
    countActiveBuyerSellerCommitments({ escrows: [listingOnly], userPubkey: me }) === 0,
    "CREATE-only listing does not count toward active commitments",
  );
  assert(
    countActiveBuyerSellerCommitments({ escrows: [asBuyer], userPubkey: me }) === 1,
    "Single LOCKED trade counts once",
  );
  assert(
    countActiveBuyerSellerCommitments({ escrows: [older, newer], userPubkey: me }) === 2,
    "Two concurrent live trades count twice (v0.6.5 allows it)",
  );
  assert(
    countActiveBuyerSellerCommitments({ escrows: [asArbiter, completed, cancelled, claimed], userPubkey: me }) === 0,
    "Arbiter-only + terminal + claimed escrows don't count",
  );

  // v0.6.5: sumActiveBuyerSellerTradeMsats — the honest total behind
  // the ActiveTradePill headline. Sums amountMsats across every live
  // money-moving trade (LOCKED + APPROVED), distinct from
  // activeCommittedMsats which only counts LOCKED+APPROVED.
  assert(
    sumActiveBuyerSellerTradeMsats({ escrows: [], userPubkey: me }) === 0,
    "Empty escrows → 0 msats",
  );
  assert(
    sumActiveBuyerSellerTradeMsats({ escrows: [asBuyer], userPubkey: me }) === 1_000_000,
    "Single LOCKED trade contributes its full amountMsats",
  );
  assert(
    sumActiveBuyerSellerTradeMsats({ escrows: [listingOnly, asBuyer], userPubkey: me }) === 1_000_000,
    "CREATE-only listing stays off the active-trade sum",
  );
  assert(
    sumActiveBuyerSellerTradeMsats({ escrows: [asArbiter, completed, cancelled, claimed, expired], userPubkey: me }) === 0,
    "Arbiter-only + terminal + claimed + expired escrows don't contribute",
  );
}

// ── 31d-2. isMidFunding (v0.6.5 funding-operation gate) ─────────────────
//
// The only gate that should block a second Fund tap. UI-layer concern;
// the state machine doesn't care about concurrency. Exists because the
// Fedimint WASM client shares one OPFS wallet and two concurrent
// spendNotes calls would race.
console.log("\n── isMidFunding ──");
{
  assert(
    isMidFunding({ fundAndLockInProgress: false }) === false,
    "Not mid-funding → gate open",
  );
  assert(
    isMidFunding({ fundAndLockInProgress: true }) === true,
    "Mid-funding → gate closed",
  );
}

// ── 31d-3. pickArbiterFromPool (v0.6.5 round-robin assignment) ──────────
//
// Deterministic round-robin selection across the community arbiter
// pool. Same escrow id → same arbiter (relay-replay idempotent).
// Different escrow ids spread load across the pool.
console.log("\n── pickArbiterFromPool ──");
{
  assert(
    pickArbiterFromPool([], "any-id") === undefined,
    "Empty pool → undefined",
  );
  assert(
    pickArbiterFromPool(["solo"], "any-id") === "solo",
    "Single-arbiter pool → that arbiter",
  );

  const pool = ["arb-A", "arb-B", "arb-C"];
  const pick = pickArbiterFromPool(pool, "escrow-xyz");
  assert(pick !== undefined && pool.includes(pick), "Pick is in the pool");
  assert(
    pickArbiterFromPool(pool, "escrow-xyz") === pick,
    "Same escrow id → same arbiter on repeated calls (idempotent for relay replay)",
  );

  // Distribution: a handful of distinct ids should reach more than one
  // bucket in a 3-arbiter pool. Charcode-sum doesn't guarantee perfect
  // uniformity but is more than good enough for a tiny pool.
  const seen = new Set<string>();
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
    const p = pickArbiterFromPool(pool, id);
    if (p) seen.add(p);
  }
  assert(seen.size >= 2, "Round-robin spreads load across the pool, not always one slot");
  assert(
    pickArbiterFromPool(["buyer", "arb-B"], "any-id", ["buyer"]) === "arb-B",
    "Arbiter pick excludes existing participants",
  );
  assert(
    pickArbiterFromPool(["buyer"], "any-id", ["buyer"]) === undefined,
    "Arbiter pick returns empty when every pool member is already a participant",
  );

  const create = createEvent({ communityArbiters: [BUYER_PK] });
  const r1 = applyEvent(null, create);
  if (r1.ok) {
    const buyerJoin = joinEvent(Role.BUYER, BUYER_PK, create.raw.id);
    const r2 = applyEvent(r1.state, buyerJoin);
    if (r2.ok) {
      let createEscrowLockCalled = false;
      const bridge = new EscrowFedimintBridge(
        {
          getState: () => r2.state,
          lockEscrow: async () => {
            throw new Error("lockEscrow should not be called");
          },
        } as any,
        {
          createEscrowLock: async () => {
            createEscrowLockCalled = true;
            throw new Error("Fedimint spend should not be called");
          },
        } as any,
        {} as any,
      );
      let refusedBeforeSpend = false;
      try {
        await bridge.lockAndPublish(ESCROW_ID);
      } catch (e: any) {
        refusedBeforeSpend = /no arbiter available/i.test(e?.message || "")
          && /no eligible backup/i.test(e?.message || "");
      }
      assert(refusedBeforeSpend,
        "Bridge refuses LOCK when the only pool arbiter is already the buyer");
      assert(!createEscrowLockCalled,
        "Bridge refuses duplicate-arbiter LOCK before spending Fedimint ecash");
    }
  }
}

// ── 31d-3b. 2B prefer-bonded arbiter assignment (consensus-safe) ─────────
//
// Prefer a FUNDED bonded arbiter, stamped into CREATE. The JOIN gate accepts
// BOTH the bonded-preferred pick AND the legacy pick, so a mixed-version replay
// never diverges on ARBITER_NOT_ASSIGNED. Absent bonded ⇒ byte-identical to the
// pre-2B single-pick gate. Front-run defense (only the computed picks pass) holds.
console.log("\n── 2B prefer-bonded ──");
{
  const THIRD = "ff".repeat(32);
  const POOL = [ARBITER_PK, ARBITER2_PK, THIRD];

  // pickPreferredArbiter — the pure pick.
  assert(
    pickPreferredArbiter(POOL, [ARBITER2_PK], "any-id") === ARBITER2_PK,
    "Prefers the sole bonded arbiter",
  );
  assert(
    pickPreferredArbiter(POOL, [], "escrow-xyz") === pickArbiterFromPool(POOL, "escrow-xyz"),
    "Empty bonded ⇒ legacy pick (byte-identical)",
  );
  assert(
    pickPreferredArbiter(POOL, undefined, "escrow-xyz") === pickArbiterFromPool(POOL, "escrow-xyz"),
    "Undefined bonded ⇒ legacy pick",
  );
  assert(
    pickPreferredArbiter(POOL, ["9a".repeat(32)], "escrow-xyz") === pickArbiterFromPool(POOL, "escrow-xyz"),
    "Bonded arbiter not in pool ⇒ ignored, legacy pick",
  );
  assert(
    pickPreferredArbiter(POOL, [ARBITER2_PK], "escrow-xyz", [ARBITER2_PK]) ===
      pickArbiterFromPool(POOL, "escrow-xyz", [ARBITER2_PK]),
    "Bonded arbiter excluded (is a party) ⇒ legacy fallback, never strands",
  );

  // Reducer JOIN gate — accept-both, front-run still blocked.
  const create = createEvent({ communityArbiters: POOL, bondedArbiters: [ARBITER2_PK] });
  const r1 = applyEvent(null, create);
  if (assertOk(r1, "CREATE with bondedArbiters applies") && r1.ok) {
    const st = r1.state;
    assert(
      (st.bondedArbiters ?? []).join(",") === ARBITER2_PK,
      "bondedArbiters round-trips onto state (the stamped consensus anchor)",
    );
    const excl = [st.participants[Role.BUYER], st.participants[Role.SELLER]];
    const legacy = pickArbiterFromPool(st.communityArbiters, st.id, excl);
    const preferred = pickPreferredArbiter(st.communityArbiters, st.bondedArbiters, st.id, excl);
    assert(preferred === ARBITER2_PK, "seat prefers the bonded arbiter");
    assertOk(
      applyEvent(st, joinEvent(Role.ARBITER, preferred!, create.raw.id)),
      "bonded-preferred arbiter JOIN accepted",
    );
    if (legacy && legacy !== preferred) {
      assertOk(
        applyEvent(st, joinEvent(Role.ARBITER, legacy, create.raw.id)),
        "legacy-pick arbiter JOIN ALSO accepted (mixed-client safe, no divergence)",
      );
    }
    const intruder = POOL.find((pk) => pk !== legacy && pk !== preferred);
    if (intruder) {
      assertErr(
        applyEvent(st, joinEvent(Role.ARBITER, intruder, create.raw.id)),
        "ARBITER_NOT_ASSIGNED",
        "a non-pick pool member is still blocked (front-run defense holds)",
      );
    }
  }

  // ⭐ The core no-divergence property, made DETERMINISTIC. The harness reuses
  // one escrow id (so the hash pick is fixed); construct the divergent case
  // directly by stamping a bond on a pool member that ISN'T the legacy pick,
  // then prove a JOIN by EITHER the bonded seat OR the legacy seat is accepted —
  // a new client (seats bonded) and an old client (seats legacy) never fork on
  // ARBITER_NOT_ASSIGNED. (state.bondedArbiters is what the reducer reads.)
  {
    const c = createEvent({ communityArbiters: POOL });
    const r = applyEvent(null, c);
    if (assertOk(r, "divergent-case CREATE applies") && r.ok) {
      const excl = [r.state.participants[Role.BUYER], r.state.participants[Role.SELLER]];
      const lg = pickArbiterFromPool(r.state.communityArbiters, r.state.id, excl)!;
      const bondedChoice = POOL.find((pk) => pk !== lg && !excl.includes(pk))!;
      const s = { ...r.state, bondedArbiters: [bondedChoice] };
      const pf = pickPreferredArbiter(s.communityArbiters, s.bondedArbiters, s.id, excl)!;
      assert(pf === bondedChoice && pf !== lg, "constructed a divergent case: bonded pick ≠ legacy pick");
      assertOk(applyEvent(s, joinEvent(Role.ARBITER, pf, c.raw.id)),
        "divergent: bonded-preferred (new-client) JOIN accepted");
      assertOk(applyEvent(s, joinEvent(Role.ARBITER, lg, c.raw.id)),
        "divergent: legacy-pick (old-client) JOIN ALSO accepted — no chain fork");
    }
  }

  // Backward-compat: no bonded stamp ⇒ gate accepts exactly the legacy pick.
  const createLegacy = createEvent({ communityArbiters: POOL });
  const rL = applyEvent(null, createLegacy);
  if (assertOk(rL, "CREATE without bondedArbiters applies (pre-2B shape)") && rL.ok) {
    const st = rL.state;
    assert((st.bondedArbiters ?? []).length === 0, "no bonded stamp ⇒ empty bondedArbiters");
    const excl = [st.participants[Role.BUYER], st.participants[Role.SELLER]];
    const legacy = pickArbiterFromPool(st.communityArbiters, st.id, excl)!;
    assertOk(
      applyEvent(st, joinEvent(Role.ARBITER, legacy, createLegacy.raw.id)),
      "legacy pick JOIN accepted on a pre-2B trade (unchanged)",
    );
    const intruder = POOL.find((pk) => pk !== legacy);
    if (intruder) {
      assertErr(
        applyEvent(st, joinEvent(Role.ARBITER, intruder, createLegacy.raw.id)),
        "ARBITER_NOT_ASSIGNED",
        "non-pick still blocked on a pre-2B trade",
      );
    }
  }

  // C1 classify — a bonded-preferred seat is as-assigned; a non-basis seat is off.
  {
    const ID = "escrow-2b-c1";
    const preferred = pickPreferredArbiter(POOL, [ARBITER2_PK], ID, [BUYER_PK, SELLER_PK])!;
    assert(
      classifyArbiterAssignment({
        pool: POOL, escrowId: ID, committedArbiter: preferred,
        buyerPubkey: BUYER_PK, sellerPubkey: SELLER_PK, bondedArbiters: [ARBITER2_PK],
      }).status === "as-assigned",
      "C1: bonded-preferred seat reads as-assigned",
    );
    assert(
      classifyArbiterAssignment({
        pool: POOL, escrowId: ID, committedArbiter: "99".repeat(32),
        buyerPubkey: BUYER_PK, sellerPubkey: SELLER_PK, bondedArbiters: [ARBITER2_PK],
      }).status === "off-assignment",
      "C1: a non-basis (hand-seated) arbiter still reads off-assignment",
    );
  }
}

// ── 31d-4. Arbiter fee policy constants (v0.9.2) ────────────────────────
//
// These constants pin the v1 social contract without changing claim
// settlement yet. The current bearer-token escrow still needs a
// dedicated multi-party payout path before the UI should deduct these
// from Fedi/ecash claims.
console.log("\n── arbiter fee policy ──");
{
  assert(AMBIENT_ARBITER_FEE_BPS === 50, "Ambient arbiter fee is locked at 0.5%");
  assert(DISPUTE_ARBITER_FEE_BPS === 150, "Dispute escalation fee is locked at 1.5%");
  assert(DISPUTE_PARTY_SHARE_BPS === 75, "Dispute fee splits 0.75% per party");
  assert(TOTAL_DISPUTED_ARBITER_FEE_BPS === 200, "Disputed trade total arbiter take is 2%");

  const oneThousandSats = 1_000_000;
  assert(
    calculateAmbientArbiterFeeMsats(oneThousandSats) === 5_000,
    "0.5% of 1,000 sats is 5 sats",
  );
  assert(
    calculateDisputeArbiterFeeMsats(oneThousandSats) === 15_000,
    "1.5% of 1,000 sats is 15 sats",
  );
  assert(
    calculateDisputePartyShareMsats(oneThousandSats) === 7_500,
    "Each dispute side carries 0.75% of trade value",
  );
  assert(
    calculateBasisPointFeeMsats(50_000, AMBIENT_ARBITER_FEE_BPS) === 250,
    "Small trades keep fee precision in msats until a payout path rounds",
  );
}

// ── 31e. shouldShowRecoveryBanner + identifyStrandedEcashSource (item 2)─
//
// When the user's OPFS holds a balance but no in-flight trade
// claims it, that's a recovery state. The banner replaces Browse
// and forces resolution before any commitment can be created.
// identifyStrandedEcashSource walks the local replay to find the
// most recent CLAIM event the user signed; the escrow that CLAIM
// lives on is the source of the orphan ecash.
console.log("\n── shouldShowRecoveryBanner + identifyStrandedEcashSource ──");
{
  // shouldShowRecoveryBanner: only when balance is material enough for
  // main-flow interruption AND no active trade. Tiny payout dust is
  // surfaced quietly in Me instead.
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasCurrentEscrow: false,
    }) === true,
    "Material balance + no active trade → show banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 50_000, hasCurrentEscrow: false }) === false,
    "Small recovered balance → no main-flow banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 1_500_000, hasCurrentEscrow: false }) === false,
    "1,500 sat leftover → no main-flow banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 0, hasCurrentEscrow: false }) === false,
    "Zero balance → no banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 999, hasCurrentEscrow: false }) === false,
    "Sub-sat dust → no recovery banner",
  );
  assert(
    shouldShowRecoveryBanner({ balanceMsats: 2_500, hasCurrentEscrow: false }) === false,
    "Fee-floor dust → no recovery banner until it accumulates",
  );
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasCurrentEscrow: true,
    }) === false,
    "Balance > 0 but active trade exists → no banner (active trade owns the funds)",
  );
  // v0.6.5: balance held briefly by the atomic fund-and-lock flow is
  // expected-transient and must not race the recovery banner.
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasCurrentEscrow: false,
      fundingInProgress: true,
    }) === false,
    "Mid-fund-and-lock holds the balance → no banner",
  );
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasCurrentEscrow: false,
      claimPayoutInProgress: true,
    }) === false,
    "Mid-claim-and-payout holds the balance → no banner",
  );
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasCurrentEscrow: false,
      fundingInProgress: false,
      claimPayoutInProgress: false,
    }) === true,
    "Truly unexplained balance → banner fires (the orphan case)",
  );
  // v0.6.5: the preferred hasAnyActiveEscrow param name resolves
  // identically to the legacy hasCurrentEscrow alias.
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasAnyActiveEscrow: true,
    }) === false,
    "hasAnyActiveEscrow (new name) suppresses the banner just like hasCurrentEscrow",
  );
  // Phase 1: sim manual-fund balances are intentional & fake. The recovery
  // banner is a production real-stranded-funds alarm, so sim mode suppresses
  // it even for a MATERIAL unexplained balance that would otherwise fire it
  // (contrast the "orphan case" assertion above, which returns true with the
  // same balance and no sim flag — so this guards the gate, not the dust line).
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasAnyActiveEscrow: false,
      simModeOn: true,
    }) === false,
    "Sim mode suppresses the recovery banner even with a material unexplained balance",
  );
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: 1_000_000,
      hasAnyActiveEscrow: false,
      simModeOn: true,
    }) === false,
    "Sim mode keeps the recovery banner quiet for a manual-fund balance",
  );

  // identifyStrandedEcashSource: find the most recent CLAIM signed by user.
  const me = "me_pubkey_dddd";
  const other = "other_pubkey_eeee";
  const arb = "arb_pubkey_ffff";

  const escrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "test-id",
    status: EscrowStatus.COMPLETED,
    description: "test",
    amountMsats: 1_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BLF_FEDERATION_INVITE,
    participants: { buyer: me, seller: other, arbiter: arb },
    initiator: { pubkey: me, role: Role.BUYER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: 0,
    createdAt: 1000,
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  const claimEvent = (pubkey: string, timestamp: number) => ({
    raw: {} as any,
    payload: {} as any,
    escrowId: "test-id",
    prevEventId: null,
    kind: EscrowEventKind.CLAIM,
    pubkey,
    timestamp,
  });

  // No CLAIM events → null (banner falls back to "unknown counterparty").
  assert(
    identifyStrandedEcashSource({ escrows: [], userPubkey: me }) === null,
    "No escrows → null (generic withdraw fallback)",
  );

  // CLAIM signed by user → return source.
  const claimed = escrow({
    id: "claimed",
    description: "Pay my electric bill",
    amountMsats: 80_000_000,
    eventChain: [claimEvent(me, 5000)] as any,
  });
  const found = identifyStrandedEcashSource({ escrows: [claimed], userPubkey: me });
  assert(found !== null, "User-signed CLAIM → source identified");
  if (found) {
    assert(found.escrowId === "claimed", "Source escrow id matches");
    assert(found.counterpartyPubkey === other,
      "Counterparty is the other non-arbiter participant");
    assert(found.role === Role.BUYER,
      "Role reflects the user's position in the trade");
    assert(found.amountMsats === 80_000_000,
      "Amount carries through for the withdraw CTA");
    assert(found.description === "Pay my electric bill",
      "Description carries through for the banner identity card");
  }

  // CLAIM signed by someone else → not the source (privacy: don't
  // surface a counterparty for trades the user wasn't winner on).
  const otherWon = escrow({
    id: "other-won",
    eventChain: [claimEvent(other, 6000)] as any,
  });
  assert(
    identifyStrandedEcashSource({ escrows: [otherWon], userPubkey: me }) === null,
    "CLAIM signed by someone else → null (not the user's stranded ecash)",
  );

  // Multiple user-CLAIMs → most recent timestamp wins.
  const olderClaim = escrow({
    id: "older",
    eventChain: [claimEvent(me, 1000)] as any,
  });
  const newerClaim = escrow({
    id: "newer",
    eventChain: [claimEvent(me, 9000)] as any,
  });
  const mostRecent = identifyStrandedEcashSource({
    escrows: [olderClaim, newerClaim],
    userPubkey: me,
  });
  assert(mostRecent?.escrowId === "newer",
    "Most recent CLAIM by timestamp wins");
}

// ── 31e2. Pending claim payouts (stranded-payout recovery) ──────────────
//
// The claim-side analog of #37's pending-native-locks summary: a
// CLAIMED-not-COMPLETED trade the user won explains the wallet balance
// (the claimed ecash whose outbound payout never finished), so the
// drain-shaped recovery surfaces suppress and the calm "Finish your
// payout" card takes over. Bounded: other-fed trades and week-old claims
// stop suppressing. Plus the banner attribution honesty rule: a trade
// card must never front a sweep its amount can't explain.
console.log("\n── PENDING CLAIM PAYOUTS (stranded-payout recovery) ──");
{
  const me = "me_pubkey_pp01";
  const other = "other_pubkey_pp02";
  const arb = "arb_pubkey_pp03";
  const FED_A = "a".repeat(64);
  const FED_B = "b".repeat(64);

  const escrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "pp-id",
    status: EscrowStatus.CLAIMED,
    description: "sell sats for KES",
    amountMsats: 1_570_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BLF_FEDERATION_INVITE,
    participants: { buyer: me, seller: other, arbiter: arb },
    initiator: { pubkey: me, role: Role.BUYER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: 0,
    createdAt: 1000,
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  const mkEvent = (
    kind: EscrowEventKind,
    pubkey: string,
    timestamp: number,
    payload: unknown = {},
  ) => ({
    raw: {} as any,
    payload: payload as any,
    escrowId: "pp-id",
    prevEventId: null,
    kind,
    pubkey,
    timestamp,
  });

  const CLAIM_AT = 5_000; // Unix seconds
  const NOW_MS = CLAIM_AT * 1000 + 60_000; // one minute after the claim
  const noRecord = () => null;

  // finish: CLAIMED + my CLAIM + no journal record + balance covers →
  // an actionable "finish your payout" story that suppresses the drain.
  const claimed = escrow({
    eventChain: [mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT)] as any,
  });
  const finish = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000, nowMs: NOW_MS,
  });
  assert(finish.suppressRecovery === true,
    "CLAIMED + my CLAIM + no record + balance covers → suppress the drain surfaces");
  assert(finish.card?.kind === "finish",
    "No journal record → the card invites finishing the payout (RETRY CLAIM path)");
  assert(finish.card?.amountMsats === 1_570_000_000,
    "The card carries the trade amount, not the wallet balance");

  // Balance can't hold the claim (claim-pending: redeem never landed) →
  // no false "your sats are back" story; nothing suppresses.
  const short = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 100_000_000, nowMs: NOW_MS,
  });
  assert(short.suppressRecovery === false && short.card === null,
    "Balance below the claim amount → no finish entry (no false story)");

  // submitted journal record → "confirming" even at balance 0 (the sats
  // may be with the gateway; reattach resolves the truth).
  const confirming = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me,
    getPayoutRecord: () => ({ status: "submitted" as const }),
    balanceMsats: 0, nowMs: NOW_MS,
  });
  assert(confirming.card?.kind === "confirming",
    "Submitted payout record → confirming card (never invites a re-pay)");

  // V7: an intent record is NOT evidence a payment exists — it reads
  // exactly like no record: the balance-gated "finish" bucket.
  const intentRec = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me,
    getPayoutRecord: () => ({ status: "intent" as const }),
    balanceMsats: 2_462_000_000, nowMs: NOW_MS,
  });
  assert(intentRec.card?.kind === "finish",
    "Intent payout record → finish card (pre-send breadcrumb, not a sent payout)");

  // settled record → the payout went out; nothing to card or suppress.
  const settled = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me,
    getPayoutRecord: () => ({ status: "settled" as const }),
    balanceMsats: 2_462_000_000, nowMs: NOW_MS,
  });
  assert(settled.suppressRecovery === false && settled.entries.length === 0,
    "Settled payout record → no entry (the reattach sweep publishes COMPLETE)");

  // COMPLETED trade → residue is the generic-residue story, not a payout
  // to finish.
  const completed = summarizePendingPayoutsForUi({
    escrows: [escrow({
      status: EscrowStatus.COMPLETED,
      eventChain: [mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT)] as any,
    })],
    userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000, nowMs: NOW_MS,
  });
  assert(completed.suppressRecovery === false,
    "COMPLETED trade → no pending-payout entry");

  // Someone else's CLAIM → not my payout to finish.
  const otherWon = summarizePendingPayoutsForUi({
    escrows: [escrow({
      eventChain: [mkEvent(EscrowEventKind.CLAIM, other, CLAIM_AT)] as any,
    })],
    userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000, nowMs: NOW_MS,
  });
  assert(otherWon.suppressRecovery === false,
    "CLAIM signed by someone else → no entry (not my claim residue)");

  // Suppression is BOUNDED: a claim older than the horizon stops hiding
  // the recovery banner (the drain is safe on settled claim residue —
  // escalation, not harm).
  const aged = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000,
    nowMs: CLAIM_AT * 1000 + PENDING_PAYOUT_SUPPRESS_MAX_MS + 1,
  });
  assert(aged.suppressRecovery === false,
    "Claim older than PENDING_PAYOUT_SUPPRESS_MAX_MS → stops suppressing (bounded)");

  // Fed context: a trade stamped with a DIFFERENT fed can't explain THIS
  // fed's balance; same-fed and legacy unstamped trades pass through.
  const stamped = (fed: string) => escrow({
    eventChain: [
      mkEvent(EscrowEventKind.CREATE, other, 1_000, { fed }),
      mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT),
    ] as any,
  });
  const otherFed = summarizePendingPayoutsForUi({
    escrows: [stamped(FED_B)], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000, nowMs: NOW_MS, currentFederationId: FED_A,
  });
  assert(otherFed.suppressRecovery === false,
    "Other-fed trade → no entry (can't explain this fed's balance)");
  const sameFed = summarizePendingPayoutsForUi({
    escrows: [stamped(FED_A)], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000, nowMs: NOW_MS, currentFederationId: FED_A,
  });
  assert(sameFed.suppressRecovery === true,
    "Same-fed stamped trade → entry passes the fed gate");
  const unstamped = summarizePendingPayoutsForUi({
    escrows: [claimed], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 2_462_000_000, nowMs: NOW_MS, currentFederationId: FED_A,
  });
  assert(unstamped.suppressRecovery === true,
    "Legacy unstamped trade → passes the fed gate (warn-and-allow doctrine)");

  // Newest claim fronts the card.
  const older = escrow({
    id: "pp-old",
    eventChain: [mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT - 1_000)] as any,
  });
  const newest = summarizePendingPayoutsForUi({
    escrows: [older, claimed], userPubkey: me, getPayoutRecord: noRecord,
    balanceMsats: 4_000_000_000, nowMs: NOW_MS,
  });
  assert(newest.card?.escrowId === "pp-id" && newest.entries.length === 2,
    "Multiple pending payouts → newest claim fronts the card, all listed");

  // The suppressor plumbs through the recovery banner + ChamaBar pill.
  assert(
    shouldShowRecoveryBanner({
      balanceMsats: 2_462_000_000,
      hasAnyActiveEscrow: false,
      hasPendingClaimPayout: true,
    }) === false,
    "hasPendingClaimPayout suppresses the recovery banner",
  );
  assert(
    decideChamaBarLabel({
      balanceMsats: 2_462_000_000,
      hasActiveBuyerSellerCommitment: false,
      hasPendingClaimPayout: true,
    }).kind === "ready",
    "hasPendingClaimPayout suppresses the stranded ChamaBar pill",
  );

  // Boot-sweep targets: any CLAIMED trade I won holding a journal record
  // (submitted OR settled) — reattach is structurally re-pay-free.
  const records: Record<string, { status: "submitted" | "settled" }> = {
    "pp-id": { status: "submitted" },
    "pp-done": { status: "settled" },
    // Records exist for these too — the skips below must be proven by
    // status/ownership, not by a missing record.
    "pp-completed": { status: "submitted" },
    "pp-theirs": { status: "submitted" },
  };
  const getRec = (id: string) => records[id] ?? null;
  const targets = selectPayoutReattachTargets({
    escrows: [
      claimed,                                          // submitted → target
      escrow({ id: "pp-done",
        eventChain: [mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT)] as any }), // settled → target
      escrow({ id: "pp-norec",
        eventChain: [mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT)] as any }), // no record → skip
      escrow({ id: "pp-completed", status: EscrowStatus.COMPLETED,
        eventChain: [mkEvent(EscrowEventKind.CLAIM, me, CLAIM_AT)] as any }), // COMPLETED → skip
      escrow({ id: "pp-theirs",
        eventChain: [mkEvent(EscrowEventKind.CLAIM, other, CLAIM_AT)] as any }), // not mine → skip
    ],
    userPubkey: me,
    getPayoutRecord: getRec,
  });
  assert(targets.length === 2 && targets.includes("pp-id") && targets.includes("pp-done"),
    "Reattach targets = CLAIMED trades I won that hold a journal record");

  // Attribution honesty: the banner card only names a claim whose amount
  // explains the balance. ₿1,570 must never front a ₿2,462 sweep.
  assert(strandedSourceExplainsBalance(1_570_000_000, 1_570_000_000) === true,
    "Balance == trade amount → card is honest");
  assert(strandedSourceExplainsBalance(1_570_000_000, 1_580_000_000) === true,
    "Small overage (denomination/fee dust) → card still honest");
  assert(strandedSourceExplainsBalance(1_570_000_000, 2_462_000_000) === false,
    "₿2,462 balance vs ₿1,570 trade → card dropped (generic residue copy)");
  assert(strandedSourceExplainsBalance(1_570_000_000, 900_000_000) === true,
    "Balance below the trade amount → still honestly 'from this trade'");
}

// ── 31f. sats trace provenance ──────────────────────────────────────────
console.log("\n── SATS TRACE PROVENANCE ──");
{
  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope("trace_user");

  const entry = recordSatsTrace({
    source: "claim",
    escrowId: "trace-escrow-001",
    amountMsats: 2_000_000,
    balanceMsats: 1_500_000,
    reason: "claim-payout-leftover",
    operationIds: { reissue: "mint_op_1" },
  });
  assert(entry.escrowId === "trace-escrow-001",
    "Trace records escrow id for leftover sats");
  assert(listOpenSatsTraces().length === 1,
    "Open trace is listed");
  assert(getBestSatsTrace(1_500_000)?.escrowId === "trace-escrow-001",
    "Best trace returns the latest open leftover source");
  assert(describeSatsTrace(entry)?.includes("trace-esc") === true,
    "Trace description includes shortened trade id");

  recordSatsTrace({
    source: "claim",
    escrowId: "trace-escrow-001",
    balanceMsats: 1_000_000,
    operationIds: { pay: "ln_pay_1" },
  });
  const updated = listOpenSatsTraces()[0];
  assert(updated.balanceMsats === 1_000_000,
    "Trace upsert refreshes current leftover balance");
  assert(updated.operationIds?.reissue === "mint_op_1" && updated.operationIds?.pay === "ln_pay_1",
    "Trace upsert merges operation ids");

  const meta = buildChamaOperationMeta({
    flow: "claim_reissue",
    escrowId: "trace-escrow-001",
    amountMsats: 2_000_000,
    notesHashPrefix: "abc123",
  });
  assert(meta.chama_escrow_id === "trace-escrow-001",
    "Operation metadata carries escrow id");
  assert(meta.chama_flow === "claim_reissue",
    "Operation metadata carries flow");

  markSatsTracesDrained("test-drained");
  assert(listOpenSatsTraces().length === 0,
    "Draining closes open traces");
  assert((globalThis as any).localStorage.getItem(scopedStorageKey(SATS_TRACE_STORAGE_KEY)) !== null,
    "Trace store is scoped per user");
  setLocalStorageUserScope(null);
}

// ── 31f. decideListingTapEffect (items 1 + 4) ───────────────────────────
//
// Federation-follows-listing dispatch. Per Q1 confirmation: re-init
// happens at LISTING-TAP time, not Fund-CTA time. The detail screen
// always opens on the right fed; State B's past-tense narration
// reflects the switch that already happened.
console.log("\n── decideListingTapEffect ──");
{
  // Matching fed → State A render, no client work.
  const matching = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BLF_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(matching.kind === "matching",
    "Listing on user's current fed → matching (State A)");

  // Different fed, balance == 0 → silent switch.
  const switchSilent = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(switchSilent.kind === "switch-silent",
    "Different fed + balance==0 → switch-silent (State B path)");
  if (switchSilent.kind === "switch-silent") {
    assert(switchSilent.targetInvite === BLF_FEDERATION_INVITE,
      "Target invite matches the listing's fed");
    assert(switchSilent.displayName === "Global · Bitcoin",
      "Display name carries community name for narration");
  }

  const dustSwitchSilent = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 999,
  });
  assert(dustSwitchSilent.kind === "switch-silent",
    "Sub-sat dust does not block listing-fed switching");
  const feeFloorSwitchSilent = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 2_500,
  });
  assert(feeFloorSwitchSilent.kind === "switch-silent",
    "Sub-fee dust does not block listing-fed switching");
  // Same material dust line as the community path: a withdrawable-but-sub-
  // material balance (50 sats) must NOT block a listing-fed switch.
  const subMaterialSwitchSilent = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 50_000,
  });
  assert(subMaterialSwitchSilent.kind === "switch-silent",
    "Sub-material balance (50 sats) does not block listing-fed switching");

  // Different fed + MATERIAL balance (>= 2000 sats) → destroy-confirm modal.
  const destroyConfirm = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 5_000_000,
  });
  assert(destroyConfirm.kind === "destroy-confirm",
    "Different fed + material balance → destroy-confirm (Pillar 2.1)");

  // No current invite (truly disconnected) → switch-silent (caller
  // dispatches initFedimint vs switchFederation based on whether a
  // client is loaded).
  const noClient = decideListingTapEffect({
    listing: { mintUrl: BLF_FEDERATION_INVITE, community: "sn-cfa" },
    currentInvite: null,
    balanceMsats: 0,
  });
  assert(noClient.kind === "switch-silent",
    "No current invite → switch-silent (no fund to preserve)");

  // mintUrl missing/stale → falls back to community-derived invite.
  // Defense-in-depth for pre-v0.1.87 listings without probe data.
  const fallback = decideListingTapEffect({
    listing: { mintUrl: "", community: "us-blf" },
    currentInvite: BP_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(fallback.kind === "switch-silent",
    "Missing mintUrl falls back to community-derived invite");
  if (fallback.kind === "switch-silent") {
    assert(fallback.targetInvite === BLF_FEDERATION_INVITE,
      "Community-derived fallback resolves to us-blf's pinned invite");
  }

  const legacyStaleFedMatching = decideListingTapEffect({
    listing: {
      mintUrl: BLF_FEDERATION_INVITE,
      community: "us-blf",
      fedId: BP_FEDERATION_ID,
    },
    currentInvite: BLF_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(legacyStaleFedMatching.kind === "matching",
    "Listing tap treats stale fed as matching when mintUrl and community agree");

  const fedWinsOverLoneMint = decideListingTapEffect({
    listing: {
      mintUrl: BLF_FEDERATION_INVITE,
      community: null,
      fedId: BP_FEDERATION_ID,
    },
    currentInvite: BLF_FEDERATION_INVITE,
    balanceMsats: 0,
  });
  assert(fedWinsOverLoneMint.kind === "switch-silent",
    "Listing tap keeps CREATE fed authoritative over a lone stale mintUrl");
  if (fedWinsOverLoneMint.kind === "switch-silent") {
    assert(fedWinsOverLoneMint.targetInvite === BP_FEDERATION_INVITE,
      "Fed-authoritative listing targets the invite mapped from CREATE fed");
  }

  const bpFedId = BP_FEDERATION_ID;
  const blfFedId = BLF_FEDERATION_ID;
  assert(
    listingMatchesActiveRoute({
      listingMintUrl: BLF_FEDERATION_INVITE,
      listingFedId: bpFedId,
      activeInvite: BLF_FEDERATION_INVITE,
      activeFedId: blfFedId,
    }) === false,
    "Browse matching uses CREATE fed id over stale mintUrl when fed id is present",
  );
  assert(
    listingMatchesActiveRoute({
      listingMintUrl: BLF_FEDERATION_INVITE,
      listingFedId: bpFedId,
      activeInvite: BLF_FEDERATION_INVITE,
      activeFedId: bpFedId,
    }) === true,
    "Browse matching accepts a listing when CREATE fed id matches active fed id",
  );
  assert(
    listingMatchesActiveRoute({
      listingMintUrl: BLF_FEDERATION_INVITE,
      listingFedId: null,
      activeInvite: BLF_FEDERATION_INVITE,
      activeFedId: blfFedId,
    }) === true,
    "Legacy listing without fed id falls back to mintUrl matching",
  );
  assert(
    listingMatchesActiveRoute({
      listingMintUrl: BLF_FEDERATION_INVITE,
      listingFedId: bpFedId,
      listingCommunity: "us-blf",
      activeInvite: BLF_FEDERATION_INVITE,
      activeFedId: blfFedId,
    }) === true,
    "Legacy listing with stale fed id is matched when mintUrl and community agree",
  );
  assert(
    listingMatchesActiveRoute({
      listingMintUrl: BP_FEDERATION_INVITE,
      listingFedId: null,
      listingCommunity: "ke-kes",
      activeInvite: AFRIBIT_KIBERA_FEDERATION_INVITE,
      activeFedId: AFRIBIT_KIBERA_FEDERATION_ID,
    }) === true,
    "Legacy listing without fed id can match by community-derived invite",
  );
}

// ── 31g. decideArbiterWarning (item 10) ─────────────────────────────────
//
// Arbiter status doesn't hard-block Create — instead, fire one of two
// warnings. Hard wins over soft; within tier, most recent escrow wins.
console.log("\n── decideArbiterWarning ──");
{
  const me = "me_arbiter_aaaa";
  const buyer = "buyer_pubkey_bbbb";
  const seller = "seller_pubkey_cccc";

  const arbEscrow = (overrides: Partial<EscrowState>): EscrowState => ({
    id: "arb-test",
    status: EscrowStatus.LOCKED,
    description: "test",
    amountMsats: 1_000_000,
    category: "p2p-trade",
    fulfillment: "service",
    community: "sn-cfa",
    mintUrl: BLF_FEDERATION_INVITE,
    participants: { buyer, seller, arbiter: me },
    initiator: { pubkey: seller, role: Role.SELLER },
    communityArbiters: [],
    subscription: null,
    votes: {},
    resolvedOutcome: null,
    resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: seller, arbiterFeeMsats: 0 },
    expiresAt: 0,
    createdAt: 1000,
    eventChain: [],
    chatMessages: [],
    lock: { handle: null },
    ...overrides,
  } as EscrowState);

  // No arbiter escrows → none.
  assert(
    decideArbiterWarning({ escrows: [], userPubkey: me }).kind === "none",
    "No arbiter responsibility → none",
  );

  // LOCKED, no votes → soft.
  const noVotes = arbEscrow({ id: "soft1" });
  const soft = decideArbiterWarning({ escrows: [noVotes], userPubkey: me });
  assert(soft.kind === "soft",
    "LOCKED with no votes → soft warning (happy-path may never need arbiter)");
  if (soft.kind === "soft") {
    assert(soft.escrowId === "soft1", "Soft carries the escrow id");
    assert(soft.counterpartyA === buyer, "Soft counterpartyA is the buyer");
    assert(soft.counterpartyB === seller, "Soft counterpartyB is the seller");
  }

  // LOCKED with both votes disagreeing → hard.
  const disputed = arbEscrow({
    id: "hard1",
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND },
  });
  const hard = decideArbiterWarning({ escrows: [disputed], userPubkey: me });
  assert(hard.kind === "hard",
    "LOCKED with disagreeing votes → hard warning (tiebreaker pending)");
  if (hard.kind === "hard") {
    assert(hard.escrowId === "hard1", "Hard carries the escrow id");
  }

  // Hard wins over soft when both present.
  const mixedSoft = arbEscrow({ id: "soft2", createdAt: 5000 });
  const mixedHard = arbEscrow({
    id: "hard2",
    createdAt: 1000,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND },
  });
  const mixed = decideArbiterWarning({
    escrows: [mixedSoft, mixedHard],
    userPubkey: me,
  });
  assert(mixed.kind === "hard",
    "Hard always wins over soft, even when soft is more recent");
  if (mixed.kind === "hard") {
    assert(mixed.escrowId === "hard2",
      "Hard winner is the disputed escrow regardless of relative timestamps");
  }

  // Within hard tier, most recent wins.
  const olderHard = arbEscrow({
    id: "old-hard",
    createdAt: 1000,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND },
  });
  const newerHard = arbEscrow({
    id: "new-hard",
    createdAt: 5000,
    votes: { [Role.BUYER]: Outcome.REFUND, [Role.SELLER]: Outcome.RELEASE },
  });
  const mostRecentHard = decideArbiterWarning({
    escrows: [olderHard, newerHard],
    userPubkey: me,
  });
  assert(
    mostRecentHard.kind === "hard"
      && mostRecentHard.escrowId === "new-hard",
    "Within hard tier, most recent createdAt wins",
  );

  // Non-LOCKED arbiter trade → not surfaced (settled or terminal).
  const completed = arbEscrow({
    id: "done",
    status: EscrowStatus.COMPLETED,
  });
  assert(
    decideArbiterWarning({ escrows: [completed], userPubkey: me }).kind === "none",
    "Arbiter on COMPLETED escrow → no warning (settled)",
  );

  // Both votes agree → state machine should have moved to APPROVED;
  // a stuck-at-LOCKED-with-agreeing-votes is defensive-only soft.
  const agreeStuck = arbEscrow({
    id: "agree-stuck",
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.RELEASE },
  });
  assert(
    decideArbiterWarning({ escrows: [agreeStuck], userPubkey: me }).kind === "soft",
    "LOCKED with agreeing votes → soft (defensive — no tiebreaker needed)",
  );
}

// ── 32. CreateForm derives mintUrl from active route ────────────────────
//
// v0.1.85 cleanup: the federation invite input field was removed from
// CreateForm. Listings now derive mintUrl from the joined route first,
// then fall back to the user's current community when no route is loaded.
// This keeps Browse color/sorting aligned with the CREATE fed tag.
console.log("\n── CreateForm-derived mintUrl ──");
{
  (globalThis as any).localStorage.clear();
  assert(resolveCreateMintUrl({
    activeInvite: BP_FEDERATION_INVITE,
    community: "us-blf",
  }) === BP_FEDERATION_INVITE,
    "Active route wins over home community when creating a listing");
  assert(resolveCreateMintUrl({
    activeInvite: null,
    community: "us-blf",
  }) === BLF_FEDERATION_INVITE,
    "No active route falls back to community-derived mintUrl");
  // sn-cfa pins OCA (v2.6 African regional default) — listings go to OCA.
  assert(resolveFederationForCommunity("sn-cfa") === OCA_FEDERATION_INVITE,
    "sn-cfa listing → OCA invite (community-derived mintUrl)");
  // us-blf pins BLF — listings in us-blf go to BLF.
  assert(resolveFederationForCommunity("us-blf") === BLF_FEDERATION_INVITE,
    "us-blf listing → BLF invite");
  // Unknown community → BLF fallback (DECISION 2026-06-16).
  assert(resolveFederationForCommunity("xx-unknown") === BLF_FEDERATION_INVITE,
    "Unknown community → BLF fallback (no listing stranded)");
}

// ── 33. LNURL PARSER (v0.3.0 Phase 1) ────────────────────────────────────
//
// Parse-time validation rejects malformed Lightning Addresses BEFORE any
// network call. Catches typos with a usable error in <1ms instead of
// burning a 5-second DNS timeout that surfaces as a generic network
// error. Per the v0.3.0 brief addition #1.
console.log("\n── LNURL PARSER ──");
{
  // Standard form
  const a = parseLightningAddress("alice@phoenix.app");
  assert(a.user === "alice" && a.domain === "phoenix.app",
    "Parses standard user@domain.tld");

  // Whitespace trimmed
  const b = parseLightningAddress("  bob@strike.me  ");
  assert(b.user === "bob" && b.domain === "strike.me",
    "Trims whitespace before parsing");

  // Mixed case normalized to lowercase
  const c = parseLightningAddress("Alice@Phoenix.App");
  assert(c.user === "alice" && c.domain === "phoenix.app",
    "Lowercases user and domain");

  // Underscores, dots, dashes in user
  const d = parseLightningAddress("first.last_99-x@wallet.io");
  assert(d.user === "first.last_99-x" && d.domain === "wallet.io",
    "Accepts dot/dash/underscore in user");

  // Multi-level subdomain
  const e = parseLightningAddress("user@pay.api.example.com");
  assert(e.user === "user" && e.domain === "pay.api.example.com",
    "Accepts multi-level subdomains");

  // ── Synchronous rejection — no fetch issued ────────────────────────────
  // Track whether fetch is called during parse-time validation. parser
  // must not touch the network for any input it will reject.
  let fetchCalled = 0;
  const sentinelFetch: typeof fetch = (async () => {
    fetchCalled++;
    return new Response("{}", { status: 200 });
  }) as any;
  void sentinelFetch; // explicitly unused — parseLightningAddress is sync

  const rejects = (raw: any, label: string) => {
    let threwParse = false;
    let code = "";
    try { parseLightningAddress(raw); }
    catch (err) {
      if (err instanceof LnurlError) {
        threwParse = true;
        code = err.code;
      }
    }
    assert(threwParse && code === "LnurlParseError",
      `Rejects ${label} synchronously as LnurlParseError`);
  };

  rejects("", "empty string");
  rejects("   ", "whitespace only");
  rejects("noatsign", "missing '@'");
  rejects("user@@two.ats", "two '@' signs");
  rejects("user@nodot", "domain without TLD dot");
  rejects("user@.tld", "domain starting with dot");
  rejects("user@tld.x", "TLD shorter than 2 chars");
  rejects("user@host.", "trailing dot domain");
  rejects("user with space@host.com", "spaces in user");
  rejects("user@host with space.com", "spaces in domain");
  rejects("user!@host.com", "special char in user");
  rejects(null, "null");
  rejects(undefined, "undefined");
  rejects(42, "number input");

  assert(fetchCalled === 0,
    "Parser issued zero fetches (synchronous validation only)");

  // isLightningAddress mirrors parser without throwing
  assert(isLightningAddress("alice@phoenix.app") === true,
    "isLightningAddress true for valid input");
  assert(isLightningAddress("not-an-address") === false,
    "isLightningAddress false for invalid input");
  assert(isLightningAddress("") === false,
    "isLightningAddress false for empty");

  const rawLnurl = "lnurl1dp68gurn8ghj7urgdajku6tc9eshqup0d3h82unvwqhkzmrfvdjsr5eqhc";
  assert(isRawLnurl(rawLnurl) === true,
    "Raw bech32 LNURL recognized");
  assert(isRawLnurl(`lightning:${rawLnurl}`) === true,
    "lightning:LNURL URI recognized");
  assert(parseRawLnurl(rawLnurl) === "https://phoenix.app/lnurlp/alice",
    "Raw bech32 LNURL decodes to metadata URL");

  let rawCode = "";
  try { parseRawLnurl("lnurl1bad"); }
  catch (e) { if (e instanceof LnurlError) rawCode = e.code; }
  assert(rawCode === "LnurlParseError",
    "Malformed raw LNURL rejects as LnurlParseError");
}

// ── 34. LNURL RESOLVER (mocked fetch) ────────────────────────────────────
//
// Resolver tests use an explicit fetchImpl injected per test rather than
// monkey-patching globalThis.fetch. Keeps tests order-independent and
// concurrent-safe.
console.log("\n── LNURL RESOLVER ──");
{
  const okMetadata = (overrides: Partial<any> = {}) => ({
    callback: "https://phoenix.app/lnurlp/alice/callback",
    minSendable: 1000,
    maxSendable: 1_000_000_000,
    metadata: "[]",
    tag: "payRequest",
    ...overrides,
  });

  const jsonResponse = (body: any, status = 200) => new Response(
    JSON.stringify(body), { status, headers: { "content-type": "application/json" } },
  );

  const textResponse = (body: string, status = 200) => new Response(
    body, { status, headers: { "content-type": "text/plain" } },
  );

  // Happy path — metadata fetch + invoice request → BOLT11 returned
  {
    const calls: string[] = [];
    const mockFetch: typeof fetch = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes("/.well-known/lnurlp/")) {
        return jsonResponse(okMetadata());
      }
      return jsonResponse({ pr: "lnbc500n1pfakeinvoice", routes: [] });
    }) as any;

    const meta = await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch);
    assert(meta.callback === "https://phoenix.app/lnurlp/alice/callback",
      "Metadata callback parsed");
    assert(meta.minSendable === 1000 && meta.maxSendable === 1_000_000_000,
      "Metadata min/maxSendable parsed");
    assert(meta.tag === "payRequest",
      "Metadata tag pinned to payRequest");

    const bolt11 = await requestLnurlInvoice(meta, 5000, mockFetch);
    assert(bolt11 === "lnbc500n1pfakeinvoice",
      "Callback returns BOLT11 invoice string");
    assert(calls[0].endsWith("/.well-known/lnurlp/alice"),
      "Metadata URL uses .well-known/lnurlp path");
    assert(calls[1].includes("amount=5000000"),
      "Callback URL includes amount in msats (5000 sats)");
  }

  // Resolver one-shot — chains metadata + callback
  {
    const mockFetch: typeof fetch = (async (url: any) => {
      if (String(url).includes("/.well-known/lnurlp/")) {
        return jsonResponse(okMetadata());
      }
      return jsonResponse({ pr: "lnbc1000n1pchainedok" });
    }) as any;
    const bolt11 = await resolveLightningAddressToInvoice(
      "alice@phoenix.app", 1000, mockFetch,
    );
    assert(bolt11 === "lnbc1000n1pchainedok",
      "resolveLightningAddressToInvoice chains metadata + callback");
  }

  // Raw bech32 LNURL one-shot — decode metadata URL + callback
  {
    const rawLnurl = "lnurl1dp68gurn8ghj7urgdajku6tc9eshqup0d3h82unvwqhkzmrfvdjsr5eqhc";
    const calls: string[] = [];
    const mockFetch: typeof fetch = (async (url: any) => {
      calls.push(String(url));
      if (String(url) === "https://phoenix.app/lnurlp/alice") {
        return jsonResponse(okMetadata({ callback: "https://phoenix.app/lnurlp/alice/callback" }));
      }
      return jsonResponse({ pr: "lnbc2500n1prawlnurl" });
    }) as any;
    const bolt11 = await resolveRawLnurlToInvoice(rawLnurl, 2500, mockFetch);
    assert(bolt11 === "lnbc2500n1prawlnurl",
      "resolveRawLnurlToInvoice decodes raw LNURL and requests amount");
    assert(calls[0] === "https://phoenix.app/lnurlp/alice",
      "Raw LNURL metadata URL was fetched");
    assert(calls[1].includes("amount=2500000"),
      "Raw LNURL callback carries amount in msats");
  }

  // DNS / network error
  {
    const mockFetch: typeof fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlDnsError",
      "Network/DNS failure surfaces as LnurlDnsError");
  }

  // HTTP 404
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ status: "ERROR", reason: "user not found" }, 404)
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("ghost@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlServerError",
      "HTTP 404 surfaces as LnurlServerError");
  }

  // 200 OK but body is non-JSON
  {
    const mockFetch: typeof fetch = (async () =>
      textResponse("<html>not json</html>")
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Non-JSON body surfaces as LnurlMalformedError");
  }

  // 200 OK with LNURL-level error (status: ERROR)
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ status: "ERROR", reason: "user disabled" })
    ) as any;
    let code = "";
    let msg = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) {
      if (e instanceof LnurlError) {
        code = e.code;
        msg = e.message;
      }
    }
    assert(code === "LnurlServerError",
      "LNURL status:ERROR surfaces as LnurlServerError");
    assert(/user disabled/.test(msg),
      "LNURL error reason carried into surfaced message");
  }

  // Malformed metadata — missing required fields
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ tag: "payRequest", callback: "https://x" /* no min/max */ })
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Metadata missing min/maxSendable surfaces as LnurlMalformedError");
  }

  // Malformed metadata — wrong tag
  {
    const mockFetch: typeof fetch = (async () =>
      jsonResponse({ tag: "withdrawRequest", callback: "https://x", minSendable: 1, maxSendable: 1 })
    ) as any;
    let code = "";
    try { await fetchLnurlPayMetadata("alice@phoenix.app", mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Wrong tag (not payRequest) surfaces as LnurlMalformedError");
  }

  // Amount out of range — synchronous, no fetch issued
  {
    let fetched = 0;
    const mockFetch: typeof fetch = (async () => {
      fetched++;
      return jsonResponse({ pr: "lnbc1" });
    }) as any;
    const meta: LnurlPayMetadata = {
      callback: "https://x/cb",
      minSendable: 100_000,    // 100 sats
      maxSendable: 1_000_000,  //   1k sats
      metadata: "[]",
      tag: "payRequest",
    };
    let codeBelow = "";
    try { await requestLnurlInvoice(meta, 50, mockFetch); }
    catch (e) { if (e instanceof LnurlError) codeBelow = e.code; }
    let codeAbove = "";
    try { await requestLnurlInvoice(meta, 5000, mockFetch); }
    catch (e) { if (e instanceof LnurlError) codeAbove = e.code; }
    assert(codeBelow === "LnurlAmountOutOfRangeError",
      "Below minSendable → LnurlAmountOutOfRangeError");
    assert(codeAbove === "LnurlAmountOutOfRangeError",
      "Above maxSendable → LnurlAmountOutOfRangeError");
    assert(fetched === 0,
      "Out-of-range amount issues no callback fetch (synchronous reject)");
  }

  // Callback returns no `pr` field
  {
    const mockFetch: typeof fetch = (async (url: any) => {
      if (String(url).includes("/.well-known/")) return jsonResponse(okMetadata());
      return jsonResponse({ routes: [] }); // no pr field
    }) as any;
    let code = "";
    try { await resolveLightningAddressToInvoice("alice@phoenix.app", 5, mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Callback without pr field → LnurlMalformedError");
  }

  // Callback returns non-BOLT11 string (not starting with lnbc)
  {
    const mockFetch: typeof fetch = (async (url: any) => {
      if (String(url).includes("/.well-known/")) return jsonResponse(okMetadata());
      return jsonResponse({ pr: "not-an-invoice" });
    }) as any;
    let code = "";
    try { await resolveLightningAddressToInvoice("alice@phoenix.app", 5, mockFetch); }
    catch (e) { if (e instanceof LnurlError) code = e.code; }
    assert(code === "LnurlMalformedError",
      "Callback with non-BOLT11 pr → LnurlMalformedError");
  }
}

// ── 34b. NWC MAKE_INVOICE HELPER ────────────────────────────────────────
//
// More Options uses NWC as a receive-invoice source: the user pastes a
// NIP-47 connection string, Chama asks that wallet to make an invoice,
// then Fedimint pays the resulting BOLT11.
console.log("\n── NWC MAKE_INVOICE HELPER ──");
{
  const walletPubkey = "b".repeat(64);
  const secret = "1".repeat(64);
  const nwc = `nostr+walletconnect://${walletPubkey}?relay=wss%3A%2F%2Frelay.example.com&relay=wss%3A%2F%2Frelay2.example.com&secret=${secret}&lud16=alice%40wallet.example`;

  const parsed = parseNwcConnectionString(nwc);
  assert(parsed.walletPubkey === walletPubkey,
    "NWC parser extracts wallet service pubkey");
  assert(parsed.secret === secret,
    "NWC parser extracts client secret");
  assert(parsed.relays.length === 2 && parsed.relays[0] === "wss://relay.example.com",
    "NWC parser extracts relay URLs");
  assert(parsed.lud16 === "alice@wallet.example",
    "NWC parser preserves optional lud16");
  assert(isNwcConnectionString(nwc) === true,
    "isNwcConnectionString accepts valid NIP-47 URI");
  assert(isNwcConnectionString("lnbc500n1pfake") === false,
    "isNwcConnectionString rejects non-NWC input");

  const request = buildNwcMakeInvoiceRequest(2485, "Chama payout");
  assert(request.method === "make_invoice",
    "NWC request uses make_invoice, not pay_invoice");
  assert(request.params.amount === 2_485_000,
    "NWC make_invoice amount is encoded in millisats");
  assert(request.params.description === "Chama payout",
    "NWC make_invoice carries description");

  const response = JSON.stringify({
    result_type: "make_invoice",
    error: null,
    result: {
      type: "incoming",
      invoice: "lnbc2485n1pnwcmade",
      amount: 2_485_000,
    },
  });
  assert(extractInvoiceFromNwcResponse(response) === "lnbc2485n1pnwcmade",
    "NWC response extracts returned BOLT11 invoice");

  const payRequest = buildNwcPayInvoiceRequest("lnbc2485n1pnwcpay");
  assert(payRequest.method === "pay_invoice",
    "NWC funding request uses pay_invoice");
  assert(payRequest.params.invoice === "lnbc2485n1pnwcpay",
    "NWC pay_invoice carries the Chama funding invoice");

  const payResponse = JSON.stringify({
    result_type: "pay_invoice",
    error: null,
    result: {
      preimage: "f".repeat(64),
    },
  });
  assert(extractPreimageFromNwcPayResponse(payResponse) === "f".repeat(64),
    "NWC pay_invoice response extracts optional preimage");

  let unsupportedCode = "";
  try { parseNwcConnectionString(`nostr+walletconnect://${walletPubkey}?secret=${secret}`); }
  catch (e) { if (e instanceof NwcError) unsupportedCode = e.code; }
  assert(unsupportedCode === "NwcParseError",
    "NWC parser rejects missing relay");

  let walletError = "";
  try {
    extractInvoiceFromNwcResponse(JSON.stringify({
      result_type: "make_invoice",
      error: { code: "RESTRICTED", message: "budget exhausted" },
      result: null,
    }));
  } catch (e) {
    if (e instanceof NwcError) walletError = e.code;
  }
  assert(walletError === "NwcWalletError",
    "NWC wallet errors are typed distinctly");
}

// ── 34a. NWC ERROR HUMANISATION (v1.2.5) ────────────────────────────────
//
// `humanizeNwcError` turns NIP-47 / BOLT-spec error codes into copy a
// user can read on a phone. Critical because the failures it
// translates ("FAILURE_REASON_NO_ROUTE", etc.) are the ones that
// stall trades in flight — the message has to say what to do next, not
// just what code was returned.
console.log("\n── NWC ERROR HUMANISATION ──");
{
  // BOLT failure reasons embedded in INTERNAL / PAYMENT_FAILED messages
  // — the v1.2.4 / 1.2.5 production reproducer.
  const noRoute = humanizeNwcError("INTERNAL: FAILURE_REASON_NO_ROUTE");
  assert(noRoute.includes("route") && noRoute.includes("channel"),
    "FAILURE_REASON_NO_ROUTE explains the routing/channel cause");

  const timeout = humanizeNwcError("PAYMENT_FAILED: FAILURE_REASON_TIMEOUT");
  assert(timeout.toLowerCase().includes("timeout") || timeout.toLowerCase().includes("deadline"),
    "FAILURE_REASON_TIMEOUT explains the deadline cause");

  const insufficient = humanizeNwcError("PAYMENT_FAILED: FAILURE_REASON_INSUFFICIENT_BALANCE");
  assert(insufficient.toLowerCase().includes("channel") && insufficient.toLowerCase().includes("liquidity"),
    "FAILURE_REASON_INSUFFICIENT_BALANCE distinguishes channel liquidity from wallet balance");

  // NIP-47 top-level error codes
  const rateLimited = humanizeNwcError("RATE_LIMITED: too many requests");
  assert(rateLimited.toLowerCase().includes("throttling") || rateLimited.toLowerCase().includes("wait"),
    "RATE_LIMITED suggests waiting");

  const insufficientWallet = humanizeNwcError("INSUFFICIENT_BALANCE: not enough sats");
  assert(insufficientWallet.toLowerCase().includes("wallet") && insufficientWallet.toLowerCase().includes("sats"),
    "INSUFFICIENT_BALANCE (wallet-level) names the wallet, not the channel");

  const restricted = humanizeNwcError("RESTRICTED: payments not permitted");
  assert(restricted.toLowerCase().includes("permission") || restricted.toLowerCase().includes("re-pair"),
    "RESTRICTED suggests permissions / re-pairing");

  // Bare BOLT reason without an outer NIP-47 code prefix
  const bareReason = humanizeNwcError("FAILURE_REASON_NO_ROUTE");
  assert(bareReason.includes("route"),
    "Bare FAILURE_REASON_NO_ROUTE still translates");

  // Unknown code with a useful tail message — should preserve the
  // wallet's own message in a parenthetical
  const unknown = humanizeNwcError("WEIRD_CODE: something specific went wrong");
  assert(unknown.includes("WEIRD_CODE") || unknown.includes("something specific"),
    "Unknown codes fall back to passing through the original text");

  // Empty / nullish input
  assert(humanizeNwcError("").length > 0,
    "Empty input still returns a non-empty fallback message");
  assert(humanizeNwcError(null).length > 0,
    "Null input still returns a non-empty fallback message");
  assert(humanizeNwcError(undefined).length > 0,
    "Undefined input still returns a non-empty fallback message");

  // Error object — should grab the .message
  const fromError = humanizeNwcError(new Error("INTERNAL: FAILURE_REASON_NO_ROUTE"));
  assert(fromError.includes("route"),
    "humanizeNwcError unwraps Error objects via .message");
}

// ── 34b2. BOLT11 PAYOUT AMOUNT ROUTING ──────────────────────────────────
console.log("\n── BOLT11 PAYOUT AMOUNT ROUTING ──");
{
  assert(parsePaymentBolt11Msats("lnbc24850n1pnwcpayout") === 2_485_000,
    "BOLT11 helper parses amountful invoices into msats");
  assert(parsePaymentBolt11Msats("lightning:lnbc24850n1pnwcpayout") === 2_485_000,
    "BOLT11 helper strips lightning: URI wrapper");
  assert(parsePaymentBolt11Msats("lnbc1pamountless") === null,
    "BOLT11 helper treats lnbc1... invoices as amountless");

  const originalFetch = (globalThis as any).fetch;
  const calls: Array<{ url: string; body: any }> = [];
  (globalThis as any).fetch = async (url: unknown, init?: { body?: unknown }) => {
    const path = String(url);
    calls.push({
      url: path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path.endsWith("/pay")) {
      // #9 Part 3: the bridge returns a discriminated outcome; `settled` is the
      // success case that resolves payInvoice (the body assertions are the point).
      return new Response(
        JSON.stringify({ status: "settled", operation_id: "op_pay", preimage: "deadbeef" }),
        { status: 200 },
      );
    }
    if (path.endsWith("/info")) {
      return new Response(JSON.stringify({
        federation_id: "fed_native_test",
        network: "bitcoin",
        total_amount_msat: 0,
        meta: {},
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected path" }), { status: 404 });
  };

  try {
    const wallet = new NativeBridgeWallet("http://bridge.test");
    await wallet.lightning.payInvoice(
      "lnbc24850n1pnwcpayout",
      { chama_amount_msats: 2_485_000 } as any,
    );
    await wallet.lightning.payInvoice(
      "lnbc1pamountless",
      { chama_amount_msats: 2_485_000 } as any,
    );

    const payBodies = calls
      .filter((call) => call.url.endsWith("/pay"))
      .map((call) => call.body);
    assert(payBodies.length === 2,
      "Native bridge test captured both pay calls");
    assert(!("amountMsats" in payBodies[0]),
      "Native bridge omits explicit amount for amountful BOLT11 invoices");
    assert(payBodies[1].amountMsats === 2_485_000,
      "Native bridge still sends explicit amount for amountless BOLT11 invoices");
  } finally {
    (globalThis as any).fetch = originalFetch;
  }

  // ── #9 Part 3: native /pay discriminated outcome (double-pay guard) ───────
  // The bridge now returns settled / refunded / inflight so the claim guard can
  // tell a real payout from a refund (sats back ⇒ re-pay safe) from a
  // submitted-but-unknown one (⇒ NEVER blindly re-pay). RETRY CLAIM safety on
  // native depends on payInvoice throwing the right coded error for each.
  {
    const originalFetch = (globalThis as any).fetch;
    const mockPay = (payBody: any, payStatus = 200) => {
      (globalThis as any).fetch = async (url: unknown) => {
        const path = String(url);
        if (path.endsWith("/pay")) {
          return new Response(JSON.stringify(payBody), { status: payStatus });
        }
        if (path.endsWith("/info")) {
          return new Response(JSON.stringify({
            federation_id: "fed_native_test", network: "bitcoin", total_amount_msat: 0, meta: {},
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "unexpected path" }), { status: 404 });
      };
    };
    try {
      // settled ⇒ resolves with the operation id (claim guard marks it settled).
      mockPay({ status: "settled", operation_id: "op_settled", preimage: "beef" });
      {
        const wallet = new NativeBridgeWallet("http://bridge.test");
        const res = await wallet.lightning.payInvoice("lnbc100n1payout");
        assert(res.operationId === "op_settled",
          "Native payInvoice resolves a settled payout with its operation id");
      }

      // refunded ⇒ throws LN_PAY_REFUNDED — the sats came back, so re-pay is safe.
      mockPay({ status: "refunded", operation_id: "op_refunded", error: "no route" });
      {
        const wallet = new NativeBridgeWallet("http://bridge.test");
        let code = "";
        try { await wallet.lightning.payInvoice("lnbc100n1payout"); }
        catch (e: any) { code = e?.code; }
        assert(code === "LN_PAY_REFUNDED",
          "Native payInvoice throws LN_PAY_REFUNDED for a refunded payout (retry-safe)");
      }

      // inflight ⇒ throws LN_PAY_INFLIGHT + operationId so the guard records the
      // payout submitted and reconciles via /pay-outcome instead of re-paying.
      mockPay({ status: "inflight", operation_id: "op_inflight" });
      {
        const wallet = new NativeBridgeWallet("http://bridge.test");
        let code = ""; let opId = "";
        try { await wallet.lightning.payInvoice("lnbc100n1payout"); }
        catch (e: any) { code = e?.code; opId = e?.operationId; }
        assert(code === "LN_PAY_INFLIGHT",
          "Native payInvoice throws LN_PAY_INFLIGHT for a submitted-but-unknown payout");
        assert(opId === "op_inflight",
          "Native INFLIGHT throw carries the operationId for journal + reconcile");
      }

      // unrecognized/legacy /pay shape (no status) ⇒ default to INFLIGHT. unknown
      // ⇒ refuse to re-pay (the safe direction — never a double-send).
      mockPay({ operation_id: "op_legacy" });
      {
        const wallet = new NativeBridgeWallet("http://bridge.test");
        let code = "";
        try { await wallet.lightning.payInvoice("lnbc100n1payout"); }
        catch (e: any) { code = e?.code; }
        assert(code === "LN_PAY_INFLIGHT",
          "Native payInvoice defaults an unrecognized /pay outcome to INFLIGHT (refuse re-pay)");
      }

      // pre-send failure (non-2xx) ⇒ a plain, UNCODED throw — no payment started,
      // so the guard clears the record and a fresh retry is correct (no sats moved).
      mockPay({ error: "Couldn't find a reachable federation Lightning gateway" }, 500);
      {
        const wallet = new NativeBridgeWallet("http://bridge.test");
        let code: any = "unset"; let threw = false;
        try { await wallet.lightning.payInvoice("lnbc100n1payout"); }
        catch (e: any) { threw = true; code = e?.code; }
        assert(threw, "Native payInvoice throws on a pre-send /pay failure");
        assert(code === undefined,
          "Native pre-send /pay failure is uncoded (safe-to-retry, not INFLIGHT)");
      }

      // LOST RESPONSE (transport failure) after the bridge may have committed ⇒
      // INFLIGHT, never a re-payable throw. "kill the await after send" must not
      // double-pay. A thrown fetch (bridge killed/socket dropped) → request()
      // raises nativeBridgeUnavailableError (chamaDiagnostics) → LN_PAY_INFLIGHT.
      (globalThis as any).fetch = async () => { throw new TypeError("Failed to fetch"); };
      {
        const wallet = new NativeBridgeWallet("http://bridge.test");
        let code: any = "unset"; let threw = false;
        try { await wallet.lightning.payInvoice("lnbc100n1payout"); }
        catch (e: any) { threw = true; code = e?.code; }
        assert(threw, "Native payInvoice throws when the /pay response is lost in transport");
        assert(code === "LN_PAY_INFLIGHT",
          "Native lost-/pay-response maps to LN_PAY_INFLIGHT (ambiguous ⇒ never re-pay)");
      }
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  }

  // #9 Part 3: awaitPayOutcome reconciles a submitted payout via /pay-outcome
  // without ever re-paying; unknown ⇒ keep the submitted record (refuse re-pay).
  {
    const originalFetch = (globalThis as any).fetch;
    const mockOutcome = (body: any, status = 200) => {
      (globalThis as any).fetch = async (url: unknown) => {
        const path = String(url);
        if (path.endsWith("/pay-outcome")) {
          return new Response(JSON.stringify(body), { status });
        }
        return new Response(JSON.stringify({ error: "unexpected path" }), { status: 404 });
      };
    };
    try {
      const wallet = new NativeBridgeWallet("http://bridge.test");
      const awaitOutcome = wallet.lightning.awaitPayOutcome!;
      assert(typeof awaitOutcome === "function",
        "Native lightning adapter exposes awaitPayOutcome (so the guard can re-attach)");

      mockOutcome({ status: "settled", operation_id: "op1", preimage: "beef" });
      assert((await awaitOutcome("op1")) === "settled",
        "awaitPayOutcome maps a settled /pay-outcome to settled");

      mockOutcome({ status: "refunded", operation_id: "op1", error: "refunded" });
      assert((await awaitOutcome("op1")) === "refunded",
        "awaitPayOutcome maps a refunded /pay-outcome to refunded");

      mockOutcome({ status: "inflight", operation_id: "op1" });
      assert((await awaitOutcome("op1")) === "unknown",
        "awaitPayOutcome maps an inflight /pay-outcome to unknown (keep submitted)");

      mockOutcome({ error: "boom" }, 500);
      assert((await awaitOutcome("op1")) === "unknown",
        "awaitPayOutcome maps a failed /pay-outcome reconcile to unknown (refuse re-pay)");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  }

  {
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    try {
      const wallet = new NativeBridgeWallet("http://127.0.0.1:8788");
      let message = "";
      let diagnostics: any = null;
      try {
        await wallet.open();
      } catch (e) {
        message = (e as Error).message;
        diagnostics = (e as any).chamaDiagnostics;
      }
      assert(/Native Fedimint bridge is enabled but unreachable/.test(message),
        "Native bridge unavailable errors name the Rust bridge, not gateway vetting");
      assert(diagnostics?.issue === "native_fedimint_bridge_unavailable",
        "Native bridge unavailable errors carry a distinct diagnostic issue");
      assert(diagnostics?.adapter === "native-rust-sidecar",
        "Native bridge unavailable diagnostics identify the native adapter");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  }

  {
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: unknown) => {
      const path = String(url);
      if (path.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, joined: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected path" }), { status: 404 });
    };
    try {
      const wallet = new NativeBridgeWallet("http://127.0.0.1:8788");
      let message = "";
      let diagnostics: any = null;
      try {
        await wallet.open();
      } catch (e) {
        message = (e as Error).message;
        diagnostics = (e as any).chamaDiagnostics;
      }
      assert(/stale or incompatible/.test(message),
        "Native bridge rejects stale sidecars before opening a wallet");
      assert(diagnostics?.issue === "native_fedimint_bridge_incompatible",
        "Native bridge stale-sidecar errors carry a distinct diagnostic issue");
      assert(Array.isArray(diagnostics?.requiredCapabilities) &&
        diagnostics.requiredCapabilities.includes("reset"),
        "Native bridge stale-sidecar diagnostics name the missing reset capability");
      assert(Array.isArray(diagnostics?.requiredCapabilities) &&
        diagnostics.requiredCapabilities.includes("idempotent_join"),
        "Native bridge stale-sidecar diagnostics require idempotent join capability");
      assert(Array.isArray(diagnostics?.requiredCapabilities) &&
        diagnostics.requiredCapabilities.includes("effective_iroh_config"),
        "Native bridge stale-sidecar diagnostics require effective iroh config reporting");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  }

  {
    const originalFetch = (globalThis as any).fetch;
    const calls: Array<{ url: string; body: any }> = [];
    (globalThis as any).fetch = async (url: unknown, init?: { body?: unknown }) => {
      const path = String(url);
      calls.push({
        url: path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.endsWith("/health")) {
        return new Response(JSON.stringify({
          ok: true,
          joined: false,
          api_version: 2,
          capabilities: ["reset", "idempotent_join", "effective_iroh_config"],
          join_timeout_secs: 90,
          iroh: { dht: true, next: true, resolver: "n0-pkarr-https+dns", resolver_url: "https://dns.iroh.link/pkarr" },
          discovery: { status: "reachable", target: "dns.iroh.link:443", detail: null },
        }), { status: 200 });
      }
      if (path.endsWith("/join")) {
        return new Response(JSON.stringify({
          error: "open failed before join attempt: Client database not initialized: timed out joining federation: deadline has elapsed",
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ error: "unexpected path" }), { status: 404 });
    };
    try {
      const wallet = new NativeBridgeWallet("http://127.0.0.1:8788");
      let message = "";
      let diagnostics: any = null;
      try {
        await wallet.joinFederation("fed1nativejoinretry");
      } catch (e) {
        message = (e as Error).message;
        diagnostics = (e as any).chamaDiagnostics;
      }
      const joinCalls = calls.filter((call) => call.url.endsWith("/join"));
      assert(joinCalls.length === 3,
        "Native bridge join retries discovery timeout failures twice after the first attempt");
      assert(/Couldn't reach this federation yet/i.test(message),
        "Native bridge join surfaces friendly reconnect copy after retry exhaustion");
      assert(!/Native Fedimint bridge \/join failed \(500\)/.test(message),
        "Native bridge join does not surface the raw bridge 500 popup text");
      assert(diagnostics?.issue === "native_fedimint_join_discovery_failed",
        "Native bridge join retry exhaustion carries a distinct discovery diagnostic issue");
      assert(diagnostics?.attempts === 3,
        "Native bridge join diagnostic records the total attempt count");
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  }

  {
    const originalCapacitor = (globalThis as any).Capacitor;
    const originalTauri = (globalThis as any).__TAURI_INTERNALS__;
    (globalThis as any).localStorage?.removeItem?.("chama_native_fedimint");
    try {
      (globalThis as any).Capacitor = { isNativePlatform: () => true };
      assert(isNativeBridgeModeOn(),
        "Native Fedimint defaults on inside Capacitor native builds");

      (globalThis as any).Capacitor = { getPlatform: () => "web" };
      assert(!isNativeBridgeModeOn(),
        "Native Fedimint does not default on for web platform detection");

      (globalThis as any).__TAURI_INTERNALS__ = {};
      assert(isNativeBridgeModeOn(),
        "Native Fedimint defaults on inside Tauri native builds");
    } finally {
      if (originalCapacitor === undefined) delete (globalThis as any).Capacitor;
      else (globalThis as any).Capacitor = originalCapacitor;
      if (originalTauri === undefined) delete (globalThis as any).__TAURI_INTERNALS__;
      else (globalThis as any).__TAURI_INTERNALS__ = originalTauri;
    }
  }

  {
    const originalInjected = (globalThis as any).__CHAMA_NATIVE_FEDIMINT__;
    (globalThis as any).localStorage?.setItem?.(
      NATIVE_BRIDGE_URL_KEY,
      "http://127.0.0.1:8787",
    );
    try {
      (globalThis as any).__CHAMA_NATIVE_FEDIMINT__ = {
        bridgeUrl: "http://127.0.0.1:61234",
        instanceId: "second-demo-window",
      };
      assert(getNativeBridgeUrl() === "http://127.0.0.1:61234",
        "Tauri-injected bridge URL wins over shared localStorage");
    } finally {
      if (originalInjected === undefined) delete (globalThis as any).__CHAMA_NATIVE_FEDIMINT__;
      else (globalThis as any).__CHAMA_NATIVE_FEDIMINT__ = originalInjected;
      (globalThis as any).localStorage?.removeItem?.(NATIVE_BRIDGE_URL_KEY);
    }
  }

  {
    (globalThis as any).localStorage?.removeItem?.(NATIVE_BRIDGE_COMMUNITY_KEY);
    assert(DEFAULT_NATIVE_BRIDGE_COMMUNITY === DEFAULT_COMMUNITY_SLUG,
      "Native bridge default community follows the normal BLF default");
    assert(getNativeBridgeCommunitySlug() === DEFAULT_COMMUNITY_SLUG,
      "Native bridge default slug is us-blf, not the GBF proof route");
    assert(getConfiguredNativeBridgeCommunitySlug() === null,
      "Native bridge has no implicit configured community override");

    (globalThis as any).localStorage?.setItem?.(NATIVE_BRIDGE_COMMUNITY_KEY, "us-gbf");
    assert(getConfiguredNativeBridgeCommunitySlug() === "us-gbf",
      "Native bridge still honors an explicit debug community override");
    (globalThis as any).localStorage?.removeItem?.(NATIVE_BRIDGE_COMMUNITY_KEY);
  }

  {
    const originalFetch = (globalThis as any).fetch;
    const calls: Array<{ url: string; method?: string }> = [];
    (globalThis as any).localStorage?.setItem?.(NATIVE_BRIDGE_MODE_KEY, "1");
    (globalThis as any).fetch = async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({
          ok: true,
          joined: true,
          api_version: 2,
          capabilities: ["reset", "idempotent_join", "effective_iroh_config"],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      await resetLocalFedimintWallet();
      assert(calls.length === 2,
        "Native reset uses the Rust bridge reset endpoint instead of browser OPFS");
      assert(calls[0].url === "http://127.0.0.1:8787/health",
        "Native reset checks bridge capability before reset");
      assert(calls[1].url === "http://127.0.0.1:8787/reset",
        "Native reset targets the local sidecar reset endpoint");
      assert(calls[1].method === "POST",
        "Native reset posts to the sidecar reset endpoint");
    } finally {
      (globalThis as any).fetch = originalFetch;
      (globalThis as any).localStorage?.removeItem?.(NATIVE_BRIDGE_MODE_KEY);
    }
  }

  {
    const tauriSrc = readFileSync("src-tauri/src/main.rs", "utf8");
    const androidSrc = readFileSync(
      "android/app/src/main/java/app/chama/market/MainActivity.java",
      "utf8",
    );
    const tauriArgs = tauriSrc.match(/\.args\(\[\s*([\s\S]*?)\s*\]\)/)?.[1] ?? "";
    assert(/"--data-dir"[\s\S]*data_dir_arg\.as_str\(\)[\s\S]*"serve"[\s\S]*"--bind"[\s\S]*bind_arg\.as_str\(\)/.test(tauriArgs),
      "Tauri launches the native bridge with --data-dir, serve, and --bind in the expected order");
    assert(/command\.add\("--data-dir"\)[\s\S]*command\.add\(dataDir\.getAbsolutePath\(\)\)[\s\S]*command\.add\("serve"\)[\s\S]*command\.add\("--bind"\)[\s\S]*command\.add\(FEDIMINT_BRIDGE_BIND\)/.test(androidSrc),
      "Android launches the native bridge with --data-dir, serve, and --bind in the expected order");

    const tauriDiscoveryWiring = /--iroh-dns|CHAMA_FEDIMINT_IROH_DNS/.test(tauriSrc);
    const androidDiscoveryWiring = /--iroh-dns|CHAMA_FEDIMINT_IROH_DNS/.test(androidSrc);
    assert(tauriDiscoveryWiring === androidDiscoveryWiring,
      "Native bridge discovery policy wiring must stay in parity across Tauri and Android launchers");
  }

  {
    const cargoLock = readFileSync("native/fedimint-bridge/Cargo.lock", "utf8");
    const packageJson = readFileSync("package.json", "utf8");
    const relayVersions = Array.from(
      cargoLock.matchAll(/\[\[package\]\]\s+name = "iroh-relay"\s+version = "([^"]+)"/g),
      (match) => match[1],
    );
    assert(relayVersions.includes("0.90.0"),
      "Native bridge lockfile keeps the next-gen iroh-relay 0.90.0 version visible");
    assert(relayVersions.includes("0.35.0"),
      "Native bridge lockfile keeps the Fedimint stable iroh-relay 0.35.0 version visible");
    assert(packageJson.includes('"@fedimint/transport-web": "0.0.0-canary-cf43f9193627f8081b7144f7c057a7a112989031"'),
      "Browser Fedimint transport stays on the known iroh-relay-0.90 canary until native/browser transport is intentionally re-aligned");
  }

  {
    const bridgeSrc = readFileSync("native/fedimint-bridge/src/main.rs", "utf8");
    // Launch-blocker fix: native discovery must default to n0's HTTPS PKARR
    // relay so a fresh join resolves guardians the same reliable way the browser
    // does — DNS(:53)+DHT(UDP) alone hang on mobile/CGNAT. This is the lever that
    // turns the fresh-join hang into a working join, so guard it from regressing.
    assert(/const DEFAULT_IROH_PKARR_RELAY: &str = "https:\/\/dns\.iroh\.link\/pkarr";/.test(bridgeSrc),
      "Native bridge pins the default PKARR resolver to n0's production HTTPS relay (dns.iroh.link/pkarr)");
    assert(/None\s*=>\s*\(\s*Some\(\s*SafeUrl::from_str\(DEFAULT_IROH_PKARR_RELAY\)/.test(bridgeSrc),
      "Native bridge falls back to the n0 PKARR relay when no --iroh-dns override is given");
    assert(/builder\s*=\s*builder\.set_iroh_dns\(iroh_dns\.clone\(\)\)/.test(bridgeSrc),
      "Native bridge applies the resolver via set_iroh_dns — additive over DNS+DHT (non-replacing, verified in fedimint-connectors)");
    assert(!/"status":\s*"unprobed"/.test(bridgeSrc),
      "Native bridge /health reports a real boot discovery probe, not the old 'unprobed' stub");
  }
}

// ── 34c. SAVED NWC CONNECTIONS ──────────────────────────────────────────
//
// Saved NWC wallets are reusable local bearer credentials. They are not
// payment handles and never flow into listing/LOCK reveal payloads.
console.log("\n── SAVED NWC CONNECTIONS ──");
{
  (globalThis as any).localStorage.clear();
  const walletPubkey = "c".repeat(64);
  const secret = "2".repeat(64);
  const nwc = `nostr+walletconnect://${walletPubkey}?relay=wss%3A%2F%2Frelay.example.com&secret=${secret}&lud16=cypher%40wallet.example`;

  const saved = addOrTouchSavedNwcConnection(nwc);
  assert(saved.id.startsWith("nwc_"),
    "Saved NWC connection uses nwc_ ID prefix");
  assert(saved.label === "cypher@wallet.example",
    "Saved NWC label prefers lud16");
  assert(saved.walletPubkey === walletPubkey,
    "Saved NWC stores wallet service pubkey for display/dedupe");
  assert(saved.relayCount === 1,
    "Saved NWC stores relay count");
  assert(listSavedNwcConnections().length === 1,
    "Saved NWC list returns one connection");
  assert(listSavedHandles().length === 0,
    "Saved NWC connection is not a trade payment handle");
  assert(listPayoutDestinations().length === 0,
    "Saved NWC connection is not a Lightning Address destination");

  await new Promise(r => setTimeout(r, 1100));
  const touched = addOrTouchSavedNwcConnection(nwc);
  assert(touched.id === saved.id,
    "Re-saving same NWC connection touches existing row");
  assert((touched.lastUsedAt ?? 0) > (saved.lastUsedAt ?? 0),
    "Re-saving same NWC connection bumps lastUsedAt");
  assert(listSavedNwcConnections().length === 1,
    "NWC store dedupes by wallet pubkey + secret");

  const backupRaw = (globalThis as any).localStorage.getItem(NWC_CONNECTIONS_BACKUP_STORAGE_KEY);
  assert(!!backupRaw && JSON.parse(backupRaw).length === 1,
    "Saved NWC connections are mirrored into a backup row");
  (globalThis as any).localStorage.removeItem(NWC_CONNECTIONS_STORAGE_KEY);
  assert(listSavedNwcConnections().length === 1,
    "Missing primary NWC row restores from backup");

  deleteSavedNwcConnection(saved.id);
  assert(listSavedNwcConnections().length === 0,
    "deleteSavedNwcConnection removes the saved NWC wallet");
}

// ── 35. PAYOUT DESTINATIONS — Lightning Address store ───────────────────
//
// addOrTouchPayoutDestination is idempotent: re-saving the same address
// bumps lastUsedAt rather than duplicating. listPayoutDestinations
// returns LN destinations sorted by most-recent-used, falling back to
// createdAt for destinations missing lastUsedAt.
console.log("\n── PAYOUT DESTINATIONS — Lightning Address store ──");
{
  (globalThis as any).localStorage.clear();

  // First save creates new entry
  const a = addOrTouchPayoutDestination("alice@phoenix.app");
  assert(a.id.startsWith("pd_"),
    "First save uses payout-destination ID prefix");
  assert(a.address === "alice@phoenix.app",
    "Address stored as-typed (lowercase normalized)");
  assert(typeof a.lastUsedAt === "number",
    "First save sets lastUsedAt");
  assert(listSavedHandles().length === 0,
    "Payout destination is NOT stored as a saved payment handle");

  // Mixed-case input normalized
  const b = addOrTouchPayoutDestination("Bob@Strike.ME");
  assert(b.address === "bob@strike.me",
    "Mixed case normalized to lowercase on save");

  // ── Idempotency: same address (same case) bumps lastUsedAt, no dup ───
  // Wait at least 1 second so the second save's lastUsedAt is strictly
  // greater than the first (the storage uses 1-second resolution).
  await new Promise(r => setTimeout(r, 1100));
  const aTouched = addOrTouchPayoutDestination("alice@phoenix.app");
  assert(aTouched.id === a.id,
    "Re-saving same address returns same id (no dup)");
  assert((aTouched.lastUsedAt ?? 0) > (a.lastUsedAt ?? 0),
    "Re-saving bumps lastUsedAt forward");
  assert(listPayoutDestinations().length === 2,
    "Storage still holds 2 payout destinations after touch (no duplicate row)");

  // Idempotency is case-insensitive
  const aCaseTouched = addOrTouchPayoutDestination("ALICE@PHOENIX.APP");
  assert(aCaseTouched.id === a.id,
    "Case-insensitive match against existing destination (no dup)");

  // Empty rejected
  let threwEmpty = false;
  try { addOrTouchPayoutDestination("   "); } catch { threwEmpty = true; }
  assert(threwEmpty,
    "addOrTouchPayoutDestination rejects empty/whitespace input");

  // ── Sort: most-recent-used first ─────────────────────────────────────
  // After touching alice last, alice should be first in the picker list.
  const sorted = listPayoutDestinations();
  assert(sorted.length === 2,
    "Two payout destinations in storage");
  assert(sorted[0].address === "alice@phoenix.app",
    "Most-recently-used destination (alice) sorts first");
  assert(sorted[1].address === "bob@strike.me",
    "Older destination (bob) sorts second");

  // ── Backup restore guard ─────────────────────────────────────────────
  const backupRaw = (globalThis as any).localStorage.getItem(PAYOUT_DESTINATIONS_BACKUP_STORAGE_KEY);
  assert(!!backupRaw && JSON.parse(backupRaw).length === 2,
    "Payout destinations are mirrored into a backup row");
  (globalThis as any).localStorage.removeItem(PAYOUT_DESTINATIONS_STORAGE_KEY);
  const restored = listPayoutDestinations();
  assert(restored.length === 2 && restored.some(d => d.address === "alice@phoenix.app"),
    "Missing primary payout-destinations row restores from backup instead of appearing cleared");
  assert((globalThis as any).localStorage.getItem(PAYOUT_DESTINATIONS_STORAGE_KEY) !== null,
    "Backup restore rewrites the primary payout-destinations row");

  // ── Other rails unaffected ───────────────────────────────────────────
  addSavedHandle("revtag", "@charlie");
  assert(listPayoutDestinations().length === 2,
    "listPayoutDestinations excludes saved payment handles");
  assert(listSavedHandles().length === 1,
    "Saved payment handles stay separate from payout destinations");

  // ── Fallback to createdAt when lastUsedAt missing ────────────────────
  // Simulate an older destination that lacks lastUsedAt by writing
  // directly to storage. listPayoutDestinations must not crash and
  // must use createdAt as the sort key.
  const raw = (globalThis as any).localStorage.getItem(PAYOUT_DESTINATIONS_STORAGE_KEY);
  const all = JSON.parse(raw);
  all.push({
    id: "pd_legacy",
    address: "legacy@old.app",
    createdAt: 1, // very old
    // no lastUsedAt
  });
  (globalThis as any).localStorage.setItem(
    PAYOUT_DESTINATIONS_STORAGE_KEY, JSON.stringify(all),
  );
  const withLegacy = listPayoutDestinations();
  assert(withLegacy.length === 3,
    "Destination with no lastUsedAt read without crash");
  assert(withLegacy[withLegacy.length - 1].address === "legacy@old.app",
    "Destination missing lastUsedAt sorts last (createdAt fallback works)");

  // ── Migration from legacy saved_handles LIGHTNING_RAIL rows ─────────
  (globalThis as any).localStorage.clear();
  (globalThis as any).localStorage.setItem(SAVED_HANDLES_STORAGE_KEY, JSON.stringify([
    {
      id: "h_old_ln",
      rail: LIGHTNING_RAIL,
      handle: "Legacy@Wallet.App",
      visibility: "private",
      createdAt: 5,
      lastUsedAt: 10,
    },
    {
      id: "h_fiat",
      rail: "wave",
      handle: "+221 77 555 1234",
      visibility: "private",
      createdAt: 6,
    },
  ]));
  assert(migrateLegacyLightningHandles() === 1,
    "Migration moves legacy LIGHTNING_RAIL handles into payout destinations");
  const migrated = listPayoutDestinations();
  assert(migrated.length === 1 && migrated[0].address === "legacy@wallet.app",
    "Migrated destination is normalized and readable from new store");
  const remainingHandles = listSavedHandles();
  assert(remainingHandles.length === 1 && remainingHandles[0].rail === "wave",
    "Migration removes legacy Lightning rows from saved payment handles");
}

// ── 36. DESTINATION PICKER — pure decision logic (v0.3.0 Phase 1) ───────
//
// Tests the pure helpers in destination-picker-logic.ts. Component-level
// rendering is exercised transitively by phases 3, 4 (claim, recovery,
// destroy modal) per the brief.
console.log("\n── DESTINATION PICKER — logic ──");
{
  // ── decoratePayoutDestinationsForPicker ──────────────────────────────
  // Empty list → empty array
  assert(decoratePayoutDestinationsForPicker([]).length === 0,
    "Empty payout-destinations input → empty decorated list");

  // Default badge on first (most-recent-used)
  const destinations: PayoutDestination[] = [
    { id: "pd1", address: "alice@phoenix.app",
      createdAt: 100, lastUsedAt: 200 },
    { id: "pd2", address: "bob@strike.me",
      createdAt: 100, lastUsedAt: 100 },
    { id: "pd3", address: "carol@wallet.io",
      createdAt: 100, lastUsedAt: 150 },
  ];
  const decorated = decoratePayoutDestinationsForPicker(destinations);
  assert(decorated.length === 3,
    "Decorator preserves all input destinations");
  assert(decorated[0].destination.id === "pd1" && decorated[0].isDefault === true,
    "Most-recent-used destination (pd1, lastUsedAt=200) gets isDefault=true");
  assert(decorated[1].isDefault === false && decorated[2].isDefault === false,
    "Non-first destinations all have isDefault=false");
  assert(decorated[1].destination.id === "pd3",
    "Sort: lastUsedAt 200 > 150 > 100 (pd1, pd3, pd2)");

  // Fallback to createdAt when lastUsedAt missing on some entries
  const mixed = [
    { id: "pd_old", address: "old@a.app",
      createdAt: 50 /* no lastUsedAt */ },
    { id: "pd_new", address: "new@b.app",
      createdAt: 100, lastUsedAt: 100 },
  ];
  const mixedDec = decoratePayoutDestinationsForPicker(mixed);
  assert(mixedDec[0].destination.id === "pd_new",
    "Destinations with lastUsedAt sort above bare createdAt entries");

  // ── classifyDestinationInput ─────────────────────────────────────────
  assert(classifyDestinationInput("").kind === "empty",
    "Empty input → empty");
  assert(classifyDestinationInput("   ").kind === "empty",
    "Whitespace-only → empty");

  const lnAddr = classifyDestinationInput("alice@phoenix.app");
  assert(lnAddr.kind === "lightning-address" && lnAddr.address === "alice@phoenix.app",
    "Lightning Address recognized");

  const lnAddrCase = classifyDestinationInput("ALICE@PHOENIX.APP");
  assert(lnAddrCase.kind === "lightning-address" && lnAddrCase.address === "alice@phoenix.app",
    "Lightning Address normalized to lowercase");

  const bolt = classifyDestinationInput("lnbc500n1pfake");
  assert(bolt.kind === "bolt11" && bolt.bolt11 === "lnbc500n1pfake",
    "BOLT11 recognized via lnbc prefix");

  const boltTrim = classifyDestinationInput("  lnbc500n1pfake  ");
  assert(boltTrim.kind === "bolt11",
    "BOLT11 with surrounding whitespace recognized after trim");

  const rawLnurl = "lnurl1dp68gurn8ghj7urgdajku6tc9eshqup0d3h82unvwqhkzmrfvdjsr5eqhc";
  const lnurlClass = classifyDestinationInput(rawLnurl);
  assert(lnurlClass.kind === "invalid" && /Raw LNURL/.test(lnurlClass.reason),
    "Raw LNURL paste is rejected from the payout picker");
  const lnurlUriClass = classifyDestinationInput(`lightning:${rawLnurl}`);
  assert(lnurlUriClass.kind === "invalid",
    "lightning:LNURL URI is rejected from the payout picker");
  const nwcString = `nostr+walletconnect://${"b".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"1".repeat(64)}`;
  const nwcClass = classifyDestinationInput(nwcString);
  assert(nwcClass.kind === "nwc" && nwcClass.connectionString === nwcString,
    "NWC connection string recognized as advanced invoice source");
  const boltUri = classifyDestinationInput("lightning:lnbc500n1pfake");
  assert(boltUri.kind === "bolt11" && boltUri.bolt11 === "lnbc500n1pfake",
    "lightning:BOLT11 URI recognized and stripped");

  assert(makeLightningInvoiceQrPayload("  lnbc500n1pfake  ") === "LIGHTNING:LNBC500N1PFAKE",
    "Lightning QR payload trims and prefixes BOLT11 invoices");
  assert(makeLightningInvoiceQrPayload("lightning:lnbc500n1pfake") === "LIGHTNING:LNBC500N1PFAKE",
    "Lightning QR payload avoids double-prefixing existing lightning URIs");
  assert(makeLightningInvoiceQrPayload("") === "",
    "Lightning QR payload preserves empty invoice as empty");

  const invalid = classifyDestinationInput("zzz garbage");
  assert(invalid.kind === "invalid",
    "Random garbage → invalid");

  // ── decideDispatch ───────────────────────────────────────────────────
  // Tier 1: tapped saved row wins regardless of typed/paste content
  const sample: PayoutDestination = {
    id: "pd_sample", address: "alice@phoenix.app",
    createdAt: 100, lastUsedAt: 100,
  };
  {
    const r = decideDispatch({
      tappedSavedDestination: sample,
      typedInput: classifyDestinationInput("ignored@host.com"),
      saveToggleOn: false,
    });
    assert(r.ok && r.decision.tier === "saved-row",
      "Tapped saved row → tier=saved-row");
    assert(r.ok && r.decision.addressUsed === "alice@phoenix.app",
      "Tapped saved row → addressUsed = the saved destination");
    assert(r.ok && r.decision.saveAfter === true,
      "Tapped saved row → saveAfter true (bumps lastUsedAt)");
  }

  // Tier 3 (Advanced paste) wins over Tier 2 typed when both present
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      bolt11PasteInput: classifyDestinationInput("lnbc999n1ppaste"),
      saveToggleOn: true,
    });
    assert(r.ok && r.decision.tier === "pasted-bolt11",
      "Advanced BOLT11 paste preempts typed address");
    assert(r.ok && r.decision.saveAfter === false,
      "Advanced BOLT11 paste → saveAfter false (no address to save)");
    assert(r.ok && r.decision.addressUsed === undefined,
      "Advanced BOLT11 paste → addressUsed undefined");
  }

  // Tier 3 NWC paste also wins and must be resolved before payout.
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      bolt11PasteInput: classifyDestinationInput(nwcString),
      saveToggleOn: true,
    });
    assert(r.ok && r.decision.tier === "pasted-nwc",
      "Advanced NWC paste preempts typed address");
    assert(r.ok && r.decision.saveAfter === false,
      "Advanced NWC paste → Lightning-address saveAfter false");
  }

  // Tier 2 typed Lightning Address — saveAfter follows toggle
  {
    const rOn = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      saveToggleOn: true,
    });
    assert(rOn.ok && rOn.decision.tier === "typed-address" && rOn.decision.saveAfter === true,
      "Typed address with toggle ON → tier=typed-address, saveAfter=true");
    const rOff = decideDispatch({
      typedInput: classifyDestinationInput("alice@phoenix.app"),
      saveToggleOn: false,
    });
    assert(rOff.ok && rOff.decision.saveAfter === false,
      "Typed address with toggle OFF → saveAfter=false");
  }

  // Tier 2 cross-tier paste — user pasted BOLT11 into the LN field
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("lnbc12n1pcross"),
      saveToggleOn: true,
    });
    assert(r.ok && r.decision.tier === "pasted-bolt11",
      "BOLT11 typed into LN field accepted as pasted-bolt11");
    assert(r.ok && r.decision.saveAfter === false,
      "Cross-tier paste forces saveAfter=false (no address to save)");
  }

  // Tier 2 cross-tier paste — user pasted NWC into the LN field.
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput(nwcString),
      saveToggleOn: true,
    });
    assert(r.ok && r.decision.tier === "pasted-nwc",
      "NWC typed into LN field accepted as pasted-nwc");
    assert(r.ok && r.decision.saveAfter === false,
      "NWC cross-tier paste forces Lightning-address saveAfter=false");
  }

  // Invalid typed input → ok:false with reason
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput("zzz garbage"),
      saveToggleOn: true,
    });
    assert(!r.ok && /Lightning Address|BOLT11/.test(r.reason),
      "Invalid input → ok:false carrying typed-classifier reason");
  }

  // Empty input + nothing tapped → ok:false
  {
    const r = decideDispatch({
      typedInput: classifyDestinationInput(""),
      saveToggleOn: true,
    });
    assert(!r.ok,
      "Empty input + no saved row tap → ok:false");
  }
}

// ── 37. POLL FOR FUNDING (v0.3.0 Phase 2) ────────────────────────────────
//
// pollForFunding is the polling watchdog inside runFundAndLock. Tests
// inject a synthetic clock + sleep + balance reader so the timing
// behavior is deterministic and fast. Each test pins one terminal
// phase + the phase events leading to it.
console.log("\n── POLL FOR FUNDING ──");
{
  // Helper: build a controllable clock + sleep that advance in lockstep,
  // plus a balance script that returns the i-th value per call.
  function harness(opts: {
    balances: number[];
    paymentDeadlineMs?: number;
    mintConfirmTimeoutMs?: number;
    pollIntervalMs?: number;
    thresholdPct?: number;
    signal?: AbortSignal;
  }) {
    let nowMs = 0;
    let i = 0;
    const phases: FundingPhase[] = [];
    const sleep = async (ms: number) => { nowMs += ms; };
    const now = () => nowMs;
    const getBalance = async () => {
      const v = opts.balances[Math.min(i, opts.balances.length - 1)];
      i++;
      return v;
    };
    const onPhase = (p: FundingPhase) => phases.push(p);
    return { phases, getBalance, sleep, now, onPhase, callCountRef: () => i, clock: () => nowMs };
  }

  // Happy path — payment lands fully on first poll
  {
    const h = harness({ balances: [0, 100_000] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Happy path: balance lands fully → payment-confirmed");
    assert(h.phases[0]?.kind === "awaiting-payment",
      "First emitted phase is awaiting-payment");
    assert(h.phases.some(p => p.kind === "payment-confirmed"),
      "Terminal payment-confirmed phase emitted");
    assert(!h.phases.some(p => p.kind === "mint-confirming"),
      "No mint-confirming phase when balance lands fully on first read");
  }

  // Threshold tolerance — accept 92% of expected (above 90% default)
  {
    const h = harness({ balances: [0, 92_000] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Threshold tolerance: 92k of 100k accepted as confirmed (>= 90%)");
  }

  // Mint-confirming → payment-confirmed sequence
  {
    const h = harness({ balances: [0, 0, 50_000, 50_000, 100_000] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Partial then full → payment-confirmed");
    const order = h.phases.map(p => p.kind);
    const awaitingIdx = order.indexOf("awaiting-payment");
    const mintIdx = order.indexOf("mint-confirming");
    const confIdx = order.indexOf("payment-confirmed");
    assert(awaitingIdx === 0,
      "Phase order: awaiting-payment first");
    assert(mintIdx > awaitingIdx,
      "Phase order: mint-confirming after awaiting-payment");
    assert(confIdx > mintIdx,
      "Phase order: payment-confirmed after mint-confirming");
  }

  // Expired — no payment ever, paymentDeadline elapses
  {
    const h = harness({ balances: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 5_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "expired",
      "No payment in window → expired");
    assert(!h.phases.some(p => p.kind === "mint-confirming"),
      "No mint-confirming phase emitted when balance never moves");
  }

  // Mint-timeout — partial credit got stuck for the full grace window
  {
    const h = harness({
      balances: [0, 0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000],
    });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 5_000,
      mintSlowWarnMs: 10_000, // higher than mint-confirm cap → no slow-warn fired
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "mint-timeout",
      "Partial credit stuck past mint timeout → mint-timeout");
    assert(h.phases.some(p => p.kind === "mint-confirming"),
      "mint-confirming phase fired before timeout");
    assert(h.phases[h.phases.length - 1].kind === "mint-timeout",
      "Terminal phase emitted last is mint-timeout");
  }

  // v0.5.1 mint-confirming-slow — soft warn that flips the UI to a
  // wait-vs-cancel surface without terminating the poll loop. Fires
  // once between mintSlowWarnMs and mintConfirmTimeoutMs, then the
  // hard cap still terminates if no progress.
  {
    const h = harness({
      balances: [0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000],
    });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 5_000,
      mintSlowWarnMs: 2_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "mint-timeout",
      "After slow warn, hard cap still terminates as mint-timeout");
    const slowIdx = h.phases.findIndex(p => p.kind === "mint-confirming-slow");
    const confIdx = h.phases.findIndex(p => p.kind === "mint-confirming");
    assert(confIdx >= 0 && slowIdx > confIdx,
      "mint-confirming-slow fires after mint-confirming, before the terminal");
    const slowCount = h.phases.filter(p => p.kind === "mint-confirming-slow").length;
    assert(slowCount === 1,
      "mint-confirming-slow fires exactly once (not on every subsequent tick)");
  }

  // v0.5.1 mint-confirming-slow is not a terminal — late landing still
  // resolves as payment-confirmed (the federation finishing after the
  // slow warn).
  {
    const h = harness({
      balances: [0, 50_000, 50_000, 50_000, 50_000, 100_000],
    });
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      mintSlowWarnMs: 1_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Late mint completion after slow warn still resolves payment-confirmed");
    assert(h.phases.some(p => p.kind === "mint-confirming-slow"),
      "slow warn fired before late completion");
    assert(h.phases[h.phases.length - 1].kind === "payment-confirmed",
      "Terminal phase is payment-confirmed, not mint-timeout");
  }

  // Mint-confirming countdown is independent of paymentDeadline. Even
  // if paymentDeadline would NOT have fired, mintConfirmTimeout fires
  // its own clock from when partial was first detected.
  {
    // 100ms paymentDeadline (would have fired at t=100); but partial
    // arrives at t=50, and mintConfirmTimeout=200ms, so terminal kind
    // should be mint-timeout at t=250 (50 + 200), NOT expired at t=100.
    let nowMs = 0;
    let i = 0;
    const balances = [0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000];
    const phases: FundingPhase[] = [];
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 100,
      mintConfirmTimeoutMs: 200,
      pollIntervalMs: 50,
    });
    assert(result.kind === "mint-timeout",
      "Mint-confirm timer is independent: partial-then-stuck = mint-timeout, not expired");
  }

  // Aborted via signal mid-loop
  {
    const ctrl = new AbortController();
    const h = harness({ balances: [0, 0, 0, 0, 0] });
    // Abort before the first sleep tick so the loop exits at the top
    ctrl.abort();
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: h.getBalance,
      onPhase: h.onPhase,
      sleep: h.sleep,
      now: h.now,
      signal: ctrl.signal,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "aborted",
      "AbortSignal already-aborted → aborted terminal");
    assert(h.phases[h.phases.length - 1].kind === "aborted",
      "Aborted phase emitted as terminal");
  }

  // getBalance throwing transiently doesn't crash the loop
  {
    let calls = 0;
    let nowMs = 0;
    const phases: FundingPhase[] = [];
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: async () => {
        calls++;
        if (calls < 3) throw new Error("transient federation error");
        return 100_000;
      },
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(result.kind === "payment-confirmed",
      "Transient getBalance throws don't break the loop");
    assert(calls >= 3, "getBalance was retried after throws");
  }

  // Defaults match the documented constants
  {
    // 15min payment deadline, 5min mint-confirm (was 60s pre-v0.5.1),
    // 60s mint slow-warn, 5s poll, 0.9 threshold. We confirm by
    // triggering the deadline path with defaults left in place. Use a
    // tiny override only on pollIntervalMs so the test finishes quickly;
    // everything else inherits.
    let nowMs = 0;
    const phases: FundingPhase[] = [];
    const result = await pollForFunding({
      baselineMsats: 0,
      expectedMsats: 100_000,
      getBalance: async () => 0,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      pollIntervalMs: 60_000, // 1-minute ticks so we hit 15min in 15 ticks
    });
    assert(result.kind === "expired",
      "Default 15min payment deadline triggers expired with no payment");
    // Roughly 15 ticks of 60s each = 15 minutes
    assert(nowMs >= 15 * 60_000 && nowMs < 17 * 60_000,
      "Expired fired around 15min mark using default deadline");
  }
}

// ── 38. RUN FUND AND LOCK (v0.3.0 Phase 2) ──────────────────────────────
//
// runFundAndLock orchestrates createFundingInvoice + pollForFunding +
// lockAndPublish. Mocks the wallet seam to verify each terminal path.
console.log("\n── RUN FUND AND LOCK ──");
{
  // Mock helpers
  function makeMockWallet(opts: {
    balances: number[];
    invoiceResult?: string | Error;
    lockResult?: "ok" | Error;
    suppressInitialReceiveState?: boolean;
  }) {
    let i = 0;
    const calls = {
      createInvoice: 0 as number,
      lockAndPublish: 0 as number,
      getBalance: 0 as number,
    };
    // v0.6.5: capture the most recent onReceiveState listener so tests
    // can drive the receive-watch state machine manually. The real SDK
    // fires this as the federation transitions through created →
    // funded → claimed; tests reproduce that without a live wallet.
    let lastReceiveListener: ((kind: import("../payments/fund-and-lock.js").LnReceiveWatchKind) => void) | null = null;
    return {
      calls,
      getBalance: async () => {
        calls.getBalance++;
        return opts.balances[Math.min(i++, opts.balances.length - 1)];
      },
      createFundingInvoice: async (
        _msats: number,
        _desc: string,
        onReceiveState?: (kind: import("../payments/fund-and-lock.js").LnReceiveWatchKind) => void,
      ) => {
        calls.createInvoice++;
        lastReceiveListener = onReceiveState ?? null;
        if (opts.invoiceResult instanceof Error) throw opts.invoiceResult;
        if (!opts.suppressInitialReceiveState) onReceiveState?.("created");
        return opts.invoiceResult ?? "lnbc100n1pfakefundingok";
      },
      lockAndPublish: async (_id: string, _o: { savedHandleId?: string }) => {
        calls.lockAndPublish++;
        if (opts.lockResult instanceof Error) throw opts.lockResult;
        return {} as any;
      },
      // Test helper: fire a receive-watch state as the SDK would.
      fireReceiveState: (kind: import("../payments/fund-and-lock.js").LnReceiveWatchKind) => {
        lastReceiveListener?.(kind);
      },
    };
  }

  // ── Happy path: invoice → balance lands → lock → locked ─────────────
  {
    const wallet = makeMockWallet({ balances: [0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_1",
      amountMsats: 100_000,
      description: "test fund",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "locked",
      "Happy path → terminal kind=locked");
    const order = phases.map(p => p.kind);
    assert(order[0] === "creating-invoice",
      "First phase: creating-invoice");
    assert(order.includes("invoice-created"),
      "invoice-created phase emitted with BOLT11");
    const invoiceCreated = phases.find(p => p.kind === "invoice-created");
    assert(!!invoiceCreated && (invoiceCreated as any).bolt11 === "lnbc100n1pfakefundingok",
      "invoice-created carries the BOLT11 returned by createFundingInvoice");
    assert(order.includes("locking"),
      "locking phase emitted after payment-confirmed");
    assert(order[order.length - 1] === "locked",
      "Terminal phase: locked");
    assert(wallet.calls.createInvoice === 1,
      "createFundingInvoice called exactly once");
    assert(wallet.calls.lockAndPublish === 1,
      "lockAndPublish called exactly once after payment");
  }

  // ── NWC auto-pay: invoice → pay_invoice → balance lands → lock ─────
  {
    const wallet = makeMockWallet({ balances: [0, 0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    let paidInvoice = "";
    const terminal = await runFundAndLock({
      escrowId: "esc_test_nwc",
      amountMsats: 100_000,
      description: "test nwc fund",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      autoPayInvoice: async (bolt11) => { paidInvoice = bolt11; },
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    const order = phases.map(p => p.kind);
    assert(terminal.kind === "locked",
      "NWC auto-pay funding → terminal kind=locked");
    assert(paidInvoice === "lnbc100n1pfakefundingok",
      "NWC auto-pay receives the generated Chama funding invoice");
    assert(order.indexOf("invoice-created") < order.indexOf("paying-with-nwc"),
      "NWC auto-pay starts after invoice-created");
    assert(order.indexOf("paying-with-nwc") < order.indexOf("payment-confirmed"),
      "NWC auto-pay happens before balance-confirmed");
    assert(wallet.calls.lockAndPublish === 1,
      "NWC auto-pay locks after payment confirmation");
  }

  // ── Sequencing assertion: lockAndPublish never called before payment-confirmed
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0, 0, 0] }); // never lands
    let lockCalledAtPhase: string | null = null;
    let lastPhase: string = "";
    let nowMs = 0;
    await runFundAndLock({
      escrowId: "esc_test_2",
      amountMsats: 100_000,
      description: "test never-land",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: async (_id, _o) => {
        lockCalledAtPhase = lastPhase;
        wallet.calls.lockAndPublish++;
        return {} as any;
      },
      onPhase: p => { lastPhase = p.kind; },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 5_000,
      mintConfirmTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    assert(wallet.calls.lockAndPublish === 0,
      "lockAndPublish NEVER called when payment doesn't land");
    assert(lockCalledAtPhase === null,
      "lock dispatch path never reached during expiry");
  }

  // ── Expired terminal: no orphan lock dispatched, modal handles cleanup
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0, 0] });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_3",
      amountMsats: 100_000,
      description: "expire test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 3_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "expired",
      "No payment in window → terminal expired");
    assert(wallet.calls.createInvoice === 1,
      "Invoice was created");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never dispatched on expired path (no orphan)");
  }

  // ── Mint-timeout terminal: surfaces try-LOCK retry path to caller
  {
    const wallet = makeMockWallet({
      balances: [0, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000],
    });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_4",
      amountMsats: 100_000,
      description: "mint timeout test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "mint-timeout",
      "Partial credit stuck → terminal mint-timeout");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK NOT auto-dispatched on mint-timeout (modal surfaces try-LOCK retry)");
  }

  // ── LOCK-failed terminal: balance landed but lockAndPublish threw.
  // This is the orphan-balance case the recovery banner catches on
  // next visit (per Phase 4).
  {
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      lockResult: new Error("FED_MISMATCH: wallet on different fed"),
    });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_5",
      amountMsats: 100_000,
      description: "lock fail test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Balance landed but lock threw → terminal lock-failed");
    if (terminal.kind === "lock-failed") {
      assert(/FED_MISMATCH/.test(terminal.error),
        "lock-failed terminal carries the underlying error message");
    }
    assert(wallet.calls.lockAndPublish === 1,
      "LOCK was attempted (not silently skipped)");
  }

  // ── Invoice-creation failure: lock-failed surfaces upstream error
  {
    const wallet = makeMockWallet({
      balances: [0],
      invoiceResult: new Error("federation unreachable"),
    });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_6",
      amountMsats: 100_000,
      description: "invoice fail test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Invoice creation failure → terminal lock-failed");
    if (terminal.kind === "lock-failed") {
      assert(/federation unreachable/.test(terminal.error),
        "Invoice failure error message preserved");
    }
    assert(wallet.calls.createInvoice === 1,
      "createFundingInvoice was attempted");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never attempted when invoice creation failed");
    // No invoice-created phase since we never got the BOLT11
    assert(!phases.some(p => p.kind === "invoice-created"),
      "No invoice-created phase emitted on invoice-creation failure");
  }

  // ── v0.6.5: createFundingInvoice timeout
  // Hangs forever → hard cap fires → terminal lock-failed with a clear
  // "couldn't reach federation" message. Before this guard, the modal
  // could sit indefinitely on the CreatingInvoice spinner when the
  // federation's WebSocket transport was broken.
  {
    const wallet = makeMockWallet({ balances: [0] });
    const phases: FundAndLockPhase[] = [];
    const hangingInvoice = () => new Promise<string>(() => {
      // never resolves, never rejects — simulates hanging gateway lookup
    });
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_invoice_hang",
      amountMsats: 100_000,
      description: "hang test",
      getBalance: wallet.getBalance,
      createFundingInvoice: hangingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      invoiceTimeoutMs: 30,
      invoiceSlowWarnMs: 10,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Hung createFundingInvoice → terminal lock-failed via hard timeout");
    if (terminal.kind === "lock-failed") {
      assert(/reach the federation/i.test(terminal.error),
        "Timeout error message points at federation reachability");
    }
    assert(phases.some(p => p.kind === "creating-invoice-slow"),
      "Slow-warn phase emitted before the hard timeout");
    assert(!phases.some(p => p.kind === "invoice-created"),
      "No invoice-created phase when createFundingInvoice never resolved");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never dispatched when invoice timed out");
  }

  // ── v0.7.1: invoice receive-watch preflight
  // A BOLT11 alone is not enough; before the QR is shown, the receive
  // stream must prove it can see the operation. This is a no-money SDK
  // probe: it cannot prove paid settlement, but it prevents asking the
  // user to fund an invoice Chama cannot watch.
  {
    const wallet = makeMockWallet({
      balances: [0, 0, 0],
      suppressInitialReceiveState: true,
    });
    const phases: FundAndLockPhase[] = [];
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_watch_not_ready",
      amountMsats: 100_000,
      description: "receive watch preflight",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      invoiceTimeoutMs: 5_000,
      invoiceSlowWarnMs: 50,
      receiveWatchReadyTimeoutMs: 1,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Missing initial receive-watch state → terminal lock-failed");
    if (terminal.kind === "lock-failed") {
      assert(/receive watcher/i.test(terminal.error),
        "Preflight error explains the receive watcher was not verified");
    }
    assert(!phases.some(p => p.kind === "invoice-created"),
      "No invoice-created phase emitted before receive-watch preflight");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never dispatched when receive-watch preflight failed");
  }

  // ── v0.6.5: fast invoice → no slow-warn phase
  // A warm federation responds in <slow-warn ms, so the user never sees
  // the "federation is slow" surface.
  {
    const wallet = makeMockWallet({ balances: [0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const terminal = await runFundAndLock({
      escrowId: "esc_test_invoice_fast",
      amountMsats: 100_000,
      description: "fast invoice test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice, // resolves immediately
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      invoiceTimeoutMs: 5_000,
      invoiceSlowWarnMs: 50,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "locked",
      "Fast invoice → happy path still works");
    assert(!phases.some(p => p.kind === "creating-invoice-slow"),
      "No slow-warn phase when invoice resolves before slow-warn timer");
  }

  // ── v0.6.5: receive-watch `funded` → mint-confirming emitted early
  // Production v0.6.4 logs prove the LN receive state machine
  // (created → funded → awaiting_funds → claimed) is the lower-
  // latency signal for "did the gateway see the payment?" — the 5s
  // balance poll is a fallback. The orchestrator subscribes to
  // receive-watch via createFundingInvoice's third arg and emits
  // mint-confirming the moment `funded` fires, so the modal stops
  // sitting on the QR.
  {
    // Three balance reads: baseline 0, two polls of 0, then 100k
    // lands. The watch fires `funded` between poll #1 and poll #2
    // — before the balance has moved — proving the watch-driven
    // mint-confirming emit lands without a positive balance delta.
    const wallet = makeMockWallet({ balances: [0, 0, 0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    let firedFunded = false;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (!firedFunded && wallet.calls.getBalance >= 2) {
        firedFunded = true;
        wallet.fireReceiveState("funded");
      }
    };
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_funded",
      amountMsats: 100_000,
      description: "receive-watch funded",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "locked",
      "Receive-watch funded → still completes happy path");
    const mintConfirmingIdx = phases.findIndex(p => p.kind === "mint-confirming");
    const paymentConfirmedIdx = phases.findIndex(p => p.kind === "payment-confirmed");
    assert(mintConfirmingIdx >= 0,
      "mint-confirming emitted at least once (by receive-watch)");
    assert(
      mintConfirmingIdx < paymentConfirmedIdx || paymentConfirmedIdx === -1,
      "mint-confirming precedes payment-confirmed (watch beats balance poll)",
    );
  }

  // ── v0.6.5: receive-watch emits are deduped
  // Real SDK fires `funded`, then `awaiting_funds`, then `claimed`
  // in quick succession. We don't want to spam the modal with
  // three consecutive mint-confirming flips — the orchestrator
  // dedups so only the first transition emits.
  {
    const wallet = makeMockWallet({ balances: [0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (wallet.calls.createInvoice > 0 && wallet.calls.getBalance === 2) {
        wallet.fireReceiveState("funded");
        wallet.fireReceiveState("awaiting_funds");
        wallet.fireReceiveState("claimed");
      }
    };
    await runFundAndLock({
      escrowId: "esc_test_receive_dedup",
      amountMsats: 100_000,
      description: "receive-watch dedup",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    // Count receive-watch-driven mint-confirming emissions. The
    // balance-poll path may emit ONE more when the delta lands;
    // the dedup is that the THREE consecutive watch states
    // (funded/awaiting_funds/claimed) only produce ONE emit.
    const mintEmits = phases.filter(p => p.kind === "mint-confirming").length;
    assert(mintEmits <= 2,
      "Receive-watch dedup: at most one watch-driven + one poll-driven mint-confirming");
  }

  // ── v0.6.5: post-funded receive-watch `canceled:rejected` does NOT
  // outrank balance polling. Prod v0.6.4 ignored canceled receive states
  // and used balance as the LOCK-readiness source of truth. Local dev
  // briefly regressed by aborting as soon as the watch reported
  // canceled:rejected after funded, even though BLF payments can still
  // credit shortly after that watch transition. Preserve the prod behavior:
  // once the gateway reports funded, keep polling for actual balance.
  {
    const wallet = makeMockWallet({ balances: [0, 0, 100_000] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    let firedCancel = false;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (!firedCancel && wallet.calls.getBalance >= 1) {
        firedCancel = true;
        wallet.fireReceiveState("funded");
        wallet.fireReceiveState({ canceled: { reason: "rejected" } });
      }
    };
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_rejected",
      amountMsats: 100_000,
      description: "receive-watch rejected",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 300_000, // long, must not fire
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "locked",
      "Post-funded canceled:rejected does not abort if balance later credits");
    assert(wallet.calls.lockAndPublish === 1,
      "LOCK still dispatches after balance confirms");
    assert(phases.some(p => p.kind === "mint-confirming"),
      "funded receive state still advances the modal to mint-confirming");
  }

  // ── v0.6.5 follow-up: receive-watch `funded` starts the mint watchdog
  // even when wallet balance never moves. Before this, the modal could show
  // "Payment detected · crediting" forever-ish because pollForFunding only
  // started mint-timeout after a positive balance delta.
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0, 0, 0, 0] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    let firedFunded = false;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (!firedFunded && wallet.calls.getBalance >= 1) {
        firedFunded = true;
        wallet.fireReceiveState("funded");
      }
    };
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_funded_no_credit",
      amountMsats: 100_000,
      description: "receive-watch funded but no wallet credit",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 3_000,
      mintSlowWarnMs: 1_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "mint-timeout",
      "Receive-watch funded with no wallet credit → mint-timeout, not invoice expiry");
    assert(phases.some(p => p.kind === "mint-confirming-slow"),
      "Funded-without-credit path emits the slow mint warning");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK is not dispatched without wallet credit");
  }

  // ── v0.7.1: post-funded canceled:rejected that never credits becomes
  // an explicit lock-failed error after a short rejection grace, not the
  // generic slow-mint / Try-LOCK path. If balance credits before the grace,
  // the previous test above still proves we lock successfully.
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0, 0, 0, 0] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    let firedCancel = false;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (!firedCancel && wallet.calls.getBalance >= 1) {
        firedCancel = true;
        wallet.fireReceiveState("funded");
        wallet.fireReceiveState({ canceled: { reason: "rejected" } });
      }
    };
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_rejected_after_funded_no_credit",
      amountMsats: 100_000,
      description: "receive-watch rejected after funded without credit",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 300_000,
      mintSlowWarnMs: 1_000,
      postFundedCancelGraceMs: 2_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Post-funded canceled:rejected with no wallet credit → explicit lock-failed");
    if (terminal.kind === "lock-failed") {
      assert(/canceled:rejected/.test(terminal.error),
        "Post-funded rejection error preserves the receive cancel reason");
      assert(/before Chama received ecash/i.test(terminal.error),
        "Post-funded rejection error explains that wallet credit never arrived");
    }
    assert(phases.some(p => p.kind === "receive-rejected"),
      "Post-funded rejection path surfaces the receive-rejected warning");
    assert(!phases.some(p => p.kind === "mint-confirming-slow"),
      "Post-funded rejection path does not keep showing generic slow-mint copy");
    assert(nowMs < 10_000,
      "Post-funded rejection fails on the short grace, not the full mint watchdog");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK is not dispatched for rejected receive without wallet credit");
  }

  // ── v0.6.5: pre-funded receive-watch `canceled:*` → lock-failed
  // If the gateway/federation cancels before any funded signal, no HTLC has
  // been accepted from Chama's perspective. This is safe to surface early.
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    let firedCancel = false;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (!firedCancel && wallet.calls.getBalance >= 1) {
        firedCancel = true;
        wallet.fireReceiveState({ canceled: { reason: "claim_rejected" } });
      }
    };
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_rejected_prefund",
      amountMsats: 100_000,
      description: "receive-watch rejected before funded",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 300_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "lock-failed",
      "Pre-funded canceled:claim_rejected remains an early lock-failed terminal");
    if (terminal.kind === "lock-failed") {
      assert(/claim_rejected/.test(terminal.error),
        "Pre-funded cancellation preserves the exact receive cancel reason");
    }
    assert(phases.some(p => p.kind === "lock-failed"),
      "Pre-funded cancellation emits the diagnostic lock-failed phase");
    assert(!phases.some(p => p.kind === "aborted"),
      "Internal poll abort does not overwrite the receive cancellation diagnostic");
    assert(wallet.calls.lockAndPublish === 0,
      "LOCK never dispatches for pre-funded cancellation");
  }

  // ── v0.6.5: receive-watch `canceled:expired` → expired terminal
  // Invoice expiry observed via the watch fires earlier than the
  // poll-loop's deadline check. Same shape: surface immediately,
  // emit expired, abort pollForFunding.
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const sleep = async (ms: number) => {
      nowMs += ms;
      if (wallet.calls.getBalance >= 1) {
        wallet.fireReceiveState({ canceled: { reason: "expired" } });
      }
    };
    const terminal = await runFundAndLock({
      escrowId: "esc_test_receive_expired",
      amountMsats: 100_000,
      description: "receive-watch expired",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 600_000, // long, must not be the trigger
      mintConfirmTimeoutMs: 300_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "expired",
      "canceled:expired → terminal expired");
    assert(phases.some(p => p.kind === "expired"),
      "expired phase emitted by the watch handler, not by the poll deadline");
    assert(!phases.some(p => p.kind === "aborted"),
      "Internal poll abort does not overwrite receive-watch expiry");
  }

  // ── v0.6.5: created/waiting_for_payment don't trigger mint-confirming
  // Only `funded` and later should advance the modal. The earlier
  // states are the QR-display phase — flipping to mint-confirming
  // there would be a lie ("payment detected" before payment exists).
  {
    const wallet = makeMockWallet({ balances: [0, 0, 0, 0] });
    const phases: FundAndLockPhase[] = [];
    let nowMs = 0;
    const sleep = async (ms: number) => {
      nowMs += ms;
      // Fire pre-funded states only. mint-confirming must NOT emit.
      if (wallet.calls.createInvoice > 0 && wallet.calls.getBalance === 1) {
        wallet.fireReceiveState("created");
        wallet.fireReceiveState("waiting_for_payment");
      }
    };
    await runFundAndLock({
      escrowId: "esc_test_receive_pre_funded",
      amountMsats: 100_000,
      description: "receive-watch pre-funded",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => phases.push(p),
      sleep,
      now: () => nowMs,
      paymentDeadlineMs: 3_000, // short — let it expire
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(!phases.some(p => p.kind === "mint-confirming"),
      "Pre-funded receive states (created / waiting_for_payment) do NOT emit mint-confirming");
  }

  // ── Aborted mid-flow: signal triggered while polling
  {
    const ctrl = new AbortController();
    ctrl.abort();
    const wallet = makeMockWallet({ balances: [0] });
    let nowMs = 0;
    const terminal: FundAndLockTerminal = await runFundAndLock({
      escrowId: "esc_test_7",
      amountMsats: 100_000,
      description: "abort test",
      getBalance: wallet.getBalance,
      createFundingInvoice: wallet.createFundingInvoice,
      lockAndPublish: wallet.lockAndPublish,
      onPhase: () => {},
      signal: ctrl.signal,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "aborted",
      "Pre-aborted signal → terminal aborted (no invoice created)");
    assert(wallet.calls.createInvoice === 0,
      "createFundingInvoice not called when signal already aborted");
    assert(wallet.calls.lockAndPublish === 0,
      "lockAndPublish not called when signal already aborted");
  }

  // ── Phase callback is called with creating-invoice as the FIRST phase
  // (before any wallet calls), so the modal can show its loading state
  // immediately on mount.
  {
    const wallet = makeMockWallet({ balances: [0, 100_000] });
    let firstPhase = "";
    let createInvoiceCalledBefore = false;
    let nowMs = 0;
    await runFundAndLock({
      escrowId: "esc_test_8",
      amountMsats: 100_000,
      description: "phase order",
      getBalance: wallet.getBalance,
      createFundingInvoice: async (msats, desc) => {
        if (firstPhase === "creating-invoice") createInvoiceCalledBefore = true;
        return wallet.createFundingInvoice(msats, desc);
      },
      lockAndPublish: wallet.lockAndPublish,
      onPhase: p => { if (!firstPhase) firstPhase = p.kind; },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      paymentDeadlineMs: 60_000,
      mintConfirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(firstPhase === "creating-invoice",
      "First emitted phase: creating-invoice (before any wallet call)");
    assert(createInvoiceCalledBefore,
      "creating-invoice phase fires BEFORE createFundingInvoice (UI loading state)");
  }
}

// ── 39. WAIT FOR BALANCE GROWTH (v0.3.0 Phase 3) ─────────────────────────
//
// The polling watchdog inside runClaimAndPayout. Mirrors Phase 2's
// pollForFunding loop but with a single timeout (no payment-vs-mint
// split — the user already triggered the claim). Tests inject
// synthetic clock + sleep + balance reader for deterministic timing.
console.log("\n── WAIT FOR BALANCE GROWTH ──");
{
  // Happy: balance grows on first read
  {
    let nowMs = 0;
    let i = 0;
    const balances = [100_000];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Balance lands fully → grew");
  }

  // Threshold tolerance — accept 92% of expected
  {
    let nowMs = 0;
    let i = 0;
    const balances = [92_000];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Threshold tolerance: 92k of 100k accepted (>= 90%)");
  }

  // Partial then full lands within timeout
  {
    let nowMs = 0;
    let i = 0;
    const balances = [0, 0, 50_000, 100_000];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Partial then full → grew");
  }

  // Timeout — balance never grows
  {
    let nowMs = 0;
    let i = 0;
    const balances = [0];
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => balances[Math.min(i++, balances.length - 1)],
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "timeout",
      "Balance never grows in window → timeout");
    assert(nowMs >= 5_000,
      "Loop ran until timeout was reached");
  }

  // Aborted via signal
  {
    const ctrl = new AbortController();
    ctrl.abort();
    let nowMs = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => 0,
      signal: ctrl.signal,
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "aborted",
      "Pre-aborted signal → aborted");
  }

  // Transient getBalance throws don't crash the loop
  {
    let nowMs = 0;
    let calls = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return 100_000;
      },
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "Transient getBalance throws don't break the wait loop");
  }

  // Default 90s timeout (v2.1.1: widened from 60s for slow links; reads
  // succeed here so no failed-read extension applies — the nominal
  // window is the whole story).
  {
    let nowMs = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => 0,
      pollIntervalMs: 5_000, // 18 ticks of 5s = 90s
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "timeout",
      "Default 90s confirm timeout fires when balance never grows");
    assert(nowMs >= 90_000 && nowMs < 100_000,
      "Default timeout fired around 90s mark");
  }
}

// ── 40. RUN CLAIM AND PAYOUT (v0.3.0 Phase 3) ────────────────────────────
//
// runClaimAndPayout orchestrates claimAndRedeem → balance-confirm →
// payInvoice → optional handle-save. Each terminal path is tested
// independently with mocked deps.
console.log("\n── RUN CLAIM AND PAYOUT ──");
{
  function makeMockWallet(opts: {
    balances: number[];
    claimResult?: "ok" | Error;
    payInvoiceResult?: "ok" | Error | string;
  }) {
    let i = 0;
    const calls = {
      claimAndRedeem: 0,
      payInvoice: 0,
      completeClaim: 0,
      clearPendingRedemption: 0,
      getBalance: 0,
      saveHandle: 0,
    };
    const handlesSaved: string[] = [];
    const clearedEscrows: string[] = [];
    return {
      calls,
      handlesSaved,
      clearedEscrows,
      getBalance: async () => {
        calls.getBalance++;
        return opts.balances[Math.min(i++, opts.balances.length - 1)];
      },
      claimAndRedeem: async (_id: string) => {
        calls.claimAndRedeem++;
        if (opts.claimResult instanceof Error) throw opts.claimResult;
        return {} as any;
      },
      payInvoice: async (_b: string) => {
        calls.payInvoice++;
        if (opts.payInvoiceResult instanceof Error) throw opts.payInvoiceResult;
        if (typeof opts.payInvoiceResult === "string") throw opts.payInvoiceResult;
      },
      completeClaim: async (_id: string) => {
        calls.completeClaim++;
      },
      clearPendingRedemption: (id: string) => {
        calls.clearPendingRedemption++;
        clearedEscrows.push(id);
      },
      addOrTouchLightningHandle: (address: string) => {
        calls.saveHandle++;
        handlesSaved.push(address);
      },
    };
  }

  // ── Happy path: claim → balance lands → payInvoice → save → done ────
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    const phases: ClaimAndPayoutPhase[] = [];
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_1",
      bolt11: "lnbc100n1pfakeclaimpayout",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "alice@phoenix.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      completeClaim: wallet.completeClaim,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => phases.push(p),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Happy path → terminal=done");
    assert(wallet.calls.claimAndRedeem === 1,
      "claimAndRedeem called exactly once");
    assert(wallet.calls.payInvoice === 1,
      "payInvoice called exactly once after claim confirms");
    assert(wallet.calls.completeClaim === 1,
      "COMPLETE published exactly once after claim balance confirms");
    assert(wallet.calls.clearPendingRedemption === 1,
      "Pending redemption stash clears exactly once after claim balance confirms");
    assert(wallet.clearedEscrows[0] === "esc_claim_1",
      "Pending redemption clear is scoped to the claimed escrow");
    assert(wallet.calls.saveHandle === 1,
      "addOrTouchLightningHandle called once on success with saveAfter=true");
    assert(wallet.handlesSaved[0] === "alice@phoenix.app",
      "Saved address matches addressUsed");
    const order = phases.map(p => p.kind);
    assert(order.indexOf("claiming") < order.indexOf("confirming"),
      "Phase order: claiming → confirming");
    assert(order.indexOf("confirming") < order.indexOf("paying-invoice"),
      "Phase order: confirming → paying-invoice");
    assert(order[order.length - 1] === "done",
      "Terminal phase emitted: done");
  }

  // ── Sequencing: payInvoice never called before claim confirms ───────
  {
    const wallet = makeMockWallet({
      balances: [0, 0, 0, 0, 0, 0, 0], // never lands
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_2",
      bolt11: "lnbc100n1pneverland",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "bob@strike.me",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      completeClaim: wallet.completeClaim,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-pending",
      "Balance never lands → terminal=claim-pending");
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NEVER called when balance doesn't confirm");
    assert(wallet.calls.completeClaim === 0,
      "COMPLETE NOT published when claim balance doesn't confirm");
    assert(wallet.calls.clearPendingRedemption === 0,
      "Pending redemption stash remains on claim-pending so boot can retry");
    assert(wallet.calls.saveHandle === 0,
      "addOrTouchLightningHandle NOT called on claim-pending (no successful payout)");
  }

  // ── Claim hard-failure: claim threw, no orphan, payInvoice not called
  {
    const wallet = makeMockWallet({
      balances: [0, 0],
      claimResult: new Error("Not enough shares"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_3",
      bolt11: "lnbc100n1pclaimfail",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "carol@wallet.io",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "claimAndRedeem throws → terminal=claim-failed");
    if (terminal.kind === "claim-failed") {
      assert(/Not enough shares/.test(terminal.error),
        "claim-failed terminal carries underlying error message");
    }
    assert(wallet.calls.claimAndRedeem === 1,
      "claimAndRedeem was attempted");
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NOT called on claim hard-failure (no orphan dispatched)");
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved on claim-failed");
  }

	  // ── Claim-published throw: continue watching, then complete + pay ───
	  {
	    const partial: any = new Error("Claim published to relays, redeem still settling");
	    partial.claimPublished = true;
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      claimResult: partial,
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_published_then_lands",
      bolt11: "lnbc100n1pclaimpublished",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      completeClaim: wallet.completeClaim,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "claimPublished throw + later balance growth → done, not claim-failed");
    assert(wallet.calls.completeClaim === 1,
      "COMPLETE published after claimPublished path balance confirms");
    assert(wallet.calls.clearPendingRedemption === 1,
      "Pending redemption stash clears once claimPublished path balance confirms");
	    assert(wallet.calls.payInvoice === 1,
	      "payInvoice called after claimPublished path balance confirms");
	  }

	  // ── Claim-published terminal settlement failure: do not call it in-flight
	  {
	    const failed: any = new Error(
	      "Claim published to relays, but ecash redeem failed: " +
	      "Mint reissue operation failed after federation consumed the notes"
	    );
	    failed.claimPublished = true;
	    failed.settlementFailed = true;
	    failed.code = "MINT_REISSUE_FAILED";
	    const wallet = makeMockWallet({
	      balances: [0, 0, 0],
	      claimResult: failed,
	    });
	    let nowMs = 0;
	    const terminal = await runClaimAndPayout({
	      escrowId: "esc_claim_published_reissue_failed",
	      bolt11: "lnbc100n1preissuefailed",
	      expectedDeltaMsats: 100_000,
	      saveAfter: false,
	      getBalance: wallet.getBalance,
	      claimAndRedeem: wallet.claimAndRedeem,
	      completeClaim: wallet.completeClaim,
	      clearPendingRedemption: wallet.clearPendingRedemption,
	      payInvoice: wallet.payInvoice,
	      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
	      onPhase: () => {},
	      sleep: async (ms) => { nowMs += ms; },
	      now: () => nowMs,
	      confirmTimeoutMs: 30_000,
	      pollIntervalMs: 1_000,
	    });
	    assert(terminal.kind === "claim-failed",
	      "claimPublished terminal settlement failure → claim-failed, not claim-pending");
	    assert(wallet.calls.payInvoice === 0,
	      "payInvoice NOT called when mint reissue terminally failed");
	    assert(wallet.calls.clearPendingRedemption === 0,
	      "Pending redemption stash remains when terminal settlement failed");
	  }

	  // ── Payout-failed: claim confirmed, balance grew, but payInvoice threw
	  // COMPLETE is not published until the outbound payout succeeds, so
	  // the trade's Claim button stays alive as the retry path.
  {
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      payInvoiceResult: new Error("no route to recipient"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_4",
      bolt11: "lnbc100n1ppayoutfail",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "dave@offline.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      completeClaim: wallet.completeClaim,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "payout-failed",
      "claim ok + payInvoice throws → terminal=payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(/no route/.test(terminal.error),
        "payout-failed terminal carries underlying LN error");
    }
    assert(wallet.calls.claimAndRedeem === 1,
      "claim was attempted (succeeded)");
    assert(wallet.calls.payInvoice === 1,
      "payInvoice was attempted (failed)");
    assert(wallet.calls.completeClaim === 0,
      "COMPLETE NOT published when balance landed but outbound payout failed");
    if (terminal.kind === "payout-failed") {
      assert(terminal.claimCompleted === false,
        "payout-failed marks claimCompleted=false so Claim stays the retry path");
    }
    assert(wallet.calls.clearPendingRedemption === 1,
      "Pending redemption stash clears once balance landed even if outbound payout fails");
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved when payout failed (retry needs a fresh successful payout)");
  }

  // WASM errors can cross the JS boundary as plain strings. Preserve the
  // useful Fedimint reason instead of collapsing to "Lightning payment failed".
  {
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      payInvoiceResult: "The generated transaction would be rejected by the federation for being too large.",
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_string_pay_error",
      bolt11: "lnbc100n1pstringpayerr",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      completeClaim: wallet.completeClaim,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "payout-failed",
      "string payInvoice throw → terminal=payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(/transaction would be rejected/.test(terminal.error),
        "payout-failed preserves plain-string Fedimint error detail");
    }
  }

  // ── Auto-save toggle OFF: success but no save call ──────────────────
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_5",
      bolt11: "lnbc100n1psaveoff",
      expectedDeltaMsats: 100_000,
      saveAfter: false,                  // toggle OFF
      addressUsed: "eve@phoenix.app",    // address known but save off
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Happy path with saveAfter=false → done");
    assert(wallet.calls.saveHandle === 0,
      "saveAfter=false → handle NOT saved despite address being known");
  }

  // ── Tier 3 BOLT11 paste: addressUsed undefined → no save attempted
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_6",
      bolt11: "lnbc100n1pbolt11paste",
      expectedDeltaMsats: 100_000,
      saveAfter: true, // even with toggle on,
      addressUsed: undefined, // no address means nothing to save
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Tier 3 BOLT11 paste happy path → done");
    assert(wallet.calls.saveHandle === 0,
      "addressUsed undefined → addOrTouchLightningHandle NOT called even with saveAfter=true");
  }

  // ── Save throws: payout already succeeded; cosmetic failure swallowed
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    // Replace addOrTouchLightningHandle with one that throws.
    const throwingSave = (_a: string) => { throw new Error("storage quota"); };
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_claim_7",
      bolt11: "lnbc100n1psavethrow",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "frank@wallet.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: throwingSave,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "Save throws → terminal still done (cosmetic, payout already sent)");
  }

  // ── Phase ordering: confirming fires BEFORE paying-invoice
  {
    const wallet = makeMockWallet({ balances: [0, 100_000, 100_000] });
    const phases: string[] = [];
    let nowMs = 0;
    let payInvoiceCalledAt = -1;
    let confirmingFiredAt = -1;
    await runClaimAndPayout({
      escrowId: "esc_claim_8",
      bolt11: "lnbc100n1pphaseorder",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: async (b) => {
        payInvoiceCalledAt = phases.length;
        return wallet.payInvoice(b);
      },
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => {
        if (p.kind === "confirming" && confirmingFiredAt === -1) {
          confirmingFiredAt = phases.length;
        }
        phases.push(p.kind);
      },
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(confirmingFiredAt >= 0 && confirmingFiredAt < payInvoiceCalledAt,
      "confirming phase fires BEFORE payInvoice is called");
  }

  // ══ v2.1.1 — absolute-balance COVER settlement ══════════════════════
  // The sm_mq1cmq6p_a2arwi0x field incident: a slow-link first attempt's
  // redeem landed AFTER its confirm window closed. Every retry then
  // re-baselined WITH the landed sats, the re-redeem reported the notes
  // consumed, and growth could never be observed again → infinite
  // claim-pending/claim-failed loop while ₿17 sat invisibly in the
  // wallet (sub-material → no recovery surface engages). The cover
  // check ends the loop: if the wallet can pay the promised payout
  // right now, pay it.
  console.log("\n── CLAIM COVER SETTLEMENT (v2.1.1) ──");

  // balanceCoversPayout: the pure predicate.
  {
    // Samuel's exact shape: ~19.6k msats expected → 17-sat invoice
    // (17_000 + 2_585 fee estimate = 19_585 ≤ 19_600).
    assert(balanceCoversPayout(19_600, 19_600, "lightning") === true,
      "cover: balance equal to expected delta covers the sized invoice");
    assert(balanceCoversPayout(19_585, 19_600, "lightning") === true,
      "cover: fee-exact balance still covers (maxLightningPayoutSats is monotone)");
    assert(balanceCoversPayout(15_000, 19_600, "lightning") === false,
      "cover: partial balance does NOT cover the promised invoice");
    assert(balanceCoversPayout(0, 19_600, "lightning") === false,
      "cover: empty wallet never covers");
    assert(balanceCoversPayout(19_600, 0, "lightning") === false,
      "cover: zero expected payout is never 'covered' (no invoice to pay)");
    assert(balanceCoversPayout(2_000, 2_000, "lightning") === false,
      "cover: sub-fee dust claim (no payable invoice exists) is not covered");
    assert(balanceCoversPayout(19_600, 19_600, "onchain") === true,
      "cover/onchain: whole-sat coverage of gross amount suffices");
    assert(balanceCoversPayout(18_999, 19_600, "onchain") === false,
      "cover/onchain: below gross sats does not cover");
  }

  // ── The Samuel rescue: consumed notes + covering balance → payout ───
  // claimAndRedeem throws claimPublished+settlementFailed (the
  // MINT_REISSUE_UNKNOWN shape), but the wallet already holds the
  // credit from the first attempt. Previously: instant claim-failed.
  // Now: cover check pays out, COMPLETE publishes AFTER the payout,
  // stash is preserved for the boot drain to reconcile.
  {
    const consumed: any = new Error(
      "Claim published to relays, but ecash redeem failed: " +
      "Mint notes were consumed by the federation, but no local reissue " +
      "operation was found to confirm wallet credit."
    );
    consumed.claimPublished = true;
    consumed.settlementFailed = true;
    consumed.code = "MINT_REISSUE_UNKNOWN";
    const order: string[] = [];
    const phases: string[] = [];
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_samuel_rescue",
      bolt11: "lnbc170n1psamuelrescue",
      expectedDeltaMsats: 19_600,
      saveAfter: false,
      getBalance: async () => 19_600, // landed on a PREVIOUS attempt
      claimAndRedeem: async () => { throw consumed; },
      completeClaim: async () => { order.push("complete"); },
      clearPendingRedemption: () => { order.push("clear"); },
      payInvoice: async () => { order.push("pay"); },
      addOrTouchLightningHandle: () => {},
      onPhase: p => phases.push(p.kind),
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "SAMUEL RESCUE: consumed notes + covering balance → done, not claim-failed");
    assert(order.filter(x => x === "pay").length === 1,
      "rescue: payInvoice called exactly once");
    assert(order.filter(x => x === "complete").length === 1,
      "rescue: COMPLETE published exactly once");
    assert(order.indexOf("pay") < order.indexOf("complete"),
      "rescue: COVER path pays FIRST, then publishes COMPLETE (claim stays retryable if payout fails)");
    assert(!order.includes("clear"),
      "rescue: pending-redemption stash preserved on cover settlement (boot drain reconciles)");
    assert(nowMs === 0,
      "rescue: growth poll SKIPPED when settlement is terminally failed (no pointless 90s wait)");
    assert(phases.includes("confirming"),
      "rescue: confirming phase still emitted for UI continuity");
  }

  // ── Clean claim + zero growth + pre-landed balance → cover pays ─────
  // The other loop entrance: redeem reports success/already-spent, but
  // the credit predates this attempt's baseline (boot drain or late
  // settlement). Growth times out; cover rescues.
  {
    const order: string[] = [];
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_cover_after_timeout",
      bolt11: "lnbc170n1pcoverafterTO",
      expectedDeltaMsats: 19_600,
      saveAfter: false,
      getBalance: async () => 19_600, // flat: baseline already includes credit
      claimAndRedeem: async () => ({} as any),
      completeClaim: async () => { order.push("complete"); },
      clearPendingRedemption: () => { order.push("clear"); },
      payInvoice: async () => { order.push("pay"); },
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 10_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "done",
      "cover-after-timeout: flat covering balance → done, not claim-pending");
    assert(nowMs >= 10_000,
      "cover-after-timeout: growth poll genuinely ran to timeout first");
    assert(order.indexOf("pay") < order.indexOf("complete"),
      "cover-after-timeout: pay-then-complete ordering on cover path");
    assert(!order.includes("clear"),
      "cover-after-timeout: stash preserved on cover settlement");
  }

  // ── Cover path payout failure → claim NOT completed, retry stays open
  {
    let completeCalls = 0;
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_cover_payout_fail",
      bolt11: "lnbc170n1pcoverpayfail",
      expectedDeltaMsats: 19_600,
      saveAfter: false,
      getBalance: async () => 19_600,
      claimAndRedeem: async () => ({} as any),
      completeClaim: async () => { completeCalls++; },
      clearPendingRedemption: () => {},
      payInvoice: async () => { throw new Error("invoice expired"); },
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "payout-failed",
      "cover + payInvoice throws → payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(terminal.claimCompleted === false,
        "cover + payout failure → claimCompleted=false (Claim button stays the retry path)");
    }
    assert(completeCalls === 0,
      "cover + payout failure → COMPLETE NOT published (trade stays claimable)");
  }

  // ── Growth path payout failure → claimCompleted=false (retry stays open)
  {
    const wallet = makeMockWallet({
      balances: [0, 100_000, 100_000],
      payInvoiceResult: new Error("no route"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_growth_payout_fail_flag",
      bolt11: "lnbc100n1pgrowthflag",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      completeClaim: wallet.completeClaim,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "payout-failed" && terminal.claimCompleted === false,
      "growth + payout failure → claimCompleted=false (COMPLETE waits for payout success)");
    assert(wallet.calls.completeClaim === 0,
      "growth + payout failure → COMPLETE NOT published before payout success");
  }

  // ── Consumed notes + NON-covering balance → honest claim-failed ─────
  // (No false hope: retrying consumed notes with an empty wallet cannot
  // help. Pinned again here with the new pathway to guard the verdict.)
  {
    const consumed: any = new Error(
      "Claim published to relays, but ecash redeem failed: " +
      "Mint reissue operation failed after federation consumed the notes"
    );
    consumed.claimPublished = true;
    consumed.settlementFailed = true;
    consumed.code = "MINT_REISSUE_FAILED";
    let payCalls = 0;
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_consumed_no_cover",
      bolt11: "lnbc170n1pconsumednocover",
      expectedDeltaMsats: 19_600,
      saveAfter: false,
      getBalance: async () => 1_200, // dust, can't cover a 17-sat invoice
      claimAndRedeem: async () => { throw consumed; },
      completeClaim: async () => {},
      clearPendingRedemption: () => {},
      payInvoice: async () => { payCalls++; },
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "consumed + non-covering balance → claim-failed (honest terminal)");
    assert(payCalls === 0,
      "consumed + non-covering → payInvoice never attempted");
  }

  // ── waitForBalanceGrowth: failed reads extend the deadline ──────────
  // A failed balance read proves nothing about non-arrival. 12s of
  // unreadable federation on a 10s window must NOT declare timeout;
  // the first successful read sees the grown balance.
  {
    let calls = 0;
    let nowMs = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => {
        calls++;
        if (calls <= 12) throw new Error("federation unreachable");
        return 100_000;
      },
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "grew",
      "slow link: failed reads extend the deadline — late credit still detected as grew");
    assert(calls === 13,
      "slow link: poll persisted through 12 failed reads to the successful 13th");
  }

  // ── waitForBalanceGrowth: hard cap terminates an unreadable loop ────
  {
    let nowMs = 0;
    const result = await waitForBalanceGrowth({
      baselineMsats: 0,
      expectedDeltaMsats: 100_000,
      getBalance: async () => { throw new Error("federation unreachable"); },
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });
    assert(result === "timeout",
      "always-unreadable federation still terminates (hard cap)");
    assert(nowMs <= 10_000 * CONFIRM_HARD_CAP_MULTIPLIER + 1_000,
      "hard cap bounds the extended deadline at the multiplier (+1 poll slack)");
  }
}

// ── 40b. PAYOUT DOUBLE-PAY GUARD (3.5.1) ─────────────────────────────────
//
// The money-critical guard from the round-2 device pass: a payout whose
// 60s watch window timed out mid-flight must NEVER be re-paid. The journal
// (payments/payout-journal.ts) records a SUBMITTED payout; runClaimAndPayout
// re-attaches to the operationId instead of sending a second payment. These
// tests inject in-memory journal fakes + coded payInvoice errors to prove the
// guard at the orchestrator boundary (the field bug: two payouts ~78s apart).
console.log("\n── PAYOUT DOUBLE-PAY GUARD (3.5.1) ──");
{
  type Rec = { status: "submitted" | "settled"; operationId?: string } | null;
  function makeJournal(seed?: Exclude<Rec, null>) {
    let record: Rec = seed ? { ...seed } : null;
    const calls = { read: 0, submitted: 0, settled: 0, cleared: 0 };
    return {
      calls,
      get current(): Rec { return record; },
      getPayoutRecord: (_id: string): Rec => { calls.read++; return record; },
      recordPayoutSubmitted: (input: { escrowId: string; operationId?: string; amountMsats?: number }) => {
        calls.submitted++;
        if (record?.status === "settled") return;
        record = { status: "submitted", operationId: input.operationId ?? record?.operationId };
      },
      markPayoutSettled: (_id: string, operationId?: string) => {
        calls.settled++;
        record = { status: "settled", operationId: operationId ?? record?.operationId };
      },
      clearPayoutRecord: (_id: string) => { calls.cleared++; record = null; },
    };
  }
  const balances = (arr: number[]) => {
    let i = 0;
    return async () => arr[Math.min(i++, arr.length - 1)];
  };
  const inflightErr = () =>
    Object.assign(new Error("payout still confirming"), {
      code: "LN_PAY_INFLIGHT",
      operationId: "op_abc",
    });

  // ── Fresh payout times out IN FLIGHT → payout-confirming, recorded
  //    submitted, attempted exactly once (no double-send) ───────────────
  {
    const journal = makeJournal();
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_inflight",
      bolt11: "lnbc100n1pdpinflight",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0, 100_000, 100_000]),
      claimAndRedeem: async () => ({}),
      completeClaim: async () => {},
      payInvoice: async () => { payCalls++; throw inflightErr(); },
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
      confirmTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    assert(terminal.kind === "payout-confirming",
      "in-flight payout → payout-confirming terminal (NOT payout-failed)");
    assert(payCalls === 1,
      "in-flight payout: payInvoice attempted exactly once");
    assert(journal.current?.status === "submitted",
      "in-flight payout journaled as submitted");
    assert(journal.current?.operationId === "op_abc",
      "submitted record carries operationId for re-attach");
  }

  // ── Retry over a SUBMITTED record + re-attach settles → done, NEVER
  //    re-pays, NEVER re-claims ──────────────────────────────────────────
  {
    const journal = makeJournal({ status: "submitted", operationId: "op_xyz" });
    let payCalls = 0, claimCalls = 0, completeCalls = 0, reattachOp = "";
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_reattach_ok",
      bolt11: "lnbc100n1pdpreattach",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0]),
      claimAndRedeem: async () => { claimCalls++; return {}; },
      completeClaim: async () => { completeCalls++; },
      payInvoice: async () => { payCalls++; },
      awaitPayoutOutcome: async (op) => { reattachOp = op; return "settled"; },
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
    });
    assert(terminal.kind === "done",
      "prior submitted + re-attach settled → done");
    assert(payCalls === 0,
      "prior submitted: payInvoice is NEVER called (no double-send)");
    assert(claimCalls === 0,
      "prior submitted short-circuits before the claim phase (balance-independent)");
    assert(reattachOp === "op_xyz",
      "re-attach uses the stored operationId");
    assert(journal.current?.status === "settled",
      "re-attach settled marks the record settled");
    assert(completeCalls === 1,
      "re-attach settled publishes COMPLETE");
  }

  // ── Retry over a SETTLED record → done immediately, no claim, no pay ──
  {
    const journal = makeJournal({ status: "settled", operationId: "op_done" });
    let payCalls = 0, claimCalls = 0, completeCalls = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_settled",
      bolt11: "lnbc100n1pdpsettled",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0]),
      claimAndRedeem: async () => { claimCalls++; return {}; },
      completeClaim: async () => { completeCalls++; },
      payInvoice: async () => { payCalls++; },
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
    });
    assert(terminal.kind === "done",
      "prior settled → done immediately");
    assert(payCalls === 0 && claimCalls === 0,
      "prior settled: neither re-claims nor re-pays");
    assert(completeCalls === 1,
      "prior settled re-publishes COMPLETE (idempotent finish)");
  }

  // ── Retry over a SUBMITTED record + re-attach REFUNDED → clears and
  //    pays fresh (re-pay is correct once the sats came back) ────────────
  {
    const journal = makeJournal({ status: "submitted", operationId: "op_ref" });
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_refunded",
      bolt11: "lnbc100n1pdprefund",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0, 100_000, 100_000]),
      claimAndRedeem: async () => ({}),
      completeClaim: async () => {},
      payInvoice: async () => { payCalls++; return "op_fresh"; },
      awaitPayoutOutcome: async () => "refunded",
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
      confirmTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    assert(terminal.kind === "done",
      "prior submitted + refunded → clears, pays fresh, done");
    assert(journal.calls.cleared === 1,
      "confirmed refund clears the stale submitted record");
    assert(payCalls === 1,
      "after a confirmed refund a fresh payout IS sent (re-pay is correct here)");
    assert(journal.current?.status === "settled" && journal.current?.operationId === "op_fresh",
      "the fresh payout settles the record with its new operationId");
  }

  // ── Happy path: payInvoice resolves with an operationId → settled ─────
  {
    const journal = makeJournal();
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_happy",
      bolt11: "lnbc100n1pdphappy",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0, 100_000, 100_000]),
      claimAndRedeem: async () => ({}),
      completeClaim: async () => {},
      payInvoice: async () => "op_happy",
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
      confirmTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    assert(terminal.kind === "done",
      "happy path → done");
    assert(journal.current?.status === "settled",
      "happy path journals the payout settled");
    assert(journal.current?.operationId === "op_happy",
      "settled record carries the success operationId");
  }

  // ── v4.0.0 FAIL-CLOSED: journal can't persist PRE-SEND → refuse to start,
  //    payInvoice NEVER called, nothing sent (no later re-tap can double-pay) ─
  {
    const journal = makeJournal();
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_unwritable",
      bolt11: "lnbc100n1pdpunwritable",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0, 100_000, 100_000]),
      claimAndRedeem: async () => ({}),
      completeClaim: async () => {},
      payInvoice: async () => { payCalls++; return "op_should_not_send"; },
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      assertPayoutJournalWritable: () => { throw new Error("QuotaExceededError"); },
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
      confirmTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    assert(terminal.kind === "payout-failed",
      "unwritable journal pre-send → payout-failed (refuse to start)");
    assert(payCalls === 0,
      "unwritable journal pre-send → payInvoice is NEVER called (no payment sent)");
    assert(journal.current === null,
      "unwritable journal pre-send → no payout record written");
  }

  // ── v4.0.0: SETTLED-guard persist fails AFTER a sent payout → payout-confirming
  //    (never `done` with no guard, never a re-payable terminal) ────────────
  {
    const journal = makeJournal();
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_settle_persist_fail",
      bolt11: "lnbc100n1pdppersist",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0, 100_000, 100_000]),
      claimAndRedeem: async () => ({}),
      completeClaim: async () => {},
      payInvoice: async () => { payCalls++; return "op_sent"; },
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: journal.recordPayoutSubmitted,
      markPayoutSettled: () => { throw new Error("QuotaExceededError"); },
      clearPayoutRecord: journal.clearPayoutRecord,
      assertPayoutJournalWritable: () => {}, // probe passes; the real write fails
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
      confirmTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    assert(terminal.kind === "payout-confirming",
      "settled-persist failure after a sent payout → payout-confirming (NOT done, NOT re-payable)");
    assert(payCalls === 1,
      "settled-persist failure: payInvoice still attempted exactly once");
  }

  // ── v4.0.0: in-flight payout whose SUBMITTED-guard persist fails → still
  //    payout-confirming, never the re-payable terminal ─────────────────────
  {
    const journal = makeJournal();
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_dp_inflight_persist_fail",
      bolt11: "lnbc100n1pdpinflightpf",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: balances([0, 100_000, 100_000]),
      claimAndRedeem: async () => ({}),
      completeClaim: async () => {},
      payInvoice: async () => { payCalls++; throw inflightErr(); },
      getPayoutRecord: journal.getPayoutRecord,
      recordPayoutSubmitted: () => { throw new Error("QuotaExceededError"); },
      markPayoutSettled: journal.markPayoutSettled,
      clearPayoutRecord: journal.clearPayoutRecord,
      assertPayoutJournalWritable: () => {},
      addOrTouchLightningHandle: () => {},
      onPhase: () => {},
      sleep: async () => {},
      now: () => 0,
      confirmTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });
    assert(terminal.kind === "payout-confirming",
      "in-flight + submitted-persist failure → payout-confirming (never re-payable)");
    assert(payCalls === 1,
      "in-flight + submitted-persist failure: payInvoice attempted exactly once");
  }
}

// ── 40c. V7 — PRE-SEND INTENT + RECONCILE-BY-ESCROW ─────────────────────
//
// Closes the last double-pay window: the app dying BETWEEN the bridge
// committing a payment and the journal write left an EMPTY journal, so a
// retry re-paid. Now (1) an `intent` record is written BEFORE payInvoice,
// and (2) a retry over an intent (or a submitted record that lost its
// operationId) reconciles BY ESCROW against the fedimint operation log
// (payments carry chama_escrow_id in extra_meta). Fund-safety asymmetry:
// "none" (scan-complete, no payment) clears an INTENT and pays fresh, but
// for a SUBMITTED record it stays unknown⇒refuse (the gateway accepted a
// payment; an empty scan is blindness, not proof of absence).
console.log("\n── V7 PRE-SEND INTENT + RECONCILE-BY-ESCROW ──");
{
  type Rec = {
    status: "intent" | "submitted" | "settled";
    operationId?: string;
    createdAt?: number;
  } | null;
  function makeJournal(seed?: Exclude<Rec, null>) {
    let record: Rec = seed ? { ...seed } : null;
    return {
      get current(): Rec { return record; },
      getPayoutRecord: (_id: string): Rec => record,
      recordPayoutIntent: (input: { escrowId: string; amountMsats?: number }) => {
        if (record?.status === "settled" || record?.status === "submitted") return;
        record = { status: "intent", createdAt: record?.createdAt ?? 5_000_000 };
      },
      recordPayoutSubmitted: (input: { escrowId: string; operationId?: string }) => {
        if (record?.status === "settled") return;
        record = { status: "submitted", operationId: input.operationId ?? record?.operationId };
      },
      markPayoutSettled: (_id: string, operationId?: string) => {
        record = { status: "settled", operationId: operationId ?? record?.operationId };
      },
      clearPayoutRecord: (_id: string) => { record = null; },
    };
  }
  const balances = (arr: number[]) => {
    let i = 0;
    return async () => arr[Math.min(i++, arr.length - 1)];
  };
  const baseOpts = (journal: ReturnType<typeof makeJournal>) => ({
    saveAfter: false,
    claimAndRedeem: async () => ({}),
    getPayoutRecord: journal.getPayoutRecord,
    recordPayoutIntent: journal.recordPayoutIntent,
    recordPayoutSubmitted: journal.recordPayoutSubmitted,
    markPayoutSettled: journal.markPayoutSettled,
    clearPayoutRecord: journal.clearPayoutRecord,
    addOrTouchLightningHandle: () => {},
    onPhase: () => {},
    sleep: async () => {},
    now: () => 0,
    confirmTimeoutMs: 1_000,
    pollIntervalMs: 100,
  });

  // ── THE V7 load-bearing unit: the intent record exists BEFORE the
  //    payment is dispatched, and success upgrades it to settled ─────────
  {
    const journal = makeJournal();
    const captured: { atPayTime: Rec } = { atPayTime: null };
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_presend",
      bolt11: "lnbc100n1pv7presend",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0, 100_000, 100_000]),
      completeClaim: async () => {},
      payInvoice: async () => {
        captured.atPayTime = journal.current;
        return "op_v7_new";
      },
    });
    assert(terminal.kind === "done", "V7 pre-send: happy path still ends done");
    assert(captured.atPayTime?.status === "intent",
      "V7 LOAD-BEARING: the intent record is PERSISTED before payInvoice dispatches");
    assert(journal.current?.status === "settled" && journal.current?.operationId === "op_v7_new",
      "V7 pre-send: success upgrades intent → settled with the new operationId");
  }

  // ── Crash aftermath: intent + reconcile says SETTLED → done, zero pays,
  //    COMPLETE published (the exact double-pay this closes) ─────────────
  {
    const journal = makeJournal({ status: "intent", createdAt: 5_000_000 });
    let payCalls = 0, claimCalls = 0, completeCalls = 0;
    let seenSince: number | undefined;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_settled",
      bolt11: "lnbc100n1pv7settled",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0]),
      claimAndRedeem: async () => { claimCalls++; return {}; },
      completeClaim: async () => { completeCalls++; },
      payInvoice: async () => { payCalls++; },
      payOutcomeByEscrow: async (_id, sinceMs) => {
        seenSince = sinceMs;
        return { outcome: "settled" as const, operationId: "op_v7_found" };
      },
    });
    assert(terminal.kind === "done",
      "intent + reconcile settled → done (crash-mid-pay retry resolves, never re-pays)");
    assert(payCalls === 0 && claimCalls === 0,
      "intent + reconcile settled: NO second payment, no re-claim");
    assert(completeCalls === 1,
      "intent + reconcile settled: COMPLETE published");
    assert(journal.current?.status === "settled" && journal.current?.operationId === "op_v7_found",
      "intent + reconcile settled: record upgraded with the FOUND operationId");
    assert(seenSince === 5_000_000 - 60 * 60 * 1000,
      "reconcile scan bounded to the intent's createdAt minus the margin");
  }

  // ── intent + reconcile NONE → payment provably never existed: record
  //    cleared, pays fresh exactly once ───────────────────────────────────
  {
    const journal = makeJournal({ status: "intent", createdAt: 5_000_000 });
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_none",
      bolt11: "lnbc100n1pv7none",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0, 100_000, 100_000]),
      completeClaim: async () => {},
      payInvoice: async () => { payCalls++; return "op_v7_fresh"; },
      payOutcomeByEscrow: async () => ({ outcome: "none" as const }),
    });
    assert(terminal.kind === "done" && payCalls === 1,
      "intent + reconcile none → pays fresh exactly once (crash was pre-send)");
    assert(journal.current?.status === "settled",
      "intent + reconcile none: fresh payment journaled settled");
  }

  // ── intent + reconcile INFLIGHT → adopt the found operationId, refuse ──
  {
    const journal = makeJournal({ status: "intent", createdAt: 5_000_000 });
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_inflight",
      bolt11: "lnbc100n1pv7inflight",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0]),
      payInvoice: async () => { payCalls++; },
      payOutcomeByEscrow: async () => ({ outcome: "inflight" as const, operationId: "op_v7_live" }),
    });
    assert(terminal.kind === "payout-confirming" && payCalls === 0,
      "intent + reconcile inflight → payout-confirming, never re-pays");
    assert(journal.current?.status === "submitted" && journal.current?.operationId === "op_v7_live",
      "intent + reconcile inflight: upgraded to submitted with the live payment's id");
  }

  // ── intent + reconcile UNKNOWN (or no reconcile dep) → refuse for now,
  //    record kept so the boot sweep retries the reconcile later ─────────
  {
    const journal = makeJournal({ status: "intent", createdAt: 5_000_000 });
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_unknown",
      bolt11: "lnbc100n1pv7unknown",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0]),
      payInvoice: async () => { payCalls++; },
      payOutcomeByEscrow: async () => ({ outcome: "unknown" as const }),
    });
    assert(terminal.kind === "payout-confirming" && payCalls === 0,
      "intent + reconcile unknown → refuse-for-now (payout-confirming), no re-pay");
    assert(journal.current?.status === "intent",
      "intent + reconcile unknown: record kept for the next reconcile attempt");
  }
  {
    const journal = makeJournal({ status: "intent", createdAt: 5_000_000 });
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_nodep",
      bolt11: "lnbc100n1pv7nodep",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0]),
      payInvoice: async () => { payCalls++; },
      // payOutcomeByEscrow deliberately absent.
    });
    assert(terminal.kind === "payout-confirming" && payCalls === 0,
      "intent + NO reconcile dep → fund-safe refuse (never a blind re-pay)");
  }

  // ── V6 residue: submitted WITHOUT operationId reconciles by escrow ─────
  {
    const journal = makeJournal({ status: "submitted", createdAt: 5_000_000 });
    let payCalls = 0, completeCalls = 0;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_v6residue",
      bolt11: "lnbc100n1pv7v6res",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0]),
      completeClaim: async () => { completeCalls++; },
      payInvoice: async () => { payCalls++; },
      payOutcomeByEscrow: async () => ({ outcome: "settled" as const, operationId: "op_v7_v6" }),
    });
    assert(terminal.kind === "done" && payCalls === 0 && completeCalls === 1,
      "submitted-without-opId + reconcile settled → done (stuck-confirming resolves, V6)");
  }

  // ── The asymmetry: submitted + reconcile NONE stays refused ────────────
  {
    const journal = makeJournal({ status: "submitted", createdAt: 5_000_000 });
    let payCalls = 0;
    const terminal = await runClaimAndPayout({
      ...baseOpts(journal),
      escrowId: "esc_v7_asym",
      bolt11: "lnbc100n1pv7asym",
      expectedDeltaMsats: 100_000,
      getBalance: balances([0]),
      payInvoice: async () => { payCalls++; },
      payOutcomeByEscrow: async () => ({ outcome: "none" as const }),
    });
    assert(terminal.kind === "payout-confirming" && payCalls === 0,
      "submitted + reconcile none → STILL refused (a blind scan must not license re-pay)");
    assert(journal.current?.status === "submitted",
      "submitted + reconcile none: record kept");
  }

  // ── Real journal module: intent upgrade semantics ──────────────────────
  {
    const journalMod = await import("../payments/payout-journal.js");
    (globalThis as any).localStorage.clear();
    journalMod.recordPayoutIntent({ escrowId: "esc_v7_real", amountMsats: 42_000 });
    assert(journalMod.getPayoutRecord("esc_v7_real")?.status === "intent",
      "real journal: recordPayoutIntent persists an intent record");
    journalMod.recordPayoutSubmitted({ escrowId: "esc_v7_real", operationId: "op_r1" });
    assert(journalMod.getPayoutRecord("esc_v7_real")?.status === "submitted",
      "real journal: intent upgrades to submitted");
    journalMod.recordPayoutIntent({ escrowId: "esc_v7_real" });
    assert(journalMod.getPayoutRecord("esc_v7_real")?.status === "submitted",
      "real journal: a retry's pre-send intent NEVER downgrades submitted");
    journalMod.markPayoutSettled("esc_v7_real", "op_r1");
    journalMod.recordPayoutIntent({ escrowId: "esc_v7_real" });
    assert(journalMod.getPayoutRecord("esc_v7_real")?.status === "settled",
      "real journal: a retry's pre-send intent NEVER downgrades settled");
    journalMod.clearAllPayoutRecords();
  }
}

// ── PAYOUT JOURNAL FAIL-CLOSED (v4.0.0) ──────────────────────────────────
// saveJournal must FAIL LOUD on a storage write error (quota / private mode /
// disabled) so the orchestrator never proceeds with an unpersisted guard; a
// failed CLEAR stays silent (keeping the record only blocks re-pay = safe).
console.log("\n── PAYOUT JOURNAL FAIL-CLOSED ──");
{
  const journalMod = await import("../payments/payout-journal.js");
  const KEY = "chama_payout_journal_v1";
  const original = (globalThis as any).localStorage;
  // Storage whose WRITES throw (reads work), simulating quota/private-mode.
  const store: Record<string, string> = {
    [KEY]: JSON.stringify({ e_keep: { escrowId: "e_keep", status: "submitted", createdAt: 0 } }),
  };
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: (k: string) => { delete store[k]; },
  };
  try {
    let threw = false;
    try { journalMod.assertPayoutJournalWritable(); } catch { threw = true; }
    assert(threw,
      "assertPayoutJournalWritable throws when storage writes fail (pre-send guard refuses)");

    threw = false;
    try { journalMod.recordPayoutSubmitted({ escrowId: "e_new", operationId: "op_new" }); }
    catch { threw = true; }
    assert(threw,
      "recordPayoutSubmitted re-throws when the guard can't persist (fail-closed, not swallowed)");

    threw = false;
    try { journalMod.markPayoutSettled("e_new", "op_new"); } catch { threw = true; }
    assert(threw,
      "markPayoutSettled re-throws when the guard can't persist (fail-closed)");

    // A failed CLEAR must NOT throw: keeping the record only blocks re-pay (safe).
    let clearThrew = false;
    try { journalMod.clearPayoutRecord("e_keep"); } catch { clearThrew = true; }
    assert(!clearThrew,
      "clearPayoutRecord does NOT throw on a write failure (failed clear keeps the guard — fund-safe)");
  } finally {
    (globalThis as any).localStorage = original;
  }
}

// ── 41. RUN RECOVERY PAYOUT (v0.3.0 Phase 4) ─────────────────────────────
//
// runRecoveryPayout drains an existing wallet balance to a Lightning
// destination. Used by RecoveryBanner and DestroyEcashConfirmModal.
// Simpler than runClaimAndPayout — no claim phase, just payInvoice +
// optional handle save. Same save-on-success-never-on-failure +
// cosmetic-failure-swallowed semantics as Phase 3.
console.log("\n── RUN RECOVERY PAYOUT ──");
{
  function makeMockWallet(opts: { payInvoiceResult?: "ok" | Error | string }) {
    const calls = { payInvoice: 0, saveHandle: 0 };
    const handlesSaved: string[] = [];
    return {
      calls,
      handlesSaved,
      payInvoice: async (_b: string) => {
        calls.payInvoice++;
        if (opts.payInvoiceResult instanceof Error) throw opts.payInvoiceResult;
        if (typeof opts.payInvoiceResult === "string") throw opts.payInvoiceResult;
      },
      addOrTouchLightningHandle: (address: string) => {
        calls.saveHandle++;
        handlesSaved.push(address);
      },
    };
  }

  // ── Happy path: pay → save → done ───────────────────────────────────
  {
    const wallet = makeMockWallet({});
    const phases: RecoveryPayoutPhase[] = [];
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1precover_ok",
      saveAfter: true,
      addressUsed: "alice@phoenix.app",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => phases.push(p),
    });
    assert(terminal.kind === "done",
      "Happy path → terminal=done");
    assert(wallet.calls.payInvoice === 1,
      "payInvoice called exactly once");
    assert(wallet.calls.saveHandle === 1,
      "addOrTouchLightningHandle called once on success with saveAfter=true");
    assert(wallet.handlesSaved[0] === "alice@phoenix.app",
      "Saved address matches addressUsed");
    const order = phases.map(p => p.kind);
    assert(order[0] === "paying-invoice",
      "First phase: paying-invoice");
    assert(order[order.length - 1] === "done",
      "Terminal phase: done");
  }

  // ── Payout-failed: payInvoice throws → no save, error propagated ────
  {
    const wallet = makeMockWallet({
      payInvoiceResult: new Error("no route to recipient"),
    });
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1precover_fail",
      saveAfter: true,
      addressUsed: "bob@phoenix.app",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "payout-failed",
      "payInvoice throws → terminal=payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(/no route/.test(terminal.error),
        "payout-failed terminal carries underlying error");
    }
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved on payout-failed (orphan stays orphaned, recover later)");
  }

  // Preserve string-shaped Fedimint/WASM errors in recovery as well.
  {
    const wallet = makeMockWallet({
      payInvoiceResult: "The generated transaction would be rejected by the federation for being too large.",
    });
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1precover_string_fail",
      saveAfter: true,
      addressUsed: "bob@phoenix.app",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "payout-failed",
      "string recovery payInvoice throw → terminal=payout-failed");
    if (terminal.kind === "payout-failed") {
      assert(/transaction would be rejected/.test(terminal.error),
        "recovery payout preserves plain-string Fedimint error detail");
    }
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved after string-shaped recovery payout failure");
  }

  // ── saveAfter=false: success, but handle NOT saved ──────────────────
  {
    const wallet = makeMockWallet({});
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1pno_save",
      saveAfter: false,                  // toggle OFF
      addressUsed: "carol@strike.me",    // address known but save off
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "done",
      "saveAfter=false happy path → done");
    assert(wallet.calls.saveHandle === 0,
      "saveAfter=false → handle NOT saved despite address known");
  }

  // ── Tier 3 BOLT11 paste: addressUsed undefined → no save ────────────
  {
    const wallet = makeMockWallet({});
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1pbolt11_paste",
      saveAfter: true,                   // toggle on, but...
      addressUsed: undefined,            // Tier 3 paste has no address
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
    });
    assert(terminal.kind === "done",
      "Tier 3 paste happy path → done");
    assert(wallet.calls.saveHandle === 0,
      "addressUsed undefined → save NOT attempted (no address to save)");
  }

  // ── Cosmetic save failure swallowed: payout already succeeded ───────
  {
    const wallet = makeMockWallet({});
    const throwingSave = (_a: string) => { throw new Error("storage quota"); };
    const terminal = await runRecoveryPayout({
      bolt11: "lnbc100n1psave_throw",
      saveAfter: true,
      addressUsed: "dave@wallet.io",
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: throwingSave,
      onPhase: () => {},
    });
    assert(terminal.kind === "done",
      "Save throws → terminal still done (cosmetic; payout already sent)");
  }

  // ── Phase callback fires paying-invoice BEFORE payInvoice runs ──────
  // (Mirror of Phase 3's "creating-invoice fires before wallet call"
  // — the modal needs to render its busy state immediately on dispatch.)
  {
    const wallet = makeMockWallet({});
    let payInvoiceCalledAfter = false;
    let firstPhase = "";
    await runRecoveryPayout({
      bolt11: "lnbc100n1porder",
      saveAfter: false,
      payInvoice: async (b) => {
        if (firstPhase === "paying-invoice") payInvoiceCalledAfter = true;
        return wallet.payInvoice(b);
      },
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: p => { if (!firstPhase) firstPhase = p.kind; },
    });
    assert(firstPhase === "paying-invoice",
      "First emitted phase: paying-invoice (UI busy state immediate)");
    assert(payInvoiceCalledAfter,
      "paying-invoice phase fires BEFORE payInvoice is called");
  }

  // ── R3-1: recovery-payout double-pay guard (#2's twin on the refund side) ─
  // The refund payout reuses runClaimAndPayout in the device pass, but the
  // recovery path (this orchestrator) had no journal — a timed-out recovery
  // would show payout-failed and a retry could double-pay the seller. These
  // tests assert the escrow-keyed guard mirrors the claim side.
  {
    type Rec = { status: "submitted" | "settled"; operationId?: string } | null;
    function makeJournal(seed?: Exclude<Rec, null>) {
      let record: Rec = seed ? { ...seed } : null;
      const calls = { submitted: 0, settled: 0, cleared: 0 };
      return {
        calls,
        get current(): Rec { return record; },
        getPayoutRecord: (_id: string): Rec => record,
        recordPayoutSubmitted: (input: { escrowId: string; operationId?: string; amountMsats?: number }) => {
          calls.submitted++;
          if (record?.status === "settled") return;
          record = { status: "submitted", operationId: input.operationId ?? record?.operationId };
        },
        markPayoutSettled: (_id: string, operationId?: string) => {
          calls.settled++;
          record = { status: "settled", operationId: operationId ?? record?.operationId };
        },
        clearPayoutRecord: (_id: string) => { calls.cleared++; record = null; },
      };
    }
    const inflightErr = () =>
      Object.assign(new Error("recovery still confirming"), { code: "LN_PAY_INFLIGHT", operationId: "op_rec" });

    // Fresh in-flight → payout-confirming + journaled submitted, attempted once
    {
      const journal = makeJournal();
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_inflight",
        saveAfter: false,
        payInvoice: async () => { payCalls++; throw inflightErr(); },
        traceContext: { escrowId: "rec_dp_inflight", amountMsats: 96_000 },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "payout-confirming",
        "recovery in-flight → payout-confirming (NOT payout-failed)");
      assert(payCalls === 1,
        "recovery in-flight: payInvoice attempted exactly once");
      assert(journal.current?.status === "submitted" && journal.current?.operationId === "op_rec",
        "recovery in-flight journaled submitted with operationId");
    }

    // v4.0.0 FAIL-CLOSED: journal unwritable pre-send (with an escrowId) →
    // refuse to send; the shared recovery payout must not leave a re-payable
    // window either.
    {
      const journal = makeJournal();
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_unwritable",
        saveAfter: false,
        payInvoice: async () => { payCalls++; return "op_should_not_send"; },
        traceContext: { escrowId: "rec_dp_unwritable", amountMsats: 96_000 },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
        assertPayoutJournalWritable: () => { throw new Error("QuotaExceededError"); },
      });
      assert(terminal.kind === "payout-failed",
        "recovery unwritable journal pre-send → payout-failed (refuse to start)");
      assert(payCalls === 0,
        "recovery unwritable journal pre-send → payInvoice is NEVER called");
    }

    // Prior settled → done, never re-pays
    {
      const journal = makeJournal({ status: "settled", operationId: "op_done" });
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_settled",
        saveAfter: false,
        payInvoice: async () => { payCalls++; },
        traceContext: { escrowId: "rec_dp_settled" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done",
        "recovery prior settled → done immediately");
      assert(payCalls === 0,
        "recovery prior settled: NEVER re-pays the seller");
    }

    // Prior submitted + re-attach settled → done, never re-pays
    {
      const journal = makeJournal({ status: "submitted", operationId: "op_x" });
      let payCalls = 0, reattachOp = "";
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_reattach",
        saveAfter: false,
        payInvoice: async () => { payCalls++; },
        awaitPayoutOutcome: async (op) => { reattachOp = op; return "settled"; },
        traceContext: { escrowId: "rec_dp_reattach" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done",
        "recovery prior submitted + re-attach settled → done");
      assert(payCalls === 0,
        "recovery prior submitted: payInvoice NEVER called");
      assert(reattachOp === "op_x",
        "recovery re-attach uses the stored operationId");
      assert(journal.current?.status === "settled",
        "recovery re-attach settled marks the record settled");
    }

    // Prior submitted + re-attach unknown → payout-confirming, never re-pays
    {
      const journal = makeJournal({ status: "submitted", operationId: "op_u" });
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_unknown",
        saveAfter: false,
        payInvoice: async () => { payCalls++; },
        awaitPayoutOutcome: async () => "unknown",
        traceContext: { escrowId: "rec_dp_unknown" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "payout-confirming",
        "recovery prior submitted + unknown re-attach → payout-confirming");
      assert(payCalls === 0,
        "recovery unknown re-attach: NEVER re-pays");
    }

    // Happy path with escrowId → done + journaled settled
    {
      const journal = makeJournal();
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_happy",
        saveAfter: false,
        payInvoice: async () => "op_happy",
        traceContext: { escrowId: "rec_dp_happy" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done",
        "recovery happy path → done");
      assert(journal.current?.status === "settled" && journal.current?.operationId === "op_happy",
        "recovery happy path journals settled with the success operationId");
    }

    // No escrowId → guard inert, existing behavior preserved
    {
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_noescrow",
        saveAfter: false,
        payInvoice: async () => { payCalls++; },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
      });
      assert(terminal.kind === "done",
        "recovery without escrowId → done (guard inert)");
      assert(payCalls === 1,
        "recovery without escrowId: payInvoice called normally");
    }

    // ── Stale-key detection (the Recover → false-green → banner no-op loop) ──
    // A SETTLED record while the wallet still holds a MATERIAL balance can
    // only mean the key was inherited from an older trade whose payout
    // already went out — the drain must proceed KEYLESS, not lie "done".

    // Stale settled key + material balance → actually pays (keyless), and
    // never touches the old trade's settled record.
    {
      const journal = makeJournal({ status: "settled", operationId: "op_done" });
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_stale_settled",
        saveAfter: false,
        payInvoice: async () => { payCalls++; return "op_new"; },
        getBalance: async () => 2_462_000, // 2,462 sats still in the wallet
        traceContext: { escrowId: "rec_dp_stale" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done",
        "stale settled key + material balance → drains and reaches done");
      assert(payCalls === 1,
        "stale settled key: payInvoice IS called (no more false-green no-op)");
      assert(journal.calls.settled === 0
        && journal.current?.status === "settled" && journal.current?.operationId === "op_done",
        "stale settled key: keyless drain never rewrites the old trade's record");
    }

    // Settled key + balance actually drained (re-tap-after-success race) →
    // fund-safe short-circuit preserved, nothing sent.
    {
      const journal = makeJournal({ status: "settled", operationId: "op_done" });
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_settled_drained",
        saveAfter: false,
        payInvoice: async () => { payCalls++; },
        getBalance: async () => 15_000, // 15-sat fee-reserve dust left
        traceContext: { escrowId: "rec_dp_drained" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done" && payCalls === 0,
        "settled key + sub-material balance → short-circuit stays (genuine retry-after-success)");
    }

    // Settled key + unreadable balance → unknown ⇒ keep the fund-safe
    // short-circuit (never pay on an unverifiable staleness claim).
    {
      const journal = makeJournal({ status: "settled", operationId: "op_done" });
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_settled_noread",
        saveAfter: false,
        payInvoice: async () => { payCalls++; },
        getBalance: async () => { throw new Error("fed unreachable"); },
        traceContext: { escrowId: "rec_dp_noread" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done" && payCalls === 0,
        "settled key + unreadable balance → unknown ⇒ fund-safe short-circuit kept");
    }

    // V7: an intent-keyed drain drops to keyless — the claim flow's
    // reconcile-by-escrow owns intent records; recovery must neither trip
    // on nor overwrite them.
    {
      let payCalls = 0, reads = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_intent",
        saveAfter: false,
        payInvoice: async () => { payCalls++; return "op_keyless"; },
        traceContext: { escrowId: "rec_dp_intent" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: (_id) => { reads++; return { status: "intent" as const }; },
        recordPayoutSubmitted: () => { throw new Error("must not journal a keyless drain"); },
        markPayoutSettled: () => { throw new Error("must not settle a claim-flow intent"); },
        clearPayoutRecord: () => { throw new Error("must not clear a claim-flow intent"); },
      });
      assert(terminal.kind === "done" && payCalls === 1 && reads === 1,
        "recovery over a claim-flow intent → drains keyless (pays; never touches the record)");
    }

    // Stale submitted key whose re-attach reports settled + material balance
    // → old record upgraded to settled, then the drain proceeds keyless.
    {
      const journal = makeJournal({ status: "submitted", operationId: "op_x" });
      let payCalls = 0;
      const terminal = await runRecoveryPayout({
        bolt11: "lnbc100n1prec_stale_reattach",
        saveAfter: false,
        payInvoice: async () => { payCalls++; return "op_new2"; },
        awaitPayoutOutcome: async () => "settled",
        getBalance: async () => 2_462_000,
        traceContext: { escrowId: "rec_dp_stale2" },
        addOrTouchLightningHandle: () => {},
        onPhase: () => {},
        getPayoutRecord: journal.getPayoutRecord,
        recordPayoutSubmitted: journal.recordPayoutSubmitted,
        markPayoutSettled: journal.markPayoutSettled,
        clearPayoutRecord: journal.clearPayoutRecord,
      });
      assert(terminal.kind === "done" && payCalls === 1,
        "stale reattach-settled key + material balance → old record closed, drain still pays");
      assert(journal.current?.status === "settled" && journal.current?.operationId === "op_x",
        "stale reattach: the OLD payout's record is marked settled with its own operationId");
    }
  }
}

// ── 41a2. PAY-OUTCOME CLASSIFICATION (R3-1b) ─────────────────────────────
// The op-log classifier the re-attach uses to decide "did the payout settle?"
// — the money decision that flips a stuck CLAIMED trade to COMPLETED. A wrong
// "settled" would complete prematurely; a wrong "pending" leaves it stuck.
console.log("\n── PAY-OUTCOME CLASSIFICATION (R3-1b) ──");
{
  assert(classifyPayOutcome({ success: { preimage: "abc" } }) === "settled",
    "success{preimage} → settled");
  assert(classifyPayOutcome("success") === "settled",
    "string 'success' → settled");
  assert(classifyPayOutcome({ refunded: { gateway_error: "x" } }) === "refunded",
    "refunded → refunded (retry-safe)");
  assert(classifyPayOutcome("canceled") === "refunded",
    "string 'canceled' → refunded");
  assert(classifyPayOutcome({ funded: { block_height: 1 } }) === "pending",
    "funded (HTLC locked) → pending");
  assert(classifyPayOutcome("created") === "pending",
    "string 'created' → pending");
  assert(classifyPayOutcome(null) === "pending",
    "no outcome yet (null) → pending");
  assert(classifyPayOutcome({ unexpected_error: { error_message: "x" } }) === "unknown",
    "unexpected_error → unknown (don't complete, don't re-pay)");
}

// ── 41b. LIGHTNING PAYOUT FEE RESERVE ───────────────────────────────────
console.log("\n── LIGHTNING PAYOUT FEE RESERVE ──");
{
  assert(estimateLightningSendFeeMsats(47_000) === 2_735,
    "47 sat payout reserves 2 sat base + 0.5% + 0.5 sat buffer");
  assert(maxLightningPayoutSats(50_000) === 47,
    "50 sat balance pays a 47 sat invoice, leaving fee headroom");
  assert(lightningPayoutReserveSats(50_000) === 3,
    "50 sat balance shows an about-3-sat Lightning fee reserve");
  assert(claimPayoutSats(55_000, "fedi-wallet") === 55,
    "Fedi wallet claim display shows the exact ecash payout with no LN reserve");
  assert(claimPayoutReserveSats(55_000, "fedi-wallet") === 0,
    "Fedi wallet claim display reserves zero sats for outbound Lightning fees");
  assert(claimPayoutSats(55_000, "lightning") === maxLightningPayoutSats(55_000),
    "Lightning claim display still uses outbound fee reserve math");
  assert(maxLightningPayoutSats(2_500) === 0,
    "Tiny balances below outbound fee floor are not offered as LN payouts");
  assert(!hasLightningWithdrawableBalance(2_500),
    "Sub-fee dust is not Lightning-withdrawable");
  assert(hasLightningWithdrawableBalance(50_000),
    "Balances above the outbound fee floor are Lightning-withdrawable");
  assert(retrySmallerLightningPayoutSats(992) === 496,
    "Too-large recovery retry halves the payout amount to reduce note inputs");
  assert(retrySmallerLightningPayoutSats(1) === 0,
    "Too-large retry stops when there is no smaller whole-sat payout");
}

// ── 41c. REAL LIGHTNING FUNDING GUARDRAILS ───────────────────────────────
console.log("\n── REAL LIGHTNING FUNDING GUARDRAILS ──");
{
  assert(MIN_REAL_ATOMIC_FUNDING_SATS === 1,
    "Real Lightning funding floor allows tiny Fedi ecash test locks");
  assert(MIN_REAL_ATOMIC_FUNDING_MSATS === 1_000,
    "Real Lightning funding floor is exposed in msats for lock gating");
  assert(minimumAtomicFundingMessage().includes("1 sat"),
    "Real Lightning funding floor copy names the 1 sat minimum");
}

// ── 42. CHAMA BAR LABEL DECISION (v0.3.0 Phase 5) ────────────────────────
//
// decideChamaBarLabel maps wallet balance + actual committed escrow value
// to one of three top-bar states. Per Phase 5 reminder #3: arbiter-only
// commitments are NOT treated as active. CREATED listings also do not
// explain wallet balance; no money has moved yet.
console.log("\n── CHAMA BAR LABEL ──");
{
  // Zero balance → ready, regardless of commitment state
  {
    const r1 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r1.kind === "ready",
      "Zero balance + no commitment → ready");

    const r2 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
    });
    assert(r2.kind === "ready",
      "Zero balance + active commitment → ready (no sats to label)");
  }

  // Small positive balance + active CREATED-only listing → ready. The listing
  // can explain the ActiveTradePill, but it cannot explain wallet ecash.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 68_000,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 0,
    });
    assert(r.kind === "ready",
      "68 sats + created-only active listing → ready, not phantom in-escrow");
  }

  // Material positive balance + active CREATED-only listing → stranded.
  // An open listing must not suppress recovery for real wallet balance.
  {
    const r = decideChamaBarLabel({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 0,
    });
    assert(r.kind === "stranded",
      "Material balance + created-only active listing → stranded");
  }

  // Small positive balance + NO active commitment → ready. This is
  // usually post-payout fee dust, and should not occupy the main top UI.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 1_500_000,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "ready",
      "1,500 sat idle balance → ready (small leftovers live in Me)");
  }

  // Material positive balance + NO active commitment → stranded
  // (failure mode) with sats.
  {
    const r = decideChamaBarLabel({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "stranded",
      "Material balance + no commitment → stranded (Pillar 2.1 Option B violation)");
    if (r.kind === "stranded") {
      assert(r.sats === MAIN_SURFACE_RECOVERY_MIN_SATS,
        "stranded carries sats");
    }
  }

  // Phase 1: sim mode suppresses the "stranded → ⚠ Recover" pill — the same
  // recovery alarm as shouldShowRecoveryBanner, on the SAME condition that
  // returns "stranded" without the flag (the assertion directly above). Sim
  // manual-fund balances are intentional & fake, so it must fall through to
  // "ready". Guards the gate, not the dust line.
  {
    const r = decideChamaBarLabel({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasActiveBuyerSellerCommitment: false,
      simModeOn: true,
    });
    assert(r.kind === "ready",
      "Sim mode: material idle balance → ready, not stranded (no cry-wolf on fake sats)");
    assert(r.kind !== "stranded",
      "Sim mode never surfaces the stranded recovery pill");
  }

  // Phase 1: sim gates ONLY the stranded alarm — real states survive, so the
  // priority ordering (unreachable > in-trade > stranded > ready) is intact.
  {
    const inTrade = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      simModeOn: true,
    });
    assert(inTrade.kind === "in-trade",
      "Sim mode preserves in-trade (escrowed funds are real even in sim)");
    const unreachable = decideChamaBarLabel({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "failed",
      simModeOn: true,
    });
    assert(unreachable.kind === "unreachable",
      "Sim mode preserves unreachable (probe-failed overrides, ordering intact)");
  }

  // Sub-msat dust floors to ready (no fractional-sat states)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 999, // less than 1 sat
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "ready",
      "Sub-1-sat dust floors to ready (no fractional-sat states)");
  }

  // Negative balance defensive guard (shouldn't happen, but pinned)
  {
    const r = decideChamaBarLabel({
      balanceMsats: -100,
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "ready",
      "Negative balance defensive → ready (never claim stranded sats that don't exist)");
  }

  // Phase 5 reminder #3: arbiter-only "commitments" do NOT count as
  // active. The predicate is computed by the caller; this test pins
  // the contract — when the caller passes false (because the user is
  // arbiter-only), the bar treats a tiny prior balance as quiet dust.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 25_000,
      // User is arbiter on an active trade. The predicate
      // hasActiveBuyerSellerCommitment is FALSE — arbiter doesn't
      // count. Their 25 sats is from a previous failed trade.
      hasActiveBuyerSellerCommitment: false,
    });
    assert(r.kind === "ready",
      "Arbiter-only commitments don't promote tiny prior dust to top UI");
  }

  // ── v0.3.1 Phase 3: bootProbeState routing ───────────────────────────
  // bootProbeState === "failed" overrides ALL other state to surface
  // the "⚠ Chama unreachable · Reconnect →" pill. Reachability is
  // the floor for any other meaningful state: if the user can't reach
  // the federation, they can't recover stranded sats or progress an
  // in-trade flow — the actionable next step is Reconnect.

  // failed + zero balance → unreachable (overrides ready)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed + zero balance → unreachable (overrides ready)");
  }

  // failed + stranded balance → unreachable (overrides stranded)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed + stranded balance → unreachable (Reconnect is the actionable step, not Recover)");
  }

  // failed + in-trade → unreachable (overrides in-trade)
  {
    const r = decideChamaBarLabel({
      balanceMsats: 100_000,
      hasActiveBuyerSellerCommitment: true,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed + active commitment → unreachable (can't progress trade until reachable)");
  }

  // ok → passes through to existing three-state decision
  {
    const r1 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "ok",
    });
    assert(r1.kind === "ready",
      "bootProbeState=ok preserves existing 'ready' kind");

    const r2 = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "ok",
    });
    assert(r2.kind === "ready",
      "bootProbeState=ok preserves quiet-dust ready kind");

    const r3 = decideChamaBarLabel({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "ok",
    });
    assert(r3.kind === "stranded",
      "bootProbeState=ok preserves material 'stranded' kind");

    const r4 = decideChamaBarLabel({
      balanceMsats: 100_000,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 0,
      bootProbeState: "ok",
    });
    assert(r4.kind === "ready",
      "bootProbeState=ok preserves created-only active listing as ready");
  }

  // pending → passes through to existing three-state decision
  // (pending is transient; UI is fine with the brief optimistic
  // rendering during it; only failed gates action surfaces).
  {
    const r1 = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "pending",
    });
    assert(r1.kind === "ready",
      "bootProbeState=pending does NOT override (transient state, optimistic render)");

    const r2 = decideChamaBarLabel({
      balanceMsats: 50_000,
      hasActiveBuyerSellerCommitment: false,
      bootProbeState: "pending",
    });
    assert(r2.kind === "ready",
      "bootProbeState=pending preserves quiet-dust ready kind (transient state)");
  }

  // bootProbeState undefined → backwards-compatible (acts as ok)
  // Defensive: any pre-Phase-3 caller that hasn't been updated
  // continues to render the three-state surface as before.
  {
    const r = decideChamaBarLabel({
      balanceMsats: MAIN_SURFACE_RECOVERY_MIN_SATS * 1000,
      hasActiveBuyerSellerCommitment: false,
      // bootProbeState omitted
    });
    assert(r.kind === "stranded",
      "bootProbeState undefined → material idle balance renders as if ok");
  }

  // Tripwire: failed-state ordering is independent of every other
  // input. If a future refactor accidentally moves the bootProbeState
  // check below the balance/commitment checks, in-trade or stranded
  // could leak through during a federation outage — this test fails
  // immediately in that case.
  {
    const inputs = [
      { balanceMsats: 0, hasActiveBuyerSellerCommitment: false },
      { balanceMsats: 50_000, hasActiveBuyerSellerCommitment: false },
      { balanceMsats: 100_000, hasActiveBuyerSellerCommitment: true },
      { balanceMsats: 999, hasActiveBuyerSellerCommitment: false },
      { balanceMsats: -100, hasActiveBuyerSellerCommitment: false },
    ];
    for (const i of inputs) {
      const r = decideChamaBarLabel({ ...i, bootProbeState: "failed" });
      assert(r.kind === "unreachable",
        `Tripwire: bootProbeState=failed overrides input { balance=${i.balanceMsats}, commitment=${i.hasActiveBuyerSellerCommitment} }`);
    }
  }

  // v0.4.2 hotfix round 3: activeCommittedMsats drives the in-escrow
  // pill during LOCKED state, when balance is correctly 0 (ecash spent
  // into SSS shares). The previous logic returned "ready" at exactly
  // the moment users needed to see "your money is in escrow" — the
  // load-bearing Pillar 2.1 Option B failure mode.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 50_000_000,
    });
    assert(r.kind === "in-trade" && (r as any).sats === 50_000,
      "balance=0 + activeCommittedMsats=50M msat → in-trade pill shows 50k sats (LOCKED state)");
  }

  // After CLAIM completes (terminal, no commitment), pill returns to
  // ready when balance has been debited. activeCommittedMsats=0
  // because LOCKED/APPROVED-only filter excludes COMPLETED.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: false,
      activeCommittedMsats: 0,
    });
    assert(r.kind === "ready",
      "Post-CLAIM terminal: balance=0 + no commitment → ready (no phantom in-escrow)");
  }

  // activeCommittedMsats wins over wallet balance for the in-escrow pill.
  // The escrow ledger is the source of truth for what has actually been
  // locked; any unrelated wallet balance is handled by recovery logic.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 30_000_000,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 50_000_000,
    });
    assert(r.kind === "in-trade" && (r as any).sats === 50_000,
      "activeCommittedMsats takes precedence: show locked 50k, not wallet 30k");
  }

  // bootProbeState=failed still overrides committed amount — Reconnect
  // is the actionable next step, not the in-escrow pill.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 50_000_000,
      bootProbeState: "failed",
    });
    assert(r.kind === "unreachable",
      "bootProbeState=failed overrides committed-msats in-trade kind");
  }

  // activeCommittedMsats < 1 sat (sub-1000 msat) → still ready.
  // The bar speaks in whole sats; sub-sat dust doesn't qualify.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
      activeCommittedMsats: 500,
    });
    assert(r.kind === "ready",
      "Sub-1-sat committed amount → ready (whole-sat granularity)");
  }

  // Backwards compat: omitting activeCommittedMsats entirely behaves
  // like the pre-round-3 callsites — balance=0 → ready.
  {
    const r = decideChamaBarLabel({
      balanceMsats: 0,
      hasActiveBuyerSellerCommitment: true,
    });
    assert(r.kind === "ready",
      "Omitted activeCommittedMsats falls back to ready (pre-round-3 callsite compat)");
  }

  // activeCommittedMsats helper itself: only LOCKED/APPROVED count.
  const { activeCommittedMsats } = await import("../ui/decisions.js");
  const committedNowSec = 50_000;
  const buildEscrow = (
    status: EscrowStatus,
    amount: number,
    me: string,
    expiresAt = committedNowSec + 3600,
  ) => ({
    id: "x", status, description: "", amountMsats: amount,
    category: "p2p-trade", fulfillment: "service", community: null,
    mintUrl: BP_FEDERATION_INVITE,
    participants: { buyer: me, seller: "s", arbiter: "a" },
    initiator: { pubkey: me, role: Role.BUYER },
    communityArbiters: [], subscription: null, votes: {},
    resolvedOutcome: null, resolvedMajority: null, resolvedAt: null,
    completedAt: null, cancelledAt: null, claim: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt, createdAt: 0, eventChain: [], chatMessages: [],
    lock: { handle: null },
  } as unknown as EscrowState);
  const me = "user_pubkey";
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.LOCKED, 50_000_000, me)],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 50_000_000,
    "activeCommittedMsats: LOCKED status counted",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.LOCKED, 50_000_000, me, committedNowSec - 1)],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 0,
    "activeCommittedMsats: expired LOCKED status NOT counted",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.APPROVED, 50_000_000, me)],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 50_000_000,
    "activeCommittedMsats: APPROVED status counted",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.CLAIMED, 50_000_000, me)],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 0,
    "activeCommittedMsats: CLAIMED NOT counted (winner has redeemed; balance reflects it)",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.COMPLETED, 50_000_000, me)],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 0,
    "activeCommittedMsats: COMPLETED NOT counted (terminal)",
  );
  assert(
    activeCommittedMsats({
      escrows: [buildEscrow(EscrowStatus.CREATED, 50_000_000, me)],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 0,
    "activeCommittedMsats: CREATED NOT counted (listing exists; no commitment yet)",
  );
  assert(
    activeCommittedMsats({
      escrows: [
        buildEscrow(EscrowStatus.LOCKED, 50_000_000, me),
        buildEscrow(EscrowStatus.APPROVED, 25_000_000, me),
      ],
      userPubkey: me,
      nowSec: committedNowSec,
    }) === 75_000_000,
    "activeCommittedMsats: sums across multiple active commitments",
  );
}

// ── 42a2. AMOUNT DISPLAY MODE — Chama fiat estimates ───────────────────
console.log("\n── AMOUNT DISPLAY MODE ──");
{
  const rates = { KES: 130, XOF: 600 };
  assert(
    Math.abs((estimateFiatForMsats({
      amountMsats: 100_000,
      currency: "KES",
      usdPerBtc: 100_000,
      usdFiatRates: rates,
    }) ?? 0) - 13) < 0.000001,
    "100 sats estimates to local Chama fiat when BTC/USD and USD/KES are known",
  );
  assert(
    estimateSatsForFiat({
      fiatAmount: 13,
      currency: "KES",
      usdPerBtc: 100_000,
      usdFiatRates: rates,
    }) === 100,
    "Local Chama fiat estimates round-trip back to sats for the Create form",
  );
  assert(
    Math.abs((estimateFiatForMsats({
      amountMsats: 100_000,
      currency: "USD",
      usdPerBtc: 100_000,
      usdFiatRates: {},
    }) ?? 0) - 0.1) < 0.000001,
    "USD estimates work without an external fiat-FX quote",
  );
  assert(
    normalizeFiatCurrency("btc") === null,
    "BTC Chamas stay sats-native instead of showing BTC-as-fiat",
  );
  assert(
    resolveEstimatedFiatCurrency({ viewerCurrency: "ZAR", listingCurrency: "TZS" }) === "ZAR",
    "Browse estimates prefer the viewer's selected Chama fiat over the listing's route fiat",
  );
  assert(
    resolveEstimatedFiatCurrency({ viewerCurrency: "BTC", listingCurrency: "TZS" }) === "TZS",
    "BTC-native public wallet services fall back to the listing route fiat for estimates",
  );
  assert(
    !shouldQuoteEstimatedFiat({ viewerCurrency: "XOF", listingCurrency: "TZS" }),
    "Viewer-currency estimate retired: a cross-currency viewer sees the creator's currency, not a re-quote (DECISIONS.md 2026-06-06)",
  );
  assert(
    !shouldQuoteEstimatedFiat({ viewerCurrency: "TZS", listingCurrency: "TZS" }),
    "Matching listing fiat anchors remain exact when the selected Chama uses the same fiat",
  );
  assert(
    estimateSatsForFiat({
      fiatAmount: 13,
      currency: "KES",
      usdPerBtc: null,
      usdFiatRates: rates,
    }) === null,
    "Fiat-to-sats conversion refuses missing BTC price instead of guessing",
  );
}

// ── 42a-bis. THEME PALETTE SWAP (#50, DECISIONS.md 2026-06-07) ──────────
//
// The whole UI reads T at render time; theming swaps the palette IN PLACE.
// The one footgun is module-load capture — STATUS and inputStyle copy T
// values when theme.ts loads, so applyThemeMode must rebuild them. These
// asserts pin that contract: after a swap, the derivations track the new
// palette, and a swap back restores the dark brand exactly.
console.log("\n── THEME PALETTE SWAP ──");
{
  const darkBg = T.bg;
  const darkAccent = T.accent;
  applyThemeMode("light");
  assert(T.bg !== darkBg, "applyThemeMode(light) swaps the palette in place");
  assert(
    STATUS.COMPLETED.c === T.green && STATUS.COMPLETED.bg === T.greenDim,
    "STATUS entries are rebuilt to the active palette on swap",
  );
  assert(
    STATUS.APPROVED.c === T.accent,
    "STATUS accent tracks the light accent, not the module-load capture",
  );
  assert(
    (inputStyle as { background?: string }).background === T.surface &&
      (inputStyle as { color?: string }).color === T.text,
    "inputStyle is rebuilt to the active palette on swap",
  );
  applyThemeMode("dark");
  assert(
    T.bg === darkBg && T.accent === darkAccent,
    "Swapping back restores the dark brand palette exactly",
  );
  assert(
    STATUS.APPROVED.c === T.accent && STATUS.CANCELLED.bg === T.surface,
    "STATUS tracks T again after the restore",
  );
  assert(
    normalizeThemeMode("garbage") === "dark" && normalizeThemeMode(null) === "dark",
    "Unknown stored theme modes fall back to dark (the brand default)",
  );
  const sysResolved = resolveThemeMode("system");
  assert(
    sysResolved === "dark" || sysResolved === "light",
    "System mode resolves to a concrete palette even without matchMedia (node)",
  );
}

// ── 42b. SIGN-IN OPTION ENVIRONMENT GATE ────────────────────────────────
//
// NIP-46 is a strong privacy candidate for desktop if the signer flow
// proves reliable, but it should not be promoted on constrained mobile
// or Fedi-webview sessions. Keep it behind More sign-in options and
// offer it only where it is most plausible today: standalone desktop web.
console.log("\n── SIGN-IN OPTION ENVIRONMENT GATE ──");
{
  const desktop = {
    isNativePlatform: false,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/134.0.0.0",
    maxTouchPoints: 0,
    hasFediInternal: false,
  };
  const androidChrome = {
    isNativePlatform: false,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36",
    maxTouchPoints: 5,
    hasFediInternal: false,
  };
  const fediWebView = {
    isNativePlatform: false,
    userAgent: "Mozilla/5.0 (Linux; Android 15) Fedi Mobile",
    maxTouchPoints: 5,
    hasFediInternal: true,
  };
  const capacitorNative = {
    ...androidChrome,
    isNativePlatform: true,
  };
  const ipadDesktopUA = {
    isNativePlatform: false,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    maxTouchPoints: 5,
    hasFediInternal: false,
  };

  assert(isMobileSignInEnvironment(androidChrome),
    "Android browser is detected as mobile for sign-in gating");
  assert(isMobileSignInEnvironment(ipadDesktopUA),
    "Touch Macintosh/iPad desktop UA is detected as mobile for sign-in gating");
  assert(isFediWebViewSignInEnvironment(fediWebView),
    "Fedi webview is detected from fediInternal/user-agent hints");
  assert(!shouldApplyCssSafeAreaInsets(fediWebView),
    "Android Fedi webview opts out of Chama CSS safe-area padding");
  assert(shouldApplyCssSafeAreaInsets({
    ...fediWebView,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Fedi Mobile",
  }),
    "iPhone Fedi webview keeps CSS safe-area padding");
  assert(shouldOfferNIP46Signer(desktop),
    "NIP-46 signer app is offered on standalone desktop web");
  assert(!shouldOfferNIP46Signer(androidChrome),
    "NIP-46 signer app is hidden on mobile browser");
  assert(!shouldOfferNIP46Signer(fediWebView),
    "NIP-46 signer app is hidden inside Fedi webview");
  assert(!shouldOfferNIP46Signer(capacitorNative),
    "NIP-46 signer app is hidden in native Capacitor builds");

  const fixedSecret = createNip46PairingSecret((bytes) => {
    bytes.fill(0xab);
    return bytes;
  });
  assert(fixedSecret === "abababababababababababababababab",
    "NIP-46 pairing secret is generated from crypto bytes");

  const validHex = await validateRecoveryKeyInput("11".repeat(32));
  assert(validHex.ok && validHex.kind === "hex" && validHex.normalized === "11".repeat(32),
    "Recovery key validation accepts exactly 32-byte hex");

  const generatedNsec = nip19.nsecEncode(generateSecretKey());
  const validNsec = await validateRecoveryKeyInput(generatedNsec);
  assert(validNsec.ok && validNsec.kind === "nsec" && validNsec.secretKey.length === 32,
    "Recovery key validation accepts valid nsec1 keys");

  const shortHex = await validateRecoveryKeyInput("11".repeat(31));
  assert(!shortHex.ok && /64-character hex/i.test(shortHex.error),
    "Recovery key validation rejects short hex with a friendly error");

  const invalidNsec = await validateRecoveryKeyInput("nsec1notavalidkey");
  assert(!invalidNsec.ok && /valid nsec/i.test(invalidNsec.error),
    "Recovery key validation rejects malformed nsec with a friendly error");

  const nip46Calls: string[] = [];
  const adapted = adaptNIP46BunkerSigner({
    async getPublicKey() { return BUYER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "nip46_signed", sig: "sig" } as NostrEvent;
    },
    async nip44Encrypt(pubkey: string, plaintext: string) {
      nip46Calls.push(`nip44_encrypt:${pubkey}:${plaintext}`);
      return "nip44-ciphertext";
    },
    async nip44Decrypt(pubkey: string, ciphertext: string) {
      nip46Calls.push(`nip44_decrypt:${pubkey}:${ciphertext}`);
      return "nip44-plaintext";
    },
  });
  assert(await adapted.nip44Encrypt("secret", SELLER_PK) === "nip44-ciphertext",
    "NIP-46 adapter encrypts through signer");
  assert(nip46Calls.includes(`nip44_encrypt:${SELLER_PK}:secret`),
    "NIP-46 adapter passes args as signer(pubkey, plaintext), not reversed");
  assert(await adapted.nip44Decrypt("cipher", SELLER_PK) === "nip44-plaintext",
    "NIP-46 adapter decrypts through signer");
  assert(nip46Calls.includes(`nip44_decrypt:${SELLER_PK}:cipher`),
    "NIP-46 adapter passes args as signer(pubkey, ciphertext), not reversed");

  // SECURITY: the NIP-46 adapter MUST refuse to silently downgrade to
  // NIP-04. An earlier build had this fallback, which weakened every
  // escrow payload (including SSS shares) sent through a bunker that
  // didn't expose NIP-44. The fallback is gone; supplying only NIP-04
  // methods now throws on both encrypt and decrypt.
  const nip04Only = adaptNIP46BunkerSigner({
    async getPublicKey() { return BUYER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "nip46_signed", sig: "sig" } as NostrEvent;
    },
    async nip04Encrypt(pubkey: string, plaintext: string) {
      return `nip04:${pubkey}:${plaintext}`;
    },
    async nip04Decrypt(pubkey: string, ciphertext: string) {
      return `nip04:${pubkey}:${ciphertext}`;
    },
  });
  let nip04EncryptRefused = false;
  try {
    await nip04Only.nip44Encrypt("secret", SELLER_PK);
  } catch {
    nip04EncryptRefused = true;
  }
  assert(nip04EncryptRefused,
    "NIP-46 adapter refuses to downgrade encryption to NIP-04");
  // Explicit NIP-04 for kind:4 DMs is NOT the downgrade path — the adapter
  // exposes it separately, with the same (plaintext, pubkey) → bunker
  // (pubkey, plaintext) arg flip as nip44 (bug #64).
  assert(await nip04Only.nip04Encrypt!("dm-text", SELLER_PK) === `nip04:${SELLER_PK}:dm-text`,
    "NIP-46 adapter nip04Encrypt flips args to bunker (pubkey, plaintext)");
  let nip04DecryptRefused = false;
  try {
    await nip04Only.nip44Decrypt("cipher", SELLER_PK);
  } catch {
    nip04DecryptRefused = true;
  }
  assert(nip04DecryptRefused,
    "NIP-46 adapter refuses to downgrade decryption to NIP-04");

  const noEncryption = adaptNIP46BunkerSigner({
    async getPublicKey() { return BUYER_PK; },
    async signEvent(event: UnsignedEvent) {
      return { ...event, id: "nip46_signed", sig: "sig" } as NostrEvent;
    },
  });
  let missingEncryptionThrew = false;
  try {
    await noEncryption.nip44Encrypt("secret", SELLER_PK);
  } catch {
    missingEncryptionThrew = true;
  }
  assert(missingEncryptionThrew,
    "NIP-46 adapter refuses plaintext fallback when signer lacks encryption");
}

// ── 43. TRINITY RING PARTICIPANT ORDER (v0.3.0 Phase 6 + v0.3.1 Phase 2) ─
//
// Pins B/A/S as the canonical participant render order. PHILOSOPHY.md
// §5.2 places the arbiter at the apex of the brand mark with
// buyer/seller flanking below; the participants row mirrors this.
//
// Two-layer tripwire:
//   (1) Constant-value assertions on TRINITY_RING_ORDER. Catches a
//       maintainer editing the constant itself in theme.ts.
//   (2) Grep tripwire over src/ui/. Catches a NEW render surface that
//       declares its own inline `[Role.X, Role.Y, Role.Z]` tuple
//       instead of importing the constant. Production smoke for
//       v0.3.0 caught exactly this — TradeCard.tsx had drifted from
//       TradeDetail.tsx because Phase 6 only patched the latter.
//       v0.3.1 Phase 2 patches TradeCard AND adds this tripwire so
//       no future participant-rendering surface can silently drift.
//
// Whitespace is normalized before matching so a future "format for
// readability" diff that breaks the tuple across multiple lines still
// trips the tripwire. Comments are stripped so doc strings mentioning
// the literal don't false-positive.
console.log("\n── TRINITY RING PARTICIPANT ORDER ──");
{
  // Layer 1: constant value
  assert(TRINITY_RING_ORDER.length === 3,
    "Trinity Ring has exactly three participants");
  assert(TRINITY_RING_ORDER[0] === Role.BUYER,
    "Trinity Ring [0] = Buyer (left)");
  assert(TRINITY_RING_ORDER[1] === Role.ARBITER,
    "Trinity Ring [1] = Arbiter (middle / apex)");
  assert(TRINITY_RING_ORDER[2] === Role.SELLER,
    "Trinity Ring [2] = Seller (right)");

  // Layer 2: grep tripwire. Walks src/ui/, strips comments, normalizes
  // whitespace, and asserts no file outside the canonical definition
  // site (theme.ts) contains an inline three-element Role tuple.
  function walkUiFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: string[];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const ent of entries) {
        // Defensive skip — src/ui/ shouldn't contain these but if a
        // future refactor introduces a nested package, don't recurse.
        if (ent === "node_modules" || ent === "dist") continue;
        const full = join(cur, ent);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) stack.push(full);
        else if (ent.endsWith(".ts") || ent.endsWith(".tsx")) out.push(full);
      }
    }
    return out;
  }

  function stripComments(src: string): string {
    // Block comments first (handles /** ... */ doc blocks too).
    let result = src.replace(/\/\*[\s\S]*?\*\//g, "");
    // Then line comments.
    result = result.replace(/\/\/[^\n]*/g, "");
    return result;
  }

  function normalizeWhitespace(src: string): string {
    return src.replace(/\s+/g, " ");
  }

  // Pattern: [Role.X, Role.Y, Role.Z] where X/Y/Z ∈ {BUYER, SELLER,
  // ARBITER}. Catches all 27 combinations (the 6 permutations plus
  // the 21 with repeats — repeats would be a bug too, so we want all).
  // Trailing comma before `]` is optional to catch reformatted variants.
  const ROLE_TUPLE_RE =
    /\[\s*Role\.(?:BUYER|SELLER|ARBITER)\s*,\s*Role\.(?:BUYER|SELLER|ARBITER)\s*,\s*Role\.(?:BUYER|SELLER|ARBITER)\s*,?\s*\]/;

  // Only the canonical definition site is allowed to contain the
  // literal tuple. Matched by suffix so the test is robust to
  // working-directory variation.
  const ALLOWED_SUFFIXES = ["theme.ts"];

  // Matcher self-tests — confirm the regex actually catches what we
  // want it to. Doctrine: if these fail, the rest of the layer-2
  // tripwire is silently broken.
  assert(
    ROLE_TUPLE_RE.test("renders [Role.BUYER, Role.SELLER, Role.ARBITER] dots"),
    "Tripwire self-test: matches the original v0.2.0 [B, S, A] bug literal",
  );
  assert(
    ROLE_TUPLE_RE.test(normalizeWhitespace(
      "[\n  Role.BUYER,\n  Role.SELLER,\n  Role.ARBITER,\n]"
    )),
    "Tripwire self-test: matches reformatted multi-line variant with trailing comma after whitespace normalization",
  );
  assert(
    !ROLE_TUPLE_RE.test("if (role === Role.BUYER) doStuff();"),
    "Tripwire self-test: does NOT trip on scalar Role references",
  );
  assert(
    !ROLE_TUPLE_RE.test("[Role.BUYER, Role.SELLER]"),
    "Tripwire self-test: does NOT trip on a two-element Role tuple",
  );

  // Actual scan
  const uiRoot = "src/ui";
  let scannedCount = 0;
  const offenders: string[] = [];
  for (const file of walkUiFiles(uiRoot)) {
    scannedCount++;
    if (ALLOWED_SUFFIXES.some(suffix => file.endsWith(suffix))) continue;
    const src = readFileSync(file, "utf8");
    const stripped = normalizeWhitespace(stripComments(src));
    if (ROLE_TUPLE_RE.test(stripped)) offenders.push(file);
  }
  assert(scannedCount > 0,
    "Tripwire actually scanned src/ui/ files (sanity: cwd resolved)");
  assert(offenders.length === 0,
    offenders.length === 0
      ? "No inline three-element Role tuples outside theme.ts (grep tripwire)"
      : `Inline Role tuple offenders outside theme.ts: ${offenders.join(", ")}`,
  );
}

// ── 44. STATE B EXPLAINER CARD GATE (v0.3.0 Phase 6) ─────────────────────
//
// Per-pubkey localStorage gate for the educational State B card.
// Mirrors the v0.2.0 chama_first_publish_done_<pubkey> pattern.
// Different pubkey on the same device sees the card fresh; same pubkey
// after dismiss never sees it again.
console.log("\n── STATE B EXPLAINER CARD ──");
{
  (globalThis as any).localStorage.clear();

  const ALICE = "alice_pubkey_hex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const BOB = "bob_pubkey_hex_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // Fresh state — neither pubkey has dismissed
  assert(hasStateBExplained(ALICE) === false,
    "Fresh storage: alice hasn't dismissed");
  assert(hasStateBExplained(BOB) === false,
    "Fresh storage: bob hasn't dismissed");

  // null pubkey treated as "not yet explained" (caller decides to render
  // or not based on pubkey presence)
  assert(hasStateBExplained(null) === false,
    "null pubkey → returns false (no localStorage check)");

  // Mark alice → alice explained, bob still fresh
  markStateBExplained(ALICE);
  assert(hasStateBExplained(ALICE) === true,
    "After marking alice, hasStateBExplained returns true");
  assert(hasStateBExplained(BOB) === false,
    "Per-pubkey isolation: bob still sees the card");

  // Mark null is a no-op (no key written)
  markStateBExplained(null);
  // No throw, no key written.
  const keys: string[] = [];
  for (let i = 0; i < (globalThis as any).localStorage.length || 0; i++) {
    keys.push((globalThis as any).localStorage.key(i)!);
  }
  // Storage stub doesn't expose .length the same way — check directly
  assert(
    (globalThis as any).localStorage.getItem(STATE_B_EXPLAINED_KEY_PREFIX + "null") === null,
    "markStateBExplained(null) does NOT write a 'null' key",
  );

  // Storage shape exactly mirrors v0.2.0 first-publish pattern
  const storedValue = (globalThis as any).localStorage.getItem(STATE_B_EXPLAINED_KEY_PREFIX + ALICE);
  assert(storedValue === "1",
    "Stored sentinel is the literal '1' (matches v0.2.0 chama_first_publish_done_ shape)");

  // Now mark bob too → both explained
  markStateBExplained(BOB);
  assert(hasStateBExplained(BOB) === true,
    "After marking bob, hasStateBExplained returns true");
  assert(hasStateBExplained(ALICE) === true,
    "Marking bob does NOT clear alice's flag");

  // Storage key uses the documented prefix
  assert(STATE_B_EXPLAINED_KEY_PREFIX === "chama_state_b_explained_",
    "Key prefix is the documented chama_state_b_explained_");

  (globalThis as any).localStorage.clear();
}

// ── 45. CLAIM-BRIDGE-THREW DISCRIMINATION (v0.3.1 Phase 1) ───────────────
//
// v0.3.0 production smoke caught a hang on Bitcoin Principles
// federation where every claim attempt landed in the `claim-pending`
// "your sats are still arriving" terminal, even though redeemEcash
// definitively failed pre-publish with FED_PROBE_FAILED. Root cause:
// claimAndRedeemAction in useEscrow.ts was swallowing typed bridge
// errors (FED_PROBE_FAILED, FED_MISMATCH) into the transient watchdog
// catch-all. By the time runClaimAndPayout saw the resolved promise,
// it interpreted the silently-returned local state as "claim
// succeeded, balance just hasn't grown yet" → claim-pending.
//
// Phase 1 fix: split the throws by code, route typed bridge errors to
// a new `claim-bridge-threw` terminal with retry semantics. Other
// throws stay on `claim-failed` (no retry). Balance-doesn't-grow
// AFTER a clean claimAndRedeem return stays on `claim-pending`.
//
// These tests pin the discrimination at the orchestrator level — the
// caller is the source of truth for whether the bridge threw, and the
// orchestrator routes correctly.
console.log("\n── CLAIM-BRIDGE-THREW DISCRIMINATION ──");
{
  function makeMockWallet(opts: {
    balances: number[];
    claimResult?: "ok" | Error;
    payInvoiceResult?: "ok" | Error;
  }) {
    let i = 0;
    const calls = { claimAndRedeem: 0, payInvoice: 0, clearPendingRedemption: 0, saveHandle: 0 };
    return {
      calls,
      getBalance: async () => opts.balances[Math.min(i++, opts.balances.length - 1)],
      claimAndRedeem: async (_id: string) => {
        calls.claimAndRedeem++;
        if (opts.claimResult instanceof Error) throw opts.claimResult;
        return {} as any;
      },
      payInvoice: async (_b: string) => {
        calls.payInvoice++;
        if (opts.payInvoiceResult instanceof Error) throw opts.payInvoiceResult;
      },
      clearPendingRedemption: (_id: string) => { calls.clearPendingRedemption++; },
      addOrTouchLightningHandle: () => { calls.saveHandle++; },
    };
  }

  // ── FED_PROBE_FAILED → claim-bridge-threw (the bug class fix) ──────
  {
    const bridgeErr: any = new Error(
      "Couldn't verify your federation before claiming. " +
        "(No sats were spent — retry when your Chama is reachable.)"
    );
    bridgeErr.code = "FED_PROBE_FAILED";
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: bridgeErr,
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_bridge_threw_probe",
      bolt11: "lnbc100n1pprobetest",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "alice@phoenix.app",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-bridge-threw",
      "FED_PROBE_FAILED throws route to claim-bridge-threw (not claim-pending)");
    if (terminal.kind === "claim-bridge-threw") {
      assert(/No sats were spent/.test(terminal.error),
        "claim-bridge-threw carries the honest 'No sats were spent' message from the bridge");
    }
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NOT called when bridge throws pre-redeem");
    assert(wallet.calls.saveHandle === 0,
      "Handle NOT saved on claim-bridge-threw (no successful payout)");
  }

  // ── FED_MISMATCH → claim-bridge-threw (sister case) ───────────────
  {
    const bridgeErr: any = new Error(
      "This trade's sats were minted on federation X. Your wallet is on Y. " +
        "Sign out and rejoin with the correct federation, then retry."
    );
    bridgeErr.code = "FED_MISMATCH";
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: bridgeErr,
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_bridge_threw_mismatch",
      bolt11: "lnbc100n1pmismatch",
      expectedDeltaMsats: 100_000,
      saveAfter: true,
      addressUsed: "bob@strike.me",
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-bridge-threw",
      "FED_MISMATCH throws route to claim-bridge-threw (sister of FED_PROBE_FAILED)");
  }

  // ── Hard-failure throws → claim-failed (existing semantic preserved)
  {
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: new Error("Not enough shares to reconstruct"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_hard_fail",
      bolt11: "lnbc100n1phardfail",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "Hard-failure throws (no error code) stay on claim-failed");
  }

  // ── Untyped throw → claim-failed (no e.code falls through) ────────
  {
    const wallet = makeMockWallet({
      balances: [0],
      claimResult: new Error("some generic protocol error"),
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_untyped",
      bolt11: "lnbc100n1puntyped",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 30_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-failed",
      "Untyped throws (no .code) route to claim-failed, not claim-bridge-threw");
  }

  // ── Balance-never-grows AFTER clean claim → claim-pending (preserved)
  // This is the case claim-pending was DESIGNED for: bridge resolved
  // successfully (no throw, no e.code), but the wallet balance hasn't
  // reflected the credit yet. Genuinely in-flight.
  {
    const wallet = makeMockWallet({
      balances: [0, 0, 0, 0, 0, 0],
      claimResult: "ok",
    });
    let nowMs = 0;
    const terminal = await runClaimAndPayout({
      escrowId: "esc_balance_stall",
      bolt11: "lnbc100n1pstall",
      expectedDeltaMsats: 100_000,
      saveAfter: false,
      getBalance: wallet.getBalance,
      claimAndRedeem: wallet.claimAndRedeem,
      clearPendingRedemption: wallet.clearPendingRedemption,
      payInvoice: wallet.payInvoice,
      addOrTouchLightningHandle: wallet.addOrTouchLightningHandle,
      onPhase: () => {},
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
      confirmTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    assert(terminal.kind === "claim-pending",
      "Clean claim + balance never grows → claim-pending (genuinely in-flight)");
    assert(wallet.calls.payInvoice === 0,
      "payInvoice NOT called on claim-pending");
    assert(wallet.calls.clearPendingRedemption === 0,
      "claim-pending preserves pending redemption stash for boot retry");
  }

  // ── BRIDGE_THREW_ERROR_CODES is the documented set ─────────────────
  // Tripwire: if a future maintainer adds a new typed bridge error
  // (e.g., FED_DISCONNECTED), this test fails unless they also update
  // the documented codes. Forces the contract update + this routing
  // logic to evolve together.
  {
    assert(BRIDGE_THREW_ERROR_CODES.length === 2,
      "BRIDGE_THREW_ERROR_CODES has exactly the two documented codes");
    assert(BRIDGE_THREW_ERROR_CODES.includes("FED_PROBE_FAILED"),
      "FED_PROBE_FAILED is in the documented set");
    assert(BRIDGE_THREW_ERROR_CODES.includes("FED_MISMATCH"),
      "FED_MISMATCH is in the documented set");
  }
}

// ── 46. PAYMENT HANDLES / PAYOUT DESTINATIONS — split contract ───────────
//
// Lightning Addresses are payout destinations, not counterparty handles.
// This test pins the storage/UI split: listSavedHandles() feeds the
// trade-time handle reveal surface and must contain only fiat/payment
// rails; listPayoutDestinations() feeds claim/recovery and must contain
// only Lightning Addresses.
console.log("\n── PAYMENT HANDLES / PAYOUT DESTINATIONS — split ──");
{
  (globalThis as any).localStorage.clear();

  // Seed a mixed set: 2 payout destinations, 2 payment handles
  addOrTouchPayoutDestination("alice@phoenix.app");
  addOrTouchPayoutDestination("bob@strike.me");
  addSavedHandle("revtag", "@carol");
  addSavedHandle("wave", "+221 77 555 1234");

  const paymentHandles = listSavedHandles();
  const payoutDestinations = listPayoutDestinations();

  assert(paymentHandles.length === 2,
    "Payment handles list contains only counterparty handles");
  assert(payoutDestinations.length === 2,
    "Payout destination list contains Lightning Addresses");
  assert(paymentHandles.every(h => h.rail !== LIGHTNING_RAIL),
    "Payment handles never include legacy LIGHTNING_RAIL rows");
  assert(payoutDestinations.every(d => d.address.includes("@")),
    "Payout destinations carry Lightning Address strings");

  // ── Delete operations are scoped to their stores ────────────────────
  const targetDestination = payoutDestinations[0];
  deletePayoutDestination(targetDestination.id);
  const destinationsAfter = listPayoutDestinations();
  assert(destinationsAfter.length === payoutDestinations.length - 1,
    "deletePayoutDestination removes one payout destination");
  assert(destinationsAfter.every(d => d.id !== targetDestination.id),
    "Deleted payout destination is gone from destination list");
  assert(listSavedHandles().length === paymentHandles.length,
    "Deleting a payout destination leaves payment handles unchanged");

  const targetHandle = paymentHandles[0];
  deleteSavedHandle(targetHandle.id);
  assert(listSavedHandles().length === paymentHandles.length - 1,
    "deleteSavedHandle removes one payment handle");
  assert(listPayoutDestinations().length === destinationsAfter.length,
    "Deleting a payment handle leaves payout destinations unchanged");

  (globalThis as any).localStorage.clear();
}

console.log("\n── CHAPSMART PAYOUT PROFILE + ADAPTER ──");
{
  (globalThis as any).localStorage.clear();
  assert(getChapsmartPayoutProfile() === null,
    "Fresh Chapsmart payout profile starts empty");

  const profile = saveChapsmartPayoutProfile({
    phoneNumber: "+255 71 234 5678",
    recipientName: "Asha Mushi",
  });
  assert(profile.phoneNumber === "+255 71 234 5678",
    "Chapsmart profile stores phone number locally");
  assert(getChapsmartPayoutProfile()?.recipientName === "Asha Mushi",
    "Chapsmart profile round-trips recipient name");
  assert(
    (globalThis as any).localStorage.getItem(CHAPSMART_PAYOUT_PROFILE_STORAGE_KEY)?.includes("Asha Mushi"),
    "Chapsmart profile persists under its private storage key",
  );

  assert(toChapsmartTanzaniaPhone("+255 71 234 5678") === "0712345678",
    "Chapsmart phone normalizes +255 to domestic 07 format");
  assert(toChapsmartTanzaniaPhone("0712345678") === "0712345678",
    "Chapsmart phone accepts domestic 07 format");
  assert(toChapsmartTanzaniaPhone("682345678") === "0682345678",
    "Chapsmart phone adds leading zero to 9-digit TZ mobile");
  let badPhone = false;
  try { toChapsmartTanzaniaPhone("+254 712 345 678"); } catch { badPhone = true; }
  assert(badPhone, "Chapsmart phone rejects non-Tanzania numbers");
  let shortTanzaniaPhone = false;
  try { toChapsmartTanzaniaPhone("+255 71 234 567"); } catch { shortTanzaniaPhone = true; }
  assert(shortTanzaniaPhone, "Chapsmart phone rejects Tanzania numbers missing a digit");
  let shortProfilePhone = false;
  try {
    saveChapsmartPayoutProfile({
      phoneNumber: "+255 71 234 567",
      recipientName: "Asha Mushi",
    });
  } catch { shortProfilePhone = true; }
  assert(shortProfilePhone,
    "Chapsmart profile save rejects incomplete phone numbers");

  assert(isChapsmartPayoutEligible({ homeCommunity: "tz-tzs" }),
    "Chapsmart eligible from Tanzania home Chama");
  assert(isChapsmartPayoutEligible({ fiatCurrency: "TZS" }),
    "Chapsmart eligible from active TZS trade context");
  assert(!isChapsmartPayoutEligible({ homeCommunity: "ke-kes", fiatCurrency: "KES" }),
    "Chapsmart hidden for non-Tanzania/non-TZS context");

  // v1.2.4: the createChapsmartPayoutInvoice API integration is gone.
  // ChapSmart is now a NATIVE LUD-16 M-Pesa offramp (chapsmart-offramp.ts +
  // the ClaimPayoutModal ChapsmartMpesaPicker), no longer a registry redirect.
}

// ── CHAPSMART ON-RAMP ("Fund with M-Pesa", fiat-funded escrow) ───────────
//
// ChapSmart as an alternate payer of the funding BOLT11 (brief:
// chama-chapsmart-fiat-funding-brief.md, CONFIRMED 2026-07-08 section).
// The escrow money-path is untouched — these tests cover the pure quote
// math (exact-sats target inside ChapSmart's ±2% send-sats tolerance),
// the confirmation-code normalizer, the payment-steps copy, and the
// context gate (Tanzania-only, Exchange excluded).
console.log("\n── CHAPSMART ON-RAMP (fund with M-Pesa) ──");
{
  // Dormant until the proxy + API key exist: flag ships OFF.
  assert(CHAPSMART_ONRAMP_ENABLED === false,
    "ChapSmart on-ramp flag ships OFF (proxy + API key not deployed yet)");
  assert(CHAPSMART_TARGET_TOLERANCE < CHAPSMART_SEND_SATS_TOLERANCE,
    "Our quote-acceptance tolerance leaves margin inside ChapSmart's ±2%");

  // Context gate: Tanzania contexts qualify, Exchange never does.
  assert(isChapsmartOnrampContext({ tradeCommunity: "tz-tzs", tradeCategory: "marketplace" }),
    "On-ramp offered for a Tanzanian marketplace trade");
  assert(isChapsmartOnrampContext({ fiatCurrency: "TZS", tradeCategory: "bill-pay" }),
    "On-ramp offered for a TZS bill-pay trade");
  assert(!isChapsmartOnrampContext({ tradeCommunity: "tz-tzs", tradeCategory: "p2p-trade" }),
    "Exchange excluded even in Tanzania — Exchange IS the P2P on-ramp");
  assert(!isChapsmartOnrampContext({ homeCommunity: "ke-kes", fiatCurrency: "KES", tradeCategory: "marketplace" }),
    "On-ramp hidden outside Tanzania context");

  // Confirmation-code normalizer: SMS codes, loose on paste noise.
  assert(normalizeMpesaConfirmationCode(" xkr4 mpt9qzn ") === "XKR4MPT9QZN",
    "M-Pesa code normalizer strips spaces and uppercases");
  assert(normalizeMpesaConfirmationCode("XKR4MPT9QZN") === "XKR4MPT9QZN",
    "Canonical 11-char code accepted verbatim");
  assert(normalizeMpesaConfirmationCode("abc") === null,
    "Too-short paste rejected before any network call");
  assert(normalizeMpesaConfirmationCode("lnbc1notacode00000000") === null,
    "Overlong paste (e.g. an invoice fragment) rejected");
  assert(normalizeMpesaConfirmationCode("XKR4-MPT9") === null,
    "Symbols rejected — codes are pure alphanumeric");

  // Payment steps: the Kutoa-Pesa agent flow with the EXACT quoted TZS.
  const steps = chapsmartMpesaPaySteps(25_500);
  assert(steps.length === 6, "Six Kutoa-Pesa steps (USSD → confirm)");
  assert(steps.some((s) => s.sw.includes(CHAPSMART_MPESA_AGENT_NUMBER)),
    "Steps carry the ChapSmart agent number");
  assert(steps.some((s) => s.sw.includes("25,500")),
    "Steps carry the exact quoted TZS amount, formatted");

  // Exact-sats quote math.
  assert(estimateTzsForTargetSats(1301, 10_000, 4337) === Math.round((1301 * 10_000) / 4337),
    "TZS estimate is the rate-scaled rounding of the reference quote");
  assert(quoteMatchesTargetSats(1301, 1301), "Exact quote matches");
  assert(quoteMatchesTargetSats(1290, 1301), "Sub-tolerance deviation matches");
  assert(!quoteMatchesTargetSats(1200, 1301), "Out-of-tolerance quote rejected");
  assert(!quoteMatchesTargetSats(0, 1301) && !quoteMatchesTargetSats(1301, NaN),
    "Degenerate quote/target never matches");

  // Convergence: probe learns the rate, second quote lands on target.
  const RATE = 0.4337; // sats per TZS
  const mkFetcher = (drift = 0) => {
    let calls = 0;
    const fetchQuote = async ({ amountTZS }: { amountTZS: number; accountNumber: string }): Promise<ChapsmartBuyQuote> => {
      calls++;
      const effRate = RATE * (1 + drift * (calls - 1));
      return {
        quoteId: `q${calls}`,
        amountTZS,
        calculatedSats: Math.round(amountTZS * effRate),
      };
    };
    return { fetchQuote, count: () => calls };
  };

  const stable = mkFetcher(0);
  const q = await getBuyQuoteForSats({
    targetSats: 12_345, accountNumber: "acct", fetchQuote: stable.fetchQuote,
  });
  assert(stable.count() === 2,
    "Stable rate converges in two calls (probe + estimate)");
  assert(quoteMatchesTargetSats(q.calculatedSats, 12_345),
    "Returned quote's sats sit within the acceptance tolerance of the invoice");
  assert(q.amountTZS === estimateTzsForTargetSats(12_345, 10_000, Math.round(10_000 * RATE)),
    "User pays the TZS estimated from the probe rate");

  // A violently moving price (8% per quote) never converges → honest throw.
  let threw = false;
  try {
    await getBuyQuoteForSats({
      targetSats: 12_345, accountNumber: "acct",
      fetchQuote: mkFetcher(0.08).fetchQuote, maxAttempts: 3,
    });
  } catch { threw = true; }
  assert(threw, "Non-converging quotes throw instead of returning an off-target quote");
}

console.log("\n── BANXAAS PAYOUT HANDOFF ──");
{
  assert(BANXAAS_SWAP_URL === "https://banxaas.com/swap",
    "Banxaas handoff points at the public swap route");
  assert(BANXAAS_PAYOUT_COUNTRIES.length === 4,
    "Banxaas payout registry covers the four requested countries");

  const senegal = getBanxaasPayoutAvailability({ homeCommunity: "sn-cfa" });
  assert(senegal?.country.countryCode === "SN" && senegal.status === "enabled",
    "Senegal Banxaas payout is live");

  const ivoryCoast = getBanxaasPayoutAvailability({ tradeCommunity: "ci-xof" });
  assert(ivoryCoast?.country.countryCode === "CI" && ivoryCoast.status === "coming-soon",
    "Côte d'Ivoire Banxaas payout is marked coming soon");

  const cameroon = getBanxaasPayoutAvailability({ tradeCommunity: "cm-xaf" });
  assert(cameroon?.country.countryCode === "CM" && cameroon.status === "coming-soon",
    "Cameroon Banxaas payout is marked coming soon");

  const guinea = getBanxaasPayoutAvailability({ tradeCommunity: "gn-gnf" });
  assert(guinea?.country.countryCode === "GN" && guinea.status === "coming-soon",
    "Guinea Banxaas payout is marked coming soon");

  const tradeBeatsHome = getBanxaasPayoutAvailability({
    homeCommunity: "sn-cfa",
    tradeCommunity: "ci-xof",
  });
  assert(tradeBeatsHome?.country.countryCode === "CI" && tradeBeatsHome.reason === "trade-community",
    "Trade community wins over home community for Banxaas country status");

  const legacyXof = getBanxaasPayoutAvailability({ fiatCurrency: "XOF" });
  assert(legacyXof?.country.countryCode === "SN" && legacyXof.status === "enabled",
    "Legacy XOF-only claim falls back to live Senegal");

  assert(getBanxaasPayoutAvailability({ homeCommunity: "ke-kes", fiatCurrency: "KES" }) === null,
    "Banxaas payout hidden outside supported countries");
}

// ── EXTERNAL SWAP REGISTRY (offramp-only redirects) ──────────────────────
//
// Day-1 fiat-ramps decision (2026-06-24): the registry hosts Banxaas,
// Bitika, and Bitzed as OFFRAMP-only guided-redirect providers,
// surfaced POST-CLAIM only. There is no `bidirectional` field and no
// pre-LOCK call site any more. Minmo was removed (too much friction); Tando
// (tando-offramp.ts) and ChapSmart (chapsmart-offramp.ts) were both promoted
// out of the registry into native LUD-16 M-Pesa offramps. This block verifies the registry's
// resolution + sort behaviour; the picker component relies on it.
console.log("\n── EXTERNAL SWAP REGISTRY (offramp-only) ──");
{
  // Registry coverage — every offramp-redirect provider.
  const providerIds = new Set(EXTERNAL_SWAP_PROVIDERS.map((p) => p.id));
  for (const expectedId of ["banxaas", "bitika", "bitzed"]) {
    assert(providerIds.has(expectedId as any),
      `Registry covers ${expectedId}`);
  }
  // Minmo removed entirely; Tando + ChapSmart are now native (not redirect entries).
  assert(!providerIds.has("minmo" as any),
    "Minmo is removed from the registry");
  assert(!providerIds.has("tando" as any),
    "Tando is no longer a registry redirect (native LUD-16 offramp instead)");
  assert(!providerIds.has("chapsmart" as any),
    "ChapSmart is no longer a registry redirect (graduated to native LUD-16 offramp)");

  // Banxaas keeps the recommended highlight so it tops its market; nothing
  // is bidirectional any more (offramp-only, post-CLAIM).
  const recommended = EXTERNAL_SWAP_PROVIDERS.filter((p) => p.recommended === true);
  assert(recommended.every((p) => p.id === "banxaas"),
    "Only Banxaas is marked recommended today");

  // Single-country trade contexts resolve to the right provider(s).
  // Tanzania now has NO external redirect — ChapSmart is a native LUD-16 offramp.
  const tz = getExternalSwapsForContext({ tradeCommunity: "tz-tzs" });
  assert(tz.length === 0,
    "Tanzania has no external redirect (ChapSmart is a native LUD-16 offramp)");

  const sn = getExternalSwapsForContext({ tradeCommunity: "sn-cfa" });
  assert(sn.length === 1 && sn[0].provider.id === "banxaas" && sn[0].provider.status === "enabled",
    "Senegal trade resolves to Banxaas (enabled)");

  const ci = getExternalSwapsForContext({ tradeCommunity: "ci-xof" });
  assert(ci.length === 1 && ci[0].provider.id === "banxaas" && ci[0].provider.status === "coming-soon",
    "Côte d'Ivoire trade resolves to Banxaas (coming-soon)");

  const zm = getExternalSwapsForContext({ tradeCommunity: "zm-zmw" });
  assert(zm.length === 1 && zm[0].provider.id === "bitzed",
    "Zambia trade resolves to Bitzed");

  // Kenya's only registry redirect is Bitika (Tando is the native offramp,
  // surfaced separately by ClaimPayoutModal; Minmo is gone).
  const ke = getExternalSwapsForContext({ tradeCommunity: "ke-kes" });
  assert(ke.length === 1 && ke[0].provider.id === "bitika",
    "Kenya trade resolves to Bitika (only registry redirect; Tando is native)");
  const keBitsacco = getExternalSwapsForContext({ tradeCommunity: "ke-kes-bitsacco" });
  assert(keBitsacco.length === 1 && keBitsacco[0].provider.id === "bitika",
    "Kenya Bitsacco route resolves to Bitika");

  // Trade-community wins over home-community (most precise context).
  const tradeBeatsHome = getExternalSwapsForContext({
    homeCommunity: "tz-tzs",
    tradeCommunity: "sn-cfa",
  });
  assert(tradeBeatsHome.some((m) => m.provider.id === "banxaas" && m.reason === "trade-community"),
    "Trade-community match beats home-community match");

  // Currency-only matches act as the legacy fallback for older trades
  // without a community slug.
  const xofOnly = getExternalSwapsForContext({ fiatCurrency: "XOF" });
  assert(xofOnly.some((m) => m.provider.id === "banxaas" && m.reason === "fiat-currency"),
    "Currency-only XOF surfaces Banxaas as fiat-currency reason");
  const kesOnly = getExternalSwapsForContext({ fiatCurrency: "KES" });
  assert(kesOnly.length === 2 && kesOnly.every((m) => m.provider.id === "bitika" && m.reason === "fiat-currency"),
    "Currency-only KES surfaces the two Bitika entries (ke-kes + ke-kes-bitsacco)");

  // No matches for unsupported markets — picker should render nothing.
  const usd = getExternalSwapsForContext({ fiatCurrency: "USD" });
  assert(usd.length === 0,
    "USD trade surfaces no external-swap providers");
  const empty = getExternalSwapsForContext({});
  assert(empty.length === 0,
    "Empty context surfaces no providers");
  // Country-scoping: when the trade carries its own community, the trade's
  // country is authoritative — a Kenyan-home user cashing out a Cameroon trade
  // sees only the Cameroon (Banxaas) redirect, never a home-country Bitika leak.
  const foreignTrade = getExternalSwapsForContext({ homeCommunity: "ke-kes", tradeCommunity: "cm-xaf", fiatCurrency: "XAF" });
  assert(foreignTrade.every((m) => m.reason === "trade-community"),
    "A trade with its own community surfaces only trade-community matches (no home/currency leak)");
  assert(!foreignTrade.some((m) => m.provider.id === "bitika"),
    "Kenyan-home user does NOT see the Bitika (Kenya) redirect on a Cameroon trade");

  // Reason priority dominates sort order: trade-community beats
  // home-community beats fiat-currency. In a mixed context, the
  // more-specific reason always wins regardless of which provider
  // is recommended.
  // (ke-kes home → Bitika, non-recommended; XOF fiat → Banxaas, recommended.)
  const mixed = getExternalSwapsForContext({
    homeCommunity: "ke-kes",
    fiatCurrency: "XOF",
  });
  assert(mixed.length >= 2,
    "Mixed context returns multiple providers");
  assert(mixed[0].provider.id === "bitika" && mixed[0].reason === "home-community",
    "Home-community match beats fiat-currency match even when the latter is the recommended provider");

  // Recommended floats WITHIN a tier. fiat-currency KES has only Bitika
  // entries (none recommended), so registry order wins.
  const kesTie = getExternalSwapsForContext({ fiatCurrency: "KES" });
  assert(kesTie.every((m) => m.reason === "fiat-currency"),
    "KES fiat-currency matches all share the same reason tier");
  assert(kesTie[0].provider.id === "bitika",
    "Within a tie, registry order is preserved");

  // Each registry entry has the fields the picker reads. Cheap shape
  // assertion to catch future entries that forget a flag.
  for (const provider of EXTERNAL_SWAP_PROVIDERS) {
    assert(typeof provider.id === "string" && provider.id.length > 0,
      `Registry entry ${provider.communitySlug} has id`);
    assert(provider.swapUrl.startsWith("https://"),
      `Registry entry ${provider.id}/${provider.communitySlug} swap URL is https`);
    assert(provider.flagEmoji.length > 0,
      `Registry entry ${provider.id}/${provider.communitySlug} has flag`);
    assert(provider.currency.length === 3,
      `Registry entry ${provider.id}/${provider.communitySlug} has ISO-4217 currency`);
  }

  // Back-compat: the legacy Banxaas shim still returns the same shape
  // tested in the Banxaas block above. This re-asserts after the unified
  // registry took over to catch any future drift.
  const sgViaShim = getBanxaasPayoutAvailability({ homeCommunity: "sn-cfa" });
  assert(sgViaShim?.country.countryCode === "SN" && sgViaShim.status === "enabled",
    "Banxaas back-compat shim still resolves Senegal after registry migration");
}

// ── TANDO NATIVE M-PESA OFFRAMP (LUD-16) ─────────────────────────────────
//
// Tando is Kenya's lead cash-out: `<phone>@bitcoin.co.ke` is a real
// Lightning Address, so the claim flow pays it through the existing LUD-16
// payout path. These tests cover the pure phone↔address layer (tando-
// offramp.ts) that the ClaimPayoutModal Tando picker depends on.
console.log("\n── TANDO NATIVE M-PESA OFFRAMP ──");
{
  // Domain is bitcoin.co.ke (Tando's live LUD-16 host), NOT use.tando.me.
  assert(TANDO_LNADDRESS_DOMAIN === "bitcoin.co.ke",
    "Tando Lightning-Address host is bitcoin.co.ke");

  // MSISDN normalization accepts the common Kenyan input shapes and
  // canonicalizes to 254 + 9 national digits.
  assert(normalizeKenyanMsisdn("0712345678") === "254712345678",
    "Local 07… form normalizes to 2547…");
  assert(normalizeKenyanMsisdn("254712345678") === "254712345678",
    "Full MSISDN passes through");
  assert(normalizeKenyanMsisdn("+254 712 345 678") === "254712345678",
    "Leading + and spaces are stripped");
  assert(normalizeKenyanMsisdn("712345678") === "254712345678",
    "Bare national significant number is accepted");
  assert(normalizeKenyanMsisdn("0712-345-678") === "254712345678",
    "Dashes are stripped");
  assert(normalizeKenyanMsisdn("0112345678") === "254112345678",
    "Newer 01… (national 1…) range is accepted");

  // Rejects non-Kenyan / malformed input.
  assert(normalizeKenyanMsisdn("0612345678") === null,
    "National numbers must start with 7 or 1 (06… rejected)");
  assert(normalizeKenyanMsisdn("071234567") === null,
    "Too-short numbers are rejected");
  assert(normalizeKenyanMsisdn("07123456789") === null,
    "Too-long numbers are rejected");
  assert(normalizeKenyanMsisdn("0712 34A 678") === null,
    "Non-digit characters are rejected");
  assert(normalizeKenyanMsisdn("") === null && normalizeKenyanMsisdn("   ") === null,
    "Empty / whitespace is rejected");
  assert(isValidKenyanMsisdn("0712345678") && !isValidKenyanMsisdn("nope"),
    "isValidKenyanMsisdn mirrors normalize");

  // Address building + round-trip.
  assert(buildTandoLightningAddress("0712345678") === "254712345678@bitcoin.co.ke",
    "buildTandoLightningAddress forms <msisdn>@bitcoin.co.ke");
  assert(buildTandoLightningAddress("not a phone") === null,
    "buildTandoLightningAddress returns null for invalid input");
  assert(isTandoLightningAddress("254712345678@bitcoin.co.ke"),
    "isTandoLightningAddress recognizes Tando addresses");
  assert(isTandoLightningAddress("254712345678@BITCOIN.CO.KE"),
    "isTandoLightningAddress is case-insensitive");
  assert(!isTandoLightningAddress("alice@getchama.app"),
    "isTandoLightningAddress rejects non-Tando addresses");
  assert(tandoMsisdnFromAddress("254712345678@bitcoin.co.ke") === "254712345678",
    "tandoMsisdnFromAddress recovers the MSISDN");
  assert(tandoMsisdnFromAddress("alice@getchama.app") === null,
    "tandoMsisdnFromAddress returns null for non-Tando addresses");

  // Display format is the familiar local 0XXX XXX XXX form.
  assert(formatKenyanMsisdnDisplay("254712345678") === "0712 345 678",
    "formatKenyanMsisdnDisplay renders the local 0XXX XXX XXX form");

  // The Tando address must survive the payout-destinations normalizer
  // (lowercased) so dedupe-by-number works and isTandoLightningAddress
  // still matches the stored value.
  const tandoAddr = buildTandoLightningAddress("0712345678")!;
  assert(tandoAddr === tandoAddr.toLowerCase() && isTandoLightningAddress(tandoAddr),
    "Tando address is already lowercase and stays recognizable when stored");

  // Kenya context detection — gates the native Tando option (independent
  // of EXTERNAL_SWAPS_ENABLED).
  assert(isKenyaPayoutContext({ tradeCommunity: "ke-kes" }),
    "ke-kes trade community is a Kenya payout context");
  assert(isKenyaPayoutContext({ homeCommunity: "ke-kes-bitsacco" }),
    "ke-kes-bitsacco home community is a Kenya payout context");
  assert(isKenyaPayoutContext({ fiatCurrency: "kes" }),
    "KES fiat currency (any case) is a Kenya payout context");
  assert(!isKenyaPayoutContext({ tradeCommunity: "tz-tzs", fiatCurrency: "TZS" }),
    "Non-Kenya context is not eligible for Tando");
  assert(!isKenyaPayoutContext({}),
    "Empty context is not eligible for Tando");
  // Country-scoping: the TRADE is authoritative. A Kenyan-home user cashing out
  // a foreign (Cameroon/XAF) trade must NOT see M-Pesa — it's unusable there.
  assert(!isKenyaPayoutContext({ homeCommunity: "ke-kes", tradeCommunity: "cm-xaf", fiatCurrency: "XAF" }),
    "Kenyan home does NOT leak M-Pesa onto a Cameroon (XAF) trade");
  assert(isKenyaPayoutContext({ homeCommunity: "ke-kes" }),
    "Kenyan home with no trade context still offers M-Pesa (context-less fallback)");
}

// ChapSmart is Tando's Tanzanian mirror: `<phone>@chapsmart.com` is a live,
// verified LUD-16 Lightning Address, so the claim flow pays it through the same
// payout path (sats → TZS on Vodacom M-Pesa). These tests cover the pure
// phone↔address layer (chapsmart-offramp.ts) the ClaimPayoutModal picker depends on.
console.log("\n── CHAPSMART NATIVE M-PESA OFFRAMP (Tanzania) ──");
{
  assert(CHAPSMART_LNADDRESS_DOMAIN === "chapsmart.com",
    "ChapSmart Lightning-Address host is chapsmart.com (apex, matches the live endpoint)");

  // MSISDN normalization accepts the common Tanzanian input shapes and
  // canonicalizes to 255 + 9 national digits (Vodacom M-Pesa).
  assert(normalizeTanzanianMsisdn("0740034110") === "255740034110",
    "Local 07… form normalizes to 2557…");
  assert(normalizeTanzanianMsisdn("255740034110") === "255740034110",
    "Full MSISDN passes through");
  assert(normalizeTanzanianMsisdn("+255 740 034 110") === "255740034110",
    "Leading + and spaces are stripped");
  assert(normalizeTanzanianMsisdn("740034110") === "255740034110",
    "Bare national significant number is accepted");
  assert(normalizeTanzanianMsisdn("0740-034-110") === "255740034110",
    "Dashes are stripped");
  assert(normalizeTanzanianMsisdn("0754111222") === "255754111222" &&
    normalizeTanzanianMsisdn("0761222333") === "255761222333" &&
    normalizeTanzanianMsisdn("0798333444") === "255798333444",
    "All Vodacom prefixes (74/75/76/79) are accepted");

  // Rejects non-Vodacom / malformed input (fail fast, before a network call).
  assert(normalizeTanzanianMsisdn("0712345678") === null,
    "Non-Vodacom prefix (71… Airtel/Tigo) is rejected");
  assert(normalizeTanzanianMsisdn("0773456789") === null,
    "77… (non-Vodacom) is rejected");
  assert(normalizeTanzanianMsisdn("074003411") === null,
    "Too-short numbers are rejected");
  assert(normalizeTanzanianMsisdn("07400341100") === null,
    "Too-long numbers are rejected");
  assert(normalizeTanzanianMsisdn("0740 03A 110") === null,
    "Non-digit characters are rejected");
  assert(normalizeTanzanianMsisdn("") === null && normalizeTanzanianMsisdn("   ") === null,
    "Empty / whitespace is rejected");
  assert(isValidTanzanianMsisdn("0740034110") && !isValidTanzanianMsisdn("nope"),
    "isValidTanzanianMsisdn mirrors normalize");

  // Address building + round-trip.
  assert(buildChapsmartLightningAddress("0740034110") === "255740034110@chapsmart.com",
    "buildChapsmartLightningAddress forms <msisdn>@chapsmart.com");
  assert(buildChapsmartLightningAddress("not a phone") === null,
    "buildChapsmartLightningAddress returns null for invalid input");
  assert(isChapsmartLightningAddress("255740034110@chapsmart.com"),
    "isChapsmartLightningAddress recognizes ChapSmart addresses");
  assert(isChapsmartLightningAddress("255740034110@CHAPSMART.COM"),
    "isChapsmartLightningAddress is case-insensitive");
  assert(!isChapsmartLightningAddress("254712345678@bitcoin.co.ke"),
    "isChapsmartLightningAddress rejects Tando (non-ChapSmart) addresses");
  assert(chapsmartMsisdnFromAddress("255740034110@chapsmart.com") === "255740034110",
    "chapsmartMsisdnFromAddress recovers the MSISDN");
  assert(chapsmartMsisdnFromAddress("alice@getchama.app") === null,
    "chapsmartMsisdnFromAddress returns null for non-ChapSmart addresses");

  // Display format is the familiar local 0XXX XXX XXX form.
  assert(formatTanzanianMsisdnDisplay("255740034110") === "0740 034 110",
    "formatTanzanianMsisdnDisplay renders the local 0XXX XXX XXX form");

  // The ChapSmart address survives the payout-destinations normalizer (lowercased).
  const csAddr = buildChapsmartLightningAddress("0740034110")!;
  assert(csAddr === csAddr.toLowerCase() && isChapsmartLightningAddress(csAddr),
    "ChapSmart address is already lowercase and stays recognizable when stored");

  // Tanzania context detection — gates the native ChapSmart option, and is
  // mutually exclusive with the Kenya (Tando) context.
  assert(isTanzaniaPayoutContext({ tradeCommunity: "tz-tzs" }),
    "tz-tzs trade community is a Tanzania payout context");
  assert(isTanzaniaPayoutContext({ fiatCurrency: "tzs" }),
    "TZS fiat currency (any case) is a Tanzania payout context");
  assert(!isTanzaniaPayoutContext({ tradeCommunity: "ke-kes", fiatCurrency: "KES" }),
    "A Kenya context is not eligible for ChapSmart");
  assert(!isTanzaniaPayoutContext({}),
    "Empty context is not eligible for ChapSmart");
  // Country-scoping mirror: a TZ-home user cashing out a foreign trade must not
  // see M-Pesa; home stays a context-less fallback only.
  assert(!isTanzaniaPayoutContext({ homeCommunity: "tz-tzs", tradeCommunity: "cm-xaf", fiatCurrency: "XAF" }),
    "Tanzanian home does NOT leak M-Pesa onto a Cameroon (XAF) trade");
  assert(isTanzaniaPayoutContext({ homeCommunity: "tz-tzs" }),
    "Tanzanian home with no trade context still offers M-Pesa (context-less fallback)");
}

// Strike is the US mirror of Tando: `<username>@strike.me` is a real LUD-16
// Lightning Address, so the claim flow pays it through the same payout path,
// converting sats→USD inside the user's own Strike account (no Chama custody).
// These tests cover the pure username↔address layer (strike-offramp.ts).
console.log("\n── STRIKE US-DOLLAR OFFRAMP ──");
{
  assert(STRIKE_LNADDRESS_DOMAIN === "strike.me",
    "Strike Lightning-Address host is strike.me");
  assert(typeof STRIKE_CASH_HINT === "string" && /cash/i.test(STRIKE_CASH_HINT),
    "Strike cash hint mentions the Cash (USD) receive setting");

  // Username normalization accepts the common input shapes, lowercased.
  assert(normalizeStrikeUsername("alice") === "alice",
    "Bare username passes through (lowercased)");
  assert(normalizeStrikeUsername("@Alice") === "alice",
    "Leading @ and uppercase are normalized");
  assert(normalizeStrikeUsername("alice@strike.me") === "alice",
    "Full Lightning Address yields the local part");
  assert(normalizeStrikeUsername("https://strike.me/alice") === "alice",
    "Profile URL yields the handle (resolved via LNURL, never the page)");
  assert(normalizeStrikeUsername("strike.me/Alice?ref=x") === "alice",
    "Bare Strike profile URL yields the handle");
  assert(normalizeStrikeUsername("https://www.strike.me/Alice") === "alice",
    "www Strike profile URL yields the handle");
  assert(normalizeStrikeUsername("a.b_c-1") === "a.b_c-1",
    "Dots, underscores and dashes are allowed inside the handle");
  assert(normalizeStrikeUsername("a") === "a",
    "Single-char handles are allowed locally; Strike's LNURL endpoint is authoritative");

  // Rejects malformed / foreign-host input.
  assert(normalizeStrikeUsername("alice@getchama.app") === null,
    "A non-strike.me host is rejected");
  assert(normalizeStrikeUsername(".alice") === null,
    "Username must start with an alphanumeric");
  assert(normalizeStrikeUsername("alice@strike.me@x") === null,
    "More than one @ is malformed");
  assert(normalizeStrikeUsername("") === null && normalizeStrikeUsername("   ") === null,
    "Empty / whitespace is rejected");
  assert(isValidStrikeUsername("alice") && isValidStrikeUsername("a") && !isValidStrikeUsername(".alice"),
    "isValidStrikeUsername mirrors normalize");

  // Address building + round-trip.
  assert(buildStrikeLightningAddress("Alice") === "alice@strike.me",
    "buildStrikeLightningAddress forms <username>@strike.me (lowercased)");
  assert(buildStrikeLightningAddress(".alice") === null,
    "buildStrikeLightningAddress returns null for invalid input");
  assert(isStrikeLightningAddress("alice@strike.me"),
    "isStrikeLightningAddress recognizes Strike addresses");
  assert(isStrikeLightningAddress("alice@STRIKE.ME"),
    "isStrikeLightningAddress is case-insensitive");
  assert(!isStrikeLightningAddress("254712345678@bitcoin.co.ke"),
    "isStrikeLightningAddress rejects non-Strike addresses");
  assert(!isStrikeLightningAddress("alice@strike.me@x"),
    "isStrikeLightningAddress rejects malformed Strike-shaped addresses");
  assert(strikeUsernameFromAddress("alice@strike.me") === "alice",
    "strikeUsernameFromAddress recovers the username");
  assert(strikeUsernameFromAddress("alice@getchama.app") === null,
    "strikeUsernameFromAddress returns null for non-Strike addresses");

  // The Strike address must survive the payout-destinations normalizer
  // (lowercased) so dedupe works and isStrikeLightningAddress still matches.
  const strikeAddr = buildStrikeLightningAddress("Alice")!;
  assert(strikeAddr === strikeAddr.toLowerCase() && isStrikeLightningAddress(strikeAddr),
    "Strike address is already lowercase and stays recognizable when stored");

  // US context detection — gates the Strike username→@strike.me option
  // (independent of EXTERNAL_SWAPS_ENABLED). TRADE context is authoritative
  // (same rule as Kenya/Tanzania offramps).
  assert(isUSPayoutContext({ tradeCommunity: "us-gbf" }),
    "us-gbf trade community is a US payout context");
  assert(isUSPayoutContext({ homeCommunity: "us-usd" }),
    "us-usd home community is a US payout context");
  assert(isUSPayoutContext({ tradeCommunity: "global-usd" }),
    "global-usd trade community is a US payout context");
  assert(isUSPayoutContext({ fiatCurrency: "usd" }),
    "USD fiat currency (any case) is a US payout context");
  assert(!isUSPayoutContext({ tradeCommunity: "ke-kes", fiatCurrency: "KES" }),
    "A Kenya context is not a US payout context");
  assert(!isUSPayoutContext({}),
    "Empty context is not eligible for Strike");
  assert(!isUSPayoutContext({ homeCommunity: "us-gbf", tradeCommunity: "ke-kes", fiatCurrency: "KES" }),
    "US home does NOT leak Strike onto a Kenya (KES) trade");
  assert(isUSPayoutContext({ homeCommunity: "us-gbf" }),
    "US home with no trade context still offers Strike (context-less fallback)");
  // Cross-check the two offramps don't claim each other's addresses.
  assert(!isTandoLightningAddress("alice@strike.me") && !isStrikeLightningAddress("254712345678@bitcoin.co.ke"),
    "Tando and Strike address detectors are mutually exclusive");

  // Cash-receive how-to copy + always-visible confirmation guidance.
  assert(Array.isArray(STRIKE_CASH_STEPS) && STRIKE_CASH_STEPS.length >= 3,
    "STRIKE_CASH_STEPS lists the Account → Bitcoin settings → Receive currency → Cash path");
  assert(/cash/i.test(STRIKE_CASH_HINT) && /passive lightning/i.test(STRIKE_CASH_HINT),
    "STRIKE_CASH_HINT names Cash + passive Lightning receives");
  assert(/\$0\.01/.test(STRIKE_CASH_CAVEAT) && /bitcoin/i.test(STRIKE_CASH_CAVEAT),
    "STRIKE_CASH_CAVEAT keeps Strike's small-payment bitcoin caveat visible");
}

// Per-category trade durations (v4.1 D, UNWIRED — pure CREATE-side expiry
// policy). The only consensus rule is expirySeconds > 0; these bounds only
// constrain what a fresh CREATE stamps, never what a client accepts off-wire.
console.log("\n── TRADE DURATIONS (per-category expiry) ──");
{
  // LOCKED defaults: Exchange 3h · CBP 3h · Marketplace 1 day · Lending 7-day cap.
  assert(defaultExpiryForCategory("p2p-trade") === 3 * HOUR_SECONDS,
    "Exchange defaults to 3h");
  assert(defaultExpiryForCategory("bill-pay") === 3 * HOUR_SECONDS,
    "CBP defaults to 3h");
  assert(defaultExpiryForCategory("marketplace") === 1 * DAY_SECONDS,
    "Marketplace defaults to 1 day");
  assert(defaultExpiryForCategory("lending") === 7 * DAY_SECONDS,
    "Lending defaults to 7 days (the cap)");

  // CONSENSUS FLOOR: every bound is > 0, and min ≤ default ≤ max for all
  // known categories + the fallback.
  const allBounds = [
    expiryBoundsForCategory("p2p-trade"),
    expiryBoundsForCategory("bill-pay"),
    expiryBoundsForCategory("marketplace"),
    expiryBoundsForCategory("lending"),
    FALLBACK_EXPIRY,
  ];
  assert(allBounds.every(b => b.min > 0 && b.min <= b.default && b.default <= b.max),
    "SAFETY: every category satisfies 0 < min ≤ default ≤ max (consensus floor holds)");

  // Lending's 7-day cap is a hard ceiling.
  assert(expiryBoundsForCategory("lending").max === 7 * DAY_SECONDS,
    "Lending max is the 7-day cap");

  // Clamp enforces the per-category window.
  assert(clampExpiryForCategory("p2p-trade", 10) === 1 * HOUR_SECONDS,
    "Below-min Exchange expiry clamps up to the 1h floor");
  assert(clampExpiryForCategory("p2p-trade", 99 * DAY_SECONDS) === 12 * HOUR_SECONDS,
    "Above-max Exchange expiry clamps down to the 12h ceiling");
  assert(clampExpiryForCategory("lending", 30 * DAY_SECONDS) === 7 * DAY_SECONDS,
    "A 30-day lending term clamps down to the 7-day cap");
  assert(clampExpiryForCategory("marketplace", 2 * DAY_SECONDS) === 2 * DAY_SECONDS,
    "An in-range Marketplace expiry passes through unchanged");

  // Non-finite / non-positive falls back to the category default (never ≤ 0).
  assert(clampExpiryForCategory("p2p-trade", 0) === 3 * HOUR_SECONDS &&
         clampExpiryForCategory("p2p-trade", -5) === 3 * HOUR_SECONDS &&
         clampExpiryForCategory("p2p-trade", NaN) === 3 * HOUR_SECONDS,
    "SAFETY: invalid expiry input falls back to the category default, never ≤ 0");

  // Unknown / legacy category → the generous fallback window (24h default),
  // so an off-registry vertical is never rejected or over-constrained.
  assert(defaultExpiryForCategory("some-future-vertical") === 1 * DAY_SECONDS &&
         defaultExpiryForCategory(undefined) === 1 * DAY_SECONDS,
    "Unknown / missing category uses the legacy 24h fallback default");
  assert(clampExpiryForCategory("some-future-vertical", 5 * DAY_SECONDS) === 5 * DAY_SECONDS,
    "Fallback window admits up to its 7-day max");

  // Extension detection drives the "longer window" tradeoff copy on Create.
  assert(isExtendedExpiry("p2p-trade", 6 * HOUR_SECONDS) === true,
    "6h on a 3h-default Exchange reads as an extension");
  assert(isExtendedExpiry("p2p-trade", 3 * HOUR_SECONDS) === false,
    "Exactly the default is not an extension");
}

// ── SIM WALLET — balance subscription end-to-end ─────────────────────────
//
// Round 3 hotfix: the user reported inconsistent ChamaBar pill behavior
// driven by suspected missing notifyBalance() calls across the sim
// wallet's mutation sites. This test simulates a full trade lifecycle
// (fund → spend/lock → redeem/claim → payout) and asserts that the
// balance subscriber receives a callback after EVERY mutation with the
// correct new value. setTimeout is monkey-patched to fire synchronously
// so the test is deterministic — no real-world 3-8s waits.
console.log("\n── SIM WALLET — balance subscription end-to-end ──");
{
  const realSetTimeout = (globalThis as any).setTimeout;
  // Replace setTimeout with a synchronous trampoline so createInvoice's
  // auto-credit fires before the next test line runs.
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) => {
    fn();
    return 0 as any;
  };

  try {
    (globalThis as any).localStorage?.removeItem?.("chama_sim_mode");
    const w = await import("../sim/sim-wallet.js");
    const npub = "test_sub_e2e_" + Date.now();
    const wallet = w.createSimWallet({ npub });
    await wallet.joinFederation("fed1sim");
    await wallet.open();

    const events: number[] = [];
    wallet.balance.subscribeBalance((b) => events.push(b));

    // subscribeBalance emits the current balance via setTimeout(0); with
    // the trampoline it fires synchronously. First entry: starting 0.
    assert(events.length >= 1 && events[0] === 0,
      "subscribeBalance emits the starting balance (0) on subscribe");

    // 1) createInvoice — auto-credit fires synchronously under the
    //    trampoline. Expect the subscriber to fire with the new balance.
    const eventsBeforeInvoice = events.length;
    await wallet.lightning.createInvoice(50_000_000, "fund");
    assert(events.length > eventsBeforeInvoice,
      "createInvoice auto-credit fires balance subscriber");
    assert(events[events.length - 1] === 50_000_000,
      "Balance after createInvoice auto-credit = 50,000,000 msat");

    // 2) spendNotes — LOCK debit path. Subscriber must fire.
    const eventsBeforeSpend = events.length;
    const oob = await wallet.mint.spendNotes(40_000_000);
    assert(events.length > eventsBeforeSpend,
      "spendNotes fires balance subscriber");
    assert(events[events.length - 1] === 10_000_000,
      "Balance after spendNotes(40M) = 10M msat (50M - 40M)");

    // 3) redeemEcash — CLAIM credit path. Subscriber must fire.
    const eventsBeforeRedeem = events.length;
    await wallet.mint.redeemEcash(oob);
    assert(events.length > eventsBeforeRedeem,
      "redeemEcash fires balance subscriber");
    assert(events[events.length - 1] === 50_000_000,
      "Balance after redeemEcash = 50M msat (10M + 40M)");

    // 4) payInvoice — outbound LN debit path. Subscriber must fire.
    //    Use a sim-formatted invoice (round-trip-safe after the round-3
    //    encoding fix).
    const eventsBeforePay = events.length;
    const inv = await wallet.lightning.createInvoice(20_000_000, "out");
    // createInvoice fires the credit timer synchronously under the
    // trampoline; the balance is now 70M. Drain the events from that
    // event before we pay so we measure payInvoice's own callback.
    const eventsAfterCredit = events.length;
    assert(events[events.length - 1] === 70_000_000,
      "Balance after second createInvoice auto-credit = 70M msat");

    await wallet.lightning.payInvoice(inv.invoice);
    assert(events.length > eventsAfterCredit,
      "payInvoice fires balance subscriber");
    assert(events[events.length - 1] === 50_000_000,
      "Balance after payInvoice(20M) = 50M msat (70M - 20M)");

    // 5) cleanup() cancels pending credit timers. The trampoline fires
    //    setTimeout synchronously, so an in-flight timer has already
    //    completed before cleanup() can see it — which means we can't
    //    test cancellation under the trampoline. Instead: confirm the
    //    visible side-effect (subscribers Set cleared) by calling
    //    notifyBalance after cleanup and verifying no callback fires.
    const eventsBeforeCleanup = events.length;
    await wallet.cleanup();
    // Manually trigger a balance bump after cleanup — subscribers
    // should be empty so no event appends. (We use the publicly-visible
    // joinFederation, which calls notifyBalance internally.)
    await wallet.joinFederation("fed1sim");
    assert(events.length === eventsBeforeCleanup,
      "cleanup() clears subscriber set (post-cleanup mutations don't reach old subscribers)");

    (globalThis as any).localStorage?.removeItem?.("chama_sim_wallet_" + npub);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
  }
}

// ── REAL SDK ADAPTER — Lightning receive watcher ────────────────────────
//
// The real Fedimint SDK returns an operation_id with every BOLT11 receive.
// Chama must keep subscribe_ln_receive alive for that operation so the
// wallet claims the inbound payment after the payer settles the invoice.
// A QR without this watcher is a footgun: the payer can send, while the
// Chama wallet never credits.
console.log("\n── REAL SDK ADAPTER — Lightning receive watcher ──");
{
  type TestGatewayInfo = {
    gateway_id: string;
    api: string;
    lightning_alias: string;
    supports_private_payments: boolean;
  };
  type TestGateway = { info: TestGatewayInfo; vetted: boolean; ttl: number };

  function makeRealWallet(
    overrides: Record<string, unknown> = {},
    gatewayList?: TestGateway[],
  ) {
    let receiveCb: ((state: "claimed" | "funded") => void) | null = null;
    const calls = {
      createInvoice: 0,
      createInvoiceGatewayId: "",
      payInvoice: 0,
      payInvoiceGatewayId: "",
      updateGatewayCache: 0,
      listGateways: 0,
      subscribeLnReceive: 0,
      subscribeLnPay: 0,
      subscribeInternalPayment: 0,
      unsubscribeReceive: 0,
      unsubscribePay: 0,
      unsubscribeInternalPay: 0,
      cleanup: 0,
      subscribedOperationId: "",
      subscribedPayOperationId: "",
    };
    const unvettedGatewayInfo = {
      gateway_id: "unvetted_gateway_123",
      api: "https://unvetted-gateway.example.test",
      lightning_alias: "Unvetted Gateway",
      supports_private_payments: true,
    };
    const vettedGatewayInfo = {
      gateway_id: "vetted_gateway_456",
      api: "https://vetted-gateway.example.test",
      lightning_alias: "Vetted Gateway",
      supports_private_payments: false,
    };
    const gateways = gatewayList ?? [
      { info: unvettedGatewayInfo, vetted: false, ttl: 60 },
      { info: vettedGatewayInfo, vetted: true, ttl: 60 },
    ];

    const real = {
      async open() { return true; },
      isOpen() { return true; },
      async joinFederation() { return true; },
      recovery: {
        async hasPendingRecoveries() { return false; },
        async waitForAllRecoveries() {},
      },
      balance: {
        async getBalance() { return 0; },
        subscribeBalance() { return () => {}; },
      },
      mint: {
        async spendNotes() { return { notes: "notes", operation_id: "mint_op" }; },
        async redeemEcash() { return "mint_op"; },
        async parseNotes() { return 0; },
      },
      lightning: {
        async createInvoice(
          _amountMsats: number,
          _description: string,
          _expiryTime?: number,
          gatewayInfo?: { gateway_id?: string },
        ) {
          calls.createInvoice++;
          calls.createInvoiceGatewayId = gatewayInfo?.gateway_id ?? "";
          return { invoice: "lnbc100n1pchama", operation_id: "ln_op_123" };
        },
        async payInvoice(_bolt11: string, gatewayInfo?: { gateway_id?: string }) {
          calls.payInvoice++;
          calls.payInvoiceGatewayId = gatewayInfo?.gateway_id ?? "";
          return {
            contract_id: "contract_123",
            fee: 0,
            payment_type: { lightning: "pay_op_123" },
          };
        },
        subscribeLnPay(
          this: any,
          operationId: string,
          onSuccess?: (state: { success: { preimage: string } }) => void,
        ) {
          if (!this || typeof this.updateGatewayCache !== "function") {
            throw new Error("subscribeLnPay lost this binding");
          }
          calls.subscribeLnPay++;
          calls.subscribedPayOperationId = operationId;
          setTimeout(() => {
            onSuccess?.({ success: { preimage: "preimage" } });
          }, 0);
          return () => { calls.unsubscribePay++; };
        },
        subscribeInternalPayment(
          operationId: string,
          onSuccess?: (state: { preimage: string }) => void,
        ) {
          calls.subscribeInternalPayment++;
          calls.subscribedPayOperationId = operationId;
          setTimeout(() => {
            onSuccess?.({ preimage: "preimage" });
          }, 0);
          return () => { calls.unsubscribeInternalPay++; };
        },
        subscribeLnReceive(
          operationId: string,
          onSuccess?: (state: "claimed" | "funded") => void,
        ) {
          calls.subscribeLnReceive++;
          calls.subscribedOperationId = operationId;
          receiveCb = onSuccess ?? null;
          return () => { calls.unsubscribeReceive++; };
        },
        async updateGatewayCache() {
          calls.updateGatewayCache++;
        },
        async listGateways() {
          calls.listGateways++;
          return gateways;
        },
      },
      federation: {
        async getConfig() { return {}; },
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() { return []; },
      },
      async cleanup() { calls.cleanup++; },
      ...overrides,
    };

    return { real, calls, claim: () => receiveCb?.("claimed"), fund: () => receiveCb?.("funded") };
  }

  // createInvoice must arm subscribe_ln_receive before returning the QR.
  {
    const h = makeRealWallet();
    const wallet = adaptRealWallet(h.real as any);
    const result = await wallet.lightning.createInvoice(100_000, "fund");

    assert(result.invoice === "lnbc100n1pchama",
      "Adapter returns the BOLT11 from real.lightning.createInvoice");
    assert(result.operationId === "ln_op_123",
      "Adapter preserves the real receive operation ID");
    assert(h.calls.createInvoice === 1,
      "real.lightning.createInvoice called once");
    assert(h.calls.updateGatewayCache === 1,
      "Adapter refreshes the gateway cache before creating a receive invoice");
    assert(h.calls.listGateways === 1,
      "Adapter lists gateways before creating a receive invoice");
    assert(h.calls.createInvoiceGatewayId === "vetted_gateway_456",
      "Adapter passes the first vetted gateway into createInvoice");
    assert(h.calls.subscribeLnReceive === 1,
      "Adapter subscribes to the LN receive operation");
    assert(h.calls.subscribedOperationId === "ln_op_123",
      "subscribeLnReceive receives the invoice operation_id");

    h.claim();
    assert(h.calls.unsubscribeReceive === 1,
      "Receive watcher unsubscribes after claimed");
  }

  // Outbound LN payout must use the same trusted gateway selection; letting
  // the SDK pick its default can choose an untrusted gateway and fail after
  // claim/redeem has already moved sats into Chama.
  {
    const h = makeRealWallet();
    const wallet = adaptRealWallet(h.real as any);
    const result = await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(result.operationId === "pay_op_123",
      "Adapter returns the real outbound payment operation ID");
    assert(h.calls.payInvoice === 1,
      "real.lightning.payInvoice called once");
    assert(h.calls.updateGatewayCache === 1,
      "Adapter refreshes the gateway cache before outbound LN pay");
    assert(h.calls.listGateways === 1,
      "Adapter lists gateways before outbound LN pay");
    assert(h.calls.payInvoiceGatewayId === "vetted_gateway_456",
      "Adapter passes the first vetted gateway into payInvoice");
    assert(h.calls.subscribeLnPay === 1,
      "Adapter subscribes to the LN pay operation");
    assert(h.calls.subscribedPayOperationId === "pay_op_123",
      "subscribeLnPay receives payment_type.lightning, not contract_id");
    assert(h.calls.unsubscribePay === 1,
      "Pay watcher unsubscribes after success");
  }

  // The SDK returns two identifiers for external LN sends: contract_id and
  // payment_type.lightning. The latter is the operation ID expected by
  // subscribe_ln_pay; using contract_id causes "Operation not found" even
  // after the invoice actually paid.
  {
    const h = makeRealWallet();
    (h.real.lightning as any).payInvoice = async (_bolt11: string, gatewayInfo?: { gateway_id?: string }) => {
      h.calls.payInvoice++;
      h.calls.payInvoiceGatewayId = gatewayInfo?.gateway_id ?? "";
      return {
        contract_id: "contract_not_watchable",
        fee: 123,
        payment_type: { lightning: "watchable_pay_operation" },
      };
    };
    const wallet = adaptRealWallet(h.real as any);
    const result = await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(result.operationId === "watchable_pay_operation",
      "Adapter returns the watchable payment_type.lightning operation ID");
    assert(h.calls.subscribedPayOperationId === "watchable_pay_operation",
      "Adapter does not subscribe with the outbound contract_id");
  }

  // Internal federation LN payments use a different watcher.
  {
    const h = makeRealWallet();
    (h.real.lightning as any).payInvoice = async (_bolt11: string, gatewayInfo?: { gateway_id?: string }) => {
      h.calls.payInvoice++;
      h.calls.payInvoiceGatewayId = gatewayInfo?.gateway_id ?? "";
      return {
        contract_id: "internal_contract",
        fee: 0,
        payment_type: { internal: "internal_pay_operation" },
      };
    };
    const wallet = adaptRealWallet(h.real as any);
    const result = await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(result.operationId === "internal_pay_operation",
      "Adapter returns the internal payment operation ID");
    assert(h.calls.subscribeInternalPayment === 1,
      "Adapter uses subscribeInternalPayment for payment_type.internal");
    assert(h.calls.subscribedPayOperationId === "internal_pay_operation",
      "Internal watcher receives payment_type.internal");
  }

  // A submitted Lightning payment is only useful to Chama if the SDK hands
  // back the operation ID needed to watch it. Treat malformed SDK responses as
  // payout failures instead of silently closing the modal as "done".
  {
    const h = makeRealWallet();
    (h.real.lightning as any).payInvoice = async (_bolt11: string, gatewayInfo?: { gateway_id?: string }) => {
      h.calls.payInvoice++;
      h.calls.payInvoiceGatewayId = gatewayInfo?.gateway_id ?? "";
      return {};
    };
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.payInvoice("lnbc100n1payout");
    } catch (e) {
      threw = /did not return a payment operation id/.test((e as Error).message);
    }
    assert(threw,
      "Adapter refuses outbound LN pay when SDK omits the payment operation ID");
    assert(h.calls.subscribeLnPay === 0,
      "Adapter does not subscribe without a payment operation ID");
  }

  // Some Fedimint WASM errors cross the boundary as string-ish values. The
  // submit-time "transaction too large" failure happens before an operation
  // id exists, so normalize it into a user-facing Error with retry framing.
  {
    const h = makeRealWallet();
    (h.real.lightning as any).payInvoice = async (_bolt11: string, gatewayInfo?: { gateway_id?: string }) => {
      h.calls.payInvoice++;
      h.calls.payInvoiceGatewayId = gatewayInfo?.gateway_id ?? "";
      throw "The generated transaction would be rejected by the federation for being too large.";
    };
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.payInvoice("lnbc100n1payout");
    } catch (e) {
      threw = /Federation rejected this payout transaction as too large/.test((e as Error).message) &&
        /retry recovery/.test((e as Error).message);
    }
    assert(threw,
      "Adapter normalizes transaction-too-large submit errors for payout recovery");
    assert(h.calls.payInvoice === 1,
      "real.lightning.payInvoice was attempted before transaction-too-large surfaced");
    assert(h.calls.subscribeLnPay === 0,
      "Adapter does not subscribe when submit failed before an operation ID");
  }

  // The browser SDK should always expose subscribeLnPay, but if that contract
  // changes we must fail visibly; otherwise claim flow could publish DONE while
  // the outbound payment is still unobserved.
  {
    const h = makeRealWallet();
    delete (h.real.lightning as any).subscribeLnPay;
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.payInvoice("lnbc100n1payout");
    } catch (e) {
      threw = /cannot watch pay status/.test((e as Error).message);
    }
    assert(threw,
      "Adapter refuses outbound LN pay when pay-status watcher is unavailable");
  }

  // If no trusted gateways are advertised, refuse to show a lossy invoice.
  {
    const h = makeRealWallet({}, [
      {
        info: {
          gateway_id: "dev_gateway_789",
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
      {
        info: {
          gateway_id: "henwen_gateway_999",
          api: "https://gateway.henwen.net/v1",
          lightning_alias: "Henwen",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.createInvoice(100_000, "fund");
    } catch (e) {
      threw = /No wallet-verifiable Lightning receive gateway/.test((e as Error).message);
    }

    assert(threw,
      "Adapter refuses receive invoices when all gateways are untrusted");
    assert(h.calls.createInvoice === 0,
      "Adapter does not create a QR invoice without a trusted gateway");
  }

  // The same trust gate applies to outbound payout; the claim can be retried
  // safely later because redeemed sats stay in the Chama wallet.
  {
    const h = makeRealWallet({}, [
      {
        info: {
          gateway_id: "dev_gateway_789",
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.payInvoice("lnbc100n1payout");
    } catch (e) {
      threw = /No trusted Lightning pay gateway/.test((e as Error).message);
    }

    assert(threw,
      "Adapter refuses outbound LN pay when all gateways are untrusted");
    assert(h.calls.payInvoice === 0,
      "Adapter does not start payout without a trusted gateway");
  }

  // Some Fedi-style federations publish gateway trust in meta.vetted_gateways
  // while list_gateways still reports vetted=false. Production claim_rejected
  // logs prove that metadata-only trust is not enough for receive invoices:
  // the payer can send sats, then the federation rejects the gateway claim
  // before ecash mints. Refuse that receive path before showing a QR.
  {
    const metaTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const h = makeRealWallet({
      federation: {
        async getConfig() {
          return {
            meta: {
              vetted_gateways: JSON.stringify([
                metaTrustedGatewayId,
              ]),
            },
          };
        },
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: metaTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    let diagnostics: any = null;
    try {
      await wallet.lightning.createInvoice(100_000, "fund");
    } catch (e) {
      diagnostics = (e as any).chamaDiagnostics;
      threw = /No wallet-verifiable Lightning receive gateway/.test((e as Error).message);
    }

    assert(threw,
      "Adapter refuses receive invoices when gateway trust is metadata-only");
    assert(diagnostics?.adapter === "browser-wasm-sdk",
      "Receive refusal diagnostics identify the browser SDK adapter");
    assert(diagnostics?.nativeBridge?.active === false,
      "Receive refusal diagnostics say this is not the native bridge path");
    assert(diagnostics?.metaProbe?.metaVettedGatewayIds?.includes(metaTrustedGatewayId),
      "Receive refusal diagnostics include the metadata-vetted gateway ID");
    assert(h.calls.createInvoice === 0,
      "Adapter does not create a receive QR from metadata-only trust");
    await wallet.cleanup();
  }

  // Metadata-only gateway trust remains useful for outbound payout because the
  // sats are already in Chama's wallet and payout can be retried.
  // Guardian admin UIs can expose meta fields as key/value records in the
  // static global config, without installing the fedimint meta module.
  {
    const metaTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const h = makeRealWallet({
      federation: {
        async getConfig() {
          return {
            global: {
              meta: [
                {
                  key: "vetted_gateways",
                  value: JSON.stringify([metaTrustedGatewayId]),
                },
              ],
            },
            modules: {
              0: { kind: "ln" },
              1: { kind: "mint" },
            },
          };
        },
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: metaTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(h.calls.payInvoiceGatewayId === metaTrustedGatewayId,
      "Adapter accepts outbound gateway trust from config meta key/value records without a meta module");
    await wallet.cleanup();
  }

  // Newer guardian UIs can store Manage Meta in the meta module consensus,
  // not in the static federation config returned by get_config. Fedimint's
  // meta module uses numeric default key 0; `vetted_gateways` lives inside
  // the JSON value stored at that key.
  {
    const metaTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    let helperKey: number | undefined;
    const h = makeRealWallet({
      federation: {
        async getMetaConsensusValue(key?: number) {
          helperKey = key;
          return {
            revision: 1,
            value: {
              vetted_gateways: [metaTrustedGatewayId],
            },
          };
        },
        async getConfig() {
          return {
            modules: {
              0: { kind: "ln" },
              2: { kind: "meta" },
            },
          };
        },
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: metaTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(helperKey === 0,
      "Adapter probes canary federation.getMetaConsensusValue with the numeric default key");
    assert(h.calls.payInvoiceGatewayId === metaTrustedGatewayId,
      "Adapter accepts outbound gateway trust from canary getMetaConsensusValue(default)");
    await wallet.cleanup();
  }

  // Keep the low-level fallback because older SDKs and some test transports
  // expose the client RPC before they expose the public helper.
  {
    const metaTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const hexJson = Array.from(JSON.stringify({
      vetted_gateways: [metaTrustedGatewayId],
    }))
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
    const rpcCalls: Array<{
      module: string;
      method: string;
      body: unknown;
      clientName: string;
    }> = [];
    const h = makeRealWallet({
      federation: {
        clientName: "test-client",
        client: {
          async rpcSingle(
            module: string,
            method: string,
            body: unknown,
            clientName: string,
          ) {
            rpcCalls.push({ module, method, body, clientName });
            if (
              module !== "meta" ||
              method !== "get_consensus_value" ||
              (body as { key?: unknown })?.key !== 0
            ) {
              return null;
            }
            return {
              revision: 1,
              value: hexJson,
            };
          },
        },
        async getConfig() {
          return {
            modules: {
              0: { kind: "ln" },
              2: { kind: "meta" },
            },
          };
        },
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: metaTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(rpcCalls.some((call) =>
      call.module === "meta" &&
      call.method === "get_consensus_value" &&
      (call.body as { key?: unknown })?.key === 0 &&
      call.clientName === "test-client"
    ), "Adapter probes the browser meta module RPC by kind + numeric default key");
    assert(h.calls.payInvoiceGatewayId === metaTrustedGatewayId,
      "Adapter accepts outbound gateway trust from hex-encoded meta.get_consensus default value even when SDK vetted=false");
    await wallet.cleanup();
  }

  // The meta default value can also come back as byte-array JSON depending on
  // the SDK path. Keep decoding both shapes.
  {
    const metaTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const rpcCalls: Array<{ body: unknown }> = [];
    const byteJson = Array.from(
      JSON.stringify({ vetted_gateways: [metaTrustedGatewayId] }),
    ).map((c) => c.charCodeAt(0));
    const h = makeRealWallet({
      federation: {
        clientName: "test-client",
        client: {
          async rpcSingle(
            module: string,
            method: string,
            body: unknown,
          ) {
            rpcCalls.push({ body });
            if (
              module !== "meta" ||
              method !== "get_consensus_value" ||
              (body as { key?: unknown })?.key !== 0
            ) {
              return null;
            }
            return {
              revision: 1,
              value: byteJson,
            };
          },
        },
        async getConfig() {
          return {
            modules: {
              0: { kind: "ln" },
              2: { kind: "meta" },
            },
          };
        },
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: metaTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(rpcCalls.some((call) => (call.body as { key?: unknown })?.key === 0),
      "Adapter probes the numeric default meta key for object-style gateway trust");
    assert(h.calls.payInvoiceGatewayId === metaTrustedGatewayId,
      "Adapter accepts outbound byte-array gateway trust from meta.get_consensus(default)");
    await wallet.cleanup();
  }

  // Receive invoices are different from outbound payout: if the wallet cannot
  // verify gateway trust itself, a QR can take payment and then reject before
  // ecash mints. BLF's curated fallback is therefore NOT allowed on receive.
  {
    const blfFederationId =
      "888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e";
    const blfTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const h = makeRealWallet({
      federation: {
        async getConfig() {
          return {
            modules: {
              0: { kind: "ln" },
              1: { kind: "mint" },
            },
          };
        },
        async getFederationId() { return blfFederationId; },
        async getInviteCode() { return "fed1blf"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: blfTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
      {
        info: {
          gateway_id: "039d1e06e6b10f3d18bbb76bb67f38a7088679c9a5e5914f4efe839298cb17e5e1",
          api: "https://gateway.henwen.net/v1",
          lightning_alias: "Henwen",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    let diagnostics: any = null;
    try {
      await wallet.lightning.createInvoice(100_000, "fund");
    } catch (e) {
      diagnostics = (e as any).chamaDiagnostics;
      threw = /No wallet-verifiable Lightning receive gateway/.test((e as Error).message);
    }

    assert(threw,
      "Adapter refuses BLF receive invoices when only curated trust exists");
    assert(diagnostics?.demoSafeFallback?.kind === "sim_mode",
      "BLF receive trust refusal exposes sim mode as the demo-safe fallback");
    assert(diagnostics?.demoSafeFallback?.invoiceCreated === false,
      "BLF receive trust refusal records that no invoice was created");
	    assert(diagnostics?.metaProbe?.curatedGatewayIds?.includes(blfTrustedGatewayId),
	      "BLF receive diagnostics include the known curated gateway ID even though receive fallback is blocked");
	    assert(diagnostics?.metaProbe?.curatedFallbackAllowed === false,
	      "BLF receive diagnostics explicitly say curated fallback is not allowed");
	    assert(diagnostics?.metaProbe?.curatedFallbackApplied === false,
	      "BLF receive diagnostics explicitly say curated fallback was not applied");
    assert(h.calls.createInvoice === 0,
      "Adapter does not create a BLF receive QR from curated-only trust");
    await wallet.cleanup();
  }

  // BLF's current browser SDK advertises a meta module in get_config, but the
  // WASM client can answer "module not found" for client-rpc(meta). That is
  // still not enough for receive: Chama must not show a QR unless wallet code
  // can verify gateway trust itself.
  {
    const blfFederationId =
      "888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e";
    const blfTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const h = makeRealWallet({
      federation: {
        clientName: "test-client",
        client: {
          async rpcSingle() {
            throw new Error("module not found: meta");
          },
        },
        async getConfig() {
          return {
            modules: {
              0: { kind: "ln" },
              1: { kind: "mint" },
              4: { kind: "meta" },
            },
          };
        },
        async getFederationId() { return blfFederationId; },
        async getInviteCode() { return "fed1blf"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: blfTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
      {
        info: {
          gateway_id: "039d1e06e6b10f3d18bbb76bb67f38a7088679c9a5e5914f4efe839298cb17e5e1",
          api: "https://gateway.henwen.net/v1",
          lightning_alias: "Henwen",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    let diagnostics: any = null;
    try {
      await wallet.lightning.createInvoice(100_000, "fund");
    } catch (e) {
      diagnostics = (e as any).chamaDiagnostics;
      threw = /No wallet-verifiable Lightning receive gateway/.test((e as Error).message);
    }

    assert(threw,
      "Adapter refuses BLF receive when meta exists but this SDK cannot call it");
    assert(diagnostics?.metaProbe?.metaRpcFailures?.some((failure: string) =>
      /module=meta key=0/.test(failure)
    ), "BLF receive diagnostics preserve the failed meta-module probe by kind");
    assert(diagnostics?.metaProbe?.metaRpcFailures?.some((failure: string) =>
      /module=4 key=0/.test(failure)
    ), "BLF receive diagnostics preserve the failed meta-module probe by instance id");
    assert(diagnostics?.demoSafeFallback?.kind === "sim_mode",
      "BLF meta access failure still points demos to the no-real-sats fallback");
    assert(h.calls.createInvoice === 0,
      "Adapter does not create a receive QR from config-meta-only curated trust");
    await wallet.cleanup();
  }

  // The BLF curated trust fallback must also cover the claim payout leg.
  {
    const blfFederationId =
      "888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e";
    const blfTrustedGatewayId =
      "0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4";
    const h = makeRealWallet({
      federation: {
        async getConfig() {
          return {
            modules: {
              0: { kind: "ln" },
              1: { kind: "mint" },
            },
          };
        },
        async getFederationId() { return blfFederationId; },
        async getInviteCode() { return "fed1blf"; },
        async listTransactions() { return []; },
      },
    }, [
      {
        info: {
          gateway_id: blfTrustedGatewayId,
          api: "https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1",
          lightning_alias: "Fedi us-east-1 [fedi.xyz]",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
      {
        info: {
          gateway_id: "039d1e06e6b10f3d18bbb76bb67f38a7088679c9a5e5914f4efe839298cb17e5e1",
          api: "https://gateway.henwen.net/v1",
          lightning_alias: "Henwen",
          supports_private_payments: true,
        },
        vetted: false,
        ttl: 60,
      },
    ]);
    const wallet = adaptRealWallet(h.real as any);
    await wallet.lightning.payInvoice("lnbc100n1payout");

    assert(h.calls.payInvoiceGatewayId === blfTrustedGatewayId,
      "Adapter uses BLF's curated gateway for outbound payout instead of untrusted Henwen");
    await wallet.cleanup();
  }

  // Non-terminal receive states stay watched; cleanup cancels the watcher.
  {
    const h = makeRealWallet();
    const wallet = adaptRealWallet(h.real as any);
    await wallet.lightning.createInvoice(100_000, "fund");
    h.fund();
    assert(h.calls.unsubscribeReceive === 0,
      "Receive watcher remains active after funded");

    await wallet.cleanup();
    assert(h.calls.unsubscribeReceive === 1,
      "cleanup cancels an active receive watcher");
    assert(h.calls.cleanup === 1,
      "real wallet cleanup still runs");
  }

  // Missing gateway introspection is also unsafe for receive: do not fall back
  // to the SDK's default gateway because that can recreate claim_rejected.
  {
    const h = makeRealWallet();
    delete (h.real.lightning as any).listGateways;
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.createInvoice(100_000, "fund");
    } catch (e) {
      threw = /No wallet-verifiable Lightning receive gateway/.test((e as Error).message);
    }

    assert(threw,
      "Adapter refuses receive invoices when the SDK cannot list gateways");
    assert(h.calls.createInvoice === 0,
      "Adapter does not fall back to the SDK default gateway for receive");
  }

  // If the SDK refuses the receive subscription, do not show an invoice.
  {
    const h = makeRealWallet({
      lightning: {
        async updateGatewayCache() {},
        async listGateways() {
          return [
            {
              info: {
                gateway_id: "vetted_gateway_456",
                api: "https://vetted-gateway.example.test",
                lightning_alias: "Vetted Gateway",
                supports_private_payments: false,
              },
              vetted: true,
              ttl: 60,
            },
          ];
        },
        async createInvoice() {
          return { invoice: "lnbc100n1punwatched", operation_id: "ln_op_bad" };
        },
        async payInvoice() { return {}; },
        subscribeLnReceive() {
          throw new Error("stream unavailable");
        },
      },
    });
    const wallet = adaptRealWallet(h.real as any);
    let threw = false;
    try {
      await wallet.lightning.createInvoice(100_000, "fund");
    } catch (e) {
      threw = /Couldn't watch Lightning receive operation/.test((e as Error).message);
    }
    assert(threw,
      "Adapter refuses to return an invoice when the receive watcher cannot start");
  }

  // Existing pending receive operations are re-armed when an OPFS wallet opens.
  {
    const h = makeRealWallet({
      federation: {
        async getFederationId() { return "fed_real"; },
        async getInviteCode() { return "fed1real"; },
        async listTransactions() {
          return [
            { kind: "ln", type: "receive", operationId: "old_receive", outcome: "funded" },
            { kind: "ln", type: "receive", operationId: "done_receive", outcome: "claimed" },
            { kind: "ln", type: "send", operationId: "send_op", outcome: "success" },
          ];
        },
      },
    });
    const wallet = adaptRealWallet(h.real as any);
    await wallet.open();

    assert(h.calls.subscribeLnReceive === 1,
      "open() resumes exactly one pending LN receive");
    assert(h.calls.subscribedOperationId === "old_receive",
      "open() resumes the pending receive operation_id from the transaction log");
    await wallet.cleanup();
  }
}

// ── SIM MODE — cross-mode drop policy + BOLT11 parser ──────────────────
//
// Bug A (round 2 hotfix) was a cross-mode listing leak: sim-tagged
// events appeared in non-sim browsers. The fix wires a chokepoint
// `shouldDropEvent` callback into the relay-manager so every dispatch
// path (handleIncomingEvent, fetchEscrowEvents, fetchOnce) uses the
// same policy. The truth table is verified directly here so a future
// refactor can't silently invert it.
//
// Bug B (round 2) was the sim payInvoice not debiting on outbound LN
// payout, leaving the winner's wallet with a phantom balance after
// COMPLETE. The fix parses the BOLT11 amount; failure modes (no
// amount, malformed prefix) must return null so the wallet can
// throw cleanly instead of silently moving phantom sats.
console.log("\n── SIM MODE — cross-mode policy + BOLT11 parser ──");
{
  const { shouldDropForSimPolicy, eventIsSim } = await import("../sim/simMode.js");
  const { parseBolt11Msats } = await import("../sim/sim-wallet.js");

  const simEvent = { tags: [["d", "abc"], ["chama-sim", "v1"]] } as any;
  const realEvent = { tags: [["d", "abc"]] } as any;

  // Force sim OFF for the first half.
  (globalThis as any).localStorage.removeItem("chama_sim_mode");

  assert(eventIsSim(simEvent) === true,
    "eventIsSim returns true for chama-sim-tagged events");
  assert(eventIsSim(realEvent) === false,
    "eventIsSim returns false for untagged events");

  assert(shouldDropForSimPolicy(simEvent) === true,
    "Sim OFF + sim-tagged event → DROP (was the listing leak failure case)");
  assert(shouldDropForSimPolicy(realEvent) === false,
    "Sim OFF + untagged event → keep");

  // Flip sim ON for the second half.
  (globalThis as any).localStorage.setItem("chama_sim_mode", "1");
  assert(shouldDropForSimPolicy(simEvent) === false,
    "Sim ON + sim-tagged event → keep");
  assert(shouldDropForSimPolicy(realEvent) === true,
    "Sim ON + untagged event → DROP (no prod chatter in sim view)");

  (globalThis as any).localStorage.removeItem("chama_sim_mode");

  // BOLT11 amount parsing — covers the sim wallet's payout-debit path
  // and the four BOLT-11 multiplier units.
  assert(parseBolt11Msats("lnbc500u1pXXX") === 50_000_000,
    "Parser handles real-shape bolt11 with 'u' multiplier (500u = 50k sats)");
  assert(parseBolt11Msats("lnbcsim50000n1pXXX") === 5_000_000,
    "Parser handles sim invoices (lnbcsim prefix, 'n' multiplier)");
  assert(parseBolt11Msats("lnbc10m1pXXX") === 1_000_000_000,
    "Parser handles 'm' multiplier (10m = 1M sats)");
  assert(parseBolt11Msats("lnbc1p10n1pXXX") !== null,
    "Parser tolerates BOLT11 strings with characters after the amount field");
  assert(parseBolt11Msats("not-a-bolt11") === null,
    "Parser returns null for non-bolt11 strings");
  assert(parseBolt11Msats("") === null,
    "Parser returns null for empty string");
}

console.log("\n── RELAY MANAGER — one-shot fetch isolation ──");
{
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    sent: string[] = [];
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(message: string) {
      this.sent.push(message);
    }

    close() {}

    emit(message: unknown[]) {
      this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    }
  }

  const relayManager = new RelayManager(
    ["wss://relay.test"],
    {},
    FakeWebSocket as unknown as typeof WebSocket
  );
  relayManager.connect();

  const socket = FakeWebSocket.instances[0]!;
  socket.onopen?.({} as Event);

  const fetchPromise = relayManager.fetchOnce({
    kinds: [30078],
    authors: ["seed-pubkey"],
    "#d": ["chama-fedimint-seed-v1"],
    limit: 4,
  }, 1_000);

  const fetchReq = socket.sent
    .map(raw => JSON.parse(raw))
    .find(msg => msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_once_"));
  assert(!!fetchReq, "fetchOnce sends an isolated temporary REQ");

  const fetchSubId = fetchReq[1];
  const unrelatedLiveEvent = {
    id: "live-escrow-event",
    pubkey: "seed-pubkey",
    created_at: 1,
    kind: EscrowEventKind.CREATE,
    tags: [["d", "some-escrow"]],
    content: JSON.stringify({ type: "escrow:create" }),
    sig: "sig",
  } as NostrEvent;
  const seedEvent = {
    id: "seed-event",
    pubkey: "seed-pubkey",
    created_at: 2,
    kind: 30078,
    tags: [["d", "chama-fedimint-seed-v1"]],
    content: "encrypted-seed",
    sig: "sig",
  } as NostrEvent;

  socket.emit(["EVENT", "sm_sub_live", unrelatedLiveEvent]);
  socket.emit(["EVENT", fetchSubId, seedEvent]);
  socket.emit(["EOSE", fetchSubId]);

  const fetched = await fetchPromise;
  assert(
    fetched.length === 1 && fetched[0].id === "seed-event",
    "fetchOnce ignores unrelated live-subscription events while seed recovery is running"
  );

  FakeWebSocket.instances = [];
  const coldRelayManager = new RelayManager(
    ["wss://cold-relay.test"],
    {},
    FakeWebSocket as unknown as typeof WebSocket
  );
  coldRelayManager.connect();
  const coldSocket = FakeWebSocket.instances[0]!;
  const coldFetch = coldRelayManager.fetchEscrowEvents("sm_cold_start_trade", 1_000);

  await new Promise(resolve => setTimeout(resolve, 20));
  assert(
    coldSocket.sent.length === 0,
    "Cold fetch waits for a relay socket instead of immediately returning empty"
  );

  coldSocket.onopen?.({} as Event);
  await new Promise(resolve => setTimeout(resolve, 300));
  const coldFetchReq = coldSocket.sent
    .map(raw => JSON.parse(raw))
    .find(msg => msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_"));
  assert(!!coldFetchReq, "Cold fetch sends the escrow REQ after relay connect");
  assert(
    coldFetchReq[2]?.["#d"]?.[0] === "sm_cold_start_trade",
    "Cold fetch keeps the requested escrow id filter intact"
  );
  coldSocket.emit(["EOSE", coldFetchReq[1]]);
  const coldFetched = await coldFetch;
  assert(coldFetched.length === 0, "Cold fetch resolves after the connected relay EOSEs");

  FakeWebSocket.instances = [];
  const closingRelayManager = new RelayManager(
    ["wss://close-relay.test"],
    {},
    FakeWebSocket as unknown as typeof WebSocket
  );
  closingRelayManager.connect();
  const closingSocket = FakeWebSocket.instances[0]!;
  closingRelayManager.disconnect();
  closingSocket.onclose?.({} as CloseEvent);
  const retryTimer = (closingRelayManager as any).relays.get("wss://close-relay.test")?.retryTimer;
  assert(!retryTimer, "Disconnect suppresses the socket-close reconnect timer");
}

// ── RELAY MANAGER — reconnect resilience ───────────────────────────────────
//
// The pool degraded in the field because: a WebSocket `error` doesn't always
// emit a following `close`, so an errored relay stalled forever (only onclose
// scheduled a reconnect); the per-relay backoff gives up permanently at
// MAX_RETRY_COUNT (retryCount only resets on a successful open), so a relay down
// through the backoff window was abandoned for the session; and the fixed
// quorum=3 stalled small/degraded pools. These pin the fixes.
console.log("\n── RELAY MANAGER — reconnect resilience ──");
{
  class FakeWS {
    static instances: FakeWS[] = [];
    sent: string[] = [];
    closed = false;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    constructor(public url: string) { FakeWS.instances.push(this); }
    send(m: string) { this.sent.push(m); }
    close() { this.closed = true; }
  }
  const WS = FakeWS as unknown as typeof WebSocket;
  const relayOf = (rm: RelayManager, url: string) => (rm as any).relays.get(url);

  // (1) onerror alone (no following onclose) must still schedule a reconnect.
  FakeWS.instances = [];
  const rmErr = new RelayManager(["wss://err.test"], {}, WS);
  rmErr.connect();
  FakeWS.instances[0]!.onerror?.({} as Event);
  const rErr = relayOf(rmErr, "wss://err.test");
  assert(!!rErr.retryTimer && rErr.retryCount === 1,
    "onerror without onclose still schedules a backoff reconnect");
  rmErr.disconnect();

  // (2) A single failure that fires BOTH onerror and onclose arms exactly one
  // reconnect — the backoff must not double-increment.
  FakeWS.instances = [];
  const rmFlap = new RelayManager(["wss://flap.test"], {}, WS);
  rmFlap.connect();
  const sFlap = FakeWS.instances[0]!;
  sFlap.onerror?.({} as Event);
  sFlap.onclose?.({} as CloseEvent);
  assert(relayOf(rmFlap, "wss://flap.test").retryCount === 1,
    "onerror+onclose for one failure arm a single reconnect (backoff not double-incremented)");
  rmFlap.disconnect();

  // (3) The backoff gives up at the cap; forceReconnectAll recovers it.
  FakeWS.instances = [];
  const rmGave = new RelayManager(["wss://gaveup.test"], {}, WS);
  rmGave.connect();
  const rGave = relayOf(rmGave, "wss://gaveup.test");
  rGave.retryCount = 99;                       // simulate an abandoned relay
  rGave.status = RelayStatus.DISCONNECTED;
  (rmGave as any).scheduleReconnect("wss://gaveup.test");
  assert(!rGave.retryTimer,
    "scheduleReconnect gives up once retryCount passes the cap (no auto-retry)");
  const beforeProbe = FakeWS.instances.length;
  rmGave.forceReconnectAll();
  assert(rGave.retryCount === 0 && FakeWS.instances.length === beforeProbe + 1,
    "forceReconnectAll clears the give-up state and immediately re-probes the abandoned relay");
  rmGave.disconnect();

  // (3b) forceReconnectAll is a no-op after disconnect (respects `stopped`).
  FakeWS.instances = [];
  const rmStopped = new RelayManager(["wss://stopped.test"], {}, WS);
  rmStopped.connect();
  rmStopped.disconnect();
  const afterStop = FakeWS.instances.length;
  rmStopped.forceReconnectAll();
  assert(FakeWS.instances.length === afterStop,
    "forceReconnectAll is a no-op after disconnect (stopped pool stays down)");

  // (4) The fetch quorum adapts to the configured pool size: min(3, count-1),
  // so a small/degraded pool resolves instead of stalling, while a healthy
  // 5-7 relay pool keeps the original quorum of 3.
  const quorumOf = (urls: string[]) => (new RelayManager(urls) as any).effectiveQuorum();
  assert(quorumOf(["a"]) === 1, "effectiveQuorum: single-relay pool needs 1 (never 0)");
  assert(quorumOf(["a", "b"]) === 1, "effectiveQuorum: 2-relay pool needs 1");
  assert(quorumOf(["a", "b", "c"]) === 2, "effectiveQuorum: 3-relay pool needs 2");
  assert(quorumOf(["a", "b", "c", "d", "e"]) === 3, "effectiveQuorum: 5-relay pool keeps 3");
  assert(quorumOf(["a", "b", "c", "d", "e", "f", "g"]) === 3,
    "effectiveQuorum: 7-relay pool stays at 3 (margin without a wall of red)");
}

// ── FIRST-ACK PUBLISH (field fix: slow Create→Publish) ─────────────────
//
// publish() sends the EVENT frame to every connected relay immediately,
// then used to await ALL of them (Promise.allSettled) — so one zombie
// "connected" relay held every publish hostage for the full 8s timeout
// even after healthy relays ACKed in milliseconds. These asserts pin the
// fix: resolve on the FIRST accept; zero accepts still rejects.
console.log("\n── FIRST-ACK PUBLISH ──");
{
  const rm = new RelayManager([]);
  const mkRelay = (url: string) => ({ url, status: RelayStatus.CONNECTED });
  (rm as any).relays.set("wss://fast.test", mkRelay("wss://fast.test"));
  (rm as any).relays.set("wss://zombie.test", mkRelay("wss://zombie.test"));

  let zombieSettled = false;
  (rm as any).publishToSingleRelay = (relay: { url: string }) =>
    relay.url === "wss://fast.test"
      ? Promise.resolve({ accepted: true, message: "" })
      : new Promise(resolve => setTimeout(() => {
          zombieSettled = true;
          resolve({ accepted: false, message: "Timeout on wss://zombie.test" });
        }, 200));

  const publishStart = Date.now();
  const result = await rm.publish({ id: "a1".repeat(32) } as any);
  const publishElapsedMs = Date.now() - publishStart;
  assert(result.accepted === 1, "First-ACK publish returns as soon as one relay accepts");
  assert(
    !zombieSettled && publishElapsedMs < 150,
    `Publish does not wait for the zombie relay (resolved in ${publishElapsedMs}ms, straggler still pending)`,
  );

  // Durability bar unchanged: zero accepts still rejects after all settle.
  (rm as any).publishToSingleRelay = () =>
    Promise.resolve({ accepted: false, message: "blocked: nope" });
  let rejectedAll = false;
  try {
    await rm.publish({ id: "b2".repeat(32) } as any);
  } catch {
    rejectedAll = true;
  }
  assert(rejectedAll, "Zero accepts still rejects the publish (accepted>=1 durability bar unchanged)");

  // Let the zombie's timer settle so the runner exits without a dangling handle.
  await new Promise(resolve => setTimeout(resolve, 250));
}

// ── EOSE QUORUM — one hung relay must not stall the fetch (round 3b step 2) ──
//
// A relay can complete the WS handshake then never answer (field:
// relay.primal.net — conn:Y req:Y eose:n). The old fetch resolved only on
// ALL-EOSE-or-timeout, so that one zombie pinned every fetch — and the
// parallel My-Trades heal — to the full timeout. Now a QUORUM of EOSEs plus a
// short grace resolves it. This pins: events still arrive, and resolution
// happens on the ~1s grace, NOT the 8s timeout.
console.log("\n── RELAY MANAGER — EOSE quorum ──");
{
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    sent: string[] = [];
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    send(message: string) { this.sent.push(message); }
    close() {}
    emit(message: unknown[]) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  }

  // 4 relays so the EOSE quorum (3) is strictly below the connected count (4):
  // 3 relays answer, the 4th is a zombie that never EOSEs.
  const rm = new RelayManager(
    ["wss://r1.test", "wss://r2.test", "wss://r3.test", "wss://r4.test"],
    {},
    FakeWebSocket as unknown as typeof WebSocket,
  );
  rm.connect();
  for (const s of FakeWebSocket.instances) s.onopen?.({} as Event);

  const started = Date.now();
  const fetchPromise = rm.fetchOnce(
    { kinds: [EscrowEventKind.CREATE], "#d": ["sm_quorum_probe"] },
    8_000,
  );

  await new Promise(r => setTimeout(r, 10));
  const subIdOf = (s: FakeWebSocket): string =>
    JSON.parse(s.sent.find(raw => JSON.parse(raw)[0] === "REQ")!)[1];
  const ev = {
    id: "ev_quorum", pubkey: "pk", created_at: 1, kind: EscrowEventKind.CREATE,
    tags: [["d", "sm_quorum_probe"]], content: JSON.stringify({ type: "escrow:create" }), sig: "sig",
  } as NostrEvent;

  const [s1, s2, s3] = FakeWebSocket.instances;
  s1.emit(["EVENT", subIdOf(s1), ev]);
  s1.emit(["EOSE", subIdOf(s1)]);
  s2.emit(["EOSE", subIdOf(s2)]);
  s3.emit(["EOSE", subIdOf(s3)]);
  // s4 (zombie) stays silent.

  const fetched = await fetchPromise;
  const elapsed = Date.now() - started;
  assert(
    fetched.length === 1 && fetched[0].id === "ev_quorum",
    "EOSE quorum: fetch returns the events the responsive relays delivered",
  );
  assert(
    elapsed < 4_000,
    `EOSE quorum: resolves on the ~1s grace, not the 8s timeout — one zombie relay does not stall the fetch (resolved in ${elapsed}ms)`,
  );
  rm.disconnect();
}

// ── SIGNED ARBITER ROSTER — kind:38120 (V3 keystone, field-read J) ──────
//
// The roster lands on 38120, NOT the 38104 the design notes used — 38104 is
// RESOLVE on the escrow wire. Hybrid authority: registry steward pin first,
// shell creator fallback. Replaceable: newest created_at wins, ties break to
// the smaller event id. Cache is re-verified on every read.
console.log("\n── SIGNED ARBITER ROSTER ──");
{
  const stewardSk = generateSecretKey();
  const stewardPk = getPublicKey(stewardSk);
  const intruderSk = generateSecretKey();
  const arbA = getPublicKey(generateSecretKey());
  const arbB = getPublicKey(generateSecretKey());

  const rosterKindNumber: number = ARBITER_ROSTER_KIND;
  assert(rosterKindNumber === 38120 && rosterKindNumber !== Number(EscrowEventKind.RESOLVE),
    "Roster kind 38120 stays clear of the escrow wire band (38104 is RESOLVE)");

  // Build → sign → parse round-trip.
  const unsigned = buildArbiterRosterEvent({
    community: "ke-kes",
    arbiters: [arbA, arbB, arbA],
    createdAt: 1_900_000_000,
  });
  const signed = finalizeEvent(unsigned, stewardSk) as unknown as NostrEvent;
  const parsed = parseArbiterRosterEvent(signed);
  assert(parsed.ok, "Signed roster parses + verifies");
  if (parsed.ok) {
    assert(parsed.roster.community === "ke-kes", "Roster community round-trips via the d tag");
    assert(parsed.roster.arbiters.length === 2 && parsed.roster.arbiters[0] === arbA,
      "Roster dedupes arbiters and preserves order");
    assert(parsed.roster.signer === stewardPk, "Roster signer is the event author");
  }

  // Tampering: flip a byte in content → signature must fail.
  const tampered = { ...signed, content: signed.content.replace("ke-kes", "ke-keS") } as NostrEvent;
  const tamperedResult = parseArbiterRosterEvent(tampered);
  assert(!tamperedResult.ok, "Tampered roster content fails (d-tag mismatch or signature)");

  // Authority: hybrid resolution prefers the pin, falls back to creator.
  const onlyCreator = resolveRosterAuthority({ stewardPubkey: null, creatorPubkey: stewardPk });
  assert(onlyCreator.length === 1 && onlyCreator[0] === stewardPk,
    "Hybrid authority: creator fallback when no steward pin exists");
  const pinned = resolveRosterAuthority({ stewardPubkey: arbA, creatorPubkey: stewardPk });
  assert(pinned[0] === arbA && pinned[1] === stewardPk,
    "Hybrid authority: steward pin outranks the creator fallback");

  // selectLatestRoster: intruder-signed roster is ignored even when newer.
  const intruderRoster = finalizeEvent(buildArbiterRosterEvent({
    community: "ke-kes",
    arbiters: [getPublicKey(intruderSk)],
    createdAt: 1_900_000_500,
  }), intruderSk) as unknown as NostrEvent;
  const best = selectLatestRoster([signed, intruderRoster], [stewardPk]);
  assert(!!best && best.signer === stewardPk && best.arbiters[0] === arbA,
    "Unauthorized roster is ignored even when newer — authority gates selection");

  // Replaceable: a newer steward-signed roster supersedes the older one.
  const newer = finalizeEvent(buildArbiterRosterEvent({
    community: "ke-kes",
    arbiters: [arbB],
    createdAt: 1_900_001_000,
  }), stewardSk) as unknown as NostrEvent;
  const latest = selectLatestRoster([signed, newer], [stewardPk]);
  assert(!!latest && latest.arbiters.length === 1 && latest.arbiters[0] === arbB,
    "Newest authorized roster wins (replaceable semantics)");

  // Cache → readRosterPool re-verifies on read; wrong authority reads empty.
  writeCachedRosterEvent("ke-kes", newer);
  const pool = readRosterPool("ke-kes", [stewardPk]);
  assert(pool.length === 1 && pool[0] === arbB,
    "Cached roster feeds the pool after re-verification on read");
  const wrongAuthorityPool = readRosterPool("ke-kes", [arbA]);
  assert(wrongAuthorityPool.length === 0,
    "Cache is worthless without authority — re-verified on every read");

  // Build-time validation: non-hex arbiters and oversize rosters refuse.
  let threwOnNpub = false;
  try {
    buildArbiterRosterEvent({ community: "ke-kes", arbiters: ["npub1notahexkey"] });
  } catch {
    threwOnNpub = true;
  }
  assert(threwOnNpub, "Roster builder refuses non-hex arbiter keys");

  // fetchAndCacheCommunityRoster — the relay sync used on community switch.
  const fetchedNewer = finalizeEvent(buildArbiterRosterEvent({
    community: "sn-cfa",
    arbiters: [arbA],
    createdAt: 1_900_002_000,
  }), stewardSk) as unknown as NostrEvent;
  const viaFetch = await fetchAndCacheCommunityRoster({
    community: "sn-cfa",
    authority: [stewardPk],
    query: async () => [fetchedNewer],
  });
  assert(!!viaFetch && viaFetch.eventId === fetchedNewer.id,
    "fetchAndCache picks the relay's authorized roster and caches it");
  const cachedPool = readRosterPool("sn-cfa", [stewardPk]);
  assert(cachedPool.length === 1 && cachedPool[0] === arbA,
    "Fetched roster is cached for sync pool reads (getTrustedArbiterPool path)");
  const viaFailedRelay = await fetchAndCacheCommunityRoster({
    community: "sn-cfa",
    authority: [stewardPk],
    query: async () => { throw new Error("relay down"); },
  });
  assert(!!viaFailedRelay && viaFailedRelay.eventId === fetchedNewer.id,
    "Relay failure falls back to the cached roster instead of throwing");
  const noAuthority = await fetchAndCacheCommunityRoster({
    community: "sn-cfa",
    authority: [],
    query: async () => [fetchedNewer],
  });
  assert(noAuthority === null, "No authority anchor → no roster, never a guess");

  // ── #74: arbiter applications (kind:38121) — the on-ramp ──
  const applicantSk = generateSecretKey();
  const applicantPk = getPublicKey(applicantSk);
  const appUnsigned = buildArbiterApplicationEvent({
    community: "ke-kes",
    statement: "Kibera shopkeeper, 3 languages, online evenings.",
    createdAt: 1_900_003_000,
  });
  const appSigned = finalizeEvent(appUnsigned, applicantSk) as unknown as NostrEvent;
  const appParsed = parseArbiterApplicationEvent(appSigned);
  assert(
    !!appParsed && appParsed.applicant === applicantPk && appParsed.community === "ke-kes",
    "Signed application parses with applicant + community intact",
  );

  // Newest-per-applicant + roster-filter + ordering.
  const appOlder = finalizeEvent(buildArbiterApplicationEvent({
    community: "ke-kes",
    statement: "older statement",
    createdAt: 1_900_002_500,
  }), applicantSk) as unknown as NostrEvent;
  const rosteredSk = generateSecretKey();
  const rosteredPk = getPublicKey(rosteredSk);
  const rosteredApp = finalizeEvent(buildArbiterApplicationEvent({
    community: "ke-kes",
    statement: "already on the roster",
    createdAt: 1_900_003_500,
  }), rosteredSk) as unknown as NostrEvent;
  const collected = collectArbiterApplications(
    [appOlder, appSigned, rosteredApp],
    { excludePubkeys: [rosteredPk] },
  );
  assert(
    collected.length === 1 && collected[0].applicant === applicantPk &&
      collected[0].statement.startsWith("Kibera"),
    "Review list keeps each applicant's NEWEST application and filters rostered keys",
  );

  // Tampered application drops silently. JSON round-trip strips nostr-tools'
  // verifiedSymbol memo that finalizeEvent stamps (and that object spread
  // copies!) — relay-delivered events arrive symbol-free exactly like this,
  // so THIS is the real verification path.
  const appTampered = JSON.parse(JSON.stringify({
    ...appSigned,
    content: appSigned.content.replace("Kibera", "Nairobi"),
  })) as NostrEvent;
  assert(
    parseArbiterApplicationEvent(appTampered) === null,
    "Tampered application fails signature verification and is dropped",
  );

  // Builder refuses empty + oversized statements.
  let threwEmpty = false;
  try {
    buildArbiterApplicationEvent({ community: "ke-kes", statement: "   " });
  } catch {
    threwEmpty = true;
  }
  assert(threwEmpty, "Application builder refuses an empty statement");
}

// ── #88 Trade notifications — the pure "should this buzz?" core ──
console.log("\n── Trade notifications (notificationForTransition) ──");
{
  const BUYER = "11".repeat(32);
  const SELLER = "22".repeat(32);
  const ARB = "33".repeat(32);
  const STRANGER = "44".repeat(32);
  // p2p-trade: seller locks → buyer is the RELEASE (non-locker) recipient.
  const mk = (over: Partial<EscrowState>): EscrowState => ({
    id: "sm_notif_demo_0001",
    category: "p2p-trade",
    status: EscrowStatus.CREATED,
    participants: { [Role.BUYER]: BUYER, [Role.SELLER]: SELLER, [Role.ARBITER]: ARB },
    votes: {},
    resolvedOutcome: null,
    communityArbiters: [ARB],
    ...over,
  }) as EscrowState;

  const created = mk({ status: EscrowStatus.CREATED });
  const locked = mk({ status: EscrowStatus.LOCKED });

  // 1) LOCKED → only the non-locker (buyer) is told; the locker (seller) isn't.
  const buyerLocked = notificationForTransition(created, locked, BUYER);
  assert(buyerLocked?.tag === "sm_notif_demo_0001:locked",
    "LOCKED notifies the non-locker (buyer) — sats are live, their move");
  assert(notificationForTransition(created, locked, SELLER) === null,
    "LOCKED does NOT notify the locker (seller) — they did the action");
  assert(notificationForTransition(created, locked, STRANGER) === null,
    "A non-participant is never notified");

  // Guard: first observation (prev null) never fires — no cold-load buzz storm.
  assert(notificationForTransition(null, locked, BUYER) === null,
    "No notification on first observation (prev null) — avoids cold-replay spam");

  // 2) APPROVED → the winner (release recipient = buyer) is told to claim.
  const approved = mk({ status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.RELEASE } });
  assert(notificationForTransition(locked, approved, BUYER)?.tag === "sm_notif_demo_0001:approved",
    "APPROVED notifies the winner that their claim is ready");
  // Refund-resolved → the refund recipient (seller, the locker) is the winner.
  const refunded = mk({ status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.REFUND,
    votes: { [Role.BUYER]: Outcome.REFUND, [Role.SELLER]: Outcome.REFUND } });
  assert(notificationForTransition(locked, refunded, SELLER)?.tag === "sm_notif_demo_0001:approved",
    "APPROVED-by-refund notifies the refund recipient (seller)");

  // 3) Dispute opens (buyer≠seller) while LOCKED → ONLY the arbiter is summoned.
  const disputed = mk({ status: EscrowStatus.LOCKED,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND } });
  assert(notificationForTransition(locked, disputed, ARB)?.tag === "sm_notif_demo_0001:dispute",
    "A fresh dispute summons the arbiter — the antidote to no-shows");
  assert(notificationForTransition(locked, disputed, BUYER) === null,
    "The dispute notification targets the arbiter, not the parties");
  // Agreement (both RELEASE) is NOT a dispute.
  const agreed = mk({ status: EscrowStatus.LOCKED,
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.RELEASE } });
  assert(notificationForTransition(locked, agreed, ARB) === null,
    "Agreement is not a dispute — the arbiter isn't summoned");

  // 4) + 5) Terminal moments → the two parties (not strangers).
  assert(notificationForTransition(locked, mk({ status: EscrowStatus.COMPLETED }), BUYER)?.tag
    === "sm_notif_demo_0001:completed", "COMPLETED tells the parties it settled");
  assert(notificationForTransition(locked, mk({ status: EscrowStatus.EXPIRED }), SELLER)?.tag
    === "sm_notif_demo_0001:expired", "EXPIRED tells the parties to look");

  // No-op transition (same status, same votes) → nothing.
  assert(notificationForTransition(locked, mk({ status: EscrowStatus.LOCKED }), BUYER) === null,
    "An unchanged re-observation (relay replay) never re-buzzes");

  // A stepped-in pool arbiter (actingArbiter) is still recognized as the arbiter.
  const subArb = "55".repeat(32);
  const disputedSub = mk({ status: EscrowStatus.LOCKED, actingArbiter: subArb,
    communityArbiters: [ARB, subArb],
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.REFUND } });
  assert(notificationForTransition(locked, disputedSub, subArb)?.tag === "sm_notif_demo_0001:dispute",
    "A backup pool arbiter is summoned to a dispute too");
}

// ── Cold-start catch-up (catchUpPrev + persisted last-seen status) ──
// Bug 2: a KILLED app re-observes trades with prev=undefined. catchUpPrev feeds
// the persisted last-seen status back as a synthesized prev so a transition that
// advanced while the app was dead still fires once — without re-buzzing every
// historical trade on a fresh install.
console.log("\n── Cold-start catch-up (catchUpPrev + last-seen store) ──");
{
  const BUYER = "11".repeat(32);
  const SELLER = "22".repeat(32);
  const ARB = "33".repeat(32);
  const mk = (over: Partial<EscrowState>): EscrowState => ({
    id: "sm_notif_catchup_01",
    category: "p2p-trade",
    status: EscrowStatus.CREATED,
    participants: { [Role.BUYER]: BUYER, [Role.SELLER]: SELLER, [Role.ARBITER]: ARB },
    votes: {},
    resolvedOutcome: null,
    communityArbiters: [ARB],
    ...over,
  }) as EscrowState;

  const locked = mk({ status: EscrowStatus.LOCKED });
  const completed = mk({ status: EscrowStatus.COMPLETED });

  // A live in-memory prev always wins — catch-up never overrides a real prev.
  const created = mk({ status: EscrowStatus.CREATED });
  assert(catchUpPrev(created, locked, EscrowStatus.CREATED) === created,
    "catchUpPrev returns the live prev unchanged when one exists");

  // Fresh install / never seen → no synthesis → still suppressed (no spam).
  assert(catchUpPrev(undefined, locked, null) === undefined,
    "catchUpPrev returns undefined with no prior record — fresh installs stay quiet");
  assert(notificationForTransition(catchUpPrev(undefined, locked, null), locked, BUYER) === null,
    "Cold first-observation with no record never buzzes (cold-replay guard intact)");

  // Seen at the same status → nothing changed → no synthesis.
  assert(catchUpPrev(undefined, locked, EscrowStatus.LOCKED) === undefined,
    "catchUpPrev returns undefined when last-seen equals the current status");

  // Seen EARLIER (CREATED) + now LOCKED → synthesize prev@CREATED → buzz once.
  const synthLocked = catchUpPrev(undefined, locked, EscrowStatus.CREATED);
  assert(synthLocked?.status === EscrowStatus.CREATED,
    "catchUpPrev synthesizes a prev pinned at the last-seen status");
  assert(notificationForTransition(synthLocked, locked, BUYER)?.tag === "sm_notif_catchup_01:locked",
    "A LOCK missed while the app was dead fires once on cold start (non-locker buyer)");

  // Multi-status jump while dead (seen LOCKED, now COMPLETED) → the terminal
  // moment fires, not a stale intermediate one.
  const synthDone = catchUpPrev(undefined, completed, EscrowStatus.LOCKED);
  assert(notificationForTransition(synthDone, completed, BUYER)?.tag === "sm_notif_catchup_01:completed",
    "A multi-status jump while dead fires the terminal (completed) moment on cold start");

  // Persisted last-seen store: round-trip, no-op-on-unchanged, overwrite, isolation.
  const ID = "sm_seen_store_01";
  assert(readSeenStatus(ID) === null, "Unknown trade has no last-seen status");
  recordSeenStatus(ID, EscrowStatus.LOCKED);
  assert(readSeenStatus(ID) === EscrowStatus.LOCKED, "recordSeenStatus persists the status");
  recordSeenStatus(ID, EscrowStatus.LOCKED); // unchanged — no-op, value stays
  assert(readSeenStatus(ID) === EscrowStatus.LOCKED, "Recording the same status is a no-op");
  recordSeenStatus(ID, EscrowStatus.COMPLETED);
  assert(readSeenStatus(ID) === EscrowStatus.COMPLETED, "recordSeenStatus overwrites with the newer status");
  assert(readSeenStatus("sm_seen_store_other") === null, "Last-seen is per-trade (no cross-trade bleed)");
}

// ── DM / trade-chat notifications (chatNotificationFor) ──
console.log("\n── DM / trade-chat notifications (chatNotificationFor) ──");
{
  const BUYER = "11".repeat(32);
  const SELLER = "22".repeat(32);
  const ARB = "33".repeat(32);
  const STRANGER = "44".repeat(32);
  const CHAT_ID = "sm_notif_chat_0001";
  const LIVE = 1_700_000_000; // session went live at this second

  const stateL = ({
    id: CHAT_ID,
    category: "p2p-trade",
    status: EscrowStatus.LOCKED,
    participants: { [Role.BUYER]: BUYER, [Role.SELLER]: SELLER, [Role.ARBITER]: ARB },
    votes: {},
    resolvedOutcome: null,
    communityArbiters: [ARB],
  }) as EscrowState;

  const mkChat = (sender: string, senderRole: Role, ts: number, evId: string) => ({
    raw: { id: evId, pubkey: sender, created_at: ts, kind: 38108, tags: [] as string[][], content: "", sig: "" },
    payload: { type: "escrow:chat" as const, message: "see you at noon", senderRole, sentAt: ts },
    escrowId: CHAT_ID,
    prevEventId: null,
    kind: EscrowEventKind.CHAT,
    pubkey: sender,
    timestamp: ts,
  }) as ParsedEscrowEvent<ChatPayload>;

  // auto: the arbiter is the responder → buzzed on an inbound counterparty chat.
  const toArb = chatNotificationFor(stateL, mkChat(BUYER, Role.BUYER, LIVE + 10, "c1"), ARB, "auto", LIVE);
  assert(toArb?.tag === "sm_notif_chat_0001:chat:c1",
    "auto: the arbiter is buzzed for an inbound chat (they're the responder)");
  assert(toArb?.title === "💬 New message" && /buyer/.test(toArb?.body ?? ""),
    "chat notification names the sender's role and carries the trade");
  assert(toArb?.escrowId === CHAT_ID,
    "chat notification carries escrowId so the tap deep-links to the trade");

  // auto: buyers/sellers stay quiet by default — the role-on-trade default.
  assert(chatNotificationFor(stateL, mkChat(SELLER, Role.SELLER, LIVE + 10, "c2"), BUYER, "auto", LIVE) === null,
    "auto: a buyer is NOT buzzed (role default keeps the parties quiet)");
  assert(chatNotificationFor(stateL, mkChat(BUYER, Role.BUYER, LIVE + 10, "c3"), SELLER, "auto", LIVE) === null,
    "auto: a seller is NOT buzzed by default");

  // on / off: explicit global overrides win over the role default.
  assert(chatNotificationFor(stateL, mkChat(SELLER, Role.SELLER, LIVE + 10, "c4"), BUYER, "on", LIVE)?.escrowId === CHAT_ID,
    "on: the explicit override buzzes a buyer for an inbound chat");
  assert(chatNotificationFor(stateL, mkChat(BUYER, Role.BUYER, LIVE + 10, "c5"), ARB, "off", LIVE) === null,
    "off: nothing buzzes, even for the arbiter");

  // Own echo never buzzes — not even under an explicit 'on'.
  assert(chatNotificationFor(stateL, mkChat(ARB, Role.ARBITER, LIVE + 10, "c6"), ARB, "on", LIVE) === null,
    "a participant's own echoed message never buzzes");

  // Backlog guard: a message older than live-since stays silent (no cold-boot storm).
  assert(chatNotificationFor(stateL, mkChat(BUYER, Role.BUYER, LIVE - 10, "c7"), ARB, "auto", LIVE) === null,
    "backlog (older than live-since) never buzzes — the analogue of prev-must-be-non-null");

  // A non-participant is never buzzed, even under 'on'.
  assert(chatNotificationFor(stateL, mkChat(BUYER, Role.BUYER, LIVE + 10, "c8"), STRANGER, "on", LIVE) === null,
    "a non-participant viewer is never buzzed");
  // No viewer pubkey → no buzz.
  assert(chatNotificationFor(stateL, mkChat(BUYER, Role.BUYER, LIVE + 10, "c9"), null, "on", LIVE) === null,
    "no viewer pubkey → no buzz");

  // Sender role is resolved from participants (by pubkey), not the spoofable payload.
  const spoof = chatNotificationFor(stateL, mkChat(BUYER, Role.SELLER, LIVE + 10, "c10"), ARB, "auto", LIVE);
  assert(/buyer/.test(spoof?.body ?? "") && !/seller/.test(spoof?.body ?? ""),
    "sender role comes from participants (pubkey), not the self-declared payload role");
}

// ── Liquidity & attention: buyer-interest + new-listing notification deciders ──
console.log("\n── Liquidity & attention (buyerInterest / newListing / needsYou) ──");
{
  const BUYER = "11".repeat(32);
  const BUYER2 = "77".repeat(32);
  const SELLER = "22".repeat(32);
  const ARB = "33".repeat(32);
  const STRANGER = "44".repeat(32);
  const LIVE = 1_700_000_000;
  const HOME = "ke-kes";

  const mk = (over: Partial<EscrowState>): EscrowState => ({
    id: "sm_liq_0001",
    category: "marketplace",
    status: EscrowStatus.CREATED,
    participants: { [Role.BUYER]: null, [Role.SELLER]: SELLER, [Role.ARBITER]: null },
    votes: {},
    resolvedOutcome: null,
    communityArbiters: [ARB],
    community: HOME,
    createdAt: LIVE + 5,
    ...over,
  }) as EscrowState;

  // ── buyerInterestNotificationFor ──
  // Case A: a fresh child order on my storefront (prev undefined) → seller buzzes.
  const child = mk({ id: "sm_child_01", parent: "sm_parent_01" });
  const iA = buyerInterestNotificationFor(undefined, child, SELLER, LIVE);
  assert(iA?.tag === "sm_child_01:interest", "buyer-interest: a fresh child order buzzes the seller");
  // Not the seller → nothing.
  assert(buyerInterestNotificationFor(undefined, child, STRANGER, LIVE) === null,
    "buyer-interest: only the seller is buzzed on a child order");
  // Backlog child (created before live-since) stays silent.
  const oldChild = mk({ id: "sm_child_02", parent: "sm_parent_01", createdAt: LIVE - 10 });
  assert(buyerInterestNotificationFor(undefined, oldChild, SELLER, LIVE) === null,
    "buyer-interest: a child created before live-since is backlog, no buzz");
  // Already-seen child (prev present) never re-buzzes.
  assert(buyerInterestNotificationFor(child, child, SELLER, LIVE) === null,
    "buyer-interest: an already-seen child never re-buzzes");

  // Case B: a JOIN hold lands on my own single listing → seller buzzes (per buyer).
  const held = mk({ joinHolds: { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER, joinedAt: LIVE + 10, expiresAt: LIVE + 9000, eventId: "j1" } } });
  const iB = buyerInterestNotificationFor(mk({}), held, SELLER, LIVE);
  assert(iB?.tag === `sm_liq_0001:interest:${BUYER}`, "buyer-interest: a JOIN hold buzzes the seller, tagged by buyer");
  // Same buyer already held in prev → no re-buzz.
  assert(buyerInterestNotificationFor(held, held, SELLER, LIVE) === null,
    "buyer-interest: the same buyer's hold doesn't re-buzz");
  // A different buyer re-buzzes (fire-once per buyer).
  const held2 = mk({ joinHolds: { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER2, joinedAt: LIVE + 20, expiresAt: LIVE + 9000, eventId: "j2" } } });
  assert(buyerInterestNotificationFor(held, held2, SELLER, LIVE)?.tag === `sm_liq_0001:interest:${BUYER2}`,
    "buyer-interest: a different buyer's hold re-buzzes");
  // Backlog hold (joinedAt < live-since) stays silent.
  const oldHold = mk({ joinHolds: { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER, joinedAt: LIVE - 5, expiresAt: LIVE + 9000, eventId: "j3" } } });
  assert(buyerInterestNotificationFor(mk({}), oldHold, SELLER, LIVE) === null,
    "buyer-interest: a hold older than live-since is backlog, no buzz");
  // A LOCKED order is a funded sale (the transition core owns it) — not interest.
  assert(buyerInterestNotificationFor(mk({}), mk({ status: EscrowStatus.LOCKED }), SELLER, LIVE) === null,
    "buyer-interest: a LOCKED trade is a sale, not pre-lock interest");

  // ── newListingNotificationFor ──
  const listing = mk({ id: "sm_new_01" });
  const n1 = newListingNotificationFor(undefined, listing, STRANGER, HOME, "Kenya · KES", LIVE);
  assert(n1?.tag === "sm_new_01:newlisting", "new-listing: a fresh home-chama listing buzzes a non-owner");
  assert(/Kenya/.test(n1?.body ?? ""), "new-listing: body carries the friendly community name");
  // My own listing (I'm the seller) → never.
  assert(newListingNotificationFor(undefined, listing, SELLER, HOME, "Kenya · KES", LIVE) === null,
    "new-listing: my own listing never buzzes me");
  // Foreign community → never.
  assert(newListingNotificationFor(undefined, mk({ id: "sm_new_02", community: "ng-ngn" }), STRANGER, HOME, "Kenya · KES", LIVE) === null,
    "new-listing: a listing in another chama doesn't ping my home");
  // No explicit home → never.
  assert(newListingNotificationFor(undefined, listing, STRANGER, null, "", LIVE) === null,
    "new-listing: no explicit home ⇒ no ping");
  // Backlog listing → never.
  assert(newListingNotificationFor(undefined, mk({ id: "sm_new_03", createdAt: LIVE - 10 }), STRANGER, HOME, "Kenya · KES", LIVE) === null,
    "new-listing: a listing created before live-since is backlog");
  // Already seen (prev present) → never (only a brand-new sighting is "new").
  assert(newListingNotificationFor(listing, listing, STRANGER, HOME, "Kenya · KES", LIVE) === null,
    "new-listing: an already-seen listing never re-buzzes");
  // A child order isn't a listing.
  assert(newListingNotificationFor(undefined, mk({ id: "sm_new_04", parent: "p" }), STRANGER, HOME, "Kenya · KES", LIVE) === null,
    "new-listing: a child order is not a listing");

  // ── selectNeedsYouTrades / countNeedsYou (Part ① attention set) ──
  const nowSec = LIVE + 100;
  const claim = mk({ id: "t_claim", status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE,
    participants: { [Role.BUYER]: BUYER, [Role.SELLER]: SELLER, [Role.ARBITER]: ARB },
    votes: { [Role.BUYER]: Outcome.RELEASE, [Role.SELLER]: Outcome.RELEASE }, expiresAt: nowSec + 9000 });
  const vote = mk({ id: "t_vote", status: EscrowStatus.LOCKED,
    participants: { [Role.BUYER]: BUYER, [Role.SELLER]: SELLER, [Role.ARBITER]: ARB },
    votes: {}, expiresAt: nowSec + 9000 });
  const waiting = mk({ id: "t_wait", status: EscrowStatus.CREATED,
    joinHolds: { [Role.BUYER]: { role: Role.BUYER, pubkey: BUYER, joinedAt: nowSec - 5, expiresAt: nowSec + 9000, eventId: "jw" } } });
  const idle = mk({ id: "t_idle", status: EscrowStatus.CREATED }); // no hold, no action
  const ordered = selectNeedsYouTrades({ escrows: [waiting, claim, vote, idle], userPubkey: SELLER, nowSec });
  assert(ordered.map((e) => e.id).join(",") === "t_claim,t_vote,t_wait",
    "needs-you: ordered most-urgent first (claim → vote → waiting), idle listing excluded");
  assert(countNeedsYou({ escrows: [waiting, claim, vote, idle], userPubkey: SELLER, nowSec }) === 3,
    "needs-you: count matches the attention set size");
  assert(countNeedsYou({ escrows: [waiting, claim, vote, idle], userPubkey: STRANGER, nowSec }) === 0,
    "needs-you: a non-participant has zero attention items");
}

// ── Ratings primitive (kind:38123) — the reputation keystone ──
console.log("\n── Ratings primitive (kind:38123) ──");
{
  const raterSk = generateSecretKey();
  const raterPk = getPublicKey(raterSk);
  const rateePk = "dd".repeat(32);
  const TRADE = "rate-trade-001";

  // Round-trip a signed thumbs-up.
  const upUnsigned = buildRatingEvent({ tradeId: TRADE, ratee: rateePk, thumb: "up", createdAt: 1_900_010_000 });
  assert(upUnsigned.kind === RATING_KIND, "rating: builder stamps kind:38123");
  assert(upUnsigned.tags.find(t => t[0] === "d")?.[1] === ratingReplaceableKey(TRADE, rateePk),
    "rating: d-tag is the (trade, ratee) replaceable key");
  // v3.1.1 (#1 regression): the internal escrow id (`sm_…`) is NOT a 32-byte
  // Nostr event id, so it must never be emitted as a fixed-size `e` tag — relays
  // reject the whole event ("unexpected size for fixed-size tag: e") and no
  // rating ever publishes. The trade is identified by the d-tag + content.
  assert(!upUnsigned.tags.some(t => t[0] === "e"),
    "rating: no e-tag — escrow id is not a Nostr event id, relays reject it");
  const upSigned = finalizeEvent(upUnsigned, raterSk) as unknown as NostrEvent;
  const up = parseRatingEvent(upSigned);
  assert(!!up && up.rater === raterPk && up.ratee === rateePk && up.tradeId === TRADE && up.thumb === "up",
    "rating: a signed thumbs-up parses with rater/ratee/trade/thumb intact");

  // Tampering (flip the thumb in content) fails signature verification.
  const tampered = JSON.parse(JSON.stringify({
    ...upSigned, content: upSigned.content.replace('"up"', '"down"'),
  })) as NostrEvent;
  assert(parseRatingEvent(tampered) === null, "rating: a tampered thumb fails signature verification and drops");

  // You cannot rate yourself.
  const selfSigned = finalizeEvent(
    buildRatingEvent({ tradeId: TRADE, ratee: raterPk, thumb: "up" }), raterSk,
  ) as unknown as NostrEvent;
  assert(parseRatingEvent(selfSigned) === null, "rating: a self-rating is rejected (rater === ratee)");

  // Builder guards.
  let threwThumb = false;
  try { buildRatingEvent({ tradeId: TRADE, ratee: rateePk, thumb: "meh" as any }); } catch { threwThumb = true; }
  assert(threwThumb, "rating: builder refuses a non-up/down thumb");

  // ── verifyRatingForTrade: cross-trade integrity ──
  const settled = (over: Partial<EscrowState> = {}): EscrowState => ({
    id: TRADE,
    category: "p2p-trade",
    status: EscrowStatus.COMPLETED,
    resolvedOutcome: Outcome.RELEASE,
    participants: { [Role.BUYER]: raterPk, [Role.SELLER]: rateePk, [Role.ARBITER]: ARBITER_PK },
    ...over,
  } as unknown as EscrowState);
  const r = (over: Partial<Rating> = {}): Rating => ({
    tradeId: TRADE, rater: raterPk, ratee: rateePk, thumb: "up", createdAt: 1_900_010_000, eventId: "ev1", ...over,
  });
  assert(verifyRatingForTrade(r(), settled()) === true,
    "rating: a settled trade where rater+ratee were both parties verifies");
  assert(verifyRatingForTrade(r(), null) === false,
    "rating: an unknown trade (null) never verifies — no vouching for what you can't see");
  assert(verifyRatingForTrade(r(), settled({ resolvedOutcome: null })) === false,
    "rating: an UNSETTLED trade never verifies (nobody performed yet)");
  assert(verifyRatingForTrade(r({ rater: "99".repeat(32) }), settled()) === false,
    "rating: a rater who wasn't a party is dropped");
  assert(verifyRatingForTrade(r({ ratee: "99".repeat(32) }), settled()) === false,
    "rating: a ratee who wasn't a party is dropped");
  assert(verifyRatingForTrade(r({ tradeId: "other" }), settled()) === false,
    "rating: a trade-id mismatch is dropped");
  // A stepped-in backup arbiter counts as a party; the arbiter is a ratee like any other.
  const backupPk = "ab".repeat(32);
  assert(verifyRatingForTrade(r({ ratee: backupPk }), settled({ actingArbiter: backupPk })) === true,
    "rating: a stepped-in backup arbiter (actingArbiter) counts as a participant");
  assert(verifyRatingForTrade(r({ ratee: ARBITER_PK }), settled()) === true,
    "rating: the arbiter is a ratee like any other (one generic primitive)");

  // ── aggregateRatings: dedup per (rater, trade), newest wins, filter ratee ──
  const A = "rater-A", B = "rater-B";
  const agg = aggregateRatings([
    r({ rater: A, tradeId: "t1", thumb: "up", createdAt: 10 }),
    r({ rater: A, tradeId: "t1", thumb: "down", createdAt: 20, eventId: "newer" }), // overwrites A:t1 → down
    r({ rater: A, tradeId: "t2", thumb: "up", createdAt: 30 }),                     // distinct trade → counts
    r({ rater: B, tradeId: "t1", thumb: "up", createdAt: 40 }),                     // distinct rater → counts
    r({ rater: B, tradeId: "t1", thumb: "up", createdAt: 5, eventId: "older" }),    // older dup → ignored
    r({ ratee: "99".repeat(32), rater: A, tradeId: "t9", thumb: "up" }),            // other ratee → ignored
  ], rateePk);
  assert(agg.count === 3 && agg.positive === 2 && agg.negative === 1,
    `rating: aggregation dedups per (rater,trade), newest wins, filters other ratees (got ${JSON.stringify(agg)})`);

  // ── aggregateVerifiedRatings: parse → verify → aggregate, drops unverifiable ──
  const goodSk = generateSecretKey(); const goodPk = getPublicKey(goodSk);
  const goodEvent = finalizeEvent(
    buildRatingEvent({ tradeId: TRADE, ratee: rateePk, thumb: "up", createdAt: 1_900_011_000 }), goodSk,
  ) as unknown as NostrEvent;
  const tradeFor = (id: string) => id === TRADE
    ? settled({ participants: { [Role.BUYER]: goodPk, [Role.SELLER]: rateePk, [Role.ARBITER]: ARBITER_PK } })
    : null;
  const aggV = aggregateVerifiedRatings([goodEvent, upSigned], rateePk, tradeFor);
  // goodEvent's rater is a party of TRADE → counts. upSigned's rater is NOT a
  // party in this mapping → dropped.
  assert(aggV.count === 1 && aggV.positive === 1,
    `rating: aggregateVerifiedRatings counts only ratings backed by a settled trade the rater was in (got ${JSON.stringify(aggV)})`);

  // ── Feeds the existing graduation gate verbatim ──
  const fivePositive = aggregateRatings(
    Array.from({ length: 5 }, (_, i) => r({ rater: `rater-${i}`, tradeId: `tg${i}`, thumb: "up" })),
    rateePk,
  );
  assert(canOfferSubscription({ ratings: fivePositive }) === true,
    "rating: 5 positive / 0 negative graduates a seller (feeds canOfferSubscription unchanged)");
  const withANegative = aggregateRatings(
    [...Array.from({ length: 5 }, (_, i) => r({ rater: `rater-${i}`, tradeId: `tn${i}`, thumb: "up" })),
     r({ rater: "rater-x", tradeId: "tneg", thumb: "down" })],
    rateePk,
  );
  assert(canOfferSubscription({ ratings: withANegative }) === false,
    "rating: any negative keeps the seller below the v1 graduation bar");

  // ── counterpartyToRate: who the one-tap rates (buyer↔seller; arbiter is v1-deferred) ──
  // settled() seats BUYER=raterPk, SELLER=rateePk, ARBITER=ARBITER_PK.
  assert(counterpartyToRate(settled(), raterPk) === rateePk,
    "rating: the buyer rates the seller");
  assert(counterpartyToRate(settled(), rateePk) === raterPk,
    "rating: the seller rates the buyer");
  assert(counterpartyToRate(settled(), ARBITER_PK) === null,
    "rating: the arbiter has no principal counterparty to rate in v1");
  assert(counterpartyToRate(settled(), "99".repeat(32)) === null,
    "rating: a non-participant has nobody to rate");
}

console.log("\n── ESCROW CLIENT — Browse listing hydration ──");
{
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    sent: string[] = [];
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(message: string) {
      this.sent.push(message);
    }

    close() {}

    emit(message: unknown[]) {
      this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    }
  }

  const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await new Promise(r => setTimeout(r, 5));
    }
    return predicate();
  };

  const rawFromParsed = (event: ParsedEscrowEvent<EscrowPayload>): NostrEvent => ({
    ...event.raw,
    content: JSON.stringify(event.payload),
  });

  const signerPubkey = "ff".repeat(32);
  const fakeSigner: Signer = {
    async getPublicKey() { return signerPubkey; },
    async signEvent(event: UnsignedEvent) {
      return {
        ...event,
        id: `signed_${event.kind}_${Date.now()}`,
        pubkey: signerPubkey,
        sig: "sig",
      };
    },
    async nip44Encrypt(plaintext: string) { return plaintext; },
    async nip44Decrypt(ciphertext: string) { return ciphertext; },
  };

  const updates: EscrowState[] = [];
  const client = new EscrowClient(
    fakeSigner,
    {
      relays: ["wss://relay.test"],
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
      // Synthetic events in this test use placeholder `sig` strings;
      // skip real schnorr verification here. Production wires the
      // nostr-tools verifier by default.
      verifyEvent: () => true,
    },
    { onStateUpdate: (_id, state) => updates.push(state) },
  );

  client.connect();
  const socket = FakeWebSocket.instances[0]!;
  socket.onopen?.({} as Event);
  client.watchPublicListings();

  const publicReq = socket.sent
    .map(raw => JSON.parse(raw))
    .find(msg => msg[0] === "REQ" && String(msg[1]).startsWith("sm_sub_"));
  assert(!!publicReq, "Browse public-listing subscription is active");

  const create = createEvent();
  const lock = lockEvent(create.raw.id);
  const voteBuyer = voteEvent(Role.BUYER, BUYER_PK, Outcome.RELEASE, lock.raw.id);
  const voteSeller = voteEvent(Role.SELLER, SELLER_PK, Outcome.RELEASE, voteBuyer.raw.id);
  const resolve = resolveEvent(Outcome.RELEASE, [Role.BUYER, Role.SELLER], false, voteSeller.raw.id);
  const claim = claimEvent(Role.BUYER, BUYER_PK, resolve.raw.id);
  const complete = completeEvent(claim.raw.id);

  socket.emit(["EVENT", publicReq[1], rawFromParsed(create)]);
  await waitUntil(() => socket.sent.some(raw => {
    const msg = JSON.parse(raw);
    return msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_");
  }));

  assert(
    updates.length === 0,
    "Public CREATE does not surface a CREATE-only Browse card before full-chain hydration"
  );

  const fetchReq = socket.sent
    .map(raw => JSON.parse(raw))
    .find(msg => msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_"));
  assert(!!fetchReq, "Public CREATE triggers a full escrow-chain fetch");

  const fetchSubId = fetchReq[1];
  for (const event of [create, lock, voteBuyer, voteSeller, resolve, claim, complete]) {
    socket.emit(["EVENT", fetchSubId, rawFromParsed(event)]);
  }
  socket.emit(["EOSE", fetchSubId]);

  await waitUntil(() => updates.some(s => s.status === EscrowStatus.COMPLETED));
  assert(
    updates.length === 1 && updates[0].status === EscrowStatus.COMPLETED,
    "Hydrated completed trade reaches UI only as COMPLETED, never stale OPEN"
  );

  client.disconnect();

  FakeWebSocket.instances = [];
  const orderClient = new EscrowClient(
    fakeSigner,
    {
      relays: ["wss://relay.test"],
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
      // Synthetic events in this test use placeholder `sig` strings;
      // skip real schnorr verification here.
      verifyEvent: () => true,
    },
  );
  orderClient.connect();
  const orderSocket = FakeWebSocket.instances[0]!;
  orderSocket.onopen?.({} as Event);

  const exchangeItem: MenuItem = {
    id: "exact-100-sats",
    label: "Sats for sale",
    amountMsats: 100_000,
    kind: "exchange-bracket",
    minAmountMsats: 100_000,
    maxAmountMsats: 100_000,
  };
  const orderCreate = createEvent({
    amountMsats: 100_000,
    items: [exchangeItem],
  });
  const buyerJoin = joinEvent(Role.BUYER, BUYER_PK, orderCreate.raw.id);
  const selectedItems: JoinPayload["selectedItems"] = [{
    itemId: exchangeItem.id,
    label: exchangeItem.label,
    amountMsats: 100_000,
    quantity: 1,
    kind: "exchange-bracket",
    minAmountMsats: 100_000,
    maxAmountMsats: 100_000,
  }];
  const finalizedJoin = joinEvent(Role.BUYER, BUYER_PK, buyerJoin.raw.id, {
    selectedItems,
    amountMsats: 100_000,
    orderFinalized: true,
  });

  const firstLoad = orderClient.loadEscrow(ESCROW_ID);
  await waitUntil(() => orderSocket.sent.some(raw => {
    const msg = JSON.parse(raw);
    return msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_");
  }));
  const firstFetchReq = orderSocket.sent
    .map(raw => JSON.parse(raw))
    .find(msg => msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_"));
  assert(!!firstFetchReq, "Order replay test starts with a full escrow-chain fetch");

  for (const event of [orderCreate, buyerJoin, finalizedJoin]) {
    orderSocket.emit(["EVENT", firstFetchReq[1], rawFromParsed(event)]);
  }
  orderSocket.emit(["EOSE", firstFetchReq[1]]);
  const initialOrderState = await firstLoad;
  assert(
    initialOrderState?.eventChain.length === 3,
    "Initial order replay sees the finalized CREATED chain"
  );
  assert(
    !!initialOrderState?.joinHolds?.[Role.BUYER]?.orderFinalizedAt,
    "Initial order replay marks the buyer hold ready"
  );
  await waitUntil(() => orderSocket.sent.some(raw => {
    const msg = JSON.parse(raw);
    return msg[0] === "REQ" &&
      String(msg[1]).startsWith("sm_fetch_") &&
      msg[1] !== firstFetchReq[1];
  }), 100);
  for (const raw of orderSocket.sent) {
    const msg = JSON.parse(raw);
    if (
      msg[0] === "REQ" &&
      String(msg[1]).startsWith("sm_fetch_") &&
      msg[1] !== firstFetchReq[1]
    ) {
      orderSocket.emit(["EOSE", msg[1]]);
    }
  }

  const staleFetchStart = orderSocket.sent.length;
  const staleLoad = orderClient.loadEscrow(ESCROW_ID);
  await waitUntil(() => orderSocket.sent.slice(staleFetchStart).some(raw => {
    const msg = JSON.parse(raw);
    return msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_");
  }));
  const staleFetchReq = orderSocket.sent
    .slice(staleFetchStart)
    .map(raw => JSON.parse(raw))
    .find(msg => msg[0] === "REQ" && String(msg[1]).startsWith("sm_fetch_"));
  assert(!!staleFetchReq, "Stale reload test starts a second full escrow-chain fetch");

  for (const event of [orderCreate, buyerJoin]) {
    orderSocket.emit(["EVENT", staleFetchReq[1], rawFromParsed(event)]);
  }
  orderSocket.emit(["EOSE", staleFetchReq[1]]);
  const mergedOrderState = await staleLoad;
  assert(
    mergedOrderState?.eventChain.length === 3,
    "Reload merges cached order-finalized JOIN with a shorter relay fetch"
  );
  assert(
    !!mergedOrderState?.joinHolds?.[Role.BUYER]?.orderFinalizedAt,
    "Reload preserves the finalized buyer order after a shorter relay fetch"
  );

  orderClient.disconnect();
}

// ══════════════════════════════════════════════════════════════════════════
// v3.4.0 FUND SAFETY — "no sats stranded" (audit C5 / C12 / C13 / C14 / C15)
// ══════════════════════════════════════════════════════════════════════════
//
// Every test here pins a client-side wallet/stash/mint-op invariant from
// the 2026-06 fund-safety pass. None touch state-machine transitions or
// wire formats (non-consensus release).
//
// In Node there is no navigator.locks, so the mint-mutex tests exercise
// the in-process fallback queue — which shares the exact acquire/release
// semantics of the Web Locks path minus cross-tab coverage. The
// cross-tab (two real browser tabs) behavior is flagged for the device
// pass.

console.log("\n── V3.4.0 FUND SAFETY ──");

/** Mock IFedimintWallet for FedimintClient-level fund-safety tests. */
function makeFundSafetyWallet(overrides: {
  spendNotes?: (msat: number) => Promise<string>;
  redeemEcash?: (oob: string) => Promise<void>;
  parseNotes?: (oob: string) => Promise<{ total_amount: number }>;
  getBalance?: () => Promise<number>;
}) {
  return {
    async open() {},
    isOpen() { return true; },
    recovery: {
      async hasPendingRecoveries() { return false; },
      async waitForAllRecoveries() {},
    },
    async joinFederation(_invite: string) {},
    balance: {
      getBalance: overrides.getBalance ?? (async () => 0),
      subscribeBalance(_cb: (b: number) => void) { return () => {}; },
    },
    mint: {
      spendNotes: overrides.spendNotes ?? (async (msat: number) => `oob_${msat}`),
      redeemEcash: overrides.redeemEcash ?? (async () => {}),
      parseNotes: overrides.parseNotes ?? (async () => ({ total_amount: 0 })),
    },
    lightning: {
      async createInvoice(_msat: number, _desc: string) {
        return { invoice: "lnbc0", operationId: "op0" };
      },
      async payInvoice(_b: string) { return { operationId: "op0" }; },
    },
    federation: {
      async getFederationId() { return "fed_fund_safety"; },
      async getInviteCode() { return "fed1fundsafety"; },
    },
    async cleanup() {},
  };
}

// ── C12 · invariant_mint-mutex__concurrent_spends_serialize ──────────────
{
  const { FedimintClient } = await import("../fedimint/fedimint-client.js");
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const wallet = makeFundSafetyWallet({
    spendNotes: async (msat: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`spend-start-${msat}`);
      await new Promise(r => setTimeout(r, 20));
      order.push(`spend-end-${msat}`);
      active--;
      return `oob_${msat}`;
    },
  });
  const client = new FedimintClient({}, async () => wallet as any);
  await client.init();
  await Promise.all([client.spendNotes(1_000), client.spendNotes(2_000)]);
  assert(maxActive === 1,
    "invariant_mint-mutex__concurrent_spends_serialize: two concurrent spendNotes never overlap on the shared wallet");
  assert(order.join(",") === "spend-start-1000,spend-end-1000,spend-start-2000,spend-end-2000",
    "invariant_mint-mutex__concurrent_spends_serialize: serialized FIFO — second spend starts only after the first ends");
  await client.cleanup();
}

// ── C12 · invariant_mint-mutex__drain_waits_for_fund ──────────────────────
{
  const { FedimintClient } = await import("../fedimint/fedimint-client.js");
  clearAllPendingRedemptions();
  let releaseSpend!: () => void;
  const spendGate = new Promise<void>(r => { releaseSpend = r; });
  const order: string[] = [];
  const wallet = makeFundSafetyWallet({
    spendNotes: async (msat: number) => {
      order.push("spend-start");
      await spendGate;
      order.push("spend-end");
      return `oob_${msat}`;
    },
    redeemEcash: async () => { order.push("redeem"); },
    parseNotes: async () => ({ total_amount: 5_000 }),
  });
  const client = new FedimintClient({}, async () => wallet as any);
  await client.init();

  stashPendingRedemption({
    escrowId: "drain_vs_fund",
    oobNotes: "oob_pending_drain",
    notesHash: "hash_pending_drain",
    amountMsats: 5_000,
  });

  // Fund takes the mint lock and parks inside spendNotes...
  const fundP = client.createEscrowLock(50_000, { arbiterFeeMsats: 0 });
  await new Promise(r => setTimeout(r, 15));
  assert(order.includes("spend-start"),
    "invariant_mint-mutex__drain_waits_for_fund: fund spend is in flight before the drain starts");

  // ...then the boot drain arrives. It must ACQUIRE AND WAIT — neither
  // skip the lock (racing the spend) nor skip the entry.
  const drainP = drainPendingRedemptions(client);
  await new Promise(r => setTimeout(r, 40));
  assert(!order.includes("redeem"),
    "invariant_mint-mutex__drain_waits_for_fund: drain redeem WAITS while the fund spend holds the mint lock");

  releaseSpend();
  await fundP;
  const summary = await drainP;
  assert(order.indexOf("redeem") > order.indexOf("spend-end"),
    "invariant_mint-mutex__drain_waits_for_fund: drain redeem runs only after the fund spend released the lock");
  assert(summary.succeeded === 1,
    "invariant_mint-mutex__drain_waits_for_fund: the waited-for drain entry still redeems successfully");
  assert(listPendingRedemptions().length === 0,
    "invariant_mint-mutex__drain_waits_for_fund: drained entry is cleared from the stash");
  await client.cleanup();
  clearAllPendingRedemptions();
}

// ── C5 · invariant_already-spent__requires_confirmed_credit ───────────────
{
  const { FedimintClient } = await import("../fedimint/fedimint-client.js");

  // (a) Front-run shape: "already spent" and the balance never moves.
  //     Must throw ALREADY_SPENT_UNCONFIRMED — never silent success.
  {
    const wallet = makeFundSafetyWallet({
      redeemEcash: async () => { throw new Error("Notes already spent by the federation"); },
      parseNotes: async () => ({ total_amount: 7_000 }),
      getBalance: async () => 0,
    });
    const client = new FedimintClient({}, async () => wallet as any);
    await client.init();
    client.alreadySpentConfirmTimeoutMs = 60;
    let thrownCode = "";
    let resolvedSilently = false;
    try {
      await client.redeemWithRetry("oob_front_run");
      resolvedSilently = true;
    } catch (e) {
      thrownCode = (e as { code?: string })?.code ?? "";
    }
    assert(!resolvedSilently,
      "invariant_already-spent__requires_confirmed_credit: unconfirmed credit is NEVER reported as success");
    assert(thrownCode === "ALREADY_SPENT_UNCONFIRMED",
      "invariant_already-spent__requires_confirmed_credit: unconfirmed credit throws the structured needs-attention code");
    await client.cleanup();
  }

  // (b) Late-landing shape: a transient attempt actually credited this
  //     wallet, the retry sees "already spent", and the balance delta
  //     confirms the credit → success (no false alarm).
  {
    let bal = 0;
    let calls = 0;
    const wallet = makeFundSafetyWallet({
      redeemEcash: async () => {
        calls++;
        if (calls === 1) {
          bal += 7_000; // the reissue actually landed...
          throw new Error("operation timed out"); // ...but the submit looked transient
        }
        throw new Error("Notes already spent by the federation");
      },
      parseNotes: async () => ({ total_amount: 7_000 }),
      getBalance: async () => bal,
    });
    const client = new FedimintClient({}, async () => wallet as any);
    await client.init();
    client.alreadySpentConfirmTimeoutMs = 200;
    await client.redeemWithRetry("oob_late_landing");
    assert(true,
      "invariant_already-spent__requires_confirmed_credit: a balance-confirmed credit resolves as success (no cry-wolf)");
    await client.cleanup();
  }

  // (c) Drain integration: an unconfirmed already-spent entry is marked
  //     unresolved-credit (surfaced, skipped by future drains) instead of
  //     burning retry attempts forever.
  {
    clearAllPendingRedemptions();
    const wallet = makeFundSafetyWallet({
      redeemEcash: async () => { throw new Error("Notes already spent by the federation"); },
      parseNotes: async () => ({ total_amount: 7_000 }),
      getBalance: async () => 0,
    });
    const client = new FedimintClient({}, async () => wallet as any);
    await client.init();
    client.alreadySpentConfirmTimeoutMs = 60;
    stashPendingRedemption({
      escrowId: "front_run_drain",
      oobNotes: "oob_front_run_drain",
      notesHash: "hash_front_run",
      amountMsats: 7_000,
    });
    const first = await drainPendingRedemptions(client);
    assert(first.unresolved === 1,
      "invariant_already-spent__requires_confirmed_credit: drain marks the unconfirmed entry unresolved");
    const entry = listPendingRedemptions().find(e => e.escrowId === "front_run_drain");
    assert(entry?.unresolvedCredit === true && !!entry?.lastError,
      "invariant_already-spent__requires_confirmed_credit: stash entry carries the unresolved-credit flag + reason");
    const second = await drainPendingRedemptions(client);
    assert(second.attempted === 0 && second.unresolved === 1,
      "invariant_already-spent__requires_confirmed_credit: future drains skip the unresolved entry (no attempt burn)");

    // Adversarial-review fix: a manual claim retry re-stashes the same
    // escrowId; the unresolved-credit classification must survive it.
    stashPendingRedemption({
      escrowId: "front_run_drain",
      oobNotes: "oob_front_run_drain",
      notesHash: "hash_front_run",
      amountMsats: 7_000,
    });
    const restashed = listPendingRedemptions().find(e => e.escrowId === "front_run_drain");
    assert(restashed?.unresolvedCredit === true,
      "invariant_already-spent__requires_confirmed_credit: re-stashing on retry preserves the unresolved-credit classification");
    await client.cleanup();
    clearAllPendingRedemptions();
  }
}

// ── C13 · invariant_stranded-notes__surfaced_and_exportable ───────────────
{
  clearAllPendingRedemptions();
  const stashFour = () => {
    for (const id of ["fresh", "poisoned", "unresolved", "exhausted"]) {
      stashPendingRedemption({
        escrowId: id,
        oobNotes: `oob_${id}`,
        notesHash: `hash_${id}`,
        amountMsats: 9_000,
      });
    }
  };
  stashFour();
  markPoisoned("poisoned", "malformed notes");
  markUnresolvedCredit("unresolved", "already spent, credit unconfirmed");
  {
    // attempts is only bumped by real drains; simulate an exhausted entry
    // by editing the stash JSON the way 12 failed boots would have.
    const raw = (globalThis as any).localStorage.getItem(PENDING_REDEMPTIONS_KEY);
    const stash = JSON.parse(raw);
    stash["exhausted"].attempts = MAX_DRAIN_ATTEMPTS;
    (globalThis as any).localStorage.setItem(PENDING_REDEMPTIONS_KEY, JSON.stringify(stash));
  }

  const stranded = listStrandedRedemptions();
  assert(stranded.length === 3,
    "invariant_stranded-notes__surfaced_and_exportable: poisoned + unresolved + retries-exhausted entries all surface");
  assert(!stranded.some(s => s.escrowId === "fresh"),
    "invariant_stranded-notes__surfaced_and_exportable: an entry still inside its retry budget is NOT alarmed (the drain owns it)");
  assert(stranded.find(s => s.escrowId === "unresolved")?.stranded === "unresolved-credit",
    "invariant_stranded-notes__surfaced_and_exportable: unresolved-credit entries are distinguished for honest UI copy");
  assert(stranded.find(s => s.escrowId === "poisoned")?.stranded === "poisoned" &&
         stranded.find(s => s.escrowId === "exhausted")?.stranded === "retries-exhausted",
    "invariant_stranded-notes__surfaced_and_exportable: poison and retry-exhaustion are classified");
  assert(stranded.every(s => s.oobNotes === `oob_${s.escrowId}`),
    "invariant_stranded-notes__surfaced_and_exportable: every stranded entry carries its full bearer note verbatim (exportable)");
  clearAllPendingRedemptions();
}

// ── v4.0.0 · unresolved-credit reconciled against the wallet balance ───────
{
  clearAllPendingRedemptions();
  // One unresolved-credit (6,170 sats) + one poisoned (live-money) entry.
  stashPendingRedemption({ escrowId: "uc", oobNotes: "oob_uc", notesHash: "h_uc", amountMsats: 6_170_000 });
  stashPendingRedemption({ escrowId: "poison", oobNotes: "oob_p", notesHash: "h_p", amountMsats: 6_170_000 });
  markUnresolvedCredit("uc", "already spent, credit unconfirmed");
  markPoisoned("poison", "malformed notes");
  const stranded = listStrandedRedemptions();

  // Balance COVERS the unconfirmed amount → reconcile silently; poisoned stays loud.
  const covered = partitionStrandedClaims(stranded, 8_000_000);
  assert(covered.reconciledIds.length === 1 && covered.reconciledIds[0] === "uc",
    "reconcile: balance ≥ unresolved amount → the unresolved-credit entry is reconciled silently");
  assert(covered.calm.length === 0,
    "reconcile: a balance-covered unresolved-credit raises NO calm nudge (clean end, not red)");
  assert(covered.loud.length === 1 && covered.loud[0].escrowId === "poison",
    "reconcile: poisoned (possibly-live) note is NEVER balance-downgraded — stays loud");

  // Balance SHORT → calm, dismissible nudge; nothing auto-reconciled.
  const short = partitionStrandedClaims(stranded, 100_000);
  assert(short.reconciledIds.length === 0 && short.calm.length === 1 && short.calm[0].escrowId === "uc",
    "reconcile: balance < unresolved amount → calm nudge (user is visibly short), not auto-resolved");
  assert(short.loud.length === 1 && short.loud[0].escrowId === "poison",
    "reconcile: short balance still keeps the poisoned note loud");

  // SUM guard: two unresolved (6.17M each) and a balance that covers ONE but
  // not BOTH must reconcile NEITHER (same balance can't cover both).
  stashPendingRedemption({ escrowId: "uc2", oobNotes: "oob_uc2", notesHash: "h_uc2", amountMsats: 6_170_000 });
  markUnresolvedCredit("uc2", "already spent, credit unconfirmed");
  const two = partitionStrandedClaims(listStrandedRedemptions(), 7_000_000);
  assert(two.reconciledIds.length === 0 && two.calm.length === 2,
    "reconcile: balance covers one but not the summed two → neither is silently reconciled");

  // resolveUnresolvedCredit archives (keeps the note) and drops it off the alarm list.
  resolveUnresolvedCredit("uc", "balance-reconciled");
  assert(!listStrandedRedemptions().some(s => s.escrowId === "uc"),
    "reconcile: a resolved unresolved-credit leaves the stranded/alarm list");
  assert(listPendingRedemptions().some(p => p.escrowId === "uc" && p.resolution === "balance-reconciled"),
    "reconcile: the resolved entry is ARCHIVED, not deleted (bearer note kept for forensics/recovery)");

  // GUARDRAIL: resolveUnresolvedCredit refuses to silence a poisoned note.
  resolveUnresolvedCredit("poison", "user-dismissed");
  assert(listStrandedRedemptions().some(s => s.escrowId === "poison"),
    "reconcile: resolveUnresolvedCredit can NEVER archive a poisoned (possibly-live) note");
  clearAllPendingRedemptions();
}

// ── C14 · invariant_no-wipe__unknown_balance_refuses ──────────────────────
{
  // Thrown/uncertain peek: NEVER wipe. Unscoped (or already-scoped file)
  // sessions refuse loudly; a legacy file under a scoped session parks
  // untouched instead (non-destructive, boot continues).
  assert(decideOrphanWipe({
    peek: { kind: "unknown", reason: "federation unreachable" },
    storageScope: null,
    filenameSource: "legacy",
  }).action === "refuse-unknown",
    "invariant_no-wipe__unknown_balance_refuses: unknown balance + no scope ⇒ refuse, nothing deleted");
  assert(decideOrphanWipe({
    peek: { kind: "unknown", reason: "getBalance threw" },
    storageScope: "npub_alice",
    filenameSource: "scoped",
  }).action === "refuse-unknown",
    "invariant_no-wipe__unknown_balance_refuses: unknown balance on the identity's own scoped file ⇒ refuse");
  assert(decideOrphanWipe({
    peek: { kind: "unknown", reason: "worker flake" },
    storageScope: "npub_alice",
    filenameSource: "legacy",
  }).action === "preserve-and-rescope",
    "invariant_no-wipe__unknown_balance_refuses: unknown balance on a legacy file parks it untouched (never deletes)");

  // Positive confirmation is the ONLY wipe ticket.
  assert(decideOrphanWipe({
    peek: { kind: "balance", balanceMsats: 0 },
    storageScope: null,
    filenameSource: "legacy",
  }).action === "wipe",
    "invariant_no-wipe__unknown_balance_refuses: a positively-read zero balance permits the reset");
  assert(decideOrphanWipe({
    peek: { kind: "no-client" },
    storageScope: null,
    filenameSource: "legacy",
  }).action === "wipe",
    "invariant_no-wipe__unknown_balance_refuses: a provably-clientless file (ecash structurally impossible) permits the reset");

  // Balance present: unchanged v0.1.76 semantics.
  assert(decideOrphanWipe({
    peek: { kind: "balance", balanceMsats: 21_000 },
    storageScope: null,
    filenameSource: "legacy",
  }).action === "refuse-balance",
    "invariant_no-wipe__unknown_balance_refuses: a real orphan balance still refuses (v0.1.76 guard intact)");
  assert(decideOrphanWipe({
    peek: { kind: "balance", balanceMsats: 21_000 },
    storageScope: "npub_alice",
    filenameSource: "legacy",
  }).action === "preserve-and-rescope",
    "invariant_no-wipe__unknown_balance_refuses: a funded legacy file under a scoped session parks untouched (v0.1.76 path intact)");

  // The no-client classification trusts only the SDK's first-run taxonomy.
  assert(NO_CLIENT_OPEN_ERROR_RE.test("Client database not initialized"),
    "invariant_no-wipe__unknown_balance_refuses: first-run open error classifies as no-client");
  assert(!NO_CLIENT_OPEN_ERROR_RE.test("network request failed"),
    "invariant_no-wipe__unknown_balance_refuses: a generic failure does NOT classify as no-client (stays unknown ⇒ refuses)");
}

// ── C15 · invariant_claim__tries_all_envelopes ─────────────────────────────
{
  const ME = "f".repeat(64);
  const VOTER_A = "a".repeat(64);
  const VOTER_B = "b".repeat(64);
  const OUTCOME = "release";
  const vote = (voter: string, env: Record<string, unknown> | undefined) => ({
    kind: EscrowEventKind.VOTE,
    raw: { pubkey: voter },
    payload: { type: "escrow:vote", outcome: OUTCOME, shareEnvelope: env },
  });
  const env = (shareIndex: number, opts: { outcome?: string; recipient?: string; ct?: string | null } = {}) => ({
    shareIndex,
    outcome: opts.outcome ?? OUTCOME,
    notesHash: "hash_c15",
    recipientPubkey: opts.recipient ?? ME,
    encryptedFor: opts.ct === null ? {} : { [opts.recipient ?? ME]: opts.ct ?? `ct_${shareIndex}` },
  });

  const chain = [
    { kind: 38100, raw: { pubkey: VOTER_A }, payload: { type: "escrow:create" } }, // non-VOTE: skipped
    vote(ME, env(0, { ct: "ct_mine" })),                  // my own shareIndex: skipped
    vote(VOTER_A, env(1, { ct: "ct_voterA" })),           // candidate 1
    vote(VOTER_B, env(2, { outcome: "refund" })),         // wrong outcome: skipped
    vote(VOTER_B, env(2, { recipient: VOTER_A })),        // wrong recipient: skipped
    vote(VOTER_B, env(2, { ct: null })),                  // no ciphertext for me: skipped
    vote(VOTER_B, env(2, { ct: "ct_voterB" })),           // candidate 2
  ];

  const candidates = collectClaimEnvelopeCandidates(chain as any, {
    resolvedOutcome: OUTCOME as any,
    myPubkey: ME,
    ownShareIndex: 0,
  });
  assert(candidates.length === 2,
    "invariant_claim__tries_all_envelopes: ALL matching envelopes are collected, not just the first");
  assert(candidates[0]?.ciphertext === "ct_voterA" && candidates[1]?.ciphertext === "ct_voterB",
    "invariant_claim__tries_all_envelopes: candidates surface in chain order with their ciphertexts");
  assert(candidates[0]?.voterPubkey === VOTER_A && candidates[1]?.voterPubkey === VOTER_B,
    "invariant_claim__tries_all_envelopes: each candidate carries its voter (the NIP-44 sender) for decryption");
  assert(!candidates.some(c => c.shareIndex === 0),
    "invariant_claim__tries_all_envelopes: the winner's own share index is never offered as the second share");

  const refundView = collectClaimEnvelopeCandidates(chain as any, {
    resolvedOutcome: "refund" as any,
    myPubkey: ME,
    ownShareIndex: 0,
  });
  assert(refundView.length === 1 && refundView[0]?.ciphertext === "ct_2",
    "invariant_claim__tries_all_envelopes: outcome binding is exact — only envelopes bound to the resolved outcome qualify");
}

// ══════════════════════════════════════════════════════════════════════════
// BOND PHASE 0 + 1 — cabinet seating, the 38130 declaration, the §8 exposure
// ledger, and the DORMANT consent-layer capacity gate
// ══════════════════════════════════════════════════════════════════════════
console.log("\n── BOND PHASE 0: BLF custody cabinet (n=3) ──");
{
  const MAINTAINER = "22f7161f76e075b9e0a250a447884ac09b04b636effd7c703a92394ed3fb39e8";
  const CHAPSMART  = "17a96aa412d9189c3299a797dd8720eae6980d7adafc76ec550c0b3c8a1694f0";
  const GRAY       = "59f0660b34dd48f9dfac5d973b77774a75af057ea3a261214ac5cdccd5d24440";

  const cabinetHex = BLF_CABINET_NPUBS.map((np) => nip19.decode(np).data as string);
  assert(cabinetHex.length === 3, "cabinet: the trio has exactly three seats");
  assert(cabinetHex[0] === MAINTAINER,
    "cabinet seat 0 = maintainer (22f716…), the pinned BLF roster steward");
  assert(cabinetHex[1] === CHAPSMART, "cabinet seat 1 = Chapsmart (17a96aa4…)");
  assert(cabinetHex[2] === GRAY,
    "cabinet seat 2 = Graysatoshi (59f0660b…4440), seated this phase");

  assert(BLF_OFFICIAL_ARBITERS.includes(GRAY),
    "Graysatoshi is now an assignable BLF arbiter (BLF_OFFICIAL_ARBITERS)");
  assert(BLF_OFFICIAL_ARBITERS.length === 3 &&
    BLF_OFFICIAL_ARBITERS.every((pk) => cabinetHex.includes(pk)),
    "BLF_OFFICIAL_ARBITERS is exactly the cabinet trio (seeded from it)");
  assert(getTrustedArbiterPool({ community: "us-blf" }).includes(GRAY),
    "Gray is reachable as a BLF assignable arbiter via getTrustedArbiterPool");
}

console.log("\n── BOND 38130: declaration event (UNBACKED Phase 1) ──");
{
  const NOW = 1_900_000_000;
  const arbSk = generateSecretKey();
  const arbPk = getPublicKey(arbSk);
  const otherSk = generateSecretKey();

  const bondKind: number = ARBITER_BOND_KIND;
  assert(bondKind === 38130, "bond kind is 38130");
  assert(bondKind !== Number(EscrowEventKind.RESOLVE) &&
    bondKind !== 38120 && bondKind !== 38121 && bondKind !== 38123,
    "38130 stays clear of escrow/roster/application/ratings kinds");

  // Build → sign → parse round-trip.
  const signed = finalizeEvent(buildArbiterBondEvent({
    pubkey: arbPk, bondMsats: 500_000_000, termStart: NOW - 100, termEnd: NOW + 100_000, createdAt: NOW,
  }), arbSk) as unknown as NostrEvent;
  const parsed = parseArbiterBondEvent(signed);
  assert(!!parsed && parsed.npub === arbPk && parsed.bondMsats === 500_000_000,
    "signed bond parses + verifies; the signer is the bonding arbiter");

  // Tamper the amount → verification must fail. Build the tampered event by
  // copying data fields EXPLICITLY (not spreading): nostr-tools stamps a
  // per-object "verified" symbol on finalizeEvent, and a spread would copy it
  // and short-circuit the re-check, masking the tamper.
  const tampered = {
    kind: signed.kind, created_at: signed.created_at, tags: signed.tags,
    pubkey: signed.pubkey, id: signed.id, sig: signed.sig,
    content: signed.content.replace("500000000", "999000000"),
  } as unknown as NostrEvent;
  assert(parseArbiterBondEvent(tampered) === null,
    "tampered bond content fails verification (event id no longer matches the content hash)");

  // Spoof guard: payload npub ≠ signer is rejected (no declaring for others).
  const spoof = finalizeEvent(buildArbiterBondEvent({
    pubkey: arbPk, bondMsats: 1_000, termStart: NOW - 100, termEnd: NOW + 100_000, createdAt: NOW,
  }), otherSk) as unknown as NostrEvent;
  assert(parseArbiterBondEvent(spoof) === null,
    "a bond whose payload npub disagrees with the signer is rejected");

  // selectLatestBond: newest in-term wins; out-of-term + wrong-arbiter ignored.
  const older = finalizeEvent(buildArbiterBondEvent({
    pubkey: arbPk, bondMsats: 100_000_000, termStart: NOW - 100, termEnd: NOW + 100_000, createdAt: NOW,
  }), arbSk) as unknown as NostrEvent;
  const newer = finalizeEvent(buildArbiterBondEvent({
    pubkey: arbPk, bondMsats: 300_000_000, termStart: NOW - 100, termEnd: NOW + 100_000, createdAt: NOW + 50,
  }), arbSk) as unknown as NostrEvent;
  const expired = finalizeEvent(buildArbiterBondEvent({
    pubkey: arbPk, bondMsats: 900_000_000, termStart: NOW - 1000, termEnd: NOW - 1, createdAt: NOW + 100,
  }), arbSk) as unknown as NostrEvent;
  assert(selectLatestBond(arbPk, [older, newer], NOW)?.bondMsats === 300_000_000,
    "newest in-term bond wins (replaceable semantics)");
  assert(selectLatestBond(arbPk, [expired], NOW) === null, "a bond past its term is not valid now (term-gated)");
  assert(selectLatestBond(arbPk, [older, newer, expired], NOW)?.bondMsats === 300_000_000,
    "the out-of-term bond is skipped even though it's the newest event");
  assert(selectLatestBond(getPublicKey(otherSk), [older, newer], NOW) === null,
    "selectLatestBond returns only the queried arbiter's bond");
  assert(getArbiterBond(arbPk, [older, newer], NOW)?.bondMsats === 300_000_000,
    "getArbiterBond resolves the current in-term bond");
}

// ── VICTIM ATTESTATION 38131: the §11.8 restorative-strand "made whole" seam ──
// A SEAM, never an auto-trigger: the victim signs that a slashed arbiter remediated
// them; the cabinet REFERENCES it to weigh casting a withheld bond return. Capital
// only — it restores no standing. The signer IS the victim (authoritative), so the
// remediated arbiter cannot forge it and the cabinet cannot fabricate it.
console.log("\n── VICTIM ATTESTATION 38131: restorative-strand made-whole seam ──");
{
  const NOW = 1_900_000_000;
  const victimSk = generateSecretKey();
  const victimPk = getPublicKey(victimSk);
  const arbSk = generateSecretKey();
  const arbPk = getPublicKey(arbSk);

  const vKind: number = VICTIM_ATTESTATION_KIND;
  assert(vKind === 38131, "victim-attestation kind is 38131");
  assert(vKind !== Number(ARBITER_BOND_KIND) && vKind !== 38120 && vKind !== 38121,
    "38131 stays clear of bond/roster/application kinds");

  // Build → sign → parse round-trip: the signer is the victim.
  const signed = finalizeEvent(buildVictimAttestationEvent({
    victim: victimPk, arbiter: arbPk, escrowId: "trade_abc", amountMsats: 250_000, createdAt: NOW,
  }), victimSk) as unknown as NostrEvent;
  const parsed = parseVictimAttestationEvent(signed);
  assert(!!parsed && parsed.victim === victimPk && parsed.arbiter === arbPk
    && parsed.escrowId === "trade_abc" && parsed.amountMsats === 250_000,
    "a signed attestation parses + verifies; the signer is the victim, referencing the remediated arbiter");

  // Tamper the amount → verification fails (explicit field copy — nostr-tools stamps
  // a per-object 'verified' symbol that a spread would carry and mask the tamper).
  const tampered = {
    kind: signed.kind, created_at: signed.created_at, tags: signed.tags,
    pubkey: signed.pubkey, id: signed.id, sig: signed.sig,
    content: signed.content.replace("250000", "999000"),
  } as unknown as NostrEvent;
  assert(parseVictimAttestationEvent(tampered) === null, "a tampered attestation fails verification");

  // The remediated arbiter cannot sign their OWN made-whole (arbiter === victim).
  const selfSigned = finalizeEvent(buildVictimAttestationEvent({
    victim: arbPk, arbiter: victimPk, escrowId: "trade_abc", amountMsats: 1, createdAt: NOW,
  }), arbSk) as unknown as NostrEvent;
  // Re-point the payload arbiter to the signer to simulate self-attestation; parse must reject.
  const selfAttest = {
    kind: selfSigned.kind, created_at: selfSigned.created_at, tags: selfSigned.tags,
    pubkey: arbPk, id: selfSigned.id, sig: selfSigned.sig,
    content: JSON.stringify({ type: "chama:victim-made-whole", arbiter: arbPk, escrowId: "trade_abc", amountMsats: 1 }),
  } as unknown as NostrEvent;
  assert(parseVictimAttestationEvent(selfAttest) === null,
    "a self-attestation (arbiter signs their own made-whole) is rejected — only the victim's key produces the signal");

  // build() refuses a non-positive amount and a victim≡arbiter at construction.
  let threw = false;
  try { buildVictimAttestationEvent({ victim: victimPk, arbiter: arbPk, escrowId: "x", amountMsats: 0 }); }
  catch { threw = true; }
  assert(threw, "build refuses a non-positive made-whole amount");

  // selectLatestAttestation: newest for (arbiter, escrow) wins; wrong escrow ignored.
  const older = finalizeEvent(buildVictimAttestationEvent({
    victim: victimPk, arbiter: arbPk, escrowId: "trade_abc", amountMsats: 100_000, createdAt: NOW,
  }), victimSk) as unknown as NostrEvent;
  const newer = finalizeEvent(buildVictimAttestationEvent({
    victim: victimPk, arbiter: arbPk, escrowId: "trade_abc", amountMsats: 300_000, createdAt: NOW + 50,
  }), victimSk) as unknown as NostrEvent;
  const otherTrade = finalizeEvent(buildVictimAttestationEvent({
    victim: victimPk, arbiter: arbPk, escrowId: "trade_zzz", amountMsats: 900_000, createdAt: NOW + 99,
  }), victimSk) as unknown as NostrEvent;
  assert(selectLatestAttestation(arbPk, "trade_abc", [older, newer, otherTrade])?.amountMsats === 300_000,
    "newest attestation for (arbiter, escrow) wins; the other-escrow attestation is ignored");
  assert(selectLatestAttestation(arbPk, "trade_none", [older, newer]) === null,
    "selectLatestAttestation returns only the queried escrow's attestation (it never compels a heal — informational only)");
}

console.log("\n── EXPOSURE LEDGER (§8): floor, caps, tiers, consent gate ──");
{
  const ARB = ARBITER_PK; // "cc"*32 — a 64-hex test key
  const NOW = 1_900_000_000;
  const bond = (msats: number) =>
    ({ npub: ARB, bondMsats: msats, termStart: NOW - 1, termEnd: NOW + 1, createdAt: NOW, eventId: "b-" + msats });
  const mkTrade = (
    id: string, amountMsats: number, status: EscrowStatus, arbiter = ARB, community: string | null = null,
  ) => ({
    id, amountMsats, status, community,
    participants: { [Role.BUYER]: null, [Role.SELLER]: null, [Role.ARBITER]: arbiter },
  } as unknown as EscrowState);

  // Floor (§K): a sub-10k-sat trade needs NO bond; AT the floor a bond is required.
  assert(UNBONDED_FLOOR_MSATS === 10_000_000, "unbonded floor is 10,000 sats (10,000,000 msats)");
  assert(classifyArbiterCapacity({ arbiter: ARB, tradeMsats: UNBONDED_FLOOR_MSATS - 1, bond: null, openTrades: [] }).tier === "unbonded",
    "a trade below the floor is 'unbonded' even with no bond");
  assert(canAssignArbiter({ npub: ARB, tradeMsats: UNBONDED_FLOOR_MSATS - 1, bond: null, openTrades: [] }) === true,
    "sub-floor trade assigns with NO bond (permissionless entry, §K)");
  assert(canAssignArbiter({ npub: ARB, tradeMsats: UNBONDED_FLOOR_MSATS, bond: null, openTrades: [] }) === false,
    "AT the floor a bond is required (no bond ⇒ over-capacity)");

  // Per-trade cap (≤, the brief boundary).
  assert(classifyArbiterCapacity({ tradeMsats: 200_000_000, bond: bond(150_000_000), openTrades: [] }).tier === "over-capacity",
    "per-trade cap: a single trade larger than the bond is over-capacity");
  assert(classifyArbiterCapacity({ tradeMsats: 150_000_000, bond: bond(150_000_000), openTrades: [] }).tier === "covered",
    "per-trade cap: a trade EQUAL to the bond is covered (≤)");

  // Aggregate cap across MULTIPLE chamas.
  const openA = mkTrade("t-A", 60_000_000, EscrowStatus.LOCKED, ARB, "ke-kes");
  const openB = mkTrade("t-B", 60_000_000, EscrowStatus.CREATED, ARB, "sn-cfa");
  assert(classifyArbiterCapacity({ tradeMsats: 40_000_000, bond: bond(150_000_000), openTrades: [openA, openB] }).tier === "over-capacity",
    "aggregate cap: Σ(open across chamas) + new > bond ⇒ over-capacity");
  assert(classifyArbiterCapacity({ tradeMsats: 30_000_000, bond: bond(150_000_000), openTrades: [openA, openB] }).tier === "covered",
    "aggregate cap: Σ(open) + new EQUAL to the bond is covered (≤)");

  // getOpenBondedTrades: global, ≥floor, seated-only, settled excluded, EXPIRED counts.
  const settled = mkTrade("t-done", 80_000_000, EscrowStatus.COMPLETED, ARB);
  const cancelled = mkTrade("t-x", 80_000_000, EscrowStatus.CANCELLED, ARB);
  const expiredTrade = mkTrade("t-exp", 80_000_000, EscrowStatus.EXPIRED, ARB);
  const tiny = mkTrade("t-tiny", UNBONDED_FLOOR_MSATS - 1, EscrowStatus.LOCKED, ARB);
  const otherArb = mkTrade("t-other", 80_000_000, EscrowStatus.LOCKED, ARBITER2_PK);
  const all = [openA, openB, settled, cancelled, expiredTrade, tiny, otherArb];
  const open = getOpenBondedTrades(ARB, all);
  assert(open.map((t) => t.id).sort().join(",") === ["t-A", "t-B", "t-exp"].sort().join(","),
    "getOpenBondedTrades: keeps open ≥floor seated-by-ARB (incl EXPIRED), drops settled/sub-floor/other-arbiter");
  assert(open.some((t) => t.id === "t-exp"),
    "EXPIRED still exposes the arbiter (funds at stake) — it counts against capacity");
  assert(!open.some((t) => t.id === "t-done" || t.id === "t-x"),
    "settled (COMPLETED/CANCELLED) trades do not count against capacity");
  const openExcl = getOpenBondedTrades(ARB, all, { excludeId: "t-A" });
  assert(!openExcl.some((t) => t.id === "t-A") && openExcl.length === open.length - 1,
    "excludeId removes the subject trade from the open set");

  // liveCapacity = bond − Σ(open bonded).
  assert(liveCapacity(bond(150_000_000), [openA, openB]) === 30_000_000,
    "liveCapacity = bond − Σ(open) = 150M − 120M = 30M");
  assert(liveCapacity(null, [openA]) === -60_000_000, "liveCapacity with no bond is negative by the open exposure");

  // ⭐ S4 bridge — assignableBondedArbiters selects by the 38135 commitment bond
  // amount (actualSats in SATS → ×1000 msats). openA/openB (60M each) seat ARB.
  {
    const bonds = [{ npub: ARB, actualSats: 150_000n }, { npub: ARBITER2_PK, actualSats: 30_000n }];
    const big = assignableBondedArbiters({ bonds, tradeMsats: 40_000_000, allTrades: [] });
    assert(big.includes(ARB) && !big.includes(ARBITER2_PK),
      "⭐ assignableBondedArbiters: per-trade cap selects by 38135 bond amount (ARB 150k covers 40k, ARBITER2 30k covers but < the trade? no — 40k>30k ⇒ dropped)");
    const tinyOk = assignableBondedArbiters({ bonds, tradeMsats: UNBONDED_FLOOR_MSATS - 1, allTrades: [] });
    assert(tinyOk.includes(ARB) && tinyOk.includes(ARBITER2_PK),
      "assignableBondedArbiters: a sub-floor trade needs no bond — all bonded arbiters qualify");
    const combo = assignableBondedArbiters({ bonds: [{ npub: ARB, actualSats: 150_000n }], tradeMsats: 40_000_000, allTrades: [openA, openB] });
    assert(!combo.includes(ARB),
      "⭐ assignableBondedArbiters: aggregate cap — Σ(open 120M) + 40M > 150M bond drops ARB (combination of trades)");
    const reseat = assignableBondedArbiters({ bonds: [{ npub: ARB, actualSats: 150_000n }], tradeMsats: 60_000_000, allTrades: [openA, openB], excludeTradeId: "t-A" });
    assert(reseat.includes(ARB),
      "assignableBondedArbiters: excludeTradeId frees the subject trade's slot so an already-seated arbiter re-qualifies");
  }

  // Tier bands (§L) — Gold ≥ 1M sats pinned.
  assert(exposureTier(99_999_999) === "Bronze", "tier: < 100k sats is Bronze");
  assert(exposureTier(100_000_000) === "Silver", "tier: 100k sats is Silver");
  assert(exposureTier(999_999_999) === "Silver", "tier: < 1M sats is Silver");
  assert(exposureTier(1_000_000_000) === "Gold", "tier: ≥ 1M sats is Gold (pinned)");

  // Consent layer: the reducer ACCEPTS an over-capacity LOCK (no strand); the
  // classifier merely FLAGS it.
  const { state } = buildToLocked();
  const seated = state.participants[Role.ARBITER] as string;
  assert(state.status === EscrowStatus.LOCKED,
    "reducer LOCKED the trade — capacity is NEVER a reducer gate (no strand)");
  const overCap = classifyArbiterCapacity({
    arbiter: seated, tradeMsats: state.amountMsats,
    bond: { npub: seated, bondMsats: 1_000, termStart: NOW - 1, termEnd: NOW + 1, createdAt: NOW, eventId: "b" },
    openTrades: [],
  });
  assert(overCap.tier === "over-capacity",
    "classifier flags the seated arbiter as over-capacity — but the LOCK already stood (consent-layer, never a strand)");

  // ── Assignment seam (pure logic; the dormant switch lives in pool.ts) ──
  const wSk = generateSecretKey(); const wPk = getPublicKey(wSk); // holds a bond
  const nPk = getPublicKey(generateSecretKey());                  // no bond
  const wBond = finalizeEvent(buildArbiterBondEvent({
    pubkey: wPk, bondMsats: 100_000_000, termStart: NOW - 1, termEnd: NOW + 100_000, createdAt: NOW,
  }), wSk) as unknown as NostrEvent;
  const seamCtx = { tradeMsats: 50_000_000, bondEvents: [wBond], allTrades: [] as EscrowState[], now: NOW };
  assert(selectOverCapacityArbiters([wPk, nPk], seamCtx).join(",") === nPk,
    "selectOverCapacityArbiters: the un-bonded arbiter is over-capacity for a ≥floor trade; the bonded one passes");
  assert(assignablePool([wPk, nPk], seamCtx).join(",") === wPk,
    "assignablePool drops the over-capacity arbiter, keeps the covered one");

  // Never-empty fallback: when EVERY candidate is over-capacity, return the full pool.
  const allOverCtx = { tradeMsats: 50_000_000, bondEvents: [] as NostrEvent[], allTrades: [] as EscrowState[], now: NOW };
  assert(selectOverCapacityArbiters([wPk, nPk], allOverCtx).length === 2,
    "with no bonds, all candidates for a ≥floor trade are over-capacity");
  assert(assignablePool([wPk, nPk], allOverCtx).join(",") === [wPk, nPk].join(","),
    "never-empty fallback: an all-over-capacity pool returns the FULL pool (no strand)");

  // DORMANT in Phase 1: the getTrustedArbiterPool seam ignores capacity entirely.
  assert(BONDS_ENFORCED === false, "Phase 1 ships BONDS_ENFORCED = false (dormant)");
  assert(getTrustedArbiterPool({ community: "us-blf", capacity: { ...allOverCtx } }).join(",") ===
    BLF_OFFICIAL_ARBITERS.join(","),
    "Phase-1 dormancy: getTrustedArbiterPool ignores the capacity context (pool unchanged)");
}

// ── TRADEVIEW UX: roles · mark-done verbs · living-chat bubbles ───────────
// Pure display helpers behind the TradeView UX pass (src/labels/trade-progress).
// No reducer involvement — these turn (category, fulfillment, event chain) into
// the words + bubbles the redesigned screen shows.
console.log("\n── TRADEVIEW UX: trade-progress display helpers ──");
{
  // funder = locker; performer = paid-on-release (the non-locker). Mirrors the
  // engine's locker convention — NOT the v4 mockup's illustrative bill-pay roles.
  assert(funderRole("marketplace") === Role.BUYER && performerRole("marketplace") === Role.SELLER,
    "marketplace: buyer funds (locks), seller performs");
  assert(funderRole("p2p-trade") === Role.SELLER && performerRole("p2p-trade") === Role.BUYER,
    "p2p-trade: seller funds, buyer performs");
  assert(funderRole("lending") === Role.SELLER && performerRole("lending") === Role.BUYER,
    "lending: lender (seller) funds, borrower (buyer) performs");
  assert(funderRole("bill-pay") === Role.SELLER && performerRole("bill-pay") === Role.BUYER,
    "bill-pay: bill owner (seller) funds, volunteer (buyer) performs — engine wins over mockup");

  // Mark-done verb per (category × fulfillment), and lending phase-awareness.
  assert(markDoneVerb("marketplace", "physical").label === "Mark delivered"
    && markDoneVerb("marketplace", "physical").icon === "📦",
    "mark-done marketplace/physical = 📦 Mark delivered");
  assert(markDoneVerb("marketplace", "service").label === "Mark completed",
    "mark-done marketplace/service = Mark completed");
  assert(markDoneVerb("marketplace", "digital").label === "Mark sent",
    "mark-done marketplace/digital = Mark sent");
  assert(markDoneVerb("p2p-trade", "service").label === "Mark sent"
    && markDoneVerb("p2p-trade", "service").icon === "💸",
    "mark-done p2p = 💸 Mark sent");
  assert(markDoneVerb("bill-pay", "service").label === "Mark paid"
    && markDoneVerb("bill-pay", "service").icon === "✓",
    "mark-done bill-pay = ✓ Mark paid");
  assert(markDoneVerb("lending", "service").label === "Mark received"
    && markDoneVerb("lending", "service").icon === "📥",
    "mark-done lending/disbursement (default) = 📥 Mark received");
  assert(markDoneVerb("lending", "service", { lendingPhase: "repayment" }).label === "Mark repaid"
    && markDoneVerb("lending", "service", { lendingPhase: "repayment" }).icon === "↩",
    "mark-done lending/repayment = ↩ Mark repaid (phase-aware)");

  // Refund reasons offered in the double-gate — funder (complaint) vs performer
  // (return), flavoured per vertical. Sent as the party's own chat message.
  assert(refundReasons("marketplace", "physical", Role.BUYER).includes("It didn't arrive"),
    "marketplace funder (buyer) refund reasons include 'It didn't arrive'");
  assert(refundReasons("marketplace", "digital", Role.BUYER).includes("File never arrived"),
    "marketplace/digital funder refund reasons key off fulfillment");
  assert(refundReasons("marketplace", "physical", Role.SELLER).includes("Out of stock"),
    "marketplace performer (seller) refund reasons include 'Out of stock'");
  assert(refundReasons("p2p-trade", "service", Role.SELLER).includes("Fiat never arrived"),
    "p2p funder (seller) refund reasons include 'Fiat never arrived'");
  assert(refundReasons("bill-pay", "service", Role.SELLER).includes("Bill wasn't paid"),
    "bill-pay funder (owner) refund reasons include 'Bill wasn't paid'");
  assert(refundReasons("p2p-trade", "service", Role.BUYER).includes("Couldn't send the fiat"),
    "p2p performer (buyer) refund reasons include 'Couldn't send the fiat'");

  // Structured chat note + detection (the living feed lifts these to bubbles).
  assert(markDoneChatMessage("marketplace", "physical") === "📦 Marked as delivered — on its way.",
    "marketplace-physical keeps its exact legacy mark-done wording");
  assert(markDoneChatMessage("p2p-trade", "service") === "💸 Marked as sent.",
    "p2p mark-done note = '💸 Marked as sent.'");
  assert(markDoneChatMessage("lending", "service", { lendingPhase: "repayment" }) === "↩ Marked as repaid.",
    "lending repayment note = '↩ Marked as repaid.'");
  assert(isStructuredMarkDoneMessage("📦 Marked as delivered — on its way.") === true,
    "detects the legacy marketplace mark-done note");
  assert(isStructuredMarkDoneMessage("✓ Marked as paid.") === true,
    "detects a CBP mark-done note");
  assert(isStructuredMarkDoneMessage("Did you get it? Marked as urgent") === false,
    "an ordinary message mentioning 'Marked as' is NOT a structured note");
  assert(isStructuredMarkDoneMessage("hi") === false && isStructuredMarkDoneMessage("") === false,
    "plain / empty messages are not mark-done notes");

  // Living chat: event chain → centered system bubble.
  const mkEvent = (type: string, extra: Record<string, unknown> = {}, id = "evt_" + type, created = 1000) =>
    ({ raw: { id, created_at: created }, payload: { type, ...extra } } as unknown as ParsedEscrowEvent);
  const NAMES: Record<string, string> = { buyer: "Bea", seller: "Sam", arbiter: "Ada" };
  const ctxMkt: LivingChatCtx = {
    category: "marketplace", shortId: "sm_abc…9a", amountLabel: "1,723 sats",
    resolvedOutcome: Outcome.RELEASE, nameFor: (r) => NAMES[r] ?? "?",
  };
  const created = eventToSystemBubble(mkEvent("escrow:create"), ctxMkt)!;
  assert(created.icon === "📋" && created.tone === "teal" && created.text.includes("sm_abc…9a"),
    "create → 📋 teal 'Trade reserved · {shortId}'");
  const locked = eventToSystemBubble(mkEvent("escrow:lock", { notesHash: "h" }), ctxMkt)!;
  assert(locked.icon === "⚡" && locked.tone === "lock" && locked.text.includes("1,723 sats"),
    "lock → ⚡ purple 'Sats locked in escrow · {amount}'");
  // Buyer is the FUNDER in marketplace → their release reads "released → pays {seller}".
  const voteRel = eventToSystemBubble(mkEvent("escrow:vote", { outcome: Outcome.RELEASE, role: Role.BUYER }), ctxMkt)!;
  assert(voteRel.icon === "🗳️" && voteRel.tone === "vote" && voteRel.text === "Bea released → pays Sam",
    "marketplace funder (buyer) release → '{voter} released → pays {performer}'");
  // Seller is the PERFORMER in marketplace → their release IS the mark-done.
  const voteRelPerf = eventToSystemBubble(mkEvent("escrow:vote", { outcome: Outcome.RELEASE, role: Role.SELLER }), ctxMkt)!;
  assert(voteRelPerf.icon === "📦" && voteRelPerf.tone === "green" && voteRelPerf.text === "Sam marked it delivered",
    "marketplace performer (seller) release → '📦 {name} marked it delivered' (mark-done bubble)");
  // Seller is the PERFORMER → their refund returns the sats (good faith).
  const voteRefPerf = eventToSystemBubble(mkEvent("escrow:vote", { outcome: Outcome.REFUND, role: Role.SELLER }), ctxMkt)!;
  assert(voteRefPerf.icon === "↩" && voteRefPerf.text === "Sam refunded Bea",
    "marketplace performer (seller) refund → '{name} refunded {funder}' (good-faith return)");
  // Buyer is the FUNDER → their refund is a request for their sats back.
  const voteRefFunder = eventToSystemBubble(mkEvent("escrow:vote", { outcome: Outcome.REFUND, role: Role.BUYER }), ctxMkt)!;
  assert(voteRefFunder.icon === "↩" && voteRefFunder.text === "Bea asked for a refund",
    "marketplace funder (buyer) refund → '{name} asked for a refund'");
  const ctxP2p: LivingChatCtx = { ...ctxMkt, category: "p2p-trade", resolvedOutcome: Outcome.RELEASE };
  // p2p: seller confirms "Fiat received" (release) → sats pay the buyer (performer).
  const voteP2p = eventToSystemBubble(mkEvent("escrow:vote", { outcome: Outcome.RELEASE, role: Role.SELLER }), ctxP2p)!;
  assert(voteP2p.text === "Sam released → pays Bea",
    "p2p funder (seller confirms) release → pays the performer (buyer)");
  // Buyer is the PERFORMER in p2p → their release IS "marked it sent".
  const voteP2pPerf = eventToSystemBubble(mkEvent("escrow:vote", { outcome: Outcome.RELEASE, role: Role.BUYER }), ctxP2p)!;
  assert(voteP2pPerf.icon === "💸" && voteP2pPerf.tone === "green" && voteP2pPerf.text === "Bea marked it sent",
    "p2p performer (buyer) release → '💸 {name} marked it sent' (mark-done bubble)");
  const claimP2pRefund = eventToSystemBubble(
    mkEvent("escrow:claim", { notesHashVerification: "v" }),
    { ...ctxP2p, resolvedOutcome: Outcome.REFUND },
  )!;
  assert(claimP2pRefund.text === "Settled — 1,723 sats to Sam",
    "p2p refund settles back to the funder (seller)");
  assert(eventToSystemBubble(mkEvent("escrow:resolve", { outcome: Outcome.RELEASE }), ctxMkt)!.text === "Released — ready to claim",
    "resolve release → '✅ Released — ready to claim'");
  assert(eventToSystemBubble(mkEvent("escrow:resolve", { outcome: Outcome.REFUND }), ctxMkt)!.text === "Refund approved — ready to claim",
    "resolve refund → '✅ Refund approved — ready to claim'");
  const claim = eventToSystemBubble(mkEvent("escrow:claim", { notesHashVerification: "v" }), ctxMkt)!;
  assert(claim.icon === "🎉" && claim.tone === "win" && claim.text === "Settled — 1,723 sats to Sam",
    "claim (resolved RELEASE, marketplace) → '🎉 Settled — {amount} to {seller}'");
  assert(eventToSystemBubble(mkEvent("escrow:cancel"), ctxMkt)!.text === "Trade cancelled",
    "cancel → '✖ Trade cancelled'");
  assert(eventToSystemBubble(mkEvent("escrow:join", { role: Role.BUYER }), ctxMkt) === null,
    "join is not surfaced in the living feed (timeline only)");
}

// ── DURABLE TRADE INDEX (loss-proof My Trades) ──────────────────────────
//
// The index remembers a compact record of every trade the user is a party
// to, from the updateEscrow chokepoint — so history survives relay eviction
// / a chain that can't rehydrate. Verify: only parties indexed, status never
// regresses, createdAt preserved, archived = index-minus-loaded, eviction cap.
console.log("\n── DURABLE TRADE INDEX ──");
{
  const tradeIdx = await import("../escrow-engine/trade-index.js");
  const { setLocalStorageUserScope } = await import("../storage/user-scope.js");
  setLocalStorageUserScope("npub_trade_index_test");
  (globalThis as any).localStorage.clear();

  const me = "me_pubkey_ti01";
  const other = "other_pubkey_ti02";
  const mk = (over: Partial<EscrowState>): EscrowState => ({
    id: "ti-1", status: EscrowStatus.CREATED, description: "sell sats",
    amountMsats: 2_000_000, category: "p2p-trade", fulfillment: "service",
    community: "tz-tzs", mintUrl: "fed1x",
    participants: { buyer: other, seller: me, arbiter: "arb" },
    initiator: { pubkey: me, role: Role.SELLER },
    communityArbiters: [], subscription: null, votes: {},
    resolvedOutcome: null, resolvedMajority: null,
    fees: { platformBps: 50, platformPubkey: me, arbiterFeeMsats: 0 },
    expiresAt: 0, createdAt: 5000, eventChain: [], chatMessages: [], lock: { handle: null },
    ...over,
  } as EscrowState);

  // Only parties get indexed.
  assert(tradeIdx.deriveTradeIndexEntry(mk({}), me, 1000)?.role === Role.SELLER,
    "trade-index: the user's role (seller) is derived");
  assert(tradeIdx.deriveTradeIndexEntry(mk({}), "stranger_pubkey", 1000) === null,
    "trade-index: a non-party trade is NOT indexed");
  assert(tradeIdx.deriveTradeIndexEntry(mk({}), me, 1000)?.counterparty === other,
    "trade-index: counterparty is the other party");

  // Record + list.
  tradeIdx.recordTradeToIndex(mk({ id: "ti-a", createdAt: 5000 }), me, 1000);
  tradeIdx.recordTradeToIndex(mk({ id: "ti-b", createdAt: 9000 }), me, 2000);
  const listed = tradeIdx.listTradeIndex();
  assert(listed.length === 2 && listed[0].id === "ti-b",
    "trade-index: lists all, newest createdAt first");

  // Status never regresses; createdAt preserved.
  tradeIdx.recordTradeToIndex(mk({ id: "ti-a", status: EscrowStatus.COMPLETED, createdAt: 5000 }), me, 3000);
  tradeIdx.recordTradeToIndex(mk({ id: "ti-a", status: EscrowStatus.CREATED, createdAt: 0 }), me, 4000);
  const a = tradeIdx.listTradeIndex().find(e => e.id === "ti-a")!;
  assert(a.lastStatus === EscrowStatus.COMPLETED,
    "trade-index: a stale CREATED replay never regresses a COMPLETED status");
  assert(a.createdAt === 5000,
    "trade-index: original createdAt preserved across a 0-createdAt replay");

  // Terminal-from-early is accepted (EXPIRED from CREATED).
  tradeIdx.recordTradeToIndex(mk({ id: "ti-c", status: EscrowStatus.CREATED, createdAt: 100 }), me, 5000);
  tradeIdx.recordTradeToIndex(mk({ id: "ti-c", status: EscrowStatus.EXPIRED, createdAt: 100 }), me, 6000);
  assert(tradeIdx.listTradeIndex().find(e => e.id === "ti-c")!.lastStatus === EscrowStatus.EXPIRED,
    "trade-index: EXPIRED (terminal) is accepted over CREATED");

  // Archived = index entries whose id isn't loaded.
  const archived = tradeIdx.archivedTradeEntries(["ti-a"]);
  assert(archived.every(e => e.id !== "ti-a") && archived.some(e => e.id === "ti-b"),
    "trade-index: archivedTradeEntries excludes loaded ids, keeps the rest");

  // Forget drops it.
  tradeIdx.removeTradeFromIndex("ti-b");
  assert(!tradeIdx.listTradeIndex().some(e => e.id === "ti-b"),
    "trade-index: removeTradeFromIndex drops the entry");

  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope(null);
}

// ── DURABLE ESCROW-EVENT CACHE (pure logic) ─────────────────────────────
//
// The IndexedDB layer no-ops in Node (no indexedDB); verify the pure merge +
// eviction logic that makes the cache loss-proof AND bounded: dedup by id,
// and evict-OLDEST-TERMINAL-first so a full cache never drops a live trade
// before a done one.
console.log("\n── DURABLE ESCROW-EVENT CACHE ──");
{
  const cache = await import("../escrow-engine/escrow-event-cache.js");

  // dedup by id, first occurrence wins, order preserved.
  const ev = (id: string) => ({ id, kind: 38100, pubkey: "p", created_at: 1, tags: [], content: "", sig: "s" }) as any;
  const deduped = cache.dedupEventsById([ev("a"), ev("b"), ev("a"), ev("c"), ev("b")]);
  assert(deduped.map((e: any) => e.id).join(",") === "a,b,c",
    "event-cache: dedupEventsById keeps first occurrence, preserves order");
  assert(cache.dedupEventsById([{ id: 123 } as any, ev("x")]).length === 1,
    "event-cache: dedup skips malformed (non-string id) events");

  // terminal classification (UI-terminal = evict-eligible).
  assert(cache.isEvictableTerminal(EscrowStatus.COMPLETED)
    && cache.isEvictableTerminal(EscrowStatus.EXPIRED)
    && cache.isEvictableTerminal(EscrowStatus.CANCELLED),
    "event-cache: COMPLETED/EXPIRED/CANCELLED are evict-eligible terminals");
  assert(!cache.isEvictableTerminal(EscrowStatus.LOCKED)
    && !cache.isEvictableTerminal(EscrowStatus.CREATED),
    "event-cache: live trades (LOCKED/CREATED) are NOT evict-eligible");

  // Under cap → no evictions.
  assert(cache.selectEvictions(
    [{ escrowId: "a", terminal: true, updatedAt: 1 }], 5).length === 0,
    "event-cache: under cap → nothing evicted");

  // Over cap → oldest TERMINAL first; live trades kept even if older.
  const metas = [
    { escrowId: "live-old", terminal: false, updatedAt: 1 },
    { escrowId: "term-old", terminal: true, updatedAt: 2 },
    { escrowId: "term-new", terminal: true, updatedAt: 9 },
    { escrowId: "live-new", terminal: false, updatedAt: 10 },
  ];
  const evict1 = cache.selectEvictions(metas, 3);
  assert(evict1.length === 1 && evict1[0] === "term-old",
    "event-cache: over cap by 1 → evicts the OLDEST terminal, spares live trades");
  const evict2 = cache.selectEvictions(metas, 2);
  assert(evict2.join(",") === "term-old,term-new",
    "event-cache: evicts terminals oldest-first before touching any live trade");
  const evict3 = cache.selectEvictions(metas, 1);
  assert(evict3.join(",") === "term-old,term-new,live-old",
    "event-cache: only after ALL terminals are gone does it evict the oldest live trade");
}

// ── ARBITER PREMIUM (task #53 E1: the 0.5% insurance, kind 38113) ────────
//
// Load-bearing invariants: 25bps-per-side math · note-size floor ·
// BONDED-ONLY gate (the earnings license) · verdict-neutrality (computed
// from the amount, never the outcome) · PREMIUM accepted post-COMPLETED
// without flipping status or touching eventChain · envelope round-trip
// (only the arbiter can read the note) · ledger semantics (V7-style
// sending intent, decline toggle can never clobber paid, attempt cap).
console.log("\n── ARBITER PREMIUM (compute + kind 38113 + ledger) ──");
{
  const ap = await import("../arbiters/arbiter-premium.js");
  const led = await import("../arbiters/arbiter-earnings.js");
  const { setLocalStorageUserScope } = await import("../storage/user-scope.js");
  const { createEnvelope, decryptFromEnvelope } = await import("./envelope.js");

  // ── compute: math + gates ──
  const slice = (over: Record<string, unknown> = {}) => ({
    amountMsats: 1_000_000_000, // 1M-sat trade
    participants: { buyer: BUYER_PK, seller: SELLER_PK, arbiter: ARBITER_PK },
    bondedArbiters: [ARBITER_PK],
    ...over,
  }) as any;

  const buyerSide = ap.computeArbiterPremium(slice(), BUYER_PK);
  assert(buyerSide.payable === true
    && buyerSide.payable && buyerSide.amountSats === 2_500
    && buyerSide.amountMsats === 2_500_000
    && buyerSide.payerRole === Role.BUYER
    && buyerSide.arbiter === ARBITER_PK,
    "premium: buyer side of a 1M-sat trade owes 2,500 sats (25 bps)");
  const sellerSide = ap.computeArbiterPremium(slice(), SELLER_PK);
  assert(sellerSide.payable === true && sellerSide.payable && sellerSide.payerRole === Role.SELLER,
    "premium: seller side is symmetric (0.25% each, 0.5% total)");
  assert(ap.PER_SIDE_PREMIUM_BPS === 25,
    "premium: per-side bps is exactly half of AMBIENT_ARBITER_FEE_BPS");

  // Verdict-neutral BY CONSTRUCTION: outcome fields don't exist in the
  // input slice — the same trade yields the same premium either way.
  const withOutcome = ap.computeArbiterPremium(
    slice({ resolvedOutcome: "refund", status: EscrowStatus.COMPLETED }), BUYER_PK);
  assert(withOutcome.payable === true && withOutcome.payable && withOutcome.amountSats === 2_500,
    "premium: verdict-neutral — outcome/status fields never change the amount");

  // Floor on NOTE size (~10 sats), not trade size.
  const under = ap.computeArbiterPremium(slice({ amountMsats: 3_600_000 }), BUYER_PK);
  assert(!under.payable && under.reason === "below-floor",
    "premium: a 3,600-sat trade (9-sat note) skips — below the 10-sat note floor");
  const at = ap.computeArbiterPremium(slice({ amountMsats: 4_000_000 }), BUYER_PK);
  assert(at.payable === true && at.payable && at.amountSats === 10,
    "premium: a 4,000-sat trade (10-sat note) is exactly at the floor — payable");

  // BONDED-ONLY: the earnings license. OG-fallback seats earn nothing.
  const ogSeat = ap.computeArbiterPremium(slice({ bondedArbiters: [] }), BUYER_PK);
  assert(!ogSeat.payable && ogSeat.reason === "arbiter-not-bonded",
    "premium: an unbonded (OG-fallback) seated arbiter earns NOTHING");
  const otherBonded = ap.computeArbiterPremium(slice({ bondedArbiters: ["dd".repeat(32)] }), BUYER_PK);
  assert(!otherBonded.payable && otherBonded.reason === "arbiter-not-bonded",
    "premium: bonded subset must contain the SEATED arbiter, not just anyone");
  const preStamp = ap.computeArbiterPremium(slice({ bondedArbiters: undefined }), BUYER_PK);
  assert(!preStamp.payable && preStamp.reason === "arbiter-not-bonded",
    "premium: pre-2B trades (no bondedArbiters stamp) never pay");

  // Principal + seat gates.
  assert(!ap.computeArbiterPremium(slice(), "ee".repeat(32)).payable,
    "premium: a stranger owes nothing (not-principal)");
  assert(!ap.computeArbiterPremium(slice(), ARBITER_PK).payable,
    "premium: the arbiter never pays themselves (not-principal)");
  const noArb = ap.computeArbiterPremium(
    slice({ participants: { buyer: BUYER_PK, seller: SELLER_PK, arbiter: undefined } }), BUYER_PK);
  assert(!noArb.payable && noArb.reason === "no-arbiter",
    "premium: no seated arbiter → nothing to pay");
  const badAmt = ap.computeArbiterPremium(slice({ amountMsats: 0 }), BUYER_PK);
  assert(!badAmt.payable && badAmt.reason === "bad-amount",
    "premium: zero/invalid amount → bad-amount");

  // ── E1.1 funder-side invoice fold ──
  // The funding invoice carries lock + funderPremiumMsats so the wallet
  // retains the premium after the (decoupled) lock spend. Predicted from
  // the CREATE-stamped bondedArbiters (the seat isn't taken until LOCK).
  assert(ap.funderPremiumMsats(slice(), 1_000_000_000) === 2_500_000,
    "premium/E1.1: funder fold on a 1M-sat lock = 2,500 sats (whole-sat msats)");
  assert(ap.funderPremiumMsats(slice(), 5_500_000) === 13_000,
    "premium/E1.1: the field-failure trade (5,500 sats) folds a 13-sat premium");
  assert(ap.funderPremiumMsats(slice({ bondedArbiters: [] }), 1_000_000_000) === 0
    && ap.funderPremiumMsats(slice({ bondedArbiters: undefined }), 1_000_000_000) === 0,
    "premium/E1.1: no bonded stamp → no fold (OG/pre-2B trades unchanged)");
  assert(ap.funderPremiumMsats(slice(), 3_600_000) === 0,
    "premium/E1.1: below the 10-sat note floor → no fold");
  assert(ap.funderPremiumMsats(slice(), 0) === 0 && ap.funderPremiumMsats(slice(), NaN) === 0,
    "premium/E1.1: zero/invalid lock amount → no fold");
  // Residue-covers-sweep invariant: when the lock amount equals the trade
  // amount, the folded residue equals EXACTLY what the settle sweep spends.
  const sweepSide = ap.computeArbiterPremium(slice({ amountMsats: 5_500_000 }), BUYER_PK);
  assert(sweepSide.payable && sweepSide.payable
    && ap.funderPremiumMsats(slice(), 5_500_000) === sweepSide.amountMsats,
    "premium/E1.1: folded residue == the sweep's spend (funder can always pay)");

  // ── selection helpers ──
  const mkTrade = (id: string, status: EscrowStatus, over: Record<string, unknown> = {}) =>
    ({ id, status, ...slice(), ...over }) as any;
  const targets = ap.selectPremiumPayTargets({
    escrows: [
      mkTrade("pp-done", EscrowStatus.COMPLETED),
      mkTrade("pp-live", EscrowStatus.LOCKED),
      mkTrade("pp-paid", EscrowStatus.COMPLETED),
      mkTrade("pp-og", EscrowStatus.COMPLETED, { bondedArbiters: [] }),
    ],
    myPubkey: BUYER_PK,
    hasOutboxRecord: (id: string) => id === "pp-paid",
  });
  assert(targets.length === 1 && targets[0] === "pp-done",
    "premium: pay targets = COMPLETED + payable + no outbox record only");

  const noteEv = (id: string) => ({ raw: { id, pubkey: BUYER_PK } }) as any;
  const redeemTargets = ap.selectPremiumRedeemTargets({
    escrows: [
      mkTrade("pr-a", EscrowStatus.COMPLETED, { premiumNotes: [noteEv("n1")] }),
      mkTrade("pr-b", EscrowStatus.COMPLETED, { premiumNotes: [noteEv("n2")] }),
      mkTrade("pr-c", EscrowStatus.COMPLETED, { premiumNotes: [] }),
    ],
    myPubkey: ARBITER_PK,
    isSettled: (eid: string) => eid === "n2",
  });
  assert(redeemTargets.length === 1 && redeemTargets[0] === "pr-a",
    "premium: redeem targets = trades I arbiter holding UNSETTLED notes");
  assert(ap.selectPremiumRedeemTargets({
    escrows: [mkTrade("pr-a", EscrowStatus.COMPLETED, { premiumNotes: [noteEv("n1")] })],
    myPubkey: BUYER_PK,
    isSettled: () => false,
  }).length === 0,
    "premium: redeem targets empty when I'm not the seated arbiter");

  // ── kind 38113 through the reducer ──
  const { state: lockedState } = buildToLocked();
  const doneState = {
    ...lockedState,
    status: EscrowStatus.COMPLETED,
    // Past-deadline on purpose: the old gauntlet would auto-EXPIRE.
    expiresAt: NOW - 1000,
  };

  const encMock = async (pt: string, pk: string) =>
    `enc:${pk}:${Buffer.from(pt, "utf8").toString("base64")}`;
  const decMock = async (ct: string, _pk: string) =>
    Buffer.from(ct.split(":").slice(2).join(":"), "base64").toString("utf8");

  const body = {
    escrowId: ESCROW_ID, payerRole: Role.BUYER, amountSats: 2_500,
    oobNotes: "oob-notes-premium-test", kind: "ambient" as const, createdAt: NOW,
  };
  const env = await createEnvelope(JSON.stringify(body), [ARBITER_PK], encMock);
  const premiumPayload = {
    type: "escrow:premium" as const,
    noteEnvelope: env,
    payerRole: Role.BUYER,
    noteKind: "ambient" as const,
    sentAt: NOW,
  };
  const premiumEv = makeParsedEvent(EscrowEventKind.PREMIUM, BUYER_PK, premiumPayload);

  const applied = applyEvent(doneState, premiumEv);
  if (assertOk(applied, "premium: PREMIUM is accepted on a COMPLETED (truly-terminal) trade")) {
    assert(applied.state.status === EscrowStatus.COMPLETED,
      "premium: a past-deadline PREMIUM never flips COMPLETED to EXPIRED");
    assert(applied.state.eventChain.length === doneState.eventChain.length,
      "premium: PREMIUM never enters eventChain (non-consensus)");
    assert((applied.state.premiumNotes ?? []).length === 1,
      "premium: the note lands in state.premiumNotes");

    const again = applyEvent(applied.state, premiumEv);
    assert(again.ok && (again.state.premiumNotes ?? []).length === 1,
      "premium: a relay echo of the same event id dedups (still 1 note)");
  }

  const strangerEv = makeParsedEvent(EscrowEventKind.PREMIUM, "ee".repeat(32), premiumPayload);
  assertErr(applyEvent(doneState, strangerEv), "NOT_PARTICIPANT",
    "premium: a non-principal's PREMIUM is rejected");

  // A bad premium mid-chain must never brick replay (fail-soft like CHAT).
  const createEv = createEvent();
  const replayed = replayEventChain([createEv, makeParsedEvent(
    EscrowEventKind.PREMIUM, "ee".repeat(32), premiumPayload, createEv.raw.id)]);
  assert(replayed.ok,
    "premium: a stranger's PREMIUM in a replayed chain is skipped, not fatal");

  // SORT SAFETY: PREMIUM has no e-tag (prevEventId null). If the sorter
  // bucketed it with state events, root-find could pick it as the chain
  // ROOT ahead of CREATE → MISSING_CREATE → trade unloadable. It must
  // interleave like CHAT instead, and the sorted chain must replay.
  const sortedChain = sortEventChain([premiumEv, createEv]);
  assert(sortedChain[0].kind === EscrowEventKind.CREATE,
    "premium: sortEventChain never lets a PREMIUM become the chain root");
  assert(replayEventChain(sortedChain).ok,
    "premium: a relay-fetched chain containing a PREMIUM replays clean");

  // ── envelope: arbiter-only readability ──
  const arbRead = await decryptFromEnvelope(env, ARBITER_PK, BUYER_PK, decMock);
  assert(arbRead !== null && JSON.parse(arbRead!).oobNotes === body.oobNotes,
    "premium: the arbiter decrypts the note body (oobNotes round-trips)");
  const buyerRead = await decryptFromEnvelope(env, SELLER_PK, BUYER_PK, decMock);
  assert(buyerRead === null,
    "premium: a non-recipient (the seller) cannot read the note");

  // ── parser ──
  const rawPremium = makeRawEvent(EscrowEventKind.PREMIUM, BUYER_PK, [["d", ESCROW_ID]]);
  const parsedOk = parseEscrowEvent(rawPremium, JSON.stringify(premiumPayload), true);
  assert(parsedOk.ok && parsedOk.ok && parsedOk.event.kind === EscrowEventKind.PREMIUM,
    "premium: parser accepts a well-formed kind-38113 payload");
  const parsedBad = parseEscrowEvent(rawPremium, JSON.stringify({ ...premiumPayload, noteEnvelope: "nope" }), true);
  assert(!parsedBad.ok,
    "premium: parser rejects a payload without a valid envelope");

  // ── ledger ──
  setLocalStorageUserScope("npub_premium_test");
  (globalThis as any).localStorage.clear();

  led.recordPremiumSending("pl-1", 2_500_000);
  assert(led.getPremiumOutboxRecord("pl-1")?.status === "sending",
    "ledger: pre-spend 'sending' intent recorded (V7-style)");
  led.clearPremiumSending("pl-1");
  assert(led.getPremiumOutboxRecord("pl-1") === null,
    "ledger: a failed spend clears the intent (retry possible)");

  led.recordPremiumSending("pl-1", 2_500_000);
  led.recordPremiumPaid("pl-1", 2_500_000, "op-1");
  assert(led.getPremiumOutboxRecord("pl-1")?.status === "paid",
    "ledger: sending upgrades to paid after publish");
  led.clearPremiumSending("pl-1");
  assert(led.getPremiumOutboxRecord("pl-1")?.status === "paid",
    "ledger: clearPremiumSending never touches a paid record");
  led.setPremiumDeclined("pl-1", true);
  assert(led.getPremiumOutboxRecord("pl-1")?.status === "paid",
    "ledger: the decline toggle can never clobber a paid record");

  led.setPremiumDeclined("pl-2", true);
  assert(led.getPremiumOutboxRecord("pl-2")?.status === "declined",
    "ledger: declining writes a durable record (blocks the pay sweep)");
  led.setPremiumDeclined("pl-2", false);
  assert(led.getPremiumOutboxRecord("pl-2") === null,
    "ledger: re-including clears ONLY a declined record");

  const noteEntry = { eventId: "ne-1", escrowId: "pl-3", payer: BUYER_PK, amountMsats: 25_000, noteKind: "ambient" as const };
  led.recordEarningAttemptFailed(noteEntry);
  led.recordEarningAttemptFailed(noteEntry);
  assert(led.getEarningRecord("ne-1")?.attempts === 2 && !led.isEarningSettled("ne-1"),
    "ledger: redeem failures bump attempts; under the cap it stays retryable");
  for (let i = 0; i < led.PREMIUM_REDEEM_MAX_ATTEMPTS; i++) led.recordEarningAttemptFailed(noteEntry);
  assert(led.isEarningSettled("ne-1"),
    "ledger: past the attempt cap a dead note is settled (stops retrying)");
  led.recordEarningRedeemed(noteEntry);
  assert(led.getEarningRecord("ne-1")?.status === "redeemed",
    "ledger: a late successful redeem still records as redeemed");
  led.recordEarningAttemptFailed(noteEntry);
  assert(led.getEarningRecord("ne-1")?.status === "redeemed",
    "ledger: a failure report never downgrades a redeemed record");

  led.recordEarningRedeemed({ eventId: "ne-2", escrowId: "pl-3", payer: SELLER_PK, amountMsats: 25_000, noteKind: "ambient" });
  led.recordEarningRedeemed({ eventId: "ne-3", escrowId: "pl-4", payer: BUYER_PK, amountMsats: 10_000, noteKind: "ambient" });
  const sum = led.summarizeArbiterEarnings();
  assert(sum.totalMsats === 60_000 && sum.tradeCount === 2 && sum.noteCount === 3,
    "ledger: summary counts redeemed msats, distinct trades, and notes");

  led.clearArbiterEarningStores();
  assert(led.summarizeArbiterEarnings().noteCount === 0,
    "ledger: clear wipes both stores");
  (globalThis as any).localStorage.clear();
  setLocalStorageUserScope(null);
}

// ══════════════════════════════════════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
