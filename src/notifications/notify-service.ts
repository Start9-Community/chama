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
import { translate, getCurrentLang } from "../i18n/index.js";
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

function platformName(): "capacitor" | "tauri" | "web" {
  return isCapacitorNative() ? "capacitor" : isTauriNative() ? "tauri" : "web";
}

// ── Diagnostics (opt-in; the silent-on-Tauri / resume-only debugging seam) ────
//
// Notification delivery is deliberately fire-and-forget and swallows every
// failure so a missed buzz can't break a trade. That makes "why didn't it
// fire?" un-diagnosable in the field — especially on Tauri/macOS, where the
// plugin reports permission `granted` unconditionally and the real notify-rust
// delivery is gated by the app's macOS identity (dev posts as "Terminal";
// an unsigned prod bundle is silently dropped). These logs convert "silent"
// into "diagnosable": permission result, platform, and whether the OS-level
// IPC actually resolved — so you can tell transition-didn't-fire vs.
// permission vs. IPC-error vs. OS-swallowed in one run.
//
// On in dev builds; opt-in on any build via localStorage chama_notify_debug=1
// (so a packaged Tauri/APK can be inspected without a dev rebuild).
const DEBUG_KEY = "chama_notify_debug";
/** Opt-in flag for the one-shot delivery self-test (notifySelfTest). Separate
 *  from DEBUG so dev builds don't buzz a test notification on every launch. */
const SELFTEST_KEY = "chama_notify_selftest";

function notifyDebugEnabled(): boolean {
  try {
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) return true;
  } catch { /* non-Vite host (test runner) — fall through */ }
  try {
    return globalThis.localStorage?.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Log a diagnostic line when notify-debug is on. Takes a thunk so the message
 *  is never built when disabled. Never throws. */
function notifyDebug(msg: () => string): void {
  if (!notifyDebugEnabled()) return;
  try { console.info(`[chama/notify] ${msg()}`); } catch { /* ignore */ }
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

// ── Last-seen status (persisted, for cold-start catch-up) ────────────────────
//
// The transition core only buzzes on an OBSERVED prev→next change, and `prev`
// is the IN-MEMORY prior state. That's right for a live session and for a
// backgrounded-but-alive app (resume reconnects, prev is retained → the missed
// moment fires). But a KILLED app (GrapheneOS kills aggressively) cold-starts
// with an empty escrow map: the first observation has prev=undefined, so a
// transition that advanced while the app was dead is silently suppressed.
//
// Only trade *ids* are persisted (not state), so we keep a tiny per-trade
// last-seen status here. On a cold first-observation we feed it back as a
// synthesized prev (catchUpPrev) so the missed transition buzzes once — the
// fired-tag dedup still prevents repeats. A fresh install / wiped store has no
// record, so cold-replay of historical trades stays silent (no spam).
const SEEN_KEY = "chama_notif_seen_status_v1";
/** Cap the seen-status map so it can't grow unbounded over a lifetime. */
const MAX_SEEN_TRADES = 500;

function readSeenStatuses(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** The status this trade was last observed at in any prior session, or null. */
export function readSeenStatus(escrowId: string): string | null {
  const v = readSeenStatuses()[escrowId];
  return typeof v === "string" ? v : null;
}

/** Record the latest observed status for a trade. No-op when unchanged (avoids
 *  storage churn); trims to the most-recent MAX_SEEN_TRADES. Never throws. */
export function recordSeenStatus(escrowId: string, status: string): void {
  try {
    const all = readSeenStatuses();
    if (all[escrowId] === status) return;
    delete all[escrowId];       // re-insert at the end so key order ≈ recency
    all[escrowId] = status;
    const keys = Object.keys(all);
    let next = all;
    if (keys.length > MAX_SEEN_TRADES) {
      next = {};
      for (const k of keys.slice(-MAX_SEEN_TRADES)) next[k] = all[k];
    }
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* diagnostic baseline only; ignore storage failure */
  }
}

/**
 * Pick the `prev` to compare a transition against — pure, so the cold-start
 * catch-up rule is exhaustively testable. A live in-memory `prev` always wins.
 * Otherwise, if a prior session recorded an EARLIER status for this trade,
 * synthesize a prev pinned at that status so a transition that advanced while
 * the app was dead is detected. No prior record (fresh install / never seen) ⇒
 * return undefined so cold-replay of historical trades stays silent.
 *
 * Note: vote-based transitions (a dispute opening) can't be reconstructed from
 * a status alone, so a dispute that opened while the app was dead won't buzz on
 * cold start — the arbiter still sees it in-app. Status-based moments (locked,
 * claim-ready, completed, expired) all catch up correctly.
 */
export function catchUpPrev(
  prev: EscrowState | null | undefined,
  next: EscrowState,
  seenStatus: string | null | undefined,
): EscrowState | null | undefined {
  if (prev) return prev;
  if (seenStatus && seenStatus !== next.status) {
    return { ...next, status: seenStatus as EscrowState["status"] };
  }
  return undefined;
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
  notifyDebug(() => `deliver tag=${n.tag} platform=${platformName()}`);
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
      notifyDebug(() => `capacitor scheduled tag=${n.tag}`);
      return;
    }
    if (isTauriNative()) {
      // `extra` rides the notification so onAction (deep-link.ts) can route the
      // tap to this trade on desktop. NOTE: `extra` IS a valid field in
      // plugin-notification 2.x (NotificationData.extra) — it is accepted, not
      // the cause of any silence.
      //
      // We post via the plugin's own IPC command rather than its void
      // `sendNotification` so we can AWAIT the result and surface a
      // capability/registration/serialize failure (otherwise swallowed). A
      // resolved IPC with no visible buzz on macOS means the gate is the OS
      // layer (dev → "Terminal"; unsigned prod → dropped), NOT the app.
      const opts = { title: n.title, body: n.body, extra: { escrowId: n.escrowId } };
      const internals = (globalThis as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      try {
        if (internals?.invoke) {
          await internals.invoke("plugin:notification|notify", { options: opts });
        } else {
          // Older/global-less context: fall back to the public (void) API.
          const mod = await import("@tauri-apps/plugin-notification");
          mod.sendNotification(opts);
        }
        notifyDebug(() => `tauri notify IPC ok tag=${n.tag} — if no buzz appears, it's the macOS app identity/signing layer (dev posts as "Terminal"), not the app`);
      } catch (e) {
        console.warn("[chama/notify] tauri notify IPC failed", e);
      }
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
  // Record the observed status FIRST — independent of the enable toggle and of
  // whether anything buzzes — so a future cold start has a baseline to detect a
  // transition that advanced while the app was dead. Capture the prior record
  // BEFORE overwriting it.
  const seenBefore = readSeenStatus(next.id);
  recordSeenStatus(next.id, next.status);

  if (!notificationsEnabled()) return;

  // Cold-start catch-up: a killed app re-observes trades with prev=undefined;
  // synthesize a prev from the persisted last-seen status so the missed moment
  // still fires once (dedup below guards repeats; fresh installs stay silent).
  const effectivePrev = catchUpPrev(prev, next, seenBefore);
  const coldCatchup = !prev && effectivePrev !== undefined;

  const n = notificationForTransition(effectivePrev, next, userPubkey);
  if (!n) return;
  if (readFiredTags().has(n.tag)) {
    notifyDebug(() => `skip (already fired) tag=${n.tag}`);
    return;
  }
  // Reserve the tag synchronously so a burst of replays can't double-fire while
  // the async permission/delivery is in flight.
  recordFiredTag(n.tag);
  void (async () => {
    const allowed = await ensureNotificationPermission();
    notifyDebug(() => `fire tag=${n.tag} platform=${platformName()} permission=${allowed} coldCatchup=${coldCatchup}`);
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
    notifyDebug(() => `fire chat tag=${n.tag} platform=${platformName()} permission=${allowed}`);
    if (allowed) await deliver(n);
  })();
}

// ── Delivery self-test (opt-in; the on-device "is the OS layer alive?" probe) ─

/**
 * Fire ONE known-good notification through the real platform delivery path and
 * log each step. No-op unless localStorage chama_notify_selftest=1 — gated
 * separately from notify-debug so dev builds don't buzz on every launch. Call
 * once at startup: on Tauri/APK the visible buzz (or its absence + the logs)
 * tells you whether the OS layer delivers at all on this build, independent of
 * any trade transition firing. Fully fire-and-forget; never throws.
 */
export async function notifySelfTest(): Promise<void> {
  try {
    if (globalThis.localStorage?.getItem(SELFTEST_KEY) !== "1") return;
  } catch {
    return;
  }
  const n: TradeNotification = {
    escrowId: "sm_selftest",
    title: translate(getCurrentLang(), "notify.selfTestTitle"),
    body: translate(getCurrentLang(), "notify.selfTestBody"),
    tag: "selftest",
  };
  notifyDebug(() => `self-test start platform=${platformName()}`);
  const allowed = await ensureNotificationPermission();
  notifyDebug(() => `self-test permission=${allowed} platform=${platformName()}`);
  if (allowed) await deliver(n);
  notifyDebug(() => `self-test done allowed=${allowed} — no buzz on Tauri/macOS ⇒ dev posts as "Terminal" / unsigned prod is dropped (not an app bug)`);
}
