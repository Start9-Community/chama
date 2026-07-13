import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App.js";
import { LangProvider } from "./i18n/index.js";
import { assertProductionEncryption } from "./escrow-engine/encryption-config.js";

// SECURITY: hard-fail at boot if a production build is somehow
// shipping with DEV encryption (which would publish LOCK / VOTE /
// CLAIM / RESOLVE payloads in cleartext to every relay we touch).
// Vite injects `import.meta.env.PROD = true` for `vite build`
// output and false for `vite dev`, so this is a no-op for the dev
// server while remaining a guaranteed tripwire on every shipped APK
// or web bundle.
assertProductionEncryption(import.meta.env.PROD);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
);
