<p align="center">
  <img src="icon.png" alt="Chama Logo" width="21%" />
</p>

# Chama on StartOS

> **Upstream project and docs:** <https://github.com/jesuspirate/chama>
>
> Everything not listed in this document should behave the same as upstream
> Chama. If a feature, setting, or behavior is not mentioned here, the upstream
> documentation is accurate and fully applicable.

Chama is a Nostr-native peer-to-peer marketplace with non-custodial Fedimint
ecash escrow. There is no Chama account server and no custody layer: clients
coordinate encrypted trade events over Nostr and talk directly to a Fedimint
federation the user picks. This package serves the Chama web client from your
own server, so the code you load is the code you host.

This repository is both the upstream application source and the StartOS package
that wraps it — the packaging layer is `startos/`, `Dockerfile`, `Makefile`,
`icon.png`, `LICENSE`, `instructions.md`, and the `build` / `release` /
`tagAndRelease` workflows.

---

## Table of Contents

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Configuration Management](#configuration-management)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Actions](#actions)
- [Backups and Restore](#backups-and-restore)
- [Health Checks](#health-checks)
- [Dependencies](#dependencies)
- [Limitations and Differences](#limitations-and-differences)
- [What Is Unchanged from Upstream](#what-is-unchanged-from-upstream)
- [Contributing](#contributing)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

---

## Image and Container Runtime

| What          | Detail                                                                    |
| ------------- | ------------------------------------------------------------------------- |
| Image source  | Built from this repository's own `Dockerfile` — there is no published tag |
| Architectures | `x86_64`, `aarch64`                                                       |
| Entrypoint    | Custom — `startos/entrypoint.sh`, installed as `chama-startos-entrypoint` |

The build has three stages: a Rust stage compiles the `chama-fedimint-bridge`
binary from `native/fedimint-bridge/`, a Node stage runs the app's own web build
with the native bridge pinned on (`VITE_CHAMA_NATIVE_BRIDGE_REQUIRED`,
`VITE_CHAMA_NATIVE_BRIDGE_URL=/bridge`), and an nginx stage assembles the two
with `startos/nginx.conf`.

The entrypoint starts one `chama-fedimint-bridge` per client on loopback, then
nginx in the foreground, and supervises all four. If any child dies — or is left
as an unreaped zombie — it exits non-zero so StartOS restarts the whole service
rather than leaving a healthy-looking page whose wallet calls all fail.

## Volume and Data Layout

One volume, `main`, mounted at `/data`:

| Path             | Contents                                      |
| ---------------- | --------------------------------------------- |
| `/data/client-1` | Fedimint client database for **Client One**   |
| `/data/client-2` | Fedimint client database for **Client Two**   |
| `/data/client-3` | Fedimint client database for **Client Three** |

Each directory is created by the entrypoint on first start and is used
exclusively by that client's bridge process. There is no shared database, no
StartOS `store.json`, and no generated config file — the package writes nothing
else to the volume.

Everything else Chama holds — the Nostr identity, trade chains, drafts, and
local caches — lives in **browser storage**, keyed to the origin the client was
loaded from. It is not on this volume.

## Installation and First-Run Flow

There is no setup wizard, no generated credential, and no configuration step.
After install each of the three interfaces serves an empty Chama client. A
client becomes usable once the user, inside it, chooses or imports a Nostr
identity and joins a Fedimint federation with an invite code. Both are in-app
decisions the package neither makes nor stores.

## Configuration Management

| StartOS-Managed                                  | Upstream-Managed                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| Which addresses each client interface answers on | Nostr identity, relays, federation, arbiter roster, every app option |

The package sets no environment variables at runtime. The two `VITE_*` values
above are build-time constants baked into the web bundle; they cannot be changed
without rebuilding the image.

## Network Access and Interfaces

Three `ui` interfaces, one per client, each on its own host so the browser gives
each its own origin — which is what keeps their identities, storage, and wallets
separate:

| Interface id   | Name         | Internal port | Protocol |
| -------------- | ------------ | ------------- | -------- |
| `client-one`   | Client One   | 8080          | HTTP     |
| `client-two`   | Client Two   | 8081          | HTTP     |
| `client-three` | Client Three | 8082          | HTTP     |

Each client's nginx server block proxies `/bridge/` to that client's own
`chama-fedimint-bridge` on loopback (8787, 8788, 8789 respectively). The bridges
bind loopback only and are **not** exported as interfaces; they are reachable
solely through their own client's `/bridge/` path. That location carries a
one-hour proxy read timeout because `/await-invoice` is a long poll held open
until a human actually pays.

Where these interfaces are reachable from is the user's decision, made per
address on the service's Interfaces tab.

## Actions

| Action                   | Id              | Visibility | Availability | Input | Output                                    |
| ------------------------ | --------------- | ---------- | ------------ | ----- | ----------------------------------------- |
| **Wallet Bridge Status** | `wallet-status` | Enabled    | Only running | None  | Per-client federation and discovery state |

Queries each client's bridge and reports whether it answered, whether that
client has joined a federation, and the state of its relay-discovery probe
(reachable / degraded / still probing / not configured). Read-only.

## Backups and Restore

`Backups.ofVolumes('main')` — the three Fedimint client databases. StartOS stops
the service before running the backup, so the databases are quiesced, and
`restoreInit` puts them back on restore.

**Not backed up:** all browser-side state — Nostr keys, trade chains, drafts —
because it never leaves the browser profile that loaded the client. Anything the
user needs to survive a lost browser has to be exported through Chama's own
in-app recovery material.

## Health Checks

One daemon health check, displayed as **Web Clients**, with a 30-second grace
period. For each client it requires both the web port and that client's wallet
bridge port to be listening; a client whose page is up but whose bridge is not
would serve the UI and then fail every `/bridge/` call, so it is not reported
ready.

## Dependencies

None.

## Limitations and Differences

1. **Neither the clients nor the bridges authenticate anyone.** The bridge
   refuses to serve a non-loopback bind without a token, but here it is reached
   through nginx on the same origin as the page — so anyone who can load a
   client interface can spend that client's ecash. Enable only addresses you
   trust, and treat each interface URL as a credential.
2. **The client count is fixed at three** and is not configurable. It is a
   property of the image: three nginx server blocks, three bridge processes,
   three data directories.
3. **Browser state is not backed up and not portable.** Clearing site data,
   switching browsers, or opening a client in a private window yields a fresh
   local client and can lose access to browser-only state.
4. **Web client only.** The desktop (Tauri) and Android (Capacitor) shells that
   also live in this repository are not built or shipped by this package.
5. **No `riscv64` build.** The Rust bridge and the base images have not been
   confirmed to build there.

## What Is Unchanged from Upstream

The Chama application itself: the escrow state machine and its Nostr event
kinds, encrypted trade coordination, relay discovery and replay, Fedimint ecash
and Lightning operations, on-chain commitment bonds and their chain
verification, arbiter rosters and selection, and the entire user interface. All
of it behaves exactly as upstream documents — including that relay and
federation selection remain in-app choices.

## Contributing

See [AGENTS.md](./AGENTS.md).

---

## Quick Reference for AI Consumers

```yaml
package_id: chama
architectures: [x86_64, aarch64]
volumes:
  main: /data
ports:
  client-one: 8080
  client-two: 8081
  client-three: 8082
internal_only_ports:
  client-one-bridge: 8787
  client-two-bridge: 8788
  client-three-bridge: 8789
dependencies: none
startos_managed_env_vars: []
actions:
  - wallet-status
```
