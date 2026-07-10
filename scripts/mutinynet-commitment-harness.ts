#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────────────────
// Chama bond — Mutinynet harness for the SINGLE-KEY TIMELOCK COMMITMENT bond
//
// Proves the sealed v1 bond on a real network: an arbiter locks their OWN sats to
// their OWN key until block height T. Two rows, the mirror of the multisig harness:
//   ⭐ reclaim BEFORE T  → REJECTED by consensus (CLTV: "Locktime requirement not
//      satisfied" / non-final) — the coin genuinely cannot move early.
//      reclaim AFTER  T  → ACCEPTED — the owner reclaims it, alone, no cabinet.
//
// It reuses the SHIPPING module (src/bond-multisig/commitment-bond.ts), so what the
// network accepts/rejects here is exactly what the app produces. You drive funding
// (Mutinynet faucet) + broadcast; the script builds the transactions.
//
// ⚠ RUN WITH tsx (not node --strip-types): this imports commitment-bond.js which
//    imports multisig.js; tsx resolves the .js→.ts, node --strip-types does not.
//      npx tsx scripts/mutinynet-commitment-harness.ts <command>
//
// ⚠ SIGNET TEST SATS ONLY. The keyfile holds a throwaway key.
//
//   address                       — ensure key + term, print the bond address + T + tip
//   tip                           — current Mutinynet block height
//   utxos                         — UTXOs at the bond address
//   reclaim <txid:vout> [--early] — build the reclaim tx (valid; --early = before-T,
//                                   the consensus-invalid one). Amount auto-fetched.
//   broadcast <rawhex>            — send it (or use the printed curl)
//   status <txid>                 — confirmation status
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as btc from "@scure/btc-signer";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { buildCommitmentBond, buildReclaimTx } from "../src/bond-multisig/commitment-bond.js";
import { SIGNET } from "../src/bond-multisig/multisig.js";

const API = process.env.MUTINYNET_API ?? "https://mutinynet.com/api";
const FAUCET = "https://faucet.mutinynet.com/";
const FEE_SATS = BigInt(process.env.BOND_FEE_SATS ?? "300");
const TERM_BUFFER = Number(process.env.BOND_TERM_BUFFER ?? "6"); // blocks ahead → ~3 min on Mutinynet
const KEYFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".mutinynet-commitment-keys.json");
const NET = SIGNET;

interface KeyFile { owner: string; lockUntil: number; }

async function esplora(p: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${API}${p}`, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`Esplora ${res.status}: ${body}`);
  return body;
}
const tipHeight = async () => Number(await esplora("/blocks/tip/height"));

async function loadOrCreateKeys(): Promise<{ priv: Uint8Array; xonly: Uint8Array; lockUntil: number }> {
  let kf: KeyFile;
  if (fs.existsSync(KEYFILE)) {
    kf = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  } else {
    const tip = await tipHeight();
    kf = { owner: bytesToHex(btc.utils.randomPrivateKeyBytes()), lockUntil: tip + TERM_BUFFER };
    fs.writeFileSync(KEYFILE, JSON.stringify(kf, null, 2));
    console.log(`\n🔑 New signet test key written to ${path.relative(process.cwd(), KEYFILE)} (gitignored). Term T = ${kf.lockUntil} (tip ${tip} + ${TERM_BUFFER}).`);
  }
  const priv = hexToBytes(kf.owner);
  return { priv, xonly: btc.utils.pubSchnorr(priv), lockUntil: kf.lockUntil };
}

const p2trAddr = (xonly: Uint8Array) => btc.p2tr(xonly, undefined, NET).address as string;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const k = await loadOrCreateKeys();
  const bond = buildCommitmentBond(k.xonly, k.lockUntil, NET);

  switch (cmd) {
    case "address": {
      const tip = await tipHeight();
      console.log("\n=== Chama commitment bond — Mutinynet ===");
      console.log("\nBOND address (fund THIS):\n  " + bond.address);
      console.log("\nreclaim address (your own):  " + p2trAddr(k.xonly));
      console.log(`\nterm unlocks at block T = ${bond.lockUntil}   (current tip ${tip}, ${bond.lockUntil > tip ? `${bond.lockUntil - tip} blocks to go` : "UNLOCKED"})`);
      console.log("\nFund it:\n  " + FAUCET);
      console.log("\nThen: utxos → reclaim <txid:vout> --early (expect REJECTED) → wait past T → reclaim <txid:vout> (expect ACCEPTED)\n");
      break;
    }
    case "tip":
      console.log(await tipHeight());
      break;
    case "utxos": {
      const utxos = JSON.parse(await esplora(`/address/${bond.address}/utxo`)) as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }>;
      if (!utxos.length) { console.log("No UTXOs yet at " + bond.address + " — fund via " + FAUCET); break; }
      console.log(`\nUTXOs at ${bond.address} (T=${bond.lockUntil}, tip=${await tipHeight()}):`);
      for (const u of utxos) console.log(`  ${u.txid}:${u.vout}  ${u.value} sats  ${u.status.confirmed ? "confirmed" : "UNCONFIRMED"}`);
      console.log("");
      break;
    }
    case "reclaim": {
      const early = args.includes("--early");
      const token = args.find((a) => !a.startsWith("--"));
      if (!token || !token.includes(":")) throw new Error("reclaim <txid:vout> [--early]  — copy the txid:vout from `utxos`");
      const [txid, voutStr] = token.split(":");
      const vout = Number(voutStr);
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`'${txid}' is not a txid (the 64-hex from \`utxos\`, not the bond address)`);
      const found = (JSON.parse(await esplora(`/address/${bond.address}/utxo`)) as Array<{ txid: string; vout: number; value: number }>).find((u) => u.txid === txid && u.vout === vout);
      if (!found) throw new Error(`UTXO ${txid}:${vout} not found — run \`utxos\``);
      const utxo = { txid, index: vout, amountSats: BigInt(found.value) };
      const raw = buildReclaimTx({
        bond, utxos: [utxo], ownerPriv: k.priv, destination: p2trAddr(k.xonly), feeSats: FEE_SATS,
        ...(early ? { txLockTime: bond.lockUntil - 1 } : {}),
      });
      console.log(`\n=== reclaim ${early ? "(EARLY — before T)" : "(valid — at/after T)"} ===`);
      console.log("expected: " + (early ? "⛔ REJECTED — CLTV locktime requirement not satisfied" : `✅ ACCEPTED once tip ≥ ${bond.lockUntil} (else 'non-final')`));
      console.log("\nraw tx hex:\n" + raw);
      console.log("\nbroadcast it:\n  curl -s -X POST -H 'Content-Type: text/plain' --data '" + raw + "' " + API + "/tx");
      console.log("\n(or:  npx tsx scripts/mutinynet-commitment-harness.ts broadcast " + raw.slice(0, 12) + "…)\n");
      break;
    }
    case "broadcast": {
      const hex = args[0];
      if (!hex) throw new Error("broadcast <rawhex>");
      try {
        console.log("\n✅ ACCEPTED — txid:\n  " + (await esplora("/tx", { method: "POST", headers: { "Content-Type": "text/plain" }, body: hex })) + "\n");
      } catch (e) {
        console.log("\n⛔ REJECTED by Mutinynet (expected for an early reclaim):\n  " + (e as Error).message + "\n");
      }
      break;
    }
    case "status":
      if (!args[0]) throw new Error("status <txid>");
      console.log("\n" + (await esplora(`/tx/${args[0]}/status`)) + "\n");
      break;
    default:
      console.log("commands: address | tip | utxos | reclaim <txid:vout> [--early] | broadcast <hex> | status <txid>");
  }
}

main().catch((e) => { console.error("\n✗ " + (e as Error).message + "\n"); process.exit(1); });
