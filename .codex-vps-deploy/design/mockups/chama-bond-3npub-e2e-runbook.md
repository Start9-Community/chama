# Chama bond — 3-npub live e2e test (post → verify → fund → LOCK)

**Purpose.** Prove the whole bond funding path **through the real app UI**, with **three real
npubs** and **test sats on Mutinynet** (no real value): one arbiter posts a bond, the other two
recompute-and-verify it, someone funds the 2-of-3 on-chain, and the app locks it. This is the
end-to-end companion to the Mutinynet custody matrix (which proved the *spends*) — here we prove the
*app's* post → verify → fund → lock loop.

> Everything here is **DEV-only + test sats**. The enabling seams (`SHOW_BOND_CEREMONY` = dev-only,
> the `__chamaSetTestCabinet` console helper) are statically dead in a production bundle. No real
> sats, no real cabinet touched. Do NOT flip anything to a hard prod value for this.

## Prereqs

- The 3-instance dev setup (fixed ports = stable identities), per `CLAUDE.md`:
  ```
  npm run tauri:sidecar                 # once
  ./scripts/dev-instance.sh 3001 seller
  ./scripts/dev-instance.sh 3002 buyer
  ./scripts/dev-instance.sh 3003 arbiter
  ```
- The Mutinynet faucet: https://faucet.mutinynet.com/
- All three instances share `DEFAULT_RELAYS` (incl. `relay.chama.community`), so descriptors +
  attestations propagate between them automatically.

## Step 1 — collect the three hex pubkeys

In each instance: log in / connect, open the browser dev console, and read:
```
__chamaPubkey        // → this instance's hex pubkey
```
Collect all three (call them H1, H2, H3).

## Step 2 — install the trio as the test cabinet (in ALL three instances)

The ceremony's keystone only accepts cabinet keys; for the test, the trio *is* the cabinet. In
**each** instance's console, run the same line, then reload:
```
__chamaSetTestCabinet(["H1","H2","H3"])   // same array in all 3
location.reload()
```
(It persists in localStorage and re-installs on boot. Clear later with
`__chamaSetTestCabinet(null)`.) After reload, each instance is a seated cabinet member, so **Me →
"Post your bond"** and **Me → "Bonds you hold"** now appear.

## Step 3 — attest each bond key (all three)

In each instance: **Me → Post your bond → "Attest key"** (or the ceremony does it on create). This
publishes each member's kind-38132 bond-key attestation to the relays, which the keystone will fetch
live. All three must attest before a bond can be posted.

## Step 4 — post the bond (instance 1)

Instance 1: **Me → Post your bond →** set a tiny amount (e.g. the 21,000-sat seed default) → **Create
my bond.** The app recomputes the 2-of-3 **Mutinynet address** locally and shows it + a QR. Copy it.

## Step 5 — the other two verify it (recompute-don't-trust)

Instances 2 & 3: **Me → Bonds you hold.** The app discovers the descriptor (#p-tagged to them),
fetches the trio's live 38132 attestations, and **recomputes the 2-of-3 itself**. Confirm each shows
**✅ Verified** with the **same address** instance 1 displayed. (Tamper check, optional: it should
reject anything that doesn't recompute.)

## Step 6 — fund the 2-of-3 on-chain (test sats)

Send the exact bond amount to the copied address from the **Mutinynet faucet** (direct on-chain — no
fed needed). Mutinynet mines ~30s blocks, so it confirms fast.

*Alternative (only if you have a signet fed with the on-chain wallet module):* in the funding screen
tap **"Fund from my Chama balance"** → fee preview → confirm, and the app pegs out the exact amount
to the same address. Same lock result; just a different source of the UTXO.

## Step 7 — lock it (instance 1)

Instance 1, on the funding screen: **"I've sent it — check for the deposit."** The fund-watcher polls
Mutinynet, requires `defaultMinConfs` (2 on signet) for reorg safety, reads the **real** funding
scriptPubKey, and — only if it byte-matches the recomputed bond script — advances **CREATED → LOCKED**.
You should land on the **🔒 "Your bond is locked"** screen with the funding txid.

## What this proves (and what it doesn't yet)

✅ Proven live, app-driven, 3 npubs, test sats: **attest → post → recompute-verify → fund → LOCK**,
with recompute-don't-trust holding from the descriptor all the way to the on-chain deposit.

⏳ Not in this loop yet: the **custodian co-sign-a-RETURN** UI (a funded bond being returned/restored
from inside the app). The lifecycle for it is built + tested + Mutinynet-proven (the six-row matrix),
but there's no app screen yet — that's the next build, and this locked bond is exactly the state it
acts on. So a natural follow-up: wire the return co-sign, then extend this runbook to LOCK → return →
RETURNED.

## Cleanup

In each instance console: `__chamaSetTestCabinet(null)` then reload, to remove the test cabinet.
(Nothing was published that a production client would honor — prod uses the real cabinet and
`BONDS_ENFORCED` is false — but leave dev clean.)
