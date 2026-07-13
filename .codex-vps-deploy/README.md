# Chama

[![CI](https://github.com/jesuspirate/chama/actions/workflows/ci.yml/badge.svg)](https://github.com/jesuspirate/chama/actions/workflows/ci.yml)

Nostr-native P2P escrow client. Non-custodial. No server.

Built on Nostr events (kinds 38100-38108), Fedimint ecash (WASM), and 2-of-3 Shamir Secret Sharing.

## Quick Start

```bash
npm install
npm run dev          # http://localhost:3000
```

Requires a NIP-07 signer extension (nos2x, Alby, Amber) or Fedi Mini-App runtime.

## Architecture

| Layer | What | Files |
|-------|------|-------|
| #1 State machine | Pure (state, event) -> state | `src/escrow-engine/` |
| #2 Relay layer | Multi-relay WebSocket, NIP-44, signers | `src/escrow-engine/` |
| #3 Fedimint WASM | Client-side ecash, SSS split/combine | `src/fedimint/` |
| #4 React UI | Trade list, detail, vote, create | `src/ui/` |

## Commands

```bash
npm run dev          # Development server
npm run build        # Production build -> dist/
npm run preview      # Preview production build
npm run typecheck    # Type-check the codebase (no emit). Must be zero errors.
npm test             # Run escrow engine tests (79 assertions)
npm run predeploy    # Typecheck + test, run before every deploy
```

## Deploy

The canonical deploy chain. Run from the repo root after a clean checkout:

```bash
npm run typecheck && \
npm test && \
npm run build && \
npx cap sync android && \
scp -r -i "$CHAMA_DEPLOY_KEY" dist/* satoshi@satoshimarket.app:~/chama-dist/ && \
git add -A && git commit -m "vX.Y.Z — message" && \
git push
```

`CHAMA_DEPLOY_KEY` should point at the SSH private key authorised for
`satoshi@satoshimarket.app`. The maintainer keeps it at
`~/.ssh/.id_satoshi_market`; any other releaser exports their own path
before running the deploy.

The typecheck step is non-negotiable. If `tsc --noEmit` reports any error,
stop and fix it before proceeding. Shipping code that fails typecheck has
historically caused silent runtime bugs (missing methods, schema drift,
identifier-not-defined) that cost hours to diagnose downstream.

The Android APK is synced automatically by `npx cap sync android`. To
rebuild the APK itself, open `android/` in Android Studio and Build → Rebuild.

### Releasing with `npm run ship`

`scripts/ship.sh` wraps the proven two-step flow (manual `npm version` +
`git commit -F` + push, then `npm run release:all`) into one command. It
changes none of the existing scripts — it orchestrates them.

Save the notes file(s) for the **target** version in `$CHAMA_COMMIT_DIR`
(default `/tmp`), named by convention, then run one command:

```bash
# /tmp/chama-v1.3.0_release_notes    (required: commit msg + GitHub notes)
# /tmp/chama-v1.3.0_zapstore_notes   (optional: Zapstore card notes)

export SIGN_WITH=browser CHAMA_ZSP_BIN=/private/tmp/zsp   # your usual env
npm run ship -- --minor          # 1.2.x → 1.3.0
# or: ./scripts/ship.sh --patch | --major | --set-version 1.3.0
```

What it runs (see exactly, without executing, via `--dry-run`):

```bash
npm version <bump> --no-git-tag-version
git add -A && git commit -F /tmp/chama-v<VER>_release_notes && git push origin main
npm run release:all -- --github-release --clobber --zapstore \
  --gpg-key "$CHAMA_GPG_KEY" \
  --notes-file          /tmp/chama-v<VER>_release_notes \
  --zapstore-notes-file /tmp/chama-v<VER>_zapstore_notes
```

The target version is computed up front so the notes files are resolved (and
their absence caught) **before** anything is bumped or committed. Flags:
`--dry-run` (print the plan, run nothing), `--no-push`, `--no-release`,
`--yes` (skip the confirm prompt). Env: `CHAMA_COMMIT_DIR`, `CHAMA_GPG_KEY`,
`CHAMA_RELEASE_FLAGS` (full override of the `release:all` flag list);
`SIGN_WITH` / `CHAMA_ZSP_BIN` / `CHAMA_DEPLOY_KEY` pass straight through.
Template: `scripts/release-notes-template.txt`.

## License

[MIT](./LICENSE) — use it, fork it, build on it, sell it; just keep the copyright line and the license notice. Open source, freely given. est. block 934,669
