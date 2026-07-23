# Chama

## Open isolated test clients

The service exposes **Client One**, **Client Two**, and **Client Three** on its dashboard. Open each interface in a separate browser tab to act as different marketplace participants. Each interface has a distinct origin and a dedicated native Fedimint wallet, so Chama keeps its identity, wallet, and local state separate from the other two clients.

Use different Nostr identities for buyer, seller, and arbiter scenarios. All three clients use the relays and Fedimint federation selected inside Chama; the StartOS package itself has no account server, database, or custody role.

## Data and backups

Chama stores identity and trade state in each browser profile, while each native Fedimint wallet is stored in the StartOS service volume. StartOS backups cover the native wallet volume but do not include browser storage. Back up any secrets or recovery material shown by Chama using the in-app guidance.

Clearing site data, changing browsers, or opening an interface in a private window creates a fresh local client and can remove access to browser-only state.

## Learn more

- [Chama source and documentation](https://github.com/jesuspirate/chama)
