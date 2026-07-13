# CC Brief — Notifications: why Tauri is silent + APK is resume-only (diagnosis + fix)

**Status:** diagnosis from a code read + Jetty's real-device test (APK seller → Tauri buyer, both
open: **zero notifications on Tauri**; APK showed "trade complete" **only on resume**). Device is
**GrapheneOS** (de-Googled — relevant for background, not for local notifications).
**Author:** cowork (advisory), 2026-06-24. **Leave uncommitted.**

> The **tap handler is fine** — `registerNotificationTapHandlers` (`deep-link.ts:81`) is wired at
> startup (`App.tsx:1352`) and routes the tap to the trade. The problem is **firing/delivery**, not
> tapping. Two separate bugs below; fix #1 in 4.1, scope #2 honestly.

---

## ✅ ON-DEVICE CONFIRMED (2026-06-25) — app-side is DONE; only the macOS signing layer remains

Jetty ran the instrumented build (debug + self-test on, Tauri dev, Terminal allowed + **Persistent**
alert style). The filtered `[chama/notify]` logs are conclusive — **the app fires every notification
correctly:**
- Self-test: `self-test start → permission=true → deliver tag=selftest → tauri notify IPC ok`.
- Live trade: `fire …:locked permission=true`, `…:approved permission=true`, `…:completed
  permission=true` — each followed by `deliver` + `tauri notify IPC ok`.
- Yet **no buzz appears.**

⇒ Permission granted, notification built, IPC resolved — **the app cannot do more.** The final
`notify-rust show()` runs in a detached Rust task whose result is discarded, and under the borrowed
**`com.apple.Terminal`** identity macOS drops it (an unstable dev artifact — it showed earlier, now
doesn't; prod is unsigned). **The app side is finished.** Remaining work is **only** the macOS
signing fix (deferred, Apple Dev ID). **Verify on the APK** — the actual launch platform, where local
notifications post as the app directly and this identity gate does not exist. **Do NOT keep chasing
macOS dev notifications — the logs already prove it's not the app.**

---

## ⚠ CORRECTION (2026-06-25 — CC source-verified `tauri-plugin-notification@2.3.3`; supersedes Bug 1 below)

CC verified against the **installed plugin source** (I reasoned from general Tauri-v2 behavior — my
miss). **All four of my Bug-1 theories are wrong for 2.3.3:** `extra` IS a valid field (Rust
`NotificationData.extra`, no `deny_unknown_fields`); `sendNotification()` returns **`void`** (awaiting
is a no-op); desktop `request_permission`/`permission_state` **hard-code `Granted`** (so instrumenting
permission is a guaranteed `true` — tells you nothing); and `notification:default` **already grants**
`allow-notify`. None is the cause.

**Real Bug-1 root cause — macOS notify-rust identity/signing (NOT a JS bug):** `deliver()` →
`sendNotification()` → init-script `window.Notification` proxy → IPC `notify` → Rust
`notify_rust…show()`. On macOS (`desktop.rs:207-218`): **dev** attributes notifications to
`com.apple.Terminal` (they appear only if Terminal has notification permission, labelled "Terminal,"
not Chama — silent in a 3-instance dev run); **prod** attributes to `app.chama.market` but
`tauri.conf.json` has **no `signingIdentity`** (confirmed — only a `dmg` block) → unsigned → macOS
won't reliably display + Chama never appears in System Settings → Notifications. Failures are swallowed
(JS try/catch + Rust `let _ = …show()` in a detached task). **macOS-specific** (Jetty's Mac mini);
Linux/Windows Tauri likely already work — confirm.

**Fix = sign the prod macOS bundle** (Apple Developer ID — needed for distribution anyway).
**NOT a launch blocker** (Android APK is the Nairobi platform; Tauri desktop is secondary).
**Code-side now (cheap, high-value):** make the path *diagnosable* — await the IPC result, log a real
error, add a dev self-test — so "IPC ok, OS swallowed it" is provable. **Permission is NOT the gate**
(Jetty confirmed 2026-06-25: **Terminal is already allowed** and Tauri is still silent) → the easy
explanation is ruled out; the diagnostic logging is the only way to learn *not-firing* vs
*firing-but-invisible*. Also check **Notification Center** for hidden "Terminal" posts — Temporary-style
banners auto-dismiss into it, so they may be firing and just unseen.

**Bug 2 refinement (CC-confirmed):** `prev` is the **in-memory** prior state; only trade *ids* are
persisted, **not status**. Backgrounded-but-alive → resume fires (in-memory `prev` retained).
Killed/cold-start (GrapheneOS) → `prev=undefined` → first observation suppressed → a while-dead
transition is **never** notified, even on relaunch. **Fix = persist per-trade last-seen actionable
status**; synthesize `prev` from it on a cold first-observation → fire once; suppress only when there's
**no prior record** (preserves fresh-install quiet). ⚠ **The fired-tag dedup store must itself be
persistent** (localStorage) or a cold start re-fires already-seen transitions.

---

## Verified current state

- Plugin registered: `src-tauri/src/main.rs:409` (`tauri_plugin_notification::init()`),
  `Cargo.toml:19`. Capability present: `src-tauri/capabilities/default.json:36`
  (`"notification:default"`).
- Permission flow: `ensureNotificationPermission()` (`notify-service.ts:108`) — Capacitor / Tauri /
  web branches, requested **contextually** (first time a notif would fire, `:201`).
- Delivery `deliver()` (`notify-service.ts:136`): **Capacitor** `LocalNotifications.schedule(...)`
  (works), **Tauri** `mod.sendNotification({title,body,extra})` (**silent**), **web** `new
  Notification(...)` (works).
- Orchestrator `maybeNotifyTransition()` (`:188`) fires on an **observed** prev→next transition,
  with a fired-tag dedup; called from `updateEscrow` on every observed change
  (`useEscrow.ts:1039`). Events covered: locked, claim-ready, dispute, completed, expired
  (`trade-notifications.ts:65-139`). Chat buzz is the analogous `maybeNotifyChatMessage`.

---

## Bug 1 — Tauri shows NOTHING (fixable in 4.1)

Most-likely causes, in priority order — instrument first, then fix:

1. **The `extra` field is non-standard and the call is fire-and-forget.** Tauri v2
   `sendNotification(options)` takes `{ title, body, icon, sound, ... }` — **`extra` is not a
   field** and is silently dropped. That alone shouldn't suppress display, but it means:
   - desktop **tap-routing via `extra` never worked** — `deep-link.ts:104` reads
     `notification?.extra` (always `undefined` on Tauri) and already falls back to
     `LATEST_ACTIONABLE`. So desktop taps land on the *active* trade, not the specific one. Accept
     that (document it) or carry the id another way (channel/`actionTypeId`); don't pass `extra`.
   - **await it** and wrap in try/catch-with-log so a throw is visible:
     `try { await mod.sendNotification({ title: n.title, body: n.body }); } catch (e) { console.warn("tauri notify failed", e); }`.
2. **Permission not actually granted by the OS.** `isPermissionGranted()`/`requestPermission()` can
   return without a real grant if: macOS app isn't signed / lacks the notification entitlement and
   the user hasn't allowed it in System Settings → Notifications; Linux has no running notification
   daemon; or the request never prompted. **Instrument:** log the boolean from
   `ensureNotificationPermission()` on the Tauri build, and log right before `sendNotification`. This
   single log will tell you permission-vs-delivery in one run.
3. **Capability granularity.** Confirm `notification:default` actually includes
   **`notification:allow-notify`** (the granular perm exists in the schema). If the default set is
   conservative on this build, add `"notification:allow-notify"` explicitly to
   `capabilities/default.json` alongside `notification:default`.
4. **Isolate with a bare test.** Temporarily fire `sendNotification({ title:"test", body:"hello" })`
   on app start (Tauri only). If the bare one shows and the real one doesn't → it's the payload
   (`extra`) or the transition not firing; if neither shows → it's permission/capability/signing.

**Fix order:** instrument (2) → bare test (4) → await + drop `extra` (1) → capability (3) if needed.
Expected outcome: with the window open, a Tauri buyer gets a buzz the moment the seller locks /
releases / settles.

---

## Bug 2 — APK fires only on resume (architectural — scope honestly)

**Why:** notifications fire **reactively** when a live relay subscription delivers a transition
(`onStateUpdate`/`onChatMessage` → `maybeNotifyTransition`). A **backgrounded or killed** app has no
subscription, so nothing fires until **resume**, when the subscription reconnects, catches up, and
the now-"observed" transition fires (exactly what Jetty saw: "complete" appeared on grabbing the
phone). **GrapheneOS** kills background apps aggressively, so on that device the app is almost always
not-subscribed when backgrounded.

**Near-term (in 4.1 — make resume reliable):**
- Ensure the **resume catch-up actually fires** for transitions that are genuinely new to the user.
  Check that initial-load suppression (so a cold replay doesn't spam every historical transition)
  doesn't *also* swallow a transition that arrived while backgrounded. Approach: persist a
  `lastNotifiedStatus`/`lastSeen` per trade; on resume, after the fetch, fire for trades whose
  actionable status advanced since `lastSeen` (fired-tag dedup still prevents repeats).
- **Battery-optimization exemption prompt** (Android): offer to exempt Chama so it survives
  backgrounding a little longer. Partial mitigation, not a cure.

**Out of scope for 4.1 (its own design effort — say so plainly):** true **background delivery** while
the app is dead. Options, all heavy:
- **Push (FCM/UnifiedPush):** FCM is unavailable on GrapheneOS/de-Googled; **UnifiedPush** (ntfy
  etc.) is the de-Googled-friendly route but needs a push distributor + a relay-side bridge.
- **Foreground/background service** holding a relay connection: battery + OS-restricted, and exactly
  what GrapheneOS kills.
- **Relay-side notifier** (a self-hosted service that watches the user's trade events and pushes):
  most aligned with the no-Google ethos, but it's infrastructure (ties into the future "Chama-run
  relay" idea).

Recommend: ship Bug-1 (Tauri) + the resume-reliability improvement in 4.1; open a separate
**"background notifications" design** for the push/bridge path. Set expectations that, for a
sovereign no-Google app, *instant* background buzz is a known hard problem.

---

## GrapheneOS note (so it's not a red herring)

Local notifications (`@capacitor/local-notifications`) need **no** Google services — they work on
Graphene when the app is **alive**. Nothing here is blocked *by* Graphene per se; Graphene only makes
the **background** gap (Bug 2) show up almost every time. Don't chase a "Graphene notification
permission" rabbit hole for Bug 1 — instrument the permission/delivery path (above) instead.

---

## Verification

- **Tauri:** with the buyer window open, lock/release/settle from the seller → buzz appears; tap →
  opens the (active) trade. Confirm the instrumentation log shows `permission=true` + no
  `sendNotification` throw.
- **APK foregrounded:** each transition buzzes immediately.
- **APK resume:** background during a transition, resume → the missed transition buzzes once (no
  spam, no miss).
- `npm run predeploy` green.

---

## Follow-up (after the above lands) — prominence / Focus break-through

The firing chain **WORKS** (Jetty confirmed 2026-06-25: the notifications were in Notification Center
under "Terminal" all along — it was dev attribution + the Temporary-banner auto-dismiss, not a broken
path). Two polish items for once the core fix is in:

- **Break through Focus / DND for the money-and-action buzzes** (locked · claim-ready · settled — these
  are genuinely time-sensitive; leave chat as normal). **Android (the launch platform):** a HIGH/MAX-
  importance notification channel + category does it — worth doing. **iOS/macOS:** the *time-sensitive*
  interruption level needs the entitlement (+ a signed bundle on macOS) — folds into the desktop-signing
  task, not urgent.
- **Capture-friendly for demo recordings:** the app can't force it, but for Jetty's own screen
  recordings, set the alert style to **Persistent** (System Settings → Notifications → Chama/Terminal)
  so a buzz lingers on screen long enough to film. One toggle, no code.
