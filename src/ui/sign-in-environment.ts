export interface SignInEnvironment {
  isNativePlatform: boolean;
  userAgent: string;
  maxTouchPoints: number;
  hasFediInternal: boolean;
}

export function getSignInEnvironment(): SignInEnvironment {
  const nav = typeof navigator !== "undefined" ? navigator : null;

  return {
    isNativePlatform: false,
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

export function shouldOfferNIP46Signer(env: SignInEnvironment): boolean {
  return (
    !env.isNativePlatform &&
    !isMobileSignInEnvironment(env) &&
    !isFediWebViewSignInEnvironment(env)
  );
}
