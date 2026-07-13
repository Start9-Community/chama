// ══════════════════════════════════════════════════════════════════════════
// Chama — Bond custody: Bitcoin Taproot m-of-n multisig
// ══════════════════════════════════════════════════════════════════════════
//
// The cryptographic custody primitive for the arbiter bond (replaces the broken
// Shamir-of-bearer-ecash lock, where the funder held the whole secret). The bond
// funds sit at a Taproot script-path address whose ONLY spend path is an m-of-n
// (default 2-of-3 over [owner, custodianA, custodianB]). The owner is ONE key —
// so Bitcoin consensus itself, not our code, enforces that the owner alone cannot
// move the bond. No covert self-return: every spend is an on-chain transaction.
//
// Design (decided 2026-06-30, chama-bond-mvp-multisig-brief.md):
//   • Taproot script-path `p2tr_ms` (BIP342 OP_CHECKSIGADD), NUMS internal key →
//     the internal key is provably unspendable, so the threshold leaf is the ONLY
//     way to spend. SIGHASH_DEFAULT commits to all input amounts (closes the
//     BIP-143 fee-lie CVE-2020-14199 that P2WSH leaves open).
//   • m-of-n parameterized from day 1 (3-of-5 is config, not a rewrite); MVP
//     exposes 2-of-3. The keys are an ORDERED, attestation-bound list — NOT the
//     buyer/seller/arbiter role map (do not reuse holder-shares.ts here).
//   • NO owner-recovery timelock leaf (decided: absolute "owner never alone";
//     custodian-loss resilience comes from cabinet size, not an owner path).
//
// ⭐ The real security layer is verifyReturnPsbt() — the custodian checklist. A
// custodian must NEVER blind-co-sign: the multisig math is theater if a malicious
// owner can get a custodian to rubber-stamp a spend to the owner's own fresh
// address. Every check below defeats that.
//
// This module is pure over @scure/btc-signer (same noble/scure crypto family
// Chama already uses via nostr-tools). No relays, no Nostr — the coordination
// layer (descriptor + PSBTs over NIP-44) sits above this.

import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";

/** BIP341 NUMS "nothing up my sleeve" point — a provably-unspendable Taproot
 *  internal key (no known discrete log), so the ONLY spend path is the script
 *  leaf (the m-of-n threshold). Standard, well-known constant. */
export const NUMS_INTERNAL_KEY = hexToBytes(
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
);

export type BtcNetwork = typeof btc.NETWORK;
export const SIGNET: BtcNetwork = btc.TEST_NETWORK; // signet/testnet share the tb1 HRP
export const MAINNET: BtcNetwork = btc.NETWORK; // real Bitcoin (bc1 HRP) — the live bond network as of v5.0

/** A built bond multisig: the address the funds live at + everything needed to
 *  recompute it and to spend it (the Taproot script-path metadata). */
export interface BondMultisig {
  m: number;
  n: number;
  /** Ordered 32-byte x-only pubkeys (BIP340), attestation-bound to cabinet npubs. */
  xonlyKeys: Uint8Array[];
  address: string;
  /** The output scriptPubKey (for UTXO / checklist matching). */
  script: Uint8Array;
}

function assertKeys(m: number, n: number, xonlyKeys: Uint8Array[]): void {
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || n < m || n < 2) {
    throw new Error(`Bad multisig threshold: ${m}-of-${n}`);
  }
  if (xonlyKeys.length !== n) {
    throw new Error(`Expected ${n} keys, got ${xonlyKeys.length}`);
  }
  for (const k of xonlyKeys) {
    if (!(k instanceof Uint8Array) || k.length !== 32) {
      throw new Error("Each multisig key must be a 32-byte x-only pubkey");
    }
  }
  // Distinct keys — a repeated key would let one holder count twice toward m.
  const seen = new Set(xonlyKeys.map(bytesToHex));
  if (seen.size !== n) throw new Error("Multisig keys must be distinct");
}

function p2trFor(m: number, xonlyKeys: Uint8Array[], network: BtcNetwork) {
  // Single-leaf k-of-n via OP_CHECKSIGADD (avoids the p2tr_ns leaf explosion).
  // @scure/btc-signer types p2tr_ms as a leaf (P2TR_MS); p2tr accepts it as the
  // single-leaf script tree at runtime (validated), but the tree-param type is
  // narrower — cast to the exact param type rather than `any`.
  const leaf = btc.p2tr_ms(m, xonlyKeys) as unknown as Parameters<typeof btc.p2tr>[1];
  return btc.p2tr(NUMS_INTERNAL_KEY, leaf, network);
}

/** Build the bond multisig address from the ordered attested keys + threshold. */
export function buildBondMultisig(
  m: number,
  n: number,
  xonlyKeys: Uint8Array[],
  network: BtcNetwork = SIGNET,
): BondMultisig {
  assertKeys(m, n, xonlyKeys);
  const p = p2trFor(m, xonlyKeys, network);
  return { m, n, xonlyKeys, address: p.address!, script: p.script };
}

/** Recompute the address from (m, n, keys) — the funder/custodian must ALWAYS
 *  do this locally and never trust an address received over the wire (a tampered
 *  descriptor would otherwise make the owner fund an attacker's address; the
 *  peg-out is irreversible). */
export function recomputeAddress(
  m: number,
  n: number,
  xonlyKeys: Uint8Array[],
  network: BtcNetwork = SIGNET,
): string {
  return buildBondMultisig(m, n, xonlyKeys, network).address;
}

export interface BondUtxo {
  txid: string; // hex
  index: number;
  amountSats: bigint;
}

/** Build the RETURN spend PSBT: spend the single bond UTXO to the owner's return
 *  address, paying `feeSats`. The owner builds this; custodians co-sign it. The
 *  destination is fixed to the owner here, and the custodian re-verifies it
 *  (verifyReturnPsbt) — a return can only ever go to the owner. */
export function buildReturnPsbt(params: {
  bond: BondMultisig;
  utxo: BondUtxo;
  ownerReturnAddress: string;
  feeSats: bigint;
  network?: BtcNetwork;
}): string {
  const network = params.network ?? SIGNET;
  const { bond, utxo, ownerReturnAddress, feeSats } = params;
  if (feeSats < 0n || feeSats >= utxo.amountSats) throw new Error("Bad fee");
  const spend = p2trFor(bond.m, bond.xonlyKeys, network);
  const tx = new btc.Transaction();
  tx.addInput({
    txid: hexToBytes(utxo.txid),
    index: utxo.index,
    witnessUtxo: { script: spend.script, amount: utxo.amountSats },
    ...spend, // tapInternalKey, tapMerkleRoot, tapLeafScript
  });
  tx.addOutputAddress(ownerReturnAddress, utxo.amountSats - feeSats, network);
  return base64.encode(tx.toPSBT());
}

/** Co-sign a return PSBT with one key (a custodian, or the owner). Preserves any
 *  partial signatures already present, so signers can sign sequentially over
 *  Nostr in any order. Returns the updated PSBT (base64). */
export function coSignPsbt(psbtB64: string, privKey: Uint8Array, network: BtcNetwork = SIGNET): string {
  void network;
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  tx.signIdx(privKey, 0);
  return base64.encode(tx.toPSBT());
}

/** Combine partial-signature PSBTs and finalize into a broadcastable raw tx hex.
 *  THROWS if fewer than m signatures are present (the threshold is enforced here
 *  AND, on broadcast, by Bitcoin consensus). This is the code-path equivalent of
 *  the live-attack's "owner alone is rejected". */
export function combineAndFinalize(psbtsB64: string[], network: BtcNetwork = SIGNET): string {
  void network;
  if (psbtsB64.length === 0) throw new Error("No PSBTs to combine");
  const combined = btc.PSBTCombine(psbtsB64.map((p) => base64.decode(p)));
  const tx = btc.Transaction.fromPSBT(combined);
  tx.finalize(); // throws "empty witness" if below threshold
  return bytesToHex(tx.extract());
}

// ── ⭐ The custodian verification checklist (the real security layer) ─────────

export interface ReturnPsbtExpectation {
  bond: BondMultisig;
  utxo: BondUtxo;
  /** The owner's canonical return address, recomputed locally at CREATE — NEVER
   *  read from the PSBT. A return can only go here. */
  ownerReturnAddress: string;
  /** Reject if the fee exceeds this (grief/siphon guard). */
  maxFeeSats: bigint;
  network?: BtcNetwork;
}

export interface ReturnPsbtCheck {
  ok: boolean;
  failures: string[];
}

/** ⭐ Verify a return PSBT before co-signing. A custodian MUST refuse to sign
 *  unless this returns ok. These checks — not the multisig math — are what stop a
 *  malicious owner from getting a custodian to rubber-stamp a spend to the owner's
 *  own fresh address (or to inflate the fee / smuggle an extra output / use a
 *  blank-check sighash). Everything is verified against locally-known values, not
 *  values read out of the PSBT. */
export function verifyReturnPsbt(psbtB64: string, expect: ReturnPsbtExpectation): ReturnPsbtCheck {
  const network = expect.network ?? SIGNET;
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  } catch (e) {
    return { ok: false, failures: [`unparseable PSBT: ${(e as Error).message}`] };
  }

  // ── Input / UTXO ──
  if (tx.inputsLength !== 1) fail(`expected exactly 1 input, got ${tx.inputsLength}`);
  const inp = tx.inputsLength > 0 ? tx.getInput(0) : undefined;
  if (inp) {
    const inTxid = inp.txid ? bytesToHex(inp.txid) : "";
    if (inTxid !== expect.utxo.txid || inp.index !== expect.utxo.index) {
      fail(`input is not the bond UTXO (${inTxid}:${inp.index})`);
    }
    // Amount verified independently against the known bond value.
    if (inp.witnessUtxo?.amount !== expect.utxo.amountSats) {
      fail(`input amount ${inp.witnessUtxo?.amount} != bond value ${expect.utxo.amountSats}`);
    }
    // Input scriptPubKey must be the bond's — recomputed locally, not trusted.
    if (!inp.witnessUtxo?.script || bytesToHex(inp.witnessUtxo.script) !== bytesToHex(expect.bond.script)) {
      fail("input scriptPubKey is not the bond multisig");
    }
    // Sighash: DEFAULT only. Reject SINGLE/NONE/ANYONECANPAY — those are blank
    // checks that let the owner add/reorder inputs or outputs after signing.
    if (inp.sighashType !== undefined && inp.sighashType !== 0) {
      fail(`sighashType ${inp.sighashType} — only SIGHASH_DEFAULT (0) is allowed`);
    }
  }

  // ── Output / destination ──
  if (tx.outputsLength !== 1) fail(`expected exactly 1 output (owner return), got ${tx.outputsLength}`);
  let outSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    outSum += out.amount ?? 0n;
    let outAddr = "";
    try {
      outAddr = btc.Address(network).encode(btc.OutScript.decode(out.script!));
    } catch {
      outAddr = "(undecodable)";
    }
    // Recomputed owner address — NOT read from the PSBT. This is the check that
    // kills blind-cosign self-reclaim to the owner's own secret address.
    if (outAddr !== expect.ownerReturnAddress) {
      fail(`output ${i} pays ${outAddr}, not the owner return address`);
    }
  }

  // ── Fee ──
  if (inp?.witnessUtxo?.amount !== undefined) {
    const fee = inp.witnessUtxo.amount - outSum;
    if (fee < 0n) fail("outputs exceed input (negative fee)");
    else if (fee > expect.maxFeeSats) fail(`fee ${fee} exceeds max ${expect.maxFeeSats} (grief/siphon)`);
  }

  return { ok: failures.length === 0, failures };
}
