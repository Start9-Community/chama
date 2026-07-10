# Task: Migrate my websites off 1984 Hosting → StartTunnel hidden-origin (BuyVM edge + IncogNET origin)

**For:** a Claude Code (or equivalent) agent running **on my laptop**, which has SSH access to all three boxes.
**I (Jetty)** apply DNS myself at Njalla and approve every gate.
**Status:** upgraded from the original brief after reading StartTunnel's docs + CLI. Changes are listed below.
**Clock:** ~3 days before the old VPS may be suspended; treat "grace period" as "could be powered off without warning" → **back up first.**

---

## ⚠️ CHANGES FROM THE ORIGINAL BRIEF (read these — they are corrections, not style edits)

1. **Cert ordering is the real trap.** The original step 6 wants a valid, origin-issued TLS cert verified *before* DNS cutover. With Caddy's **default** challenges (HTTP-01 / TLS-ALPN-01) that is **impossible** — ACME follows public DNS, which still points at OLD, so the new origin cannot obtain a cert until *after* cutover. Two ways to make pre-cutover testing real (decide at the **post-inventory gate**, see step 1):
   - **DNS-01 via Njalla** (clean, recommended): build Caddy with the `caddy-dns/njalla` module, use a Njalla API token, certs issue with **zero inbound routing**, independent of where A records point. Auto-renews forever.
   - **Copy existing certs from OLD** (`/etc/letsencrypt`) for instant valid test certs, then switch renewal to HTTP-01 after cutover. No token needed, but two mechanisms to maintain.
2. **Edge must be Debian 13.** StartTunnel's docs **require Debian 13** on the edge. The original said "Debian 12+." Provision **BuyVM as Debian 13**. (Origin can stay Debian 12+ — it only runs `wg-quick` + Caddy.)
3. **Forward 80→80 and 443→443 raw.** Do **not** use StartTunnel's "also forward 80→443" redirect convenience. Forward both ports raw (L3/4) to the origin and let **Caddy on the origin** own the HTTP→HTTPS redirect and ACME. Keeps the edge purely L3/4, never touching plaintext.
4. **Only 80/443 ride this tunnel.** If any domain also does **mail (MX)** or depends on other ports/services, those will **break** on cutover unless handled separately. Surface every non-web service in the inventory and STOP to discuss.
5. **The origin is just "a WireGuard device."** StartTunnel treats every device the same: create a device on the edge, download its `.conf`, run it. A StartOS box imports it as a "gateway"; **our plain Debian origin just runs it with `wg-quick`.** No StartTunnel binary on the origin. (This resolves the original's "adapt for a non-StartOS origin" uncertainty — it's a non-issue.)
6. **Minor:** origin loses real client IPs in logs (L3/4 DNAT) unless PROXY protocol is added later; the edge IP is exposed with no DDoS protection (use BuyVM's filtering if needed); installer URL is **`https://start9.com/start-tunnel/install.sh`** (the original's `start9labs.github.io/...` URL is not the one in the official docs — use the docs URL).

---

## READ FIRST (source of truth — do not invent StartTunnel commands)
- Install / requirements / cloud-firewall caveats: https://docs.start9.com/start-tunnel/1.0.x/installing.html
- Devices: https://docs.start9.com/start-tunnel/1.0.x/devices.html
- Port forwarding: https://docs.start9.com/start-tunnel/1.0.x/port-forwarding.html
- CLI reference: https://docs.start9.com/start-tunnel/1.0.x/cli-reference.html
- Architecture + FAQ: https://docs.start9.com/start-tunnel/1.0.x/architecture.html · https://docs.start9.com/start-tunnel/1.0.x/faq.html

**Verified facts baked into this brief:** WireGuard listens on **UDP 51820** by default · the installer **disables UFW and manages its own iptables** (so the edge runs **StartTunnel only**) · a **dedicated public IPv4** is mandatory for port forwarding (no CGNAT/shared/IPv6-only) · the real CLI verbs are in the appendix.

---

## ARCHITECTURE (corrected)
- **EDGE (BuyVM)** — Debian 13, dedicated public IPv4, the **only** public box. Runs **StartTunnel only** (its installer owns the firewall). Raw L3/4 DNAT of public **TCP 80→origin:80** and **443→origin:443** over WireGuard. **Never terminates TLS, never sees plaintext.**
- **ORIGIN (IncogNET)** — Debian 12+. Runs the actual sites + databases + **Caddy (terminates TLS here)**. Joins the tunnel as a standard WireGuard device (`wg-quick`). **No public 80/443.** IP never published.
- **DNS at Njalla** — every domain's A record → **EDGE public IP** (TTL already 300s). Origin IP appears nowhere.

```
visitor ──▶ EDGE public IP :80/:443 ──(WireGuard, DNAT)──▶ ORIGIN tunnel IP :80/:443 ──▶ Caddy (TLS) ──▶ sites
```

---

## ACCESS (ask me for anything missing before you start)
- OLD (1984):        `root@<OLD_IP>`     (key already added)
- EDGE (BuyVM):      `root@<EDGE_IP>`    Debian **13**, dedicated public IPv4
- ORIGIN (IncogNET): `root@<ORIGIN_IP>`  Debian 12+
- My admin/source IP (for SSH firewall allow-listing on the origin): `<MY_IP>`
- Njalla: I apply records. If we choose **DNS-01**, I will create and hand you a **Njalla API token**.
- Domains: derive from OLD's vhosts, then **show me the list to confirm** before any cert work.

---

## ORDER OF WORK — hard STOP at every 🛑. Never run anything destructive on OLD.

### 1. INVENTORY (read-only on OLD) → 🛑 GATE A
Detect and record, touching nothing:
- Web server (nginx/apache/caddy/other) + **every vhost/server-block and docroot**.
- Runtimes **and exact versions**: PHP (+ `php -m` extensions, FPM pools), Node, Python, anything else.
- Databases: engine, **names, sizes**, users/grants.
- Cron jobs (per user), systemd services/timers, anything else that must run.
- **Open/listening ports** (`ss -tulpn`) — explicitly note **anything other than 22/80/443** (mail/SMTP/IMAP, etc.).
- **Mail / MX**: does any domain receive mail on this box? (If yes → out of scope for the tunnel; flag loudly.)
- **Current TLS setup**: who issues certs (certbot/Caddy/other), challenge type, **wildcard or not**, cert paths.
- Write `./migration/inventory.md`.

**🛑 GATE A — STOP and show me `inventory.md`. Decide together:**
- **(a) Domain list confirmed?**
- **(b) Cert strategy** — pick based on what the inventory shows:
  - many domains / wildcard / want zero-touch renewal → **DNS-01 via Njalla** (I provide a token);
  - simple set, want fastest path to a green test → **copy `/etc/letsencrypt` from OLD**, renew via HTTP-01 post-cutover.
- **(c) Any non-80/443 service** that needs a separate plan?

### 2. SAFETY BACKUP — do this immediately (OLD may vanish) → 🛑 confirm
Pull from OLD to **ORIGIN** *and* locally to `./migration/backup/`:
- all docroots, all web-server configs, all crontabs, all systemd unit files;
- **per-DB dumps** (`mysqldump --single-transaction` / `pg_dump`), one file per DB;
- **`/etc/letsencrypt`** (needed for the copy-cert option and as a reference either way).
Verify with checksums (`sha256sum`), record them in `./migration/backup/CHECKSUMS`. **Confirm sizes/counts look right before proceeding.** (Read-only on OLD throughout — pull, never push/delete.)

### 3. EDGE — install StartTunnel
- Confirm BuyVM box is **Debian 13** with a **dedicated public IPv4**. Confirm no cloud-panel firewall is blocking **UDP 51820** (BuyVM: check any Frantech firewall product is off or 51820 is allowed).
- Install: `curl -sSL https://start9.com/start-tunnel/install.sh | sh`
- `start-tunnel web init` → save the **web URL, password, and Root CA cert** to `./migration/start-tunnel-access.md` (**gitignored**).
- Confirm WireGuard **UDP 51820** is reachable from the outside (e.g. from the laptop: `nc -u -z -v <EDGE_IP> 51820`, or verify once the origin handshakes in step 4).

### 4. ORIGIN — join the tunnel + rebuild the sites
- On the **edge**, create a device for the origin and grab its config (see appendix):
  `start-tunnel device add <SUBNET> origin` → `start-tunnel device show-config <SUBNET> <ORIGIN_TUNNEL_IP>`
- On the **origin**, save that as `/etc/wireguard/wg0.conf`, **add `PersistentKeepalive = 25`** under `[Peer]` (origin dials out; keepalive lets the edge route back), then `wg-quick up wg0` + `systemctl enable wg-quick@wg0`.
- **Confirm both ends ping over the WireGuard subnet** before continuing.
- Install **Caddy** + the **exact runtimes/versions** from step 1.
  - If **DNS-01** chosen: build Caddy with the Njalla module (`xcaddy build --with github.com/caddy-dns/njalla`) and set `NJALLA_API_TOKEN` (appendix).
  - If **copy-cert** chosen: drop OLD's certs in place and point Caddy at them with `tls <cert> <key>` per site (appendix).
- Recreate **every vhost** in the `Caddyfile` with automatic HTTPS so **certs live on the origin**.
- Restore docroots/configs/databases; **wire up app credentials** (DB users/passwords, app secrets, file perms).
- **Origin firewall** (nftables/ufw): allow **SSH from `<MY_IP>`**; allow **80/443 ONLY from the tunnel subnet**; **deny public 80/443 on the public NIC.** (Appendix.)

### 5. EDGE — forward ports
- `start-tunnel port-forward add 80 <ORIGIN_TUNNEL_IP>:80 --label web-http`
- `start-tunnel port-forward add 443 <ORIGIN_TUNNEL_IP>:443 --label web-https`
- **Do not** enable the "also forward 80→443" redirect option — Caddy on the origin does the redirect. Leave the StartTunnel-managed firewall intact.

### 6. TEST (no DNS change yet) → 🛑 GATE B
Per domain, from the laptop:
```
curl -sSI --resolve <domain>:443:<EDGE_IP> https://<domain>/
curl -sSI --resolve <domain>:80:<EDGE_IP>  http://<domain>/      # expect 301→https
```
Verify: **200s**, **valid cert issued on the origin** (the cert step from Gate A must be done first — this is why ordering matters), correct content, **dynamic features + DB working**, **no mixed content**, and that the **ORIGIN IP leaks nowhere** (response headers, cert SANs, redirect `Location`). Write `./migration/test-results.md`. **🛑 STOP and show me.**

### 7. CUTOVER (only after I approve Gate B)
Output the **exact A/AAAA records** for Njalla (all domains → `<EDGE_IP>`; drop/append AAAA only if the edge has public IPv6). I apply them. You **monitor propagation** (`dig +short <domain> @<resolver>`) and **re-verify** each domain live. TTL is 300s so this is quick.

### 8. POST
- Leave **OLD untouched.** Produce a **verification report** + a **rollback note**: revert DNS A records to `<OLD_IP>` to instantly fall back.
- **Do NOT cancel or wipe OLD** — I decommission manually after 24–48h of stability.

---

## RULES
- Read StartTunnel's docs/CLI before touching it; **never guess its commands** (verbs in appendix).
- **Idempotent / safe to re-run.** Check-before-create; don't duplicate devices, forwards, or vhosts.
- **Never run destructive commands on OLD.** Pull only.
- **Ask before anything heavy or irreversible**, and stop at every 🛑.
- Keep all configs/notes under `./migration/`. Secrets (`start-tunnel-access.md`, Njalla token, DB creds, `backup/`) go in `./migration/.gitignore`.

---

## APPENDIX

### A. Verified `start-tunnel` CLI cheat-sheet
```
# Web UI
start-tunnel web init                          # interactive: sets password, TLS, Root CA
start-tunnel auth reset-password               # if locked out

# Subnets (a default subnet exists; create one only if you want isolation)
start-tunnel subnet <SUBNET> add <NAME>
start-tunnel subnet <SUBNET> remove

# Devices (the origin is a device)
start-tunnel device add <SUBNET> <NAME> [IP]   # add origin; optionally pin its tunnel IP
start-tunnel device list <SUBNET>
start-tunnel device show-config <SUBNET> <IP>  # prints the WireGuard .conf to import on origin
start-tunnel device remove <SUBNET> <IP>

# Port forwarding (public SOURCE -> private TARGET = device tunnel ip:port)
start-tunnel port-forward add 80  <ORIGIN_TUNNEL_IP>:80  --label web-http
start-tunnel port-forward add 443 <ORIGIN_TUNNEL_IP>:443 --label web-https
start-tunnel port-forward remove <SOURCE>
start-tunnel port-forward set-enabled <SOURCE> --enabled
```
> Use the **web UI** (from `web init`) if you prefer clicking — Devices → Add, Port Forwards → Add do the same thing. Confirm exact subnet name/IP plumbing against `--help` on the box; the docs are the source of truth.

### B. Origin WireGuard peer (`/etc/wireguard/wg0.conf`)
Start from `device show-config`, then ensure the `[Peer]` block keeps the tunnel warm:
```ini
[Interface]
PrivateKey = <from show-config>
Address    = <ORIGIN_TUNNEL_IP>/<mask>     # from show-config

[Peer]
PublicKey           = <edge pubkey, from show-config>
PresharedKey        = <from show-config>
Endpoint            = <EDGE_IP>:51820
AllowedIPs          = <tunnel subnet, e.g. 10.x.x.0/24>   # start here; see return-path note below
PersistentKeepalive = 25
```
```
wg-quick up wg0 && systemctl enable wg-quick@wg0
wg show          # confirm a recent handshake before testing
```

**⚠ Return-path (validate this — most likely failure point).** A reverse port-forward only works if the origin's *replies* go back out through `wg0`. Which config is correct depends on whether StartTunnel's edge does **SNAT/masquerade** or **DNAT-only** — check the edge with `iptables -t nat -L -n -v` (or `nft list ruleset`) and confirm against the docs; do **not** assume.
- **If the edge masquerades** (origin sees the *edge tunnel IP* as the client source): `AllowedIPs = <tunnel subnet>` is enough — replies naturally return through the tunnel. You lose the real visitor IP in logs (expected; PROXY protocol later if you want it back).
- **If the edge is DNAT-only** (origin sees the *real visitor IP*): replies to those visitors would try to leave via the origin's normal default route, not the tunnel → connections hang (SYN arrives, no SYN-ACK returns). Fix with **policy routing** on the origin: `connmark` inbound connections on `wg0`, restore the mark on replies, and an `ip rule fwmark … table <wg>` whose default route is via the tunnel. (Simpler but heavier alternative: set `AllowedIPs = 0.0.0.0/0` so all origin egress exits via the edge — if you do, add an `ip rule` to keep SSH from `<MY_IP>` on the public NIC so you don't lock yourself out.)
- **Test it explicitly in step 4** before forwarding ports: from the laptop, after the forward is up, a `curl --resolve` that *hangs* rather than errors = return-path problem, not a Caddy problem.

### C. Caddyfile (origin terminates TLS)
**Option 1 — DNS-01 via Njalla (recommended).** Build once:
```
# install Go, then:
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/njalla
# replace /usr/bin/caddy with the built binary; export the token to the caddy service env:
#   NJALLA_API_TOKEN=<token>
```
```caddyfile
{
    email <your-acme-email>
    acme_dns njalla {env.NJALLA_API_TOKEN}
}

example.com, www.example.com {
    root * /var/www/example.com
    encode gzip
    # php_fastcgi unix//run/php/php-fpm.sock   # if PHP
    # reverse_proxy 127.0.0.1:3000             # if a Node/Python app
    file_server
}
```
**Option 2 — reuse OLD's certs (no token).** Copy `/etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem` to the origin and pin per site, then switch to HTTP-01 renewal after cutover (works once 80 forwards edge→origin):
```caddyfile
example.com, www.example.com {
    tls /etc/ssl/chama/example.com/fullchain.pem /etc/ssl/chama/example.com/privkey.pem
    root * /var/www/example.com
    file_server
}
```

### D. Origin firewall (nftables sketch — adapt subnet/IPs)
```
# allow SSH only from my admin IP
# allow 80/443 ONLY from the WireGuard subnet (wg0)
# drop public 80/443 on the public NIC
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip saddr <MY_IP> tcp dport 22 accept
    iifname "wg0" tcp dport { 80, 443 } accept
    udp dport 51820 accept           # WireGuard (origin dials out, but harmless/keep if needed)
    # everything else to 80/443 on the public NIC is dropped by policy
  }
}
```

### E. Decision gate cheat-card (Gate A, certs)
| If the inventory shows… | Lean toward |
|---|---|
| wildcard cert, many subdomains, or you want hands-off renewal | **DNS-01 (Njalla token)** |
| a handful of plain domains, want the fastest green test | **Copy `/etc/letsencrypt`**, HTTP-01 after cutover |
| mixed / unsure | DNS-01 — it's the one that makes pre-cutover testing clean |

### F. Out-of-scope reminders to raise with me if the inventory hits them
- Mail/MX on the old box (tunnel is 80/443 only).
- Any non-HTTP service (SSH-to-services, game/db ports, etc.) — can be added as extra `port-forward` rules **only if** they don't need to hide the origin behind TLS the way the web does.
- Real client IPs in origin logs → needs PROXY protocol (a later enhancement, not required for cutover).

### G. Executable runbook (copy-paste per phase)
> Run from the laptop (it has SSH to all three boxes). **Adapt the variables.** Every command against **OLD is read-only** (probes, `rsync` pulls, `mysqldump`/`pg_dump` only read) — nothing here writes to or deletes from OLD. Stop at each 🛑 as in the main flow.

**G0 — set variables (edit these):**
```bash
export OLD_IP=...        EDGE_IP=...      ORIGIN_IP=...     MY_IP=...
export SUBNET=main       ORIGIN_TUNNEL_IP=10.0.0.2          # confirm subnet name + IP against `start-tunnel subnet`/web UI
cd <your working dir>/   # the one containing ./migration/
```

**G1 — inventory (READ-ONLY on OLD) → fills `migration/inventory.md`:**
```bash
ssh root@$OLD_IP '
  echo "## OS"; sed -n "1,2p" /etc/os-release; uname -a
  echo "## web server"; nginx -v 2>&1; apache2 -v 2>&1; caddy version 2>&1
  echo "## nginx vhosts"; ls -1 /etc/nginx/sites-enabled/ 2>/dev/null; grep -rEh "server_name|root " /etc/nginx/sites-enabled/ 2>/dev/null
  echo "## apache vhosts"; ls -1 /etc/apache2/sites-enabled/ 2>/dev/null; grep -rEh "ServerName|ServerAlias|DocumentRoot" /etc/apache2/sites-enabled/ 2>/dev/null
  echo "## php"; php -v 2>/dev/null | head -1; php -m 2>/dev/null | tr "\n" " "; echo
  echo "## node"; node -v 2>/dev/null; echo "## python"; python3 -V 2>/dev/null
  echo "## listening ports"; ss -tulpn 2>/dev/null
  echo "## mysql dbs+sizes"; mysql -e "SELECT table_schema, ROUND(SUM(data_length+index_length)/1048576,1) AS MB FROM information_schema.tables GROUP BY table_schema;" 2>/dev/null
  echo "## postgres dbs"; sudo -u postgres psql -lc "\l+" 2>/dev/null
  echo "## crontabs"; for u in $(cut -d: -f1 /etc/passwd); do c=$(crontab -l -u "$u" 2>/dev/null); [ -n "$c" ] && { echo "# $u"; echo "$c"; }; done
  echo "## running services"; systemctl list-units --type=service --state=running --no-pager
  echo "## certs"; ls -1 /etc/letsencrypt/live 2>/dev/null; certbot certificates 2>/dev/null
' | tee migration/inventory.raw.txt
# transcribe migration/inventory.raw.txt into the structured migration/inventory.md, then 🛑 GATE A
```

**G2 — safety backup (read-only pulls) → `migration/backup/`:**
```bash
mkdir -p migration/backup/{docroots,configs,db,crontabs}
rsync -az root@$OLD_IP:/var/www/        migration/backup/docroots/        # adjust if docroots live elsewhere
rsync -az root@$OLD_IP:/etc/nginx/      migration/backup/configs/nginx/   2>/dev/null
rsync -az root@$OLD_IP:/etc/apache2/    migration/backup/configs/apache2/ 2>/dev/null
rsync -az root@$OLD_IP:/etc/letsencrypt/ migration/backup/letsencrypt/    # also needed for the copy-cert option
ssh root@$OLD_IP 'for u in $(cut -d: -f1 /etc/passwd); do crontab -l -u "$u" 2>/dev/null > "/tmp/cron.$u"; done; cd /tmp && tar czf - cron.* 2>/dev/null' > migration/backup/crontabs/crontabs.tgz
for DB in db1 db2; do   # ← put real DB names from G1
  ssh root@$OLD_IP "mysqldump --single-transaction --routines --triggers '$DB'" | gzip > "migration/backup/db/$DB.sql.gz"
done
# postgres equivalent: ssh root@$OLD_IP "sudo -u postgres pg_dump -Fc '$DB'" > migration/backup/db/$DB.dump
( cd migration/backup && find . -type f ! -name CHECKSUMS -exec sha256sum {} \; > CHECKSUMS )   # 🛑 confirm sizes/counts
```

**G3 — EDGE: install StartTunnel (Debian 13, dedicated IPv4, UDP 51820 reachable):**
```bash
ssh root@$EDGE_IP 'curl -sSL https://start9.com/start-tunnel/install.sh | sh'
ssh -t root@$EDGE_IP 'start-tunnel web init'    # interactive — save URL/password/Root CA into migration/start-tunnel-access.md
```

**G4 — ORIGIN: join tunnel + Caddy:**
```bash
# create the origin device on the EDGE and pull its config
ssh root@$EDGE_IP "start-tunnel device add $SUBNET origin $ORIGIN_TUNNEL_IP" 2>/dev/null || true
ssh root@$EDGE_IP "start-tunnel device show-config $SUBNET $ORIGIN_TUNNEL_IP" > migration/configs/wg0.conf
# edit migration/configs/wg0.conf: add 'PersistentKeepalive = 25', set AllowedIPs per the return-path note (Appendix B)
scp migration/configs/wg0.conf root@$ORIGIN_IP:/etc/wireguard/wg0.conf
ssh root@$ORIGIN_IP 'apt-get update && apt-get install -y wireguard caddy && wg-quick up wg0 && systemctl enable wg-quick@wg0 && wg show'
ping -c2 $ORIGIN_TUNNEL_IP   # from edge: ssh root@$EDGE_IP "ping -c2 $ORIGIN_TUNNEL_IP"  — confirm both directions
# (DNS-01 path) build Caddy with Njalla, set token, deploy Caddyfile:
ssh root@$ORIGIN_IP 'apt-get install -y golang-go && go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest && ~/go/bin/xcaddy build --with github.com/caddy-dns/njalla --output /usr/bin/caddy'
scp migration/configs/Caddyfile root@$ORIGIN_IP:/etc/caddy/Caddyfile
ssh root@$ORIGIN_IP 'systemctl edit caddy'   # add: [Service]\nEnvironment=NJALLA_API_TOKEN=...   then: systemctl restart caddy
# restore docroots/DBs/app creds; apply migration/configs/nftables.conf
```

**G5 — EDGE: forward ports (raw, no edge redirect):**
```bash
ssh root@$EDGE_IP "start-tunnel port-forward add 80  $ORIGIN_TUNNEL_IP:80  --label web-http"
ssh root@$EDGE_IP "start-tunnel port-forward add 443 $ORIGIN_TUNNEL_IP:443 --label web-https"
```

**G6 — TEST (no DNS change) → fills `migration/test-results.md`, then 🛑 GATE B:**
```bash
for d in example.com www.example.com; do   # ← real domains
  echo "== $d =="
  curl -sSI --resolve "$d:443:$EDGE_IP" "https://$d/" | head -1
  curl -sSI --resolve "$d:80:$EDGE_IP"  "http://$d/"  | grep -i '^location' 
  echo | openssl s_client -connect "$EDGE_IP:443" -servername "$d" 2>/dev/null | openssl x509 -noout -issuer -subject -dates
done
# a HANG (not an error) ⇒ WireGuard return-path, not Caddy (Appendix B)
```

**G7 — CUTOVER (after Gate B approval):** output A records (`<domain> A <EDGE_IP>`, TTL 300) for me to apply at Njalla, then:
```bash
for d in example.com www.example.com; do dig +short "$d" @1.1.1.1; done   # watch propagation, then re-run G6 against live DNS
```
> Note: this sandbox couldn't run any of the above — TCP egress (22/443) is blocked here. These are written for CC/laptop execution.
