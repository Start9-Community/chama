import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build stamp for local/test builds: lets the tester SEE that a Tauri /
    // Android-Studio refresh actually picked up the new bundle (the chip reads
    // "v2.0.3 · dev 14:32"). Release builds go through ship.sh, which exports
    // CHAMA_RELEASE=1 → the stamp is empty and users see the clean version.
    __BUILD_STAMP__: JSON.stringify(
      process.env.CHAMA_RELEASE === "1"
        ? ""
        : new Date().toISOString().slice(5, 16).replace("T", " "),
    ),
  },
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
  ],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: {
    exclude: ["@fedimint/core", "@fedimint/transport-web"],
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
  server: {
    port: 3000,
  },
});
