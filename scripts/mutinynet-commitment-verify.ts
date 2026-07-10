#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────────────────
// Chama bond — ADVERSARIAL Mutinynet verifier for the single-key timelock
// COMMITMENT bond (the independent Part-A pass; the demo-shaped sibling is
// mutinynet-commitment-harness.ts).
//
// Hammers the three invariants against real consensus, using the SHIPPING module
// (src/bond-multisig/commitment-bond.ts) so what the network accepts/rejects is
// exactly what the app produces:
//
//   1. spend BEFORE T → REJECTED           (both shapes: nLockTime<T hits the CLTV
//      opcode; nLockTime=T broadcast while tip<T is non-final)
//   2. spend AFTER  T → ACCEPTED           (a REAL MULTI-INPUT sweep, size-based fee)
//   3. ONLY the owner can spend            (a well-formed witness carrying a wrong
//      key's schnorr sig is rejected by script verification; NUMS key-path +
//      single-leaf are unit-asserted in 5b-BONDCLTV)
//
// ⚠ SIGNET TEST SATS ONLY. The keyfile holds a throwaway key. Run with tsx:
//     npx tsx scripts/mutinynet-commitment-verify.ts <command>
//
//   init [blocks]     — fresh throwaway key, T = tip + blocks (default 25)
//   status            — tip, T, confirmed UTXOs at the bond address
//   early-cltv        — build sweep with nLockTime = T−1 → broadcast → EXPECT reject
//   early-nonfinal    — build valid sweep (nLockTime = T) while tip < T → EXPECT reject
//   wrong-key         — sweep witness signed by a DIFFERENT key → EXPECT reject
//   sweep             — the valid owner sweep of ALL UTXOs (run once tip ≥ T) → EXPECT accept
//   confirm <txid>    — poll the reclaim's confirmation status
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import {
  buildCommitmentBond, buildReclaimTx, buildTimelockLeaf,
  estimateReclaimFeeSats, estimateReclaimVsize,
} from "../src/bond-multisig/commitment-bond.js";
import { SIGNET } from "../src/bond-multisig/multisig.js";

const API = process.env.MUTINYNET_API ?? "https://mutinynet.com/api";
const KEYFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".mutinynet-verify-keys.json");
const NET = SIGNET;

interface KeyFile { owner: string; lockUntil: number; }
interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean } }

async function esplora(p: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${API}${p}`, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`Esplora ${res.status}: ${body}`);
  return body;
}
const tipHeight = async () => Number(await esplora("/blocks/tip/height"));
const broadcast = (hex: string) => esplora("/tx", { method: "POST", headers: { "Content-Type": "text/plain" }, body: hex });

function loadKeys(): { priv: Uint8Array; xonly: Uint8Array; lockUntil: number } {
  if (!fs.existsSync(KEYFILE)) throw new Error("No keyfile — run `init` first");
  const kf: KeyFile = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const priv = hexToBytes(kf.owner);
  return { priv, xonly: btc.utils.pubSchnorr(priv), lockUntil: kf.lockUntil };
}

async function confirmedUtxos(address: string) {
  const utxos = JSON.parse(await esplora(`/address/${address}/utxo`)) as Utxo[];
  return utxos
    .filter((u) => u.status.confirmed)
    .map((u) => ({ txid: u.txid, index: u.vout, amountSats: BigInt(u.value) }));
}

/** The valid sweep of every confirmed UTXO, size-based fee — the shipping shape. */
function validSweep(k: ReturnType<typeof loadKeys>, utxos: { txid: string; index: number; amountSats: bigint }[], txLockTime?: number) {
  const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
  const dest = btc.p2tr(k.xonly, undefined, NET).address as string;
  const feeSats = estimateReclaimFeeSats(bond, utxos.length);
  return { raw: buildReclaimTx({ bond, utxos, ownerPriv: k.priv, destination: dest, feeSats, ...(txLockTime != null ? { txLockTime } : {}) }), feeSats };
}

/** INVARIANT 3 probe: the SAME tx shape, but the witness carries a schnorr sig from
 *  a key that is NOT the owner's. Well-formed (64 bytes, right stack layout, right
 *  leaf + control block) — only the KEY is wrong. Consensus must reject it. */
function wrongKeySweep(k: ReturnType<typeof loadKeys>, utxos: { txid: string; index: number; amountSats: bigint }[]) {
  const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
  const dest = btc.p2tr(k.xonly, undefined, NET).address as string;
  const leaf = buildTimelockLeaf(k.xonly, k.lockUntil);
  const p = btc.p2tr(hexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"), { script: leaf } as never, NET, true);
  const controlBlock = (p as unknown as { leaves: { controlBlock: Uint8Array }[] }).leaves[0].controlBlock;
  const total = utxos.reduce((s, u) => s + u.amountSats, 0n);
  const feeSats = estimateReclaimFeeSats(bond, utxos.length);
  const tx = new btc.Transaction({ allowUnknownOutputs: true, lockTime: k.lockUntil });
  for (const u of utxos) {
    tx.addInput({ txid: hexToBytes(u.txid), index: u.index, witnessUtxo: { script: p.script, amount: u.amountSats }, sequence: 0xfffffffe });
  }
  tx.addOutputAddress(dest, total - feeSats, NET);
  const evilPriv = btc.utils.randomPrivateKeyBytes();
  for (let i = 0; i < utxos.length; i++) {
    // A REAL 64-byte schnorr signature — just not from the owner's key.
    const evilSig = schnorr.sign(btc.utils.randomPrivateKeyBytes(), evilPriv); // arbitrary 32-byte msg
    tx.updateInput(i, { finalScriptWitness: [evilSig, leaf, controlBlock] });
  }
  return bytesToHex(tx.extract());
}

function pass(name: string, detail: string) { console.log(`\n✅ PASS — ${name}\n   ${detail}\n`); }
function fail(name: string, detail: string) { console.log(`\n❌ FAIL — ${name}\n   ${detail}\n`); process.exitCode = 1; }

async function expectReject(name: string, rawHex: string, expectPattern: RegExp) {
  try {
    const txid = await broadcast(rawHex);
    fail(name, `network ACCEPTED the tx (txid ${txid}) — the invariant is broken`);
  } catch (e) {
    const msg = (e as Error).message;
    if (expectPattern.test(msg)) pass(name, `rejected as expected: ${msg.slice(0, 200)}`);
    else fail(name, `rejected, but with an unexpected reason: ${msg.slice(0, 200)}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "init": {
      const term = Number(arg ?? "25");
      const tip = await tipHeight();
      const kf: KeyFile = { owner: bytesToHex(btc.utils.randomPrivateKeyBytes()), lockUntil: tip + term };
      fs.writeFileSync(KEYFILE, JSON.stringify(kf, null, 2));
      const priv = hexToBytes(kf.owner);
      const bond = buildCommitmentBond(btc.utils.pubSchnorr(priv), kf.lockUntil, NET);
      console.log(`\n🔑 fresh throwaway key → ${path.relative(process.cwd(), KEYFILE)} (gitignored)`);
      console.log(`\nBOND address (fund 2–3× via https://faucet.mutinynet.com):\n  ${bond.address}`);
      console.log(`\nT = ${kf.lockUntil}  (tip ${tip} + ${term} blocks ≈ ${(term * 30) / 60} min)\n`);
      break;
    }
    case "status": {
      const k = loadKeys();
      const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
      const tip = await tipHeight();
      const utxos = await confirmedUtxos(bond.address);
      console.log(`\ntip ${tip} · T ${k.lockUntil} · ${tip >= k.lockUntil ? "UNLOCKED" : `${k.lockUntil - tip} blocks to go`}`);
      console.log(`address ${bond.address}`);
      console.log(`confirmed UTXOs: ${utxos.length}${utxos.length ? "\n" + utxos.map((u) => `  ${u.txid}:${u.index}  ${u.amountSats} sats`).join("\n") : ""}`);
      console.log(`sweep estimate: vsize ${utxos.length ? estimateReclaimVsize(bond, utxos.length) : "-"} vB, fee ${utxos.length ? estimateReclaimFeeSats(bond, utxos.length) : "-"} sats\n`);
      break;
    }
    case "early-cltv": {
      const k = loadKeys();
      const tip = await tipHeight();
      const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
      const utxos = await confirmedUtxos(bond.address);
      if (!utxos.length) throw new Error("fund the address first");
      // nLockTime = min(tip, T−1): FINAL at the next block (so the tx-level
      // finality check passes and script execution is actually reached) yet < T —
      // isolating the CLTV OPCODE as the thing that rejects. This is the tx a
      // colluding miner could otherwise include; consensus itself must refuse it.
      const lt = Math.min(tip, k.lockUntil - 1);
      const { raw } = validSweep(k, utxos, lt);
      console.log(`INVARIANT 1a: nLockTime = ${lt} (final at tip ${tip}, but < T = ${k.lockUntil}) must die on the CLTV opcode itself.`);
      await expectReject("early spend (final nLockTime < T) rejected by the CLTV opcode", raw, /locktime requirement|CLTV|mandatory-script-verify/i);
      break;
    }
    case "early-nonfinal": {
      const k = loadKeys();
      const tip = await tipHeight();
      if (tip >= k.lockUntil) throw new Error(`too late — tip ${tip} ≥ T ${k.lockUntil}; this probe needs tip < T`);
      const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
      const utxos = await confirmedUtxos(bond.address);
      if (!utxos.length) throw new Error("fund the address first");
      const { raw } = validSweep(k, utxos);
      console.log(`INVARIANT 1b: the VALID reclaim (nLockTime = T = ${k.lockUntil}) broadcast at tip ${tip} < T must be non-final.`);
      await expectReject("valid reclaim broadcast before T rejected as non-final", raw, /non-?final|locktime/i);
      break;
    }
    case "wrong-key": {
      const k = loadKeys();
      const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
      const utxos = await confirmedUtxos(bond.address);
      if (!utxos.length) throw new Error("fund the address first");
      const raw = wrongKeySweep(k, utxos);
      console.log(`INVARIANT 3: identical tx + witness shape, but the schnorr sig is from a NON-owner key.`);
      await expectReject("non-owner signature rejected by script verification", raw, /schnorr|signature|mandatory-script-verify|non-?final|locktime/i);
      break;
    }
    case "sweep": {
      const k = loadKeys();
      const tip = await tipHeight();
      const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);
      const utxos = await confirmedUtxos(bond.address);
      if (!utxos.length) throw new Error("nothing to sweep");
      const { raw, feeSats } = validSweep(k, utxos);
      const vsize = estimateReclaimVsize(bond, utxos.length);
      console.log(`INVARIANT 2: tip ${tip} ${tip >= k.lockUntil ? "≥" : "<"} T ${k.lockUntil} — sweeping ${utxos.length} UTXO(s), ${utxos.reduce((s, u) => s + u.amountSats, 0n)} sats, fee ${feeSats} (${vsize} vB → ${Number(feeSats) / vsize} sat/vB)`);
      try {
        const txid = await broadcast(raw);
        pass(`owner sweep of ${utxos.length} UTXOs accepted after T`, `txid ${txid}`);
        console.log(`   confirm with: npx tsx scripts/mutinynet-commitment-verify.ts confirm ${txid}\n`);
      } catch (e) {
        fail("owner sweep after T", (e as Error).message.slice(0, 300));
      }
      break;
    }
    case "confirm": {
      if (!arg) throw new Error("confirm <txid>");
      const s = JSON.parse(await esplora(`/tx/${arg}/status`));
      console.log(s.confirmed ? `\n✅ CONFIRMED in block ${s.block_height}\n` : "\n⏳ not confirmed yet\n");
      break;
    }
    default:
      console.log("commands: init [blocks] | status | early-cltv | early-nonfinal | wrong-key | sweep | confirm <txid>");
  }
}

main().catch((e) => { console.error("\n✗ " + (e as Error).message + "\n"); process.exit(1); });
