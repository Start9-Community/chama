// Centralised, validated configuration loaded from environment variables.

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

// PHOENIXD_URL may embed basic-auth credentials, e.g.
//   http://_:hunter2@127.0.0.1:9740
// We split the credentials out and keep a clean base URL for fetch().
const rawPhoenixdUrl = required("PHOENIXD_URL", "http://127.0.0.1:9740");
const parsed = new URL(rawPhoenixdUrl);
const phoenixdUsername = parsed.username || "_";
const phoenixdPassword = parsed.password || process.env.PHOENIXD_HTTP_PASSWORD || "";
parsed.username = "";
parsed.password = "";
const phoenixdBase = parsed.toString().replace(/\/$/, "");

export const config = {
  port: Number(process.env.PORT ?? 8000),

  // Public hostname only (no scheme). Right-hand side of the lightning address.
  hostname: required("LNURL_HOSTNAME"),

  phoenixd: {
    base: phoenixdBase,
    username: phoenixdUsername,
    password: phoenixdPassword,
  },

  minSendableSat: Number(process.env.MIN_SENDABLE_SAT ?? 1),
  maxSendableSat: Number(process.env.MAX_SENDABLE_SAT ?? 1_000_000),
  commentAllowed: Number(process.env.COMMENT_ALLOWED ?? 280),

  allowedUsernames: (process.env.ALLOWED_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  successMessage: process.env.SUCCESS_MESSAGE ?? "",
} as const;

if (!config.phoenixd.password) {
  console.warn(
    "[config] WARNING: no phoenixd password set. Set it via PHOENIXD_URL " +
      "(http://_:PASSWORD@host:port) or PHOENIXD_HTTP_PASSWORD.",
  );
}
