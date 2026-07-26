import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '5.5.0:14',
  releaseNotes: {
    en_US:
      'Lab package hardening: three-client + three-bridge health checks, fail-closed entrypoint when a wallet bridge dies, StartOS-sized icon, and clearer packaging docs. Still includes Work offers (NIP-99 + worker résumé).',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
