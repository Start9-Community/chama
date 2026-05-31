// Fedimint native sidecar adapter.
//
// This keeps Chama's existing IFedimintWallet boundary intact while routing
// wallet operations through the local Rust Fedimint bridge. Browser builds stay
// opt-in; native shells default to the bridge because the APK/Tauri shell starts
// the sidecar itself.

import type {
  IFedimintWallet,
  LnReceiveStateKind,
  OnchainDepositAddress,
  OnchainDepositSettled,
  OnchainInfo,
  OnchainWithdrawFees,
  OnchainWithdrawResult,
} from "./fedimint-client.js";
import { hasBolt11Amount } from "../payments/bolt11.js";
import type { ChamaOperationMeta } from "../payments/sats-trace.js";

export const NATIVE_BRIDGE_MODE_KEY = "chama_native_fedimint";
export const NATIVE_BRIDGE_URL_KEY = "chama_native_fedimint_url";
export const NATIVE_BRIDGE_INVITE_KEY = "chama_native_fedimint_invite";
export const NATIVE_BRIDGE_COMMUNITY_KEY = "chama_native_fedimint_community";
export const DEFAULT_NATIVE_BRIDGE_URL = "http://127.0.0.1:8787";
export const DEFAULT_NATIVE_BRIDGE_COMMUNITY = "us-blf";

const TRUE_SETTING_VALUES = new Set(["1", "true", "yes", "on"]);
const REQUIRED_NATIVE_BRIDGE_CAPABILITIES = ["reset"];
const NATIVE_BRIDGE_READY_RETRY_DELAYS_MS = [0, 250, 500, 1000, 1500, 2500];
const NATIVE_BRIDGE_HEALTH_TIMEOUT_MS = 5_000;
const NATIVE_BRIDGE_RESET_TIMEOUT_MS = 10_000;
const NATIVE_BRIDGE_INFO_TIMEOUT_MS = 20_000;
const NATIVE_BRIDGE_JOIN_TIMEOUT_MS = 50_000;

interface NativeBridgeFetchInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  timeoutMs?: number;
}

interface NativeInfoResponse {
  federation_id: string;
  network: string;
  total_amount_msat: number;
  meta: unknown;
}

interface NativeHealthResponse {
  ok: boolean;
  joined?: boolean;
  api_version?: number;
  apiVersion?: number;
  capabilities?: string[];
}

interface NativeJoinResponse {
  joined: string;
  federation_id: string;
}

interface NativeResetResponse {
  ok: boolean;
}

interface NativeInvoiceResponse {
  operation_id?: string;
  operationId?: string;
  invoice: string;
}

interface NativeSpendNotesResponse {
  operation_id?: string;
  operationId?: string;
  requested_amount_msat?: number;
  total_amount_msat: number;
  notes: string;
}

interface NativeReissueNotesResponse {
  operation_id?: string;
  operationId?: string;
  total_amount_msat: number;
  status: string;
}

interface NativeParseNotesResponse {
  total_amount_msat: number;
  federation_id_prefix: string;
  notes_json: unknown;
}

interface NativeAwaitInvoiceResponse {
  status?: string;
  operation_id?: string;
  operationId?: string;
  info?: NativeInfoResponse;
}

interface NativePayResponse {
  operation_id?: string;
  operationId?: string;
  fee_msat?: number;
}

interface NativeOnchainInfoResponse {
  network: string;
  finality_delay?: number;
  finalityDelay?: number;
  peg_in_fee_sats?: number;
  pegInFeeSats?: number;
  peg_out_fee_sats?: number;
  pegOutFeeSats?: number;
  minimum_deposit_sats?: number;
  minimumDepositSats?: number;
}

interface NativeOnchainDepositAddressResponse {
  operation_id?: string;
  operationId?: string;
  address: string;
  tweak_idx?: unknown;
  tweakIdx?: unknown;
  finality_delay?: number;
  finalityDelay?: number;
}

interface NativeOnchainDepositSettledResponse {
  status: string;
  operation_id?: string;
  operationId?: string;
  amount_sats?: number;
  amountSats?: number;
  outpoint?: string;
  info?: NativeInfoResponse;
}

interface NativeOnchainWithdrawFeesResponse {
  amount_sats?: number;
  amountSats?: number;
  fees_sats?: number;
  feesSats?: number;
  total_sats?: number;
  totalSats?: number;
}

interface NativeOnchainWithdrawResponse {
  operation_id?: string;
  operationId?: string;
  status: string;
  txid?: string | null;
  fees_sats?: number;
  feesSats?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getImportEnv(key: string): string | null {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getBrowserSearchParams(): URLSearchParams | null {
  try {
    if (typeof window === "undefined") return null;
    return new URL(window.location.href).searchParams;
  } catch {
    return null;
  }
}

function getLocalStorageValue(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(key);
    return value !== null && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function isCapacitorNativePlatform(): boolean {
  const maybeCapacitor = (globalThis as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      getPlatform?: () => string;
    };
  }).Capacitor;
  try {
    if (typeof maybeCapacitor?.isNativePlatform === "function") {
      return maybeCapacitor.isNativePlatform();
    }
    if (typeof maybeCapacitor?.getPlatform === "function") {
      const platform = maybeCapacitor.getPlatform();
      return platform === "android" || platform === "ios";
    }
  } catch {
    return false;
  }
  return false;
}

function isTauriNativePlatform(): boolean {
  const global = globalThis as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(global.__TAURI__ || global.__TAURI_INTERNALS__);
}

function isShellManagedNativeBridge(): boolean {
  return isCapacitorNativePlatform() || isTauriNativePlatform();
}

function getInjectedNativeBridgeUrl(): string | null {
  const global = globalThis as {
    __CHAMA_NATIVE_FEDIMINT__?: {
      bridgeUrl?: unknown;
    };
  };
  const value = global.__CHAMA_NATIVE_FEDIMINT__?.bridgeUrl;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function setLocalStorageValue(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience cache only; wallet operations do not rely on it.
  }
}

function isEnabledSetting(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || TRUE_SETTING_VALUES.has(normalized);
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function readOperationId(
  value:
    | NativeInvoiceResponse
    | NativeReissueNotesResponse
    | NativePayResponse
    | NativeOnchainDepositAddressResponse
    | NativeOnchainDepositSettledResponse
    | NativeOnchainWithdrawResponse,
): string {
  const operationId = value.operation_id ?? value.operationId;
  return operationId ? String(operationId) : `native-${Date.now()}`;
}

function readRequiredNumber(
  value: number | undefined,
  field: string,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Native Fedimint bridge ${path} omitted numeric ${field}`);
  }
  return value;
}

function inviteStorageKey(baseUrl: string, federationId: string): string {
  return `${NATIVE_BRIDGE_INVITE_KEY}:${baseUrl}:${federationId}`;
}

function nativeBridgeUnavailableError(
  baseUrl: string,
  path: string,
  cause: unknown,
): Error {
  const causeMessage = cause instanceof Error ? cause.message : String(cause || "unknown error");
  const diagnostic = {
    issue: "native_fedimint_bridge_unavailable",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    path,
    cause: causeMessage,
    interpretation:
      "Native Fedimint mode is enabled, but Chama cannot reach the local Rust bridge. " +
      "Start the bridge process and reconnect. This is not the browser SDK gateway-vetting failure.",
  };
  const error = new Error(
    `Native Fedimint bridge is enabled but unreachable at ${baseUrl}${path}. ` +
      `Start the local Rust bridge and tap Reconnect, or disable nativeFedimint to use the browser SDK. ` +
      `This is a Rust bridge availability issue, not a Lightning gateway-vetting failure.\n\n` +
      `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

function nativeBridgeTimeoutError(
  baseUrl: string,
  path: string,
  timeoutMs: number,
): Error {
  const diagnostic = {
    issue: "native_fedimint_bridge_timeout",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    path,
    timeoutMs,
    interpretation:
      "The local Rust bridge answered slowly enough that Chama stopped waiting. " +
      "No sats move during federation switching. Try again or reconnect the app if the target Chama route is slow.",
  };
  const error = new Error(
    `Native Fedimint bridge ${path} did not answer within ${Math.ceil(timeoutMs / 1000)}s. ` +
      `No sats moved. Try again or tap Reconnect if the route stays slow.\n\n` +
      `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

function hasChamaDiagnostics(
  error: unknown,
): error is Error & { chamaDiagnostics: Record<string, unknown> } {
  return error instanceof Error && isRecord((error as any).chamaDiagnostics);
}

function isNativeBridgeUnavailable(error: unknown): boolean {
  return (
    hasChamaDiagnostics(error) &&
    error.chamaDiagnostics.issue === "native_fedimint_bridge_unavailable"
  );
}

function nativeBridgeCompatibilityError(
  baseUrl: string,
  cause: string,
): Error {
  const diagnostic = {
    issue: "native_fedimint_bridge_incompatible",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    requiredCapabilities: REQUIRED_NATIVE_BRIDGE_CAPABILITIES,
    cause,
    interpretation:
      "A local process answered at the native Fedimint bridge URL, but it is not the current " +
      "Chama Rust bridge API. Stop the stale bridge process and start the bridge built from " +
      "this Chama release.",
  };
  const error = new Error(
    `Native Fedimint bridge at ${baseUrl} looks stale or incompatible: ${cause}. ` +
      `Stop the old bridge process, start the current Chama Rust bridge, then tap Reconnect.\n\n` +
      `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

export function isNativeBridgeModeOn(): boolean {
  const params = getBrowserSearchParams();
  const urlFlag =
    params?.get("nativeFedimint") ??
    params?.get("native-fedimint") ??
    null;
  if (urlFlag !== null) return isEnabledSetting(urlFlag);

  const storedFlag = getLocalStorageValue(NATIVE_BRIDGE_MODE_KEY);
  if (storedFlag !== null) return isEnabledSetting(storedFlag);

  const envFlag = getImportEnv("VITE_CHAMA_NATIVE_FEDIMINT");
  if (envFlag !== null) return isEnabledSetting(envFlag);

  return isCapacitorNativePlatform() || isTauriNativePlatform();
}

export function getNativeBridgeUrl(): string {
  const params = getBrowserSearchParams();
  const url =
    params?.get("nativeFedimintUrl") ??
    params?.get("native-fedimint-url") ??
    getInjectedNativeBridgeUrl() ??
    getLocalStorageValue(NATIVE_BRIDGE_URL_KEY) ??
    getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_URL") ??
    DEFAULT_NATIVE_BRIDGE_URL;
  return normalizeBaseUrl(url);
}

export function getNativeBridgeCommunitySlug(): string {
  return getConfiguredNativeBridgeCommunitySlug() ?? DEFAULT_NATIVE_BRIDGE_COMMUNITY;
}

export function getConfiguredNativeBridgeCommunitySlug(): string | null {
  const params = getBrowserSearchParams();
  const slug =
    params?.get("nativeFedimintCommunity") ??
    params?.get("native-fedimint-community") ??
    getLocalStorageValue(NATIVE_BRIDGE_COMMUNITY_KEY) ??
    getImportEnv("VITE_CHAMA_NATIVE_COMMUNITY");
  const trimmed = slug?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export async function resetNativeBridgeWallet(baseUrl = getNativeBridgeUrl()): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl);
  await assertNativeBridgeCompatible(normalized);
  await nativeBridgeFetch<NativeResetResponse>(normalized, "/reset", {
    method: "POST",
    timeoutMs: NATIVE_BRIDGE_RESET_TIMEOUT_MS,
  });
}

async function assertNativeBridgeCompatible(baseUrl: string): Promise<void> {
  let health: NativeHealthResponse;
  try {
    health = await nativeBridgeFetch<NativeHealthResponse>(baseUrl, "/health", {
      timeoutMs: NATIVE_BRIDGE_HEALTH_TIMEOUT_MS,
    });
  } catch (error) {
    if (hasChamaDiagnostics(error)) throw error;
    throw nativeBridgeCompatibilityError(baseUrl, asErrorMessage(error));
  }

  if (!health.ok) {
    throw nativeBridgeCompatibilityError(baseUrl, "health check returned ok=false");
  }

  const capabilities = new Set((health.capabilities ?? []).map((value) => String(value)));
  const missing = REQUIRED_NATIVE_BRIDGE_CAPABILITIES.filter((capability) =>
    !capabilities.has(capability)
  );
  if (missing.length > 0) {
    throw nativeBridgeCompatibilityError(
      baseUrl,
      `missing bridge capability: ${missing.join(", ")}`,
    );
  }
}

async function nativeBridgeFetch<T>(
  baseUrl: string,
  path: string,
  init: NativeBridgeFetchInit = {},
): Promise<T> {
  const {
    body: jsonBody,
    headers: rawHeaders,
    timeoutMs,
    signal: callerSignal,
    ...rest
  } = init;
  const headers = new Headers(rawHeaders);
  const requestInit: RequestInit = { ...rest, headers };
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let removeCallerAbort: (() => void) | null = null;

  if (timeoutMs !== undefined && timeoutMs > 0) {
    controller = new AbortController();
    if (callerSignal?.aborted) {
      controller.abort();
    } else if (callerSignal) {
      const onAbort = () => controller?.abort();
      callerSignal.addEventListener("abort", onAbort, { once: true });
      removeCallerAbort = () => callerSignal.removeEventListener("abort", onAbort);
    }
    timeoutId = setTimeout(() => controller?.abort(), timeoutMs);
    requestInit.signal = controller.signal;
  } else if (callerSignal) {
    requestInit.signal = callerSignal;
  }

  if (jsonBody !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(jsonBody);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, requestInit);
  } catch (error) {
    if (controller?.signal.aborted && timeoutMs !== undefined && timeoutMs > 0) {
      throw nativeBridgeTimeoutError(baseUrl, path, timeoutMs);
    }
    throw nativeBridgeUnavailableError(baseUrl, path, error);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    removeCallerAbort?.();
  }
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `Native Fedimint bridge ${path} returned non-JSON response: ${text.slice(0, 160)}`,
      );
    }
  }

  if (!response.ok) {
    const bridgeMessage =
      isRecord(json) && typeof json.error === "string"
        ? json.error
        : text || response.statusText;
    throw new Error(
      `Native Fedimint bridge ${path} failed (${response.status}): ${bridgeMessage}`,
    );
  }

  return json as T;
}

export class NativeBridgeWallet implements IFedimintWallet {
  private readonly baseUrl: string;
  private openState = false;
  private federationId: string | null = null;
  private inviteCode: string | null = null;
  private lastBalanceMsats = 0;
  private balanceSubscribers = new Set<(balance: number) => void>();
  private balancePoll: ReturnType<typeof setInterval> | null = null;

  constructor(baseUrl = getNativeBridgeUrl()) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async open(): Promise<void> {
    await assertNativeBridgeCompatible(this.baseUrl);
    const info = await this.request<NativeInfoResponse>("/info", {
      timeoutMs: NATIVE_BRIDGE_INFO_TIMEOUT_MS,
    });
    this.applyInfo(info);
    this.loadCachedInvite();
  }

  isOpen(): boolean {
    return this.openState;
  }

  async joinFederation(inviteCode: string): Promise<void> {
    await assertNativeBridgeCompatible(this.baseUrl);
    const joined = await this.request<NativeJoinResponse>("/join", {
      method: "POST",
      body: { inviteCode },
      timeoutMs: NATIVE_BRIDGE_JOIN_TIMEOUT_MS,
    });
    this.openState = true;
    this.federationId = joined.federation_id;
    this.rememberInviteCode(joined.joined || inviteCode);
    await this.refreshBalance();
  }

  rememberInviteCode(inviteCode: string): void {
    const trimmed = inviteCode.trim();
    if (!trimmed) return;
    this.inviteCode = trimmed;
    if (this.federationId) {
      setLocalStorageValue(inviteStorageKey(this.baseUrl, this.federationId), trimmed);
    }
  }

  recovery = {
    hasPendingRecoveries: async (): Promise<boolean> => false,
    waitForAllRecoveries: async (): Promise<void> => {},
  };

  balance = {
    getBalance: async (): Promise<number> => this.refreshBalance(),
    subscribeBalance: (callback: (balance: number) => void): (() => void) =>
      this.subscribeBalance(callback),
  };

  mint = {
    spendNotes: async (
      amountMsats: number,
      _meta?: ChamaOperationMeta,
    ): Promise<string> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeSpendNotesResponse>("/spend-notes", {
        method: "POST",
        body: {
          amountMsats,
          allowOverpay: false,
        },
      });
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after spend failed:", error);
      });
      return result.notes;
    },

    redeemEcash: async (
      oobNotes: string,
      _meta?: ChamaOperationMeta,
    ): Promise<string> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeReissueNotesResponse>("/reissue-notes", {
        method: "POST",
        body: {
          notes: oobNotes,
          wait: true,
        },
      });
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after reissue failed:", error);
      });
      return readOperationId(result);
    },

    parseNotes: async (oobNotes: string): Promise<{ total_amount: number }> => {
      const result = await this.request<NativeParseNotesResponse>("/parse-notes", {
        method: "POST",
        body: { notes: oobNotes },
      });
      return { total_amount: result.total_amount_msat };
    },
  };

  lightning = {
    createInvoice: async (
      amountMsats: number,
      description: string,
      onReceiveState?: (kind: LnReceiveStateKind) => void,
      _meta?: ChamaOperationMeta,
    ): Promise<{ invoice: string; operationId: string }> => {
      onReceiveState?.("created");
      await this.ensureBridgeReady();
      const result = await this.request<NativeInvoiceResponse>("/invoice", {
        method: "POST",
        body: {
          amountMsats,
          description,
        },
      });
      const operationId = readOperationId(result);
      onReceiveState?.("waiting_for_payment");
      void this.awaitInvoice(operationId, onReceiveState);
      return {
        invoice: result.invoice,
        operationId,
      };
    },

    payInvoice: async (
      bolt11: string,
      meta?: ChamaOperationMeta,
    ): Promise<{ operationId: string }> => {
      await this.ensureBridgeReady();
      const amountMsats = typeof meta?.chama_amount_msats === "number"
        ? Math.floor(meta.chama_amount_msats)
        : undefined;
      const shouldSendAmount = !!amountMsats && amountMsats > 0 && !hasBolt11Amount(bolt11);
      const result = await this.request<NativePayResponse>("/pay", {
        method: "POST",
        body: {
          paymentInfo: bolt11,
          ...(shouldSendAmount ? { amountMsats } : {}),
          noWait: false,
        },
      });
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after LN pay failed:", error);
      });
      return { operationId: readOperationId(result) };
    },
  };

  onchain = {
    getInfo: async (): Promise<OnchainInfo> => {
      const result = await this.request<NativeOnchainInfoResponse>("/onchain/info");
      return {
        network: result.network,
        finalityDelay: readRequiredNumber(
          result.finality_delay ?? result.finalityDelay,
          "finalityDelay",
          "/onchain/info",
        ),
        pegInFeeSats: readRequiredNumber(
          result.peg_in_fee_sats ?? result.pegInFeeSats,
          "pegInFeeSats",
          "/onchain/info",
        ),
        pegOutFeeSats: readRequiredNumber(
          result.peg_out_fee_sats ?? result.pegOutFeeSats,
          "pegOutFeeSats",
          "/onchain/info",
        ),
        minimumDepositSats: readRequiredNumber(
          result.minimum_deposit_sats ?? result.minimumDepositSats,
          "minimumDepositSats",
          "/onchain/info",
        ),
      };
    },

    createDepositAddress: async (
      _meta?: ChamaOperationMeta,
    ): Promise<OnchainDepositAddress> => {
      const result = await this.request<NativeOnchainDepositAddressResponse>(
        "/onchain/deposit-address",
        { method: "POST" },
      );
      return {
        operationId: readOperationId(result),
        address: result.address,
        tweakIdx: result.tweak_idx ?? result.tweakIdx,
        finalityDelay: readRequiredNumber(
          result.finality_delay ?? result.finalityDelay,
          "finalityDelay",
          "/onchain/deposit-address",
        ),
      };
    },

    awaitDeposit: async (operationId: string): Promise<OnchainDepositSettled> => {
      const result = await this.request<NativeOnchainDepositSettledResponse>(
        "/onchain/await-deposit",
        {
          method: "POST",
          body: { operationId },
        },
      );
      if (result.info) this.applyInfo(result.info);
      else await this.refreshBalance();
      return {
        status: result.status,
        operationId: readOperationId(result),
        amountSats: result.amount_sats ?? result.amountSats,
        outpoint: result.outpoint,
      };
    },

    getWithdrawFees: async (
      address: string,
      amountSats: number,
    ): Promise<OnchainWithdrawFees> => {
      const result = await this.request<NativeOnchainWithdrawFeesResponse>(
        "/onchain/withdraw-fees",
        {
          method: "POST",
          body: { address, amountSats },
        },
      );
      return {
        amountSats: readRequiredNumber(
          result.amount_sats ?? result.amountSats,
          "amountSats",
          "/onchain/withdraw-fees",
        ),
        feesSats: readRequiredNumber(
          result.fees_sats ?? result.feesSats,
          "feesSats",
          "/onchain/withdraw-fees",
        ),
        totalSats: readRequiredNumber(
          result.total_sats ?? result.totalSats,
          "totalSats",
          "/onchain/withdraw-fees",
        ),
      };
    },

    withdraw: async (
      address: string,
      amountSats: number,
      options?: { wait?: boolean; meta?: ChamaOperationMeta },
    ): Promise<OnchainWithdrawResult> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeOnchainWithdrawResponse>(
        "/onchain/withdraw",
        {
          method: "POST",
          body: {
            address,
            amountSats,
            noWait: options?.wait === false,
          },
        },
      );
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after onchain withdraw failed:", error);
      });
      return {
        operationId: readOperationId(result),
        status: result.status,
        txid: result.txid || undefined,
        feesSats: readRequiredNumber(
          result.fees_sats ?? result.feesSats,
          "feesSats",
          "/onchain/withdraw",
        ),
      };
    },
  };

  federation = {
    getFederationId: async (): Promise<string> => {
      if (this.federationId) return this.federationId;
      const info = await this.request<NativeInfoResponse>("/info", {
        timeoutMs: NATIVE_BRIDGE_INFO_TIMEOUT_MS,
      });
      this.applyInfo(info);
      return info.federation_id;
    },

    getInviteCode: async (): Promise<string> => {
      if (this.inviteCode) return this.inviteCode;
      this.loadCachedInvite();
      if (this.inviteCode) return this.inviteCode;
      throw new Error(
        "Native Fedimint bridge has no cached invite code for this federation yet",
      );
    },
  };

  async cleanup(): Promise<void> {
    if (this.balancePoll !== null) {
      clearInterval(this.balancePoll);
      this.balancePoll = null;
    }
    this.balanceSubscribers.clear();
    this.openState = false;
  }

  private request<T>(path: string, init: NativeBridgeFetchInit = {}): Promise<T> {
    return nativeBridgeFetch<T>(this.baseUrl, path, init);
  }

  private async ensureBridgeReady(): Promise<void> {
    if (!isShellManagedNativeBridge()) return;

    let lastError: unknown = null;

    for (const delayMs of NATIVE_BRIDGE_READY_RETRY_DELAYS_MS) {
      if (delayMs > 0) await sleepMs(delayMs);
      try {
        await assertNativeBridgeCompatible(this.baseUrl);
        return;
      } catch (error) {
        lastError = error;
        if (!isNativeBridgeUnavailable(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private applyInfo(info: NativeInfoResponse): void {
    this.openState = true;
    this.federationId = info.federation_id;
    this.setBalance(info.total_amount_msat);
  }

  private loadCachedInvite(): void {
    if (!this.federationId) return;
    const cached = getLocalStorageValue(inviteStorageKey(this.baseUrl, this.federationId));
    if (cached) this.inviteCode = cached;
  }

  private async refreshBalance(): Promise<number> {
    const info = await this.request<NativeInfoResponse>("/info", {
      timeoutMs: NATIVE_BRIDGE_INFO_TIMEOUT_MS,
    });
    this.applyInfo(info);
    return info.total_amount_msat;
  }

  private subscribeBalance(callback: (balance: number) => void): () => void {
    this.balanceSubscribers.add(callback);
    callback(this.lastBalanceMsats);
    void this.refreshBalance()
      .then((balance) => callback(balance))
      .catch((error) => {
        console.warn("[chama] native bridge initial balance refresh failed:", error);
      });
    this.ensureBalancePolling();

    return () => {
      this.balanceSubscribers.delete(callback);
      if (this.balanceSubscribers.size === 0 && this.balancePoll !== null) {
        clearInterval(this.balancePoll);
        this.balancePoll = null;
      }
    };
  }

  private ensureBalancePolling(): void {
    if (this.balancePoll !== null) return;
    this.balancePoll = setInterval(() => {
      void this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance poll failed:", error);
      });
    }, 3000);
  }

  private setBalance(balance: number): void {
    const changed = balance !== this.lastBalanceMsats;
    this.lastBalanceMsats = balance;
    if (!changed) return;
    for (const callback of [...this.balanceSubscribers]) {
      try {
        callback(balance);
      } catch (error) {
        console.warn("[chama] native bridge balance subscriber failed:", error);
      }
    }
  }

  private async awaitInvoice(
    operationId: string,
    onReceiveState?: (kind: LnReceiveStateKind) => void,
  ): Promise<void> {
    try {
      const result = await this.request<NativeAwaitInvoiceResponse>("/await-invoice", {
        method: "POST",
        body: { operationId },
      });
      if (result.info) this.applyInfo(result.info);
      else await this.refreshBalance();
      onReceiveState?.("claimed");
    } catch (error) {
      const reason = asErrorMessage(error);
      onReceiveState?.({ canceled: { reason } });
      console.warn(`[chama] native bridge invoice ${operationId} watcher failed:`, error);
    }
  }
}

export function createNativeBridgeWallet(baseUrl = getNativeBridgeUrl()): IFedimintWallet {
  return new NativeBridgeWallet(baseUrl);
}
