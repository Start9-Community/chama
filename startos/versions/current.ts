import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '5.7.0:0',
  releaseNotes: {
    en_US:
      'First StartOS release. Runs three self-contained Chama clients, each on its own interface with its own identity, browser storage and Fedimint wallet. Adds a Wallet Bridge Status action reporting each wallet bridge, and holds a client back from healthy until its wallet bridge is up, not just its web page.',
    es_ES:
      'Primera versión para StartOS. Ejecuta tres clientes de Chama independientes, cada uno en su propia interfaz y con su propia identidad, almacenamiento del navegador y monedero Fedimint. Añade una acción de Estado del puente de monedero e impide que un cliente aparezca como correcto hasta que su puente de monedero esté activo, no solo su página web.',
    de_DE:
      'Erste StartOS-Veröffentlichung. Betreibt drei eigenständige Chama-Clients, jeder mit eigener Schnittstelle, eigener Identität, eigenem Browser-Speicher und eigener Fedimint-Wallet. Ergänzt eine Aktion „Status der Wallet-Bridge“ und meldet einen Client erst als fehlerfrei, wenn auch seine Wallet-Bridge läuft, nicht nur seine Webseite.',
    pl_PL:
      'Pierwsze wydanie dla StartOS. Uruchamia trzech samodzielnych klientów Chama, każdego na własnym interfejsie i z własną tożsamością, pamięcią przeglądarki oraz portfelem Fedimint. Dodaje akcję Stan mostka portfela i uznaje klienta za sprawnego dopiero wtedy, gdy działa także jego mostek portfela, a nie tylko strona internetowa.',
    fr_FR:
      "Première version pour StartOS. Exécute trois clients Chama autonomes, chacun sur sa propre interface avec sa propre identité, son propre stockage de navigateur et son propre portefeuille Fedimint. Ajoute une action « État de la passerelle de portefeuille » et ne considère un client comme sain qu'une fois sa passerelle de portefeuille active, et pas seulement sa page web.",
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
