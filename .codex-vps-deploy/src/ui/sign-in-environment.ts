export interface SignInEnvironment {
  isNativePlatform: boolean;
  userAgent: string;
  maxTouchPoints: number;
  hasFediInternal: boolean;
}

export function isTauriRuntime(): boolean {
  const global = globalThis as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(global.__TAURI__ || global.__TAURI_INTERNALS__);
}

export function getSignInEnvironment(): SignInEnvironment {
  const nav = typeof navigator !== "undefined" ? navigator : null;

  return {
    isNativePlatform: isTauriRuntime(),
    userAgent: nav?.userAgent || "",
    maxTouchPoints: nav?.maxTouchPoints || 0,
    hasFediInternal: typeof window !== "undefined" && !!(window as any).fediInternal,
  };
}

export function isMobileSignInEnvironment(env: Pick<SignInEnvironment, "userAgent" | "maxTouchPoints">): boolean {
  const ua = env.userAgent;
  const mobileUA = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(ua);
  const touchMac = /Macintosh/i.test(ua) && env.maxTouchPoints > 1;
  return mobileUA || touchMac;
}

export function isFediWebViewSignInEnvironment(env: Pick<SignInEnvironment, "userAgent" | "hasFediInternal">): boolean {
  return env.hasFediInternal || /\bFedi\b/i.test(env.userAgent);
}

export function isAndroidFediWebViewEnvironment(
  env: Pick<SignInEnvironment, "userAgent" | "hasFediInternal">
): boolean {
  return /Android/i.test(env.userAgent) && isFediWebViewSignInEnvironment(env);
}

export function shouldApplyCssSafeAreaInsets(
  env: Pick<SignInEnvironment, "userAgent" | "hasFediInternal">
): boolean {
  return !isAndroidFediWebViewEnvironment(env);
}

export function shouldOfferNIP46Signer(env: SignInEnvironment): boolean {
  return (
    !env.isNativePlatform &&
    !isMobileSignInEnvironment(env) &&
    !isFediWebViewSignInEnvironment(env)
  );
}
