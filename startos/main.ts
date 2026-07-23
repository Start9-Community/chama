import { i18n } from './i18n'
import { sdk } from './sdk'
import { clientOnePort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Chama'))

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: sdk.SubContainer.of(
      effects,
      { imageId: 'chama' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'chama-sub',
    ),
    exec: { command: ['/usr/local/bin/chama-startos-entrypoint'] },
    ready: {
      display: i18n('Web clients'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, clientOnePort, {
          successMessage: i18n('The Chama web clients are ready'),
          errorMessage: i18n('The Chama web clients are not ready'),
        }),
    },
    requires: [],
  })
})
