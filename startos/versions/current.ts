import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '5.5.0:14',
  releaseNotes: {
    en_US:
      'Fixes the relay-storm memory runaway that could freeze or crash a client: redelivered events are recognised before they are decrypted, repeat chain reloads of one trade back off instead of re-arming, listing hydration is queued behind a concurrency cap, and the in-memory event cache is bounded. Also fixes funding: waiting for a Lightning payment no longer reports a false rejection when the proxy in front of the wallet bridge closes the connection — the bridge now bounds its own wait and the client re-asks, so an unpaid invoice stays honestly pending. Carries forward the lab health checks, fail-closed entrypoint, and Work offers (NIP-99 + worker résumé), plus in-progress Guided buy work from this build.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
