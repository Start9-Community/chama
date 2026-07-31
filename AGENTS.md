# AGENTS.md

This repository is **both** the Chama application source and a StartOS service-package
repository — it builds a `.s9pk` for StartOS out of the very source it ships. Everything
under `startos/` plus `Dockerfile`, `Makefile`, `icon.png`, `LICENSE`, `instructions.md`
and `.github/workflows/{build,release,tagAndRelease}.yml` is the packaging layer;
everything else is the application.

Develop the packaging layer inside a StartOS packaging workspace created by
`start-cli s9pk init-workspace`, which provides the packaging guide and agent context one
level up. If you're reading this in a bare clone with no workspace, the full guide is at
<https://docs.start9.com/packaging>.

**Start every packaging task at the recipe index** —
`../start-technologies/projects/start-sdk/docs/src/recipes.md` (or
<https://docs.start9.com/packaging/recipes.html>). It maps an intent to the constructs,
the reference pages, and a named production package to copy. Find the recipe before you
read a neighbouring package: one you reach by grepping may be non-conformant, and the
recipe outranks it.

Work `TODO.md` from top to bottom. Keep `README.md` (architecture, for developers and
LLMs) and `instructions.md` (end-user docs) in sync with your changes.

## This repo

- **Package id is `chama`.** One image built from this repo's own `Dockerfile`, one `main`
  volume, no dependencies, no actions. The image serves three independent Chama web
  origins (ports 8080/8081/8082), each proxying `/bridge/` to its own
  `chama-fedimint-bridge` process on loopback (8787/8788/8789) with its own wallet
  directory under `/data/client-<n>`.
- **`packageRepo` is this fork** (`Start9-Community/chama`); `upstreamRepo` is the
  application's home (`jesuspirate/chama`). Packaging changes land here.

## Packaging gotchas specific to this repo

- **Use the `startos:*` npm scripts, never `check` / `build`.** `npm run build` is the
  Vite web build the `Dockerfile` calls; `npm run typecheck` is the app's. The StartOS
  bundle is `startos:check` → `startos:lint` → `startos:build`. `Makefile` overrides
  `s9pk.mk`'s stock `javascript/index.js` recipe for exactly this reason — make prints a
  "overriding recipe" warning on every run, which is expected.
- **The StartOS tsconfig is `startos/tsconfig.json`, not the root one.** The root
  `tsconfig.json` belongs to the React app and includes only `src`. Keeping the packaging
  tsconfig inside `startos/` is also what lets the SDK's ESLint runner (`projectService`)
  resolve a project for `startos/**/*.ts`.
- **`javascript/index.js` is emitted as ESM, not CJS.** `ncc` follows the root
  `package.json`'s `"type": "module"`, and writes a matching `javascript/package.json`.
  StartOS's container runtime `require()`s the bundle, which works because Node ≥ 20.19
  supports `require(esm)`. Do not "fix" this by dropping `"type": "module"` — the app
  needs it — and do not add a `startos/package.json` to force CJS: webpack then emits an
  empty export table and the package loads with no `manifest`/`main`/`init`.
- **`icon.png` is a 512×512 downscale of `src-tauri/icons/icon.png`.** The 1024×1024
  original is ~713 KB, and a package icon is embedded as a base64 data URL in every
  registry index. Regenerate with:
  `convert src-tauri/icons/icon.png -filter Lanczos -resize 512x512 -strip -quality 95 icon.png`
- **Two release lanes share this repo's tags.** `scripts/release.sh` tags `vX.Y.Z` for the
  desktop/Zapstore lane; StartOS's `tagAndRelease.yml` tags `vX.Y.Z_<revision>`. The tag
  filters in `release.yml` and `desktop-release.yml` keep them apart — keep them in sync
  if either changes.
- **The Docker build context is the whole repo**, filtered by `.dockerignore`. Anything
  the web build or the Rust bridge needs must stay out of that ignore list.

## Inspecting a running install

To run a command inside the service's container (check a bridge, read nginx logs), use
`start-cli package attach chama -n chama-sub -- <cmd>`. Select the subcontainer by **name**
with `-n` (the name passed to `SubContainer.of` in `startos/main.ts` — here `chama-sub`) or
by image with `-i`. Note: `-s/--subcontainer` matches the internal **Guid**, not the name,
so passing a name to `-s` fails with "no matching subcontainers".
