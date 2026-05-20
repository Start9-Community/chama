import type { Signer } from "../escrow-engine/escrow-client.js";
import { DEFAULT_RELAYS } from "../escrow-engine/default-relays.js";
import { RelayManager } from "../escrow-engine/relay-manager.js";
import { detectSigner } from "../escrow-engine/signers.js";
import { BLF_OFFICIAL_ARBITERS } from "../arbiters/pool.js";

export const COMMUNITY_REQUEST_KIND = 4;
export const COMMUNITY_REQUEST_TAG = "community-request";
export const COMMUNITY_REQUEST_COMMUNITY = "us-blf";

export interface CommunityRequestInput {
  requestedChama: string;
  note?: string;
}

export interface CommunityRequestSendOptions {
  signer?: Signer;
  relayManager?: RelayManager;
  relays?: string[];
  now?: () => number;
  connectTimeoutMs?: number;
}

export interface CommunityRequestSendResult {
  sent: number;
  recipients: string[];
  errors: string[];
}

export function getCommunityRequestRecipients(): string[] {
  return [...BLF_OFFICIAL_ARBITERS];
}

export function buildCommunityRequestMessage(
  input: CommunityRequestInput,
  senderPubkey?: string,
): string {
  const requestedChama = cleanRequestText(input.requestedChama, 96);
  if (!requestedChama) throw new Error("Tell us which country or Chama to request.");
  const note = cleanRequestText(input.note ?? "", 240);

  return [
    "Chama country request",
    `Requested: ${requestedChama}`,
    senderPubkey ? `From: ${senderPubkey}` : null,
    note ? `Note: ${note}` : null,
    "Source: first-run country picker",
  ].filter((line): line is string => line !== null).join("\n");
}

export async function sendCommunityRequestToGlobalArbiters(
  input: CommunityRequestInput,
  options: CommunityRequestSendOptions = {},
): Promise<CommunityRequestSendResult> {
  const signer = options.signer ?? detectSigner();
  const myPubkey = await signer.getPublicKey();
  const recipients = getCommunityRequestRecipients().filter((pk) => pk && pk !== myPubkey);
  if (recipients.length === 0) {
    throw new Error("No global Chama arbiters are available for requests yet.");
  }

  const message = buildCommunityRequestMessage(input, myPubkey);
  const createdAt = options.now?.() ?? Math.floor(Date.now() / 1000);
  const relayManager = options.relayManager ?? new RelayManager(options.relays ?? DEFAULT_RELAYS);
  const ownsRelayManager = !options.relayManager;

  try {
    relayManager.connect();
    await waitForConnectedRelay(relayManager, options.connectTimeoutMs ?? 4_000);

    const sent: string[] = [];
    const errors: string[] = [];

    for (const recipient of recipients) {
      try {
        const encrypted = await signer.nip44Encrypt(message, recipient);
        const signed = await signer.signEvent({
          kind: COMMUNITY_REQUEST_KIND,
          created_at: createdAt,
          tags: [
            ["p", recipient],
            ["client", "chama"],
            ["chama", COMMUNITY_REQUEST_TAG],
            ["community", COMMUNITY_REQUEST_COMMUNITY],
          ],
          content: encrypted,
        });
        await relayManager.publish(signed);
        sent.push(recipient);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (sent.length === 0) {
      throw new Error(errors[0] || "Could not send the Chama request.");
    }

    return { sent: sent.length, recipients: sent, errors };
  } finally {
    if (ownsRelayManager) relayManager.disconnect();
  }
}

function cleanRequestText(value: string, maxLength: number): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function waitForConnectedRelay(manager: RelayManager, timeoutMs: number): Promise<void> {
  if (manager.getConnectedCount() > 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      if (manager.getConnectedCount() > 0) {
        if (timer) clearTimeout(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Could not reach a Chama relay. Try again in a moment."));
        return;
      }
      timer = setTimeout(check, 100);
    };

    check();
  });
}
