// i18n namespace "notify" — OS notification TITLE + BODY text built in
// src/notifications/ (trade-notifications.ts transition + chat notifications,
// notify-service.ts self-test). Resolved with translate(getCurrentLang(), …)
// INSIDE the builder functions at call time, so a language switch is picked up
// by the next notification. Keys MUST be prefixed "notify." — see
// src/i18n/en/connect.ts for the pattern.
//
// ⚠ NOT here on purpose (dedup TAGS / ids, compared or used as keys — never
//   translate): the `tag` strings ("{id}:locked", "{id}:chat:…", "selftest",
//   etc.) and escrowId sentinels stay hardcoded.
export const notify: Record<string, string> = {
  "notify.approvedBody":
    "Trade {label} resolved in your favor — open Chama to claim your sats.",
  "notify.approvedTitle": "✅ Your claim is ready",
  "notify.chatBody": "{who} messaged you on trade {label}.",
  "notify.chatSenderRole": "The {role}",
  "notify.chatSomeone": "Someone",
  "notify.chatTitle": "💬 New message",
  "notify.completedBody": "Trade {label} settled — the sats have moved.",
  "notify.completedTitle": "🎉 Trade complete",
  "notify.disputeBody":
    "Buyer and seller disagree on trade {label}. They're waiting on you — review and vote.",
  "notify.disputeTitle": "⚖️ A trade needs your ruling",
  "notify.expiredBody":
    "Trade {label} reached its deadline. Open Chama to see where it landed.",
  "notify.expiredTitle": "⏰ Trade timed out",
  "notify.lockedBody": "Trade {label} is live — the other side funded it. Your move.",
  "notify.lockedTitle": "⚡ Sats locked in escrow",
  "notify.selfTestBody":
    "If you can see this, OS notification delivery works on this build.",
  "notify.selfTestTitle": "Chama notifications OK",
};
