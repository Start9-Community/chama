// ══════════════════════════════════════════════════════════════════════════
// SatoshiMarket — Fedimint Integration Layer
// ══════════════════════════════════════════════════════════════════════════

export * from "./fedimint-client.js";
export * from "./escrow-bridge.js";
export * from "./federation-config.js";
export * from "./seed-manager.js";
export {
  adaptRealWallet,
  createRealWallet,
  resetLocalFedimintWallet,
} from "./sdk-adapter.js";
export {
  createNativeBridgeWallet,
  getConfiguredNativeBridgeCommunitySlug,
  getNativeBridgeCommunitySlug,
  getNativeBridgeUrl,
  isNativeBridgeModeOn,
  resetNativeBridgeWallet,
} from "./native-bridge-adapter.js";
export { isTestnetMode, createMockWallet } from "./mock-wallet.js";
export { drainPendingRedemptions } from "./pending-redemptions.js";
export {
  stashPendingFunding,
  clearPendingFunding,
  listPendingFundings,
  drainPendingFundings,
} from "./pending-fundings.js";
export {
  clearPendingNativeLockIfIntent,
  drainPendingNativeLocks,
  getPendingNativeLock,
  listPendingNativeLocks,
  stashNativeLockIntent,
  summarizeNativeLocksForUi,
  MAX_NATIVE_LOCK_DRAIN_ATTEMPTS,
} from "./pending-native-locks.js";
export type {
  NativeLockUiSummary,
  PendingNativeLock,
} from "./pending-native-locks.js";
export { deriveCreateFedTags } from "./create-fed-tags.js";
export type { CreateFedTags, CreateFedTagsInputs } from "./create-fed-tags.js";
export {
  generateFediEcash,
  getFediInternal,
  hasFediInternalEcash,
  hasFediInternalGenerateEcash,
  hasFediInternalReceiveEcash,
  msatsToExactSats,
  receiveFediEcash,
} from "./fedi-internal.js";
export type { FediEcashRequest, FediInternalProvider } from "./fedi-internal.js";
