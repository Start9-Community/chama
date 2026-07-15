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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
);
