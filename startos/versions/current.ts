import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '5.4.0:0',
  releaseNotes: {
    en_US: 'Initial StartOS package with three isolated Chama testing clients.',
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
