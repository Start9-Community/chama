import { i18n } from './i18n'
import { sdk } from './sdk'
import { clientOnePort, clientThreePort, clientTwoPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Chama'))

  const chamaSubcontainer = await sdk.SubContainer.of(
    effects,
    { imageId: 'chama' },
    sdk.Mounts.of().mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: '/data',
      readonly: false,
    }),
    'chama-sub',
  )

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: chamaSubcontainer,
    exec: { command: ['/usr/local/bin/chama-startos-entrypoint'] },
    ready: {
      display: i18n('Web clients'),
      gracePeriod: 30_000,
      fn: async () => {
        const ports = [clientOnePort, clientTwoPort, clientThreePort]
        for (const port of ports) {
          const result = await sdk.healthCheck.checkPortListening(effects, port, {
            successMessage: i18n('The Chama web clients are ready'),
            errorMessage: i18n('The Chama web clients are not ready'),
          })
          if (result.result !== 'success') return result
        }
        return {
          result: 'success' as const,
          message: i18n('The Chama web clients are ready'),
        }
      },
    },
    requires: [],
  })
})
