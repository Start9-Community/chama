// ══════════════════════════════════════════════════════════════════════════
// Notify service — side effects around the pure notification core (#88)
// ══════════════════════════════════════════════════════════════════════════
//
// Owns everything trade-notifications.ts deliberately doesn't: the on/off
// preference, the fire-once-ever dedup, the CONTEXTUAL permission ask (the
// first time a notification would actually fire), and the platform-aware
// delivery — Capacitor local-notifications on Android, the Tauri notification
// plugin on desktop, the Web Notification API in a browser. Every path is
// wrapped so a notification failure can NEVER break the trade flow.

import {
  notificationForTransition, chatNotificationFor,
  type TradeNotification, type DmNotifyPref,
} from "./trade-notifications.js";
import { setPendingTradeDeepLink } from "./deep-link.js";
import type { EscrowState, ChatPayload, ParsedEscrowEvent } from "../escrow-engine/types.js";

export type { DmNotifyPref };

const ENABLED_KEY = "chama_notifications_enabled";
const DM_PREF_KEY = "chama_dm_notifications";
const FIRED_KEY = "chama_notifications_fired_v1";
/** Cap the persisted fired-tag set so it can't grow unbounded over a lifetime. */
const MAX_FIRED_TAGS = 500;

// ── Platform detection (inlined; keeps notifications decoupled from fedimint) ─

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
  } catch {
    return false;
  }
}

function isTauriNative(): boolean {
  const g = globalThis as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return Boolean(g.__TAURI__ || g.__TAURI_INTERNALS__);
}

// ── Preference (default ON — the OS permission is the real gate) ─────────────

export function notificationsEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* cosmetic preference; ignore storage failure */
  }
}

// ── DM / trade-chat preference (tri-state, default "auto" = role-on-trade) ────

export function dmNotifyPref(): DmNotifyPref {
  try {
    const v = globalThis.localStorage?.getItem(DM_PREF_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setDmNotifyPref(pref: DmNotifyPref): void {
  try {
    globalThis.localStorage?.setItem(DM_PREF_KEY, pref);
  } catch {
    /* cosmetic preference; ignore storage failure */
  }
}

// ── Fire-once dedup (persisted, so a moment never re-buzzes across restarts) ──

function readFiredTags(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(FIRED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : []);
  } catch {
    return new Set();
  }
}

function recordFiredTag(tag: string): void {
  try {
    const tags = readFiredTags();
    tags.add(tag);
    // Keep only the most recent MAX_FIRED_TAGS (insertion order ≈ recency).
    const trimmed = [...tags].slice(-MAX_FIRED_TAGS);
    globalThis.localStorage?.setItem(FIRED_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

// ── Permission ───────────────────────────────────────────────────────────────

/** Request/confirm OS notification permission for the current platform.
 *  Returns true only when delivery is actually allowed. Never throws. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (isCapacitorNative()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const status = await LocalNotifications.checkPermissions();
      if (status.display === "granted") return true;
      const req = await LocalNotifications.requestPermissions();
      return req.display === "granted";
    }
    if (isTauriNative()) {
      const mod = await import("@tauri-apps/plugin-notification");
      if (await mod.isPermissionGranted()) return true;
      return (await mod.requestPermission()) === "granted";
    }
    // Web
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") return true;
      if (Notification.permission === "denied") return false;
      return (await Notification.requestPermission()) === "granted";
    }
  } catch {
    return false;
  }
  return false;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliver(n: TradeNotification): Promise<void> {
  try {
    if (isCapacitorNative()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      await LocalNotifications.schedule({
        notifications: [{
          // A stable small int id from the tag so re-fires would coalesce.
          id: (hashTag(n.tag) % 2_000_000_000) + 1,
          title: n.title,
          body: n.body,
          extra: { escrowId: n.escrowId },
        }],
      });
      return;
    }
    if (isTauriNative()) {
      const mod = await import("@tauri-apps/plugin-notification");
      // `extra` rides the notification so onAction (deep-link.ts) can route the
      // tap to this trade on desktop — the Nairobi demo surface.
      mod.sendNotification({ title: n.title, body: n.body, extra: { escrowId: n.escrowId } });
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      // tag de-dupes within the OS notification center too.
      const notif = new Notification(n.title, { body: n.body, tag: n.tag });
      // Tap → focus the tab and open this trade. escrowId rides the closure (the
      // web Notification API carries no custom payload).
      notif.onclick = () => {
        try { globalThis.focus?.(); } catch { /* ignore */ }
        setPendingTradeDeepLink(n.escrowId);
        try { notif.close(); } catch { /* ignore */ }
      };
    }
  } catch {
    /* a failed buzz must never surface to the user mid-trade */
  }
}

function hashTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Orchestrator — call from updateEscrow on every observed transition ───────

/**
 * Fire a notification if this prev→next transition warrants one, the user has
 * notifications enabled, it hasn't fired before, and OS permission is granted.
 * Contextual permission: the FIRST time a notification would fire, we ask — and
 * deliver it if granted. Fully fire-and-forget; never throws.
 */
export function maybeNotifyTransition(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  userPubkey: string | null | undefined,
): void {
  if (!notificationsEnabled()) return;
  const n = notificationForTransition(prev, next, userPubkey);
  if (!n) return;
  if (readFiredTags().has(n.tag)) return;
  // Reserve the tag synchronously so a burst of replays can't double-fire while
  // the async permission/delivery is in flight.
  recordFiredTag(n.tag);
  void (async () => {
    const allowed = await ensureNotificationPermission();
    if (allowed) await deliver(n);
  })();
}

/**
 * Fire an OS notification for an inbound trade-chat `message`, honoring the
 * master toggle and the tri-state DM preference. The pure decision (own-echo,
 * role default, backlog guard, copy) lives in chatNotificationFor; this owns
 * only the side effects — master gate, contextual permission, delivery.
 * Deliberately NOT wired to the fire-once-ever dedup: chat recurs, so each fresh
 * message may buzz. `liveSinceSec` is when this session went live (backlog
 * guard). Fully fire-and-forget; never throws.
 */
export function maybeNotifyChatMessage(
  state: EscrowState,
  message: ParsedEscrowEvent<ChatPayload>,
  userPubkey: string | null | undefined,
  liveSinceSec: number,
): void {
  if (!notificationsEnabled()) return; // the master mute silences DMs too
  const n = chatNotificationFor(state, message, userPubkey, dmNotifyPref(), liveSinceSec);
  if (!n) return;
  void (async () => {
    const allowed = await ensureNotificationPermission();
    if (allowed) await deliver(n);
  })();
}
