# CC Brief — Bond MVP: 2-of-3 Multisig Custody (the shippable cryptographic bond)

**Status:** ready for CC. The near-term, cryptographically-honest bond — **standard crypto, no Fedimint
module, no federation.** Replaces the broken SSS-of-bearer-notes custody (see
`chama-bond-cryptographic-custody-decision.md` §9). Leave uncommitted. **Signet first; real sats only
supervised, behind the live-attack gate.** Scope = the **BOND only** (trades stay on the ecash frontier
track).

---

## Goal

Make the bond a **2-of-3 Bitcoin multisig over [owner, custodianA, custodianB]**, so the owner
**cryptographically cannot reclaim alone.** Owner is 1-of-3 → owner-alone can't spend → the strand
finally has teeth, enforced by Bitcoin consensus itself, not by hoping the owner discarded notes.

---

## ⭐ LOCKED — decisions + sharpened spec (2026-06-30)

*Authoritative; supersedes the exploratory body below where they differ.*

**Four forks, settled (verifier-recommended, Jetty-confirmed):**
1. **No owner recovery leaf.** Owner can NEVER self-return — no timeout escape hatch. The strand stays
   permanent (its whole deterrent). Custodian-loss resilience lives in **cabinet size**, not an owner
   path. *Irreversible per funded bond — locked to absolute.*
2. **Owner IS a signer:** 2-of-3 `[owner, custA, custB]`. Return = owner + 1 custodian; robust to a lost
   owner key (custA+custB can still return **to the owner**); mirrors the SSS share-0 design.
3. **The 2-custodian-collusion residual: accepted + documented for the MVP.** Same §11.1 residual the SSS
   had — now **on-chain visible** (strictly more detectable). Cryptographic closure (nested "owner AND a
   custodian" / FROST / covenant / the Fedimint module) is a later layer. The live-attack matrix MUST
   prove the residual exists, on the record.
4. **Mutinynet** for the live-attack harness (30s blocks, Fedimint-ecosystem standard, independent public
   validators).

**Sharpened spec (CC research-decided):**
- **Address: Taproot script-path `p2tr_ms`** — BIP342 `OP_CHECKSIGADD`, NUMS internal key. **Mandatory,
  not "or P2WSH":** `SIGHASH_DEFAULT` structurally closes the BIP-143 fee-lie attack P2WSH leaves open;
  generic m-of-n is one native leaf; clean FROST key-path upgrade later. Build the descriptor
  **generically (m/n params)** — 3-of-5 = a config value.
- **Library: `@scure/btc-signer`** — same noble/scure family Chama already pulls via nostr-tools. No
  second crypto stack, pure-TS, browser-native. (NOT bitcoinjs-lib — drags in WASM.)
- **Attestation: new Nostr kind 38132** — a cabinet npub signs a binding to its BTC pubkey, **plus a
  Schnorr cross-sig from the BTC key** (proves possession, not just claim). Replaceable / term-gated like
  the bond declarations. BTC key **BIP86-derived from the existing seed.** Plan rotation/revocation now.
- **Keys = an attested, npub-bound ORDERED LIST** — **NOT** the buyer/seller/arbiter role map. **Do not
  reuse `holder-shares.ts`.**

**⭐ The custodian PSBT checklist (the multisig is theater without this).** Before a custodian co-signs,
its client MUST verify — refuse on ANY failure:
- exactly the **bond UTXO** as input (nothing else);
- **output goes ONLY to the owner's address recorded at CREATE** — *recomputed locally, never read from
  the PSBT*;
- **no extra outputs**;
- **sane, bounded fee**;
- **`SIGHASH_DEFAULT` only** — reject any `ANYONECANPAY` / `SINGLE` / `NONE` (those are blank checks).

This is where blind-cosign self-reclaim gets stopped. "Verify before co-sign" is a hard rule, not a nicety.

**⭐ The full live-attack matrix (signet — prove the guarantee AND document the residual honestly):**

| Attempt | Expected | Proves |
|---|---|---|
| owner-alone → any address | **REJECTED** by consensus | ⭐ owner can't self-return (the headline) |
| owner + 1 custodian → owner's address | ACCEPTED | the return works |
| both custodians, no owner → owner's address | ACCEPTED | cabinet can restore if owner is offline |
| ⚠️ both custodians → a THIRD address | ACCEPTED (on-chain visible) | the §11.1 residual — deterred + visible, NOT cryptographically blocked |
| strand (no co-sign) | UTXO sits, owner can't move it | the strand holds |
| restore (late co-sign) | ACCEPTED | reversibility |

---

## The construction

- **Custody:** a **2-of-3 multisig** — Taproot script-path 2-of-3 (preferred: cheaper, more private) or
  P2WSH `OP_CHECKMULTISIG` 2-of-3 (simplest to start). Over three keys: owner, custA, custB.
- **Keys (the keystone):** each cabinet member holds a **dedicated bond-signing Bitcoin key, attested to
  their npub** via a signed Nostr event (`bond-signing key for cabinet = <pubkey>`). The multisig is
  built from the three attested keys; the keystone verifies all three are attested by the real cabinet
  npubs (reuse the cabinet-roster identity check). **Do NOT reuse the raw Nostr key as the Bitcoin
  spending key** — separate, attested keys.
- **Term:** a `CLTV`/`CSV` timelock branch — optional for the MVP (can start as a social/UI term), added
  on-chain when the §11.5 inactivity self-return lands.

---

## The funding rail (where the Boltz idea fits — it's the on-ramp, NOT the lock)

The owner's sats live as Fedimint **ecash**; the multisig is **on-chain**. Funding = move ecash → into
the multisig address. The rail is interchangeable logistics; **the security is the multisig.** Options:
1. **Boltz reverse submarine swap** — ecash → LN (Fedimint LN gateway) → Boltz → on-chain to the
   multisig address. Non-custodial, atomic. (Jetty's idea — the ecash→on-chain bridge.)
2. **Fedimint peg-out** — if the fed supports on-chain peg-out to an arbitrary address, ecash → on-chain
   directly.
3. **On-chain sats** — owner funds directly if they already hold on-chain BTC.
**LOCK** = the funding tx confirms into the 2-of-3.

---

## Lifecycle (maps onto the existing engine — the custody mechanic is all that changes)

- **CREATE** — record owner + custodians (attested keys) + amount + term + the multisig descriptor.
- **LOCK** — owner funds the multisig address (the rail). Locked when the funding tx confirms.
- **Return** — a custodian co-signs a PSBT spending the multisig → owner's address. owner + 1 custodian =
  2-of-3 → valid → returned. PSBT coordinated over Nostr.
- **Strand** — custodians don't co-sign → owner alone can't reach 2-of-3 → sats sit in the multisig,
  reachable by no one. The cryptographic strand.
- **Restore** — a custodian co-signs **at any later time** → return. Restorative reversibility = a co-sign.
- **Attestation (§11.8)** — the victim "made-whole" Nostr event informs the cabinet's decision to
  co-sign the return. Same seam, unchanged.

---

## Nostr coordination

The multisig descriptor + the PSBTs flow over Nostr (Chama's existing relay layer). A return: owner
builds the spend PSBT → publishes it (encrypted) to a custodian → custodian adds their partial signature
→ owner finalizes + broadcasts. The keystone verifies the signing keys are the attested cabinet keys.

---

## The live-attack gate (the verification that matters)

On **signet**: build a 2-of-3 (you + two test keys), fund it, then **try to spend it owner-alone** —
construct a spend carrying only the owner's signature and broadcast it. **It MUST fail** — the network
rejects a 1-of-3 spend on a 2-of-3 output. That is cryptographic no-self-return, proven by Bitcoin
consensus, not by our code. Then confirm: return (owner + 1 custodian) succeeds; strand (no co-sign)
leaves it stuck; restore (late co-sign) succeeds.

---

## Boundaries

- **Bond only.** Trades stay on the ecash escrow; their cryptographic fix is the Resolvr/ecash frontier
  (on-chain multisig is too costly per trade).
- **No Fedimint module, no federation, no FROST.** Plain 2-of-3 multisig. (FROST/Resolvr = the frontier
  upgrade, separate track.)
- On-chain custody (a UTXO; fund/return are on-chain txs with fees) — acceptable for an occasional,
  long-lived, value-significant bond.
- Signet first; real tiny sats only supervised, the live-attack as the gate.

---

## Build steps

1. **Multisig**: descriptor + address from the three attested keys (2-of-3 Taproot-script or P2WSH).
2. **Attested-key primitive**: a cabinet member's bond-signing key + the Nostr attestation event + the
   keystone check (keys ∈ cabinet).
3. **Funding rail**: Boltz reverse-swap integration (ecash → LN → on-chain to the multisig), or Fedimint
   peg-out if available.
4. **PSBT + Nostr coordination**: spend PSBT → custodian co-sign → finalize → broadcast.
5. **Wire the lifecycle** onto the engine's bond category; reuse the keystone, restorative, attestation.
6. **Signet test + the live-attack gate.**

---

## Engine reuse

The §0–§7 bond accountability model survives intact. The only swap: **"deliver an SSS share via
vote-envelope" → "co-sign a 2-of-3 PSBT."** The keystone now verifies attested Bitcoin keys (alongside
npubs). The bond category, term, restorative reversibility, attestation seam, public record — all map
straight over.
