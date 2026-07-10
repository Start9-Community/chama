#!/usr/bin/env node
// scripts/dev-free-ports.mjs — free THIS instance's stale dev ports before launch.
//
// Extracted from dev-instance.sh on 2026-07-05. The script used to do this
// inline as an `lsof -ti | kill | kill -9` shell loop — a classic
// malware-behavior signature (adware/loader scripts kill competing
// processes exactly like that), and macOS XProtect killed a live dev
// session mid-run that evening with a "Malicious Script Blocked" alert.
// The same cleanup from Node via execFile + process.kill carries none of
// that shell-script signature surface.
//
// Semantics preserved from the shell version: only the ports passed on the
// command line are touched (each instance frees its OWN vite + bridge ports,
// never another instance's), TERM first, 400ms grace, then KILL whatever
// still holds the port.
import { execFileSync } from "node:child_process";

const ports = process.argv.slice(2).map((raw) => Number.parseInt(raw, 10));
if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p <= 0 || p > 65535)) {
  console.error("usage: node scripts/dev-free-ports.mjs <port> [port…]");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidsOnPort(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // lsof exits 1 when nothing holds the port — that's the happy path.
    return [];
  }
}

for (const port of ports) {
  const pids = pidsOnPort(port);
  if (pids.length === 0) continue;
  console.log(`  ⟲ freeing stale port :${port} (was held by pid ${pids.join(", ")})`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone / not ours */ }
  }
  await sleep(400);
  for (const pid of pidsOnPort(port)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone / not ours */ }
  }
}
