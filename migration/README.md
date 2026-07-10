# ./migration/ — working directory for the 1984 → StartTunnel migration

This is the scaffold referenced by `vps-migration-brief.md`. The laptop agent runs from here.

## Layout
```
migration/
├── .gitignore               # secrets stay out of git (already configured)
├── README.md                # this file
├── inventory.md             # STEP 1 output — fill in, then STOP at Gate A
├── test-results.md          # STEP 6 output — fill in, then STOP at Gate B
├── start-tunnel-access.md   # STEP 3 secret (web URL/password/Root CA) — GITIGNORED
├── backup/                  # STEP 2 — docroots, configs, crontabs, DB dumps, /etc/letsencrypt (GITIGNORED)
└── configs/                 # templates to adapt (examples are safe to commit; live files are gitignored)
    ├── Caddyfile.example
    ├── wg0.conf.example
    └── nftables.conf.example
```

## Rules (from the brief)
- Read-only on OLD. Pull, never push/delete.
- Idempotent / safe to re-run.
- STOP at **Gate A** (after inventory: confirm domains + choose cert strategy) and **Gate B** (after testing, before cutover). Ask before anything destructive.
- Live secret-bearing files (`start-tunnel-access.md`, `configs/wg0.conf`, tokens, `backup/`) are gitignored. Keep it that way.

## Using it on the laptop
Copy this whole `migration/` folder (and `vps-migration-brief.md`) into your working dir on the laptop, then hand the brief to your Claude Code session. Fill `inventory.md` first.
