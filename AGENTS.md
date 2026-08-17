# AGENTS.md

This is a StartOS service-package repository — it builds a `.s9pk` for StartOS.

Develop it inside a StartOS packaging workspace created by `start-cli s9pk init-workspace`,
which provides the packaging guide and agent context one level up. If you're reading this in a
bare clone with no workspace, the full guide is at <https://docs.start9.com/packaging>.

Work this package's `TODO.md` from top to bottom. Keep `README.md` (technical reference for an AI support or administering agent) and `instructions.md` (end-user docs) in sync with your changes.

## This repo

- **`startos/utils.ts`'s `clients` array is the single source for the three clients**, but only for the TypeScript side. `startos/nginx.conf` and `startos/entrypoint.sh` hardcode the same ports — adding or renaming a client means editing all three, and nothing catches a mismatch.
- **`packageRepo` is this fork** (`Start9-Community/chama`); `upstreamRepo` is the application's home. Packaging changes land here.
- **Use the `startos:*` npm scripts, never `check` / `build`.** `npm run build` is the Vite web build the `Dockerfile` calls and `npm run typecheck` is the app's; the StartOS bundle is `startos:check` → `startos:lint` → `startos:build`. The `Makefile` overrides `s9pk.mk`'s stock `javascript/index.js` recipe for exactly this reason, so make's "overriding recipe" warning on every run is expected.
- **The StartOS tsconfig is `startos/tsconfig.json`, not the root one.** The root belongs to the React app and includes only `src`. Keeping the packaging tsconfig inside `startos/` is also what lets the SDK's ESLint runner resolve a project for `startos/**/*.ts`.
- **`javascript/index.js` is emitted as ESM, not CJS.** `ncc` follows the root `package.json`'s `"type": "module"` and writes a matching `javascript/package.json`; the container runtime `require()`s it, which works on Node ≥ 20.19. Don't "fix" it by dropping `"type": "module"` — the app needs it — and don't add a `startos/package.json` to force CJS: webpack then emits an empty export table and the package loads with no `manifest`/`main`/`init`.
- **Keep the entrypoint's zombie check.** `kill -0` still succeeds for an unreaped zombie, so without reading the process state a natively-aborted bridge leaves nginx serving a healthy-looking UI whose bridge upstream is permanently dead.
- **The long `proxy_send_timeout` on the invoice path is load-bearing.** It is a long poll held open until a human pays; at nginx's default it hung up mid-scan and returned a 504 page the client read as a rejected payment.
- **`icon.png` is a 512×512 downscale of `src-tauri/icons/icon.png`.** The 1024×1024 original is ~713 KB and a package icon is embedded as a base64 data URL in every registry index. Regenerate with:
  `convert src-tauri/icons/icon.png -filter Lanczos -resize 512x512 -strip -quality 95 icon.png`
- **Two release lanes share this repo's tags.** `scripts/release.sh` tags `vX.Y.Z` for the desktop/Zapstore lane; StartOS's `tagAndRelease.yml` tags `vX.Y.Z_<revision>`. The tag filters in `release.yml` and `desktop-release.yml` keep them apart — keep them in sync if either changes.
- **The Docker build context is the whole repo**, filtered by `.dockerignore`. Anything the web build or the Rust bridge needs must stay out of that ignore list.
