import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App.js";
import { LangProvider } from "./i18n/index.js";
import { assertProductionEncryption } from "./escrow-engine/encryption-config.js";
import { claimRemoteBridgeInviteFromFragment } from "./fedimint/native-bridge-adapter.js";

// SECURITY: hard-fail at boot if a production build is somehow
// shipping with DEV encryption (which would publish LOCK / VOTE /
// CLAIM / RESOLVE payloads in cleartext to every relay we touch).
// Vite injects `import.meta.env.PROD = true` for `vite build`
// output and false for `vite dev`, so this is a no-op for the dev
// server while remaining a guaranteed tripwire on every shipped APK
// or web bundle.
assertProductionEncryption(import.meta.env.PROD);

// Remote-bridge "friend wallet" invite links carry `#bridge=<url>&token=<t>`
// in the URL fragment. Claim it into localStorage and strip it BEFORE the app
// renders, so the first wallet init already talks to the invited bridge and
// the token never lingers in the address bar.
claimRemoteBridgeInviteFromFragment();

// Opening another friend-wallet invite in an already-running Chama tab is a
// same-document hash navigation, so `main.tsx` does not execute again. Claim
// that new invite as soon as the hash changes, then reload once so every wallet
// consumer is rebuilt against the newly selected isolated bridge. The claim
// strips the hash before reload, preventing a loop and keeping the token out of
// the address bar.
window.addEventListener("hashchange", () => {
  if (claimRemoteBridgeInviteFromFragment()) window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
);
