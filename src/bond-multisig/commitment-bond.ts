// ══════════════════════════════════════════════════════════════════════════
// Chama — arbiter bond: single-key TIMELOCK COMMITMENT (the sealed v1 model)
// ══════════════════════════════════════════════════════════════════════════
//
// The bond is NOT slashable collateral held by a cabinet — it is a public,
// on-chain COMMITMENT. An arbiter locks THEIR OWN sats to THEIR OWN key until a
// term-end block height T. One Taproot leaf, one signer:
//
//     <T> OP_CHECKLOCKTIMEVERIFY OP_DROP <ownerXonly> OP_CHECKSIG
//
// ⭐ Collusion-IMPOSSIBLE by construction: there is no shared custody, no 2-of-3,
// nobody but the owner ever holds a key. Nothing to collude over. Before T, the
// coin cannot move at all (consensus rejects an early spend — the CLTV mirror of
// the 2-of-3 harness's owner-alone Row 1). After T, the owner reclaims it, alone.
//
// The deterrent is the COMMITMENT itself: capital locked, illiquid, in the open,
// for the term — "bonded" is not binary, it's how much × how long (PHILOSOPHY
// §2.11, DECISIONS 2026-07-03). The internal key is the BIP341 NUMS point, so the
// key-path is unspendable and every spend MUST go through the timelock leaf.
//
// (This replaces the 2-of-3 cabinet-custody bond, which a skeptic's pass proved
// self-dealing among three founders. Slashing teeth, if ever wanted, come later as
// Tier 2 — an open stranger ceremony — never a standing cabinet. See
// chama-bond-collusion-closure-brief.md.)

import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { SIGNET, type BtcNetwork, type BondUtxo } from "./multisig.js";

/** BIP341 NUMS point — the same unspendable internal key the multisig used. With no
 *  known discrete log, the taproot key-path can never be signed, so a spend can ONLY
 *  satisfy the timelock script leaf. */
const NUMS_INTERNAL_KEY = hexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");

/** Minimum bond term, in blocks. A shorter term can EXPIRE while the owner is still
 *  funding it, leaving a "locked" bond that is already reclaimable — confusing, and
 *  zero commitment signal. Enforced at the ceremony / hook layer (the pure builders
 *  below stay term-agnostic so harnesses can test tiny terms). 144 blocks ≈ 1 day on
 *  mainnet (~10-min blocks) — comfortably longer than the 1-conf funding wait. */
export const MIN_COMMITMENT_TERM_BLOCKS = 144;

/** Reclaim fee rate (sat/vB). Signet's floor is 1 sat/vB; 2 gives margin against
 *  a load-balanced Esplora node with a slightly higher mempool floor. */
export const DEFAULT_RECLAIM_FEE_RATE = 2n;

/** P2TR dust threshold — a reclaim output below this is unrelayable. */
export const P2TR_DUST_SATS = 330n;

export interface CommitmentBond {
  /** 32-byte x-only key the arbiter controls (their bond key). */
  ownerXonly: Uint8Array;
  /** Absolute block height the bond unlocks at (CLTV). */
  lockUntil: number;
  network: BtcNetwork;
  /** The bech32m address to fund. */
  address: string;
  /** The scriptPubKey (for funding-tx verification). */
  script: Uint8Array;
}

/** The single timelock leaf: `<T> CHECKLOCKTIMEVERIFY DROP <ownerXonly> CHECKSIG`. */
export function buildTimelockLeaf(ownerXonly: Uint8Array, lockUntil: number): Uint8Array {
  if (!Number.isInteger(lockUntil) || lockUntil <= 0 || lockUntil >= 500_000_000) {
    // < 500,000,000 keeps the CLTV value in the BLOCK-HEIGHT domain (BIP65), never
    // the unix-timestamp domain — the tx nLockTime must match this domain to spend.
    throw new Error("lockUntil must be a positive block height below 500000000");
  }
  if (ownerXonly.length !== 32) throw new Error("ownerXonly must be a 32-byte x-only key");
  return btc.Script.encode([
    btc.ScriptNum().encode(BigInt(lockUntil)),
    "CHECKLOCKTIMEVERIFY",
    "DROP",
    ownerXonly,
    "CHECKSIG",
  ]);
}

/** p2tr(NUMS, single timelock leaf). allowUnknownOutputs=true because @scure has no
 *  built-in coder for a CLTV leaf — the address + control block are still computed
 *  correctly (BIP341 is script-agnostic); we finalize the witness by hand. */
function p2trFor(ownerXonly: Uint8Array, lockUntil: number, network: BtcNetwork) {
  const leaf = buildTimelockLeaf(ownerXonly, lockUntil);
  return btc.p2tr(NUMS_INTERNAL_KEY, { script: leaf } as never, network, true);
}

/** Build the commitment bond: the arbiter's own sats, timelocked to their own key
 *  until `lockUntil`. One leaf, one signer — collusion-impossible by construction. */
export function buildCommitmentBond(
  ownerXonly: Uint8Array,
  lockUntil: number,
  network: BtcNetwork = SIGNET,
): CommitmentBond {
  const p = p2trFor(ownerXonly, lockUntil, network);
  return { ownerXonly, lockUntil, network, address: p.address!, script: p.script };
}

/** Recompute the bond address locally from (ownerXonly, lockUntil) — verify-don't-
 *  trust the wire; the funder/verifier must never trust an address off any wire. */
export function recomputeCommitmentAddress(
  ownerXonly: Uint8Array,
  lockUntil: number,
  network: BtcNetwork = SIGNET,
): string {
  return buildCommitmentBond(ownerXonly, lockUntil, network).address;
}

/** EXACT vsize of a reclaim sweeping `numInputs` bond UTXOs to one P2TR output.
 *  Computable without signing because a BIP340 sig is always 64 bytes (SIGHASH_DEFAULT
 *  appends no sighash byte) and every input spends the same known leaf. Unit-verified
 *  byte-exact against a real built tx (5b-BONDCLTV). */
export function estimateReclaimVsize(bond: Pick<CommitmentBond, "ownerXonly" | "lockUntil">, numInputs: number): number {
  if (!Number.isInteger(numInputs) || numInputs <= 0) throw new Error("numInputs must be a positive integer");
  const leafLen = buildTimelockLeaf(bond.ownerXonly, bond.lockUntil).length;
  const varint = (n: number) => (n < 253 ? 1 : 3);
  // base: version(4) + vin count + n*(outpoint 36 + empty script 1 + sequence 4)
  //       + vout count(1) + one P2TR output(8 + 1 + 34) + locktime(4)
  const base = 4 + varint(numInputs) + numInputs * 41 + 1 + 43 + 4;
  // witness: per input — stack count(1) + sig(1+64) + leaf(1+len) + control block(1+33)
  const witness = numInputs * (101 + leafLen);
  // BIP141: weight = 4·base + (marker+flag 2) + witness bytes
  return Math.ceil((base * 4 + 2 + witness) / 4);
}

/** Size-based reclaim fee: vsize × feeRate, floored at 300 sats (the old flat fee —
 *  keeps single-input reclaims paying what they always did). The flat 300n underpaid
 *  a ≥4-input sweep below 1 sat/vB (unrelayable); this scales with the sweep. */
export function estimateReclaimFeeSats(
  bond: Pick<CommitmentBond, "ownerXonly" | "lockUntil">,
  numInputs: number,
  feeRatePerVb: bigint = DEFAULT_RECLAIM_FEE_RATE,
): bigint {
  if (feeRatePerVb <= 0n) throw new Error("feeRatePerVb must be positive");
  const sized = BigInt(estimateReclaimVsize(bond, numInputs)) * feeRatePerVb;
  return sized > 300n ? sized : 300n;
}

/** Build + owner-sign the reclaim spend of the bond UTXO → `destination`, paying
 *  `feeSats`. It's the owner's own money after T, so the destination is their free
 *  choice. `txLockTime` defaults to the bond's `lockUntil` (the valid reclaim, which
 *  a node accepts only once the chain height has reached T); passing a value BELOW
 *  `lockUntil` builds the consensus-invalid EARLY spend the network rejects on the
 *  CLTV opcode — the ⭐ "before T → REJECTED" mirror of the multisig owner-alone row.
 *  @scure can't finalize a custom leaf, so the witness `[sig, leaf, controlBlock]`
 *  is assembled by hand (exactly as the harness forged the owner-alone witness).
 *  Returns broadcastable raw tx hex. */
export function buildReclaimTx(params: {
  bond: CommitmentBond;
  /** ALL the UTXOs sitting at the bond address — the reclaim SWEEPS them (a user may
   *  fund the address in several sends; every one is their committed stake). */
  utxos: BondUtxo[];
  ownerPriv: Uint8Array;
  destination: string;
  feeSats: bigint;
  txLockTime?: number;
  network?: BtcNetwork;
}): string {
  const network = params.network ?? params.bond.network;
  const { bond, utxos, ownerPriv, destination, feeSats } = params;
  if (utxos.length === 0) throw new Error("No UTXOs to reclaim");
  const total = utxos.reduce((s, u) => s + u.amountSats, 0n);
  if (feeSats < 0n || feeSats >= total) throw new Error("Bad fee");
  if (total - feeSats < P2TR_DUST_SATS) {
    throw new Error(`Reclaim output would be dust (${(total - feeSats).toString()} sats < ${P2TR_DUST_SATS.toString()}) — unrelayable`);
  }
  const lockTime = params.txLockTime ?? bond.lockUntil;
  if (!Number.isInteger(lockTime) || lockTime < 0) throw new Error("Bad txLockTime");
  const p = p2trFor(bond.ownerXonly, bond.lockUntil, network);
  const leaf = buildTimelockLeaf(bond.ownerXonly, bond.lockUntil);
  const controlBlock = (p as unknown as { leaves: { controlBlock: Uint8Array }[] }).leaves[0].controlBlock;

  const tx = new btc.Transaction({ allowUnknownOutputs: true, lockTime });
  for (const utxo of utxos) {
    tx.addInput({
      txid: hexToBytes(utxo.txid),
      index: utxo.index,
      witnessUtxo: { script: p.script, amount: utxo.amountSats },
      sequence: 0xfffffffe, // < 0xffffffff so nLockTime (and thus CLTV) is enforced
      ...p, // tapInternalKey, tapMerkleRoot, tapLeafScript
    });
  }
  tx.addOutputAddress(destination, total - feeSats, network);
  // Sign + hand-assemble each input's witness (every input shares the one leaf).
  for (let i = 0; i < utxos.length; i++) tx.signIdx(ownerPriv, i);
  for (let i = 0; i < utxos.length; i++) {
    const sig = tx.getInput(i).tapScriptSig![0][1];
    tx.updateInput(i, { finalScriptWitness: [sig, leaf, controlBlock] });
  }
  return bytesToHex(tx.extract());
}

// ── BIP86 derivation of the owner's bond key from the existing BIP-39 seed ────
// (Moved here from the retired 2-of-3 attestation module — the commitment bond is
// its only remaining consumer.)

/** BIP86 single-sig Taproot path. coin = 1 for signet/testnet, 0 for mainnet.
 *  A dedicated namespace, separate from the raw Nostr key and from Fedimint's own
 *  derivation — the bond key signs ONLY bond reclaims. `index` (the address index)
 *  gives each bond its OWN key → its own address, so two bonds NEVER share an
 *  address (even at the same term): no commingled UTXOs, better privacy. The
 *  ceremony picks a fresh index per bond and persists it for reclaim. */
export function bip86BondPath(network: BtcNetwork = SIGNET, account = 0, index = 0): string {
  const coin = network === SIGNET ? 1 : 0;
  return `m/86'/${coin}'/${Math.floor(account)}'/0/${Math.floor(index)}`;
}

/** Derive the bond key (private + x-only public) from the 12/24-word BIP-39
 *  mnemonic Chama already manages (seed-manager.ts). The private key never leaves
 *  the client and is never stored — re-derived at reclaim time from (seed, index). */
export function deriveBondSigningKey(
  mnemonic: string,
  opts?: { network?: BtcNetwork; account?: number; index?: number; passphrase?: string },
): { priv: Uint8Array; xonly: Uint8Array; path: string } {
  const network = opts?.network ?? SIGNET;
  const path = bip86BondPath(network, opts?.account ?? 0, opts?.index ?? 0);
  const seed = mnemonicToSeedSync(mnemonic.trim(), opts?.passphrase ?? "");
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) throw new Error("BIP86 derivation produced no private key");
  const priv = node.privateKey;
  return { priv, xonly: btc.utils.pubSchnorr(priv), path };
}
