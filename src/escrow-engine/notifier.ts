// ══════════════════════════════════════════════════════════════════════════
// Chama DM Notification Service
// ══════════════════════════════════════════════════════════════════════════
//
// Sends NIP-17 gift-wrapped DMs to the recipient's advertised DM relays.
// Falls back to legacy NIP-04 only when the recipient has no kind-10050
// inbox list, so older clients still have a chance to surface the alert.
//
// NIP-17 is the current interoperable format: a kind-14 rumor is NIP-44
// sealed and gift-wrapped as kind 1059, then routed to kind-10050 inboxes.
// The kind-4 fallback MUST use NIP-04; putting NIP-44 ciphertext directly in
// kind 4 renders as a blank message in legacy clients (bug #64). Chama has no
// inbound DM inbox — these messages exist only as external trade alerts.

import type { EscrowState, Role } from "./types.js";
import type { Signer, UnsignedEvent } from "./escrow-client.js";
import type { RelayManager } from "./relay-manager.js";
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  nip44,
} from "nostr-tools";

const DM_RELAY_LIST_KIND = 10050;
const GIFT_WRAP_KIND = 1059;
const SEAL_KIND = 13;
const PRIVATE_MESSAGE_KIND = 14;
const MAX_DM_RELAYS = 3;

function randomizedPastTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - Math.floor(Math.random() * 2 * 24 * 60 * 60);
}

function validDmRelay(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "wss:" || parsed.protocol === "ws:";
  } catch {
    return false;
  }
}

export interface NotificationConfig {
  enabled: boolean;
  /** Send DMs to community arbiter pool on trade creation */
  notifyArbitersOnCreate: boolean;
  /** Send DMs to all participants on state changes */
  notifyOnStateChange: boolean;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  notifyArbitersOnCreate: true,
  notifyOnStateChange: true,
};

export class EscrowNotifier {
  private signer: Signer;
  private relayManager: RelayManager;
  private config: NotificationConfig;

  constructor(signer: Signer, relayManager: RelayManager, config?: Partial<NotificationConfig>) {
    this.signer = signer;
    this.relayManager = relayManager;
    this.config = { ...DEFAULT_NOTIFICATION_CONFIG, ...config };
  }

  // ── Public: send a single trade-alert DM (#79 counterparty notifications) ──
  // Thin passthrough so callers outside the class (the useEscrow DM orchestrator)
  // can send one external alert without reaching into the private helper. Same
  // fail-soft guarantees as sendDM; NIP-04 is needed only for legacy fallback.
  async sendTradeAlertDM(recipientPubkey: string, message: string): Promise<boolean> {
    return this.sendDM(recipientPubkey, message);
  }

  /** NIP-17 recipients publish kind 10050 with their private-message inboxes.
   *  No list means they have not declared NIP-17 readiness, so the caller may
   *  use the legacy kind-4 fallback instead. */
  private async recipientDmRelays(recipientPubkey: string): Promise<string[]> {
    try {
      const events = await this.relayManager.fetchOnce(
        { kinds: [DM_RELAY_LIST_KIND], authors: [recipientPubkey], limit: 10 },
        3_500,
      );
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!newest) return [];
      return [...new Set(
        newest.tags
          .filter(tag => tag[0] === "relay" && typeof tag[1] === "string" && validDmRelay(tag[1]))
          .map(tag => tag[1]),
      )].slice(0, MAX_DM_RELAYS);
    } catch {
      return [];
    }
  }

  /** Build a NIP-17 kind-14 rumor → signed kind-13 seal → ephemeral kind-1059
   *  gift wrap without requiring access to the user's raw secret key. The
   *  configured signer handles the real-key NIP-44 encryption + seal signing;
   *  only the one-use wrapper key exists locally. */
  private async buildGiftWrap(recipientPubkey: string, message: string, relayUrl: string) {
    const senderPubkey = await this.signer.getPublicKey();
    const rumorBase = {
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: PRIVATE_MESSAGE_KIND,
      tags: [["p", recipientPubkey, relayUrl]],
      content: message,
    };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase as any) };
    const seal = await this.signer.signEvent({
      kind: SEAL_KIND,
      created_at: randomizedPastTimestamp(),
      tags: [],
      content: await this.signer.nip44Encrypt(JSON.stringify(rumor), recipientPubkey),
    });

    const wrapperKey = generateSecretKey();
    const wrapperConversationKey = nip44.getConversationKey(wrapperKey, recipientPubkey);
    return finalizeEvent({
      kind: GIFT_WRAP_KIND,
      created_at: randomizedPastTimestamp(),
      tags: [["p", recipientPubkey]],
      content: nip44.encrypt(JSON.stringify(seal), wrapperConversationKey),
    }, wrapperKey);
  }

  private async sendNip17(recipientPubkey: string, message: string, relays: string[]): Promise<boolean> {
    const pool = new SimplePool();
    try {
      const wrap = await this.buildGiftWrap(recipientPubkey, message, relays[0]);
      const publishes = pool.publish(relays, wrap, {
        maxWait: 8_000,
        onauth: (event) => this.signer.signEvent(event as UnsignedEvent) as any,
      });
      await Promise.any(publishes);
      console.debug(`[chama] NIP-17 DM sent to ${recipientPubkey.slice(0, 8)}... via ${relays.length} inbox relay(s)`);
      return true;
    } catch (e) {
      console.warn(`[chama] NIP-17 DM failed to ${recipientPubkey.slice(0, 8)}:`, e);
      return false;
    } finally {
      pool.destroy();
    }
  }

  // ── Send a DM to a specific pubkey ──────────────────────────────────────

  private async sendDM(recipientPubkey: string, message: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    try {
      const dmRelays = await this.recipientDmRelays(recipientPubkey);
      if (dmRelays.length > 0) {
        // A declared inbox means NIP-17 is the canonical route. Do not also
        // publish kind 4: clients supporting both would show duplicate alerts.
        return await this.sendNip17(recipientPubkey, message, dmRelays);
      }

      const now = Math.floor(Date.now() / 1000);

      // NIP-04: kind:4, content is encrypted to the recipient. A signer
      // without NIP-04 support skips the DM (throw → caught below) rather
      // than publish NIP-44 ciphertext no client can read.
      if (!this.signer.nip04Encrypt) {
        console.warn("[chama] DM skipped — signer has no NIP-04 support");
        return false;
      }
      const encrypted = await this.signer.nip04Encrypt(message, recipientPubkey);

      const unsigned = {
        kind: 4,
        created_at: now,
        tags: [["p", recipientPubkey]],
        content: encrypted,
      };

      const signed = await this.signer.signEvent(unsigned);
      await this.relayManager.publish(signed);
      console.debug(`[chama] DM sent to ${recipientPubkey.slice(0, 8)}...`);
      return true;
    } catch (e) {
      // DM failures are non-fatal — log and continue
      console.warn(`[chama] DM failed to ${recipientPubkey.slice(0, 8)}:`, e);
      return false;
    }
  }

  // ── Notify multiple recipients ──────────────────────────────────────────

  private async notifyMany(pubkeys: string[], message: string): Promise<void> {
    const myPubkey = await this.signer.getPublicKey();
    // Don't DM yourself
    const recipients = pubkeys.filter(pk => pk && pk !== myPubkey);
    await Promise.allSettled(recipients.map(pk => this.sendDM(pk, message)));
  }

  // ── Get all participant pubkeys from state ──────────────────────────────

  private getParticipantPubkeys(state: EscrowState): string[] {
    return [
      state.participants.buyer,
      state.participants.seller,
      state.participants.arbiter,
    ].filter(Boolean) as string[];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT-SPECIFIC NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════

  /** Notify community arbiters that a new trade was created */
  async onTradeCreated(state: EscrowState): Promise<void> {
    if (!this.config.notifyArbitersOnCreate) return;

    const arbiters = state.communityArbiters || [];
    if (arbiters.length === 0) return;

    const sats = Math.floor(state.amountMsats / 1000).toLocaleString();
    const msg = `🔔 New Chama trade: "${state.description}" (${sats} sats). ` +
      `Join as arbiter → ${state.id}`;

    await this.notifyMany(arbiters, msg);
  }

  /** Notify when someone joins the trade */
  async onParticipantJoined(state: EscrowState, joinerRole: Role): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const filled = pubkeys.length;
    const msg = `✅ ${joinerRole} joined trade "${state.description}" (${filled}/3 participants)`;

    await this.notifyMany(pubkeys, msg);
  }

  /** Notify all participants that ecash is locked */
  async onEscrowLocked(state: EscrowState): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const sats = Math.floor(state.amountMsats / 1000).toLocaleString();
    const msg = `🔒 ${sats} sats locked in escrow "${state.description}". ` +
      `Time to fulfill the trade and vote.`;

    await this.notifyMany(pubkeys, msg);
  }

  /** Nudge non-voters when a vote is cast */
  async onVoteCast(state: EscrowState, voterRole: Role): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const voteCount = Object.keys(state.votes).length;
    const msg = `🗳️ ${voterRole} voted on "${state.description}" (${voteCount}/3 votes). ` +
      `Your vote may be needed.`;

    await this.notifyMany(pubkeys, msg);
  }

  /** Notify everyone that the trade is resolved */
  async onTradeResolved(state: EscrowState): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    // Also notify community arbiters
    const arbiters = state.communityArbiters || [];
    const allRecipients = [...new Set([...pubkeys, ...arbiters])];

    const outcome = state.resolvedOutcome === "release" ? "RELEASE ✓" : "REFUND ↩";
    const msg = `⚖️ Trade "${state.description}" resolved: ${outcome}. ` +
      `Winner can now claim the ecash.`;

    await this.notifyMany(allRecipients, msg);
  }

}
