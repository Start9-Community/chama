import type { CapacitorConfig } from '@capacitor/cli';

// SECURITY: this config ships to every Android build, including release
// APKs that handle real bitcoin. Two settings here were dangerous in
// production and have been tightened:
//
//   - `webContentsDebuggingEnabled: true` lets anyone with USB/adb (or a
//     compromised host on the same WebView debugging port) attach Chrome
//     DevTools and read every secret in memory: nsec, decrypted SSS
//     shares, ecash notes. Now off everywhere.
//
//   - `allowMixedContent: true` permitted HTTP subresources on HTTPS
//     pages, which would let a network attacker inject scripts that
//     could swap recipient pubkeys mid-trade. Now off; only HTTPS/WSS
//     subresources are allowed, with cleartext to localhost still
//     allowed via network_security_config.xml for the local Fedimint
//     bridge.
const config: CapacitorConfig = {
  appId: 'app.chama.market',
  appName: 'Chama',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
