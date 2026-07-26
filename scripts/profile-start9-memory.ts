#!/usr/bin/env npx tsx
// Start9-topology renderer profiler. Two modes:
//
// FIXTURE (default): builds the production bundle, serves Start9-style origins
// with a mock /bridge, supplies a deterministic encrypted active trade over a
// local Nostr relay, launches two isolated Chrome sessions, and records
// bounded-memory evidence. JS-heap-scoped by construction.
//
// FIELD (CHAMA_PROFILE_TARGET_URL=https://host:port[,https://host:port2]):
// points real Chrome at the real deployed Start9 origin(s) and measures what
// the fixture mode cannot: OS-level renderer process footprint (RSS via ps).
// The 2026-07-25 field crash ("Aw, Snap" error code 5 = SIGTRAP) died with
// ~65 GiB page-allocator-mapped-size while its JS heap looked healthy —
// PartitionAlloc/ArrayBuffer growth is invisible to Runtime.getHeapUsage, so
// this mode gates on process RSS slope and renderer-crash events instead.
//   CHAMA_PROFILE_NSEC=<nsec[,nsec2]>  optional auto-login per tab
//   (no nsec ⇒ headful window; log in manually — sampling already runs)
//   CHAMA_PROFILE_HEADLESS=1           headless (default headful for field)
//   CHAMA_PROFILE_USER_DATA_DIR=<dir>  reuse a profile (default: fresh temp)
//   CHAMA_PROFILE_MAX_FOOTPRINT_MB / CHAMA_PROFILE_MAX_FOOTPRINT_SLOPE_MB_MIN
//   CHAMA_PROFILE_ALLOC_DUMP_MB=200    JS-heap/backingStorage dump trigger
//   CHAMA_PROFILE_ALLOC_DUMP_RSS_MB=1200  renderer-RSS backstop dump trigger
// Every tab (harness-managed or hand-opened) gets: heap-allocation sampling,
// a console ring buffer (retry-storm evidence), crash listeners, and
// threshold-triggered allocation dumps to /tmp — external-memory (ArrayBuffer)
// runaways trigger via backingStorage/RSS even when the JS heap stays small.
// Never touches the packaged service; read-only against the deployed origin.

import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { WebSocketServer } from "ws";
import { NsecSigner } from "../src/escrow-engine/nsec-signer.js";
import { createEnvelope } from "../src/escrow-engine/envelope.js";
import {
  EscrowEventKind,
  Role,
  type ChatBody,
  type ChatPayload,
  type NostrEvent,
} from "../src/escrow-engine/types.js";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const RELAY_PORT = Number(process.env.CHAMA_PROFILE_RELAY_PORT ?? 58100);
const ORIGIN_PORTS = [58080, 58081];
const DURATION_MS = Number(process.env.CHAMA_PROFILE_DURATION_MS ?? 30 * 60_000);
const SAMPLE_MS = Number(process.env.CHAMA_PROFILE_SAMPLE_MS ?? 5_000);
const MAX_HEAP_BYTES = Number(process.env.CHAMA_PROFILE_MAX_HEAP_MB ?? 384) * 1024 * 1024;
const MAX_SLOPE_BYTES_PER_MIN = Number(process.env.CHAMA_PROFILE_MAX_SLOPE_MB_MIN ?? 5) * 1024 * 1024;
const MAX_NODE_GROWTH = Number(process.env.CHAMA_PROFILE_MAX_NODE_GROWTH ?? 100);
const MAX_LISTENER_GROWTH = Number(process.env.CHAMA_PROFILE_MAX_LISTENER_GROWTH ?? 20);
const CHROME = process.env.CHAMA_PROFILE_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Field mode configuration (active only when a target URL is provided).
const TARGET_URLS = (process.env.CHAMA_PROFILE_TARGET_URL ?? "")
  .split(",").map(url => url.trim()).filter(Boolean);
const FIELD_NSECS = (process.env.CHAMA_PROFILE_NSEC ?? "")
  .split(",").map(secret => secret.trim()).filter(Boolean);
const FIELD_HEADLESS = process.env.CHAMA_PROFILE_HEADLESS === "1";
const MAX_FOOTPRINT_BYTES =
  Number(process.env.CHAMA_PROFILE_MAX_FOOTPRINT_MB ?? 1536) * 1024 * 1024;
const MAX_FOOTPRINT_SLOPE_BYTES_PER_MIN =
  Number(process.env.CHAMA_PROFILE_MAX_FOOTPRINT_SLOPE_MB_MIN ?? 10) * 1024 * 1024;
const MiB = 1024 * 1024;
// The observed runaway burns ~1.6 GiB/min; a healthy tab peaks under 60 MiB.
// Dumping the allocation profile at this JS-heap threshold beats V8's ~2.9 GiB
// OOM ceiling by minutes.
const ALLOC_DUMP_TRIGGER_BYTES =
  Number(process.env.CHAMA_PROFILE_ALLOC_DUMP_MB ?? 200) * 1024 * 1024;
// Two of the three field crashes (12:38, 20:50) died with a SMALL JS heap —
// the growth was external (ArrayBuffer backing stores / PartitionAlloc), which
// jsHeapUsed cannot see. Trigger on the CDP backingStorage figure and, as the
// backstop, on any renderer process RSS (which sees everything).
const ALLOC_DUMP_RSS_TRIGGER_BYTES =
  Number(process.env.CHAMA_PROFILE_ALLOC_DUMP_RSS_MB ?? 1200) * 1024 * 1024;
// A sampling profile accumulates, so a later dump strictly supersedes an
// earlier one; re-dump at most this often per document.
const ALLOC_REDUMP_INTERVAL_MS = 5 * 60_000;
const CONSOLE_RING_LIMIT = 400;

const SELLER_SECRET = "11".repeat(32);
const BUYER_SECRET = "22".repeat(32);
const ARBITER_SECRET = "33".repeat(32);
const ESCROW_ID = "profile-active-trade-001";
const NOW = Math.floor(Date.now() / 1000) - 60;
const PROFILE_RELAY_COUNT = 4;
const PROFILE_RELAY_URLS = Array.from(
  { length: PROFILE_RELAY_COUNT },
  (_, index) => `ws://127.0.0.1:${RELAY_PORT}/relay/${index}`,
);

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let activeBrowser: Browser | undefined;
const activeServers: Server[] = [];

async function cleanup(): Promise<void> {
  const browser = activeBrowser;
  activeBrowser = undefined;
  if (browser) await browser.close().catch(() => undefined);
  await Promise.all(activeServers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))
  ));
}

async function fixture(): Promise<NostrEvent[]> {
  const seller = new NsecSigner(SELLER_SECRET);
  const buyer = new NsecSigner(BUYER_SECRET);
  const arbiter = new NsecSigner(ARBITER_SECRET);
  const [sellerPk, buyerPk, arbiterPk] = await Promise.all([
    seller.getPublicKey(), buyer.getPublicKey(), arbiter.getPublicKey(),
  ]);
  const createPayload = {
    type: "escrow:create",
    description: "Deterministic profiling trade",
    amountMsats: 100_000_000,
    fiatAmount: 100,
    fiatCurrency: "USD",
    category: "p2p-trade",
    community: "us-blf",
    mintUrl: "fed1profile",
    platformFeeBps: 50,
    platformFeePubkey: arbiterPk,
    arbiterFeeMsats: 1_000_000,
    paymentMethods: ["Cash"],
    expirySeconds: 86_400,
    communityArbiters: [arbiterPk],
    createdAt: NOW,
  };
  const create = await seller.signEvent({
    kind: EscrowEventKind.CREATE,
    created_at: NOW,
    tags: [["d", ESCROW_ID], ["p", sellerPk], ["p", buyerPk], ["p", arbiterPk]],
    content: JSON.stringify(createPayload),
  });
  const lockPayload = {
    type: "escrow:lock",
    notesHash: "profile-notes-hash",
    shares: [0, 1, 2].map(shareIndex => ({
      shareIndex,
      encryptedFor: {
        [buyerPk]: `profile-share-${shareIndex}-buyer`,
        [sellerPk]: `profile-share-${shareIndex}-seller`,
        [arbiterPk]: `profile-share-${shareIndex}-arbiter`,
      },
    })),
    sellerReceivesMsats: 99_000_000,
    arbiterFeeMsats: 1_000_000,
    buyerPubkey: buyerPk,
    arbiterPubkey: arbiterPk,
    lockedAt: NOW + 1,
  };
  const envelope = await createEnvelope(
    JSON.stringify(lockPayload),
    [sellerPk, buyerPk, arbiterPk],
    (plaintext, recipient) => seller.nip44Encrypt(plaintext, recipient),
  );
  const lock = await seller.signEvent({
    kind: EscrowEventKind.LOCK,
    created_at: NOW + 1,
    tags: [
      ["d", ESCROW_ID],
      ["e", create.id, "", "reply"],
      ["p", sellerPk], ["p", buyerPk], ["p", arbiterPk],
    ],
    content: JSON.stringify(envelope),
  });
  // Large enough to model a photo receipt after per-recipient NIP-44 fan-out,
  // but below Chama's 128 KiB wire cap. The visible payload survives hydration;
  // its encrypted raw content must not remain in the renderer hot cache.
  const chatBody: ChatBody = {
    message: "Deterministic chat-bearing profiling receipt",
    attachments: [{
      id: "profile-chat-image",
      kind: "image",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${"A".repeat(16 * 1024)}`,
      name: "profile-receipt.png",
      sizeBytes: 12 * 1024,
    }],
  };
  const chatEnvelope = await createEnvelope(
    JSON.stringify(chatBody),
    [sellerPk, buyerPk, arbiterPk],
    (plaintext, recipient) => seller.nip44Encrypt(plaintext, recipient),
  );
  const chatPayload: ChatPayload = {
    type: "escrow:chat",
    message: "",
    bodyEnvelope: chatEnvelope,
    senderRole: Role.SELLER,
    sentAt: NOW + 2,
  };
  const chat = await seller.signEvent({
    kind: EscrowEventKind.CHAT,
    created_at: NOW + 2,
    tags: [["d", ESCROW_ID], ["t", "escrow:chat"]],
    content: JSON.stringify(chatPayload),
  });
  return [create, lock, chat];
}

function matches(event: NostrEvent, filter: Record<string, any>): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const tag = key.slice(1);
    if (!event.tags.some(row => row[0] === tag && values.includes(row[1]))) return false;
  }
  return true;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url?.startsWith("/bridge/")) {
    const path = req.url.slice("/bridge".length);
    res.setHeader("content-type", "application/json");
    if (path === "/health") {
      res.end(JSON.stringify({
        ok: true,
        joined: true,
        api_version: 1,
        capabilities: ["reset", "idempotent_join", "effective_iroh_config"],
      }));
      return;
    }
    if (path === "/info") {
      res.end(JSON.stringify({
        federation_id: "profile-fed",
        network: "bitcoin",
        total_amount_msat: 0,
        meta: { name: "Profile Federation" },
      }));
      return;
    }
    if (path === "/reset") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `mock bridge endpoint not implemented: ${path}` }));
    return;
  }
  const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  const candidate = normalize(join(DIST, pathname === "/" ? "index.html" : pathname));
  const safe = candidate.startsWith(DIST) ? candidate : join(DIST, "index.html");
  let file = safe;
  try {
    if (!(await stat(file)).isFile()) file = join(DIST, "index.html");
  } catch {
    file = join(DIST, "index.html");
  }
  res.setHeader("cache-control", file.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
  res.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream");
  res.end(await readFile(file));
}

async function signIn(page: Page, secret: string): Promise<void> {
  await page.evaluate(() => {
    const getStarted = [...document.querySelectorAll("button")].find(button =>
      /get started/i.test(button.textContent ?? "")
    );
    if (getStarted instanceof HTMLButtonElement) getStarted.click();
  });
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some(button =>
        /returning chama citizen/i.test(button.textContent ?? "")
      ),
      { timeout: 30_000 },
    );
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4_000));
    throw new Error(`Returning-user button did not appear. Page text:\n${bodyText}`, {
      cause: error,
    });
  }
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const returning = buttons.find(button =>
      /returning chama citizen/i.test(button.textContent ?? "")
    );
    if (!(returning instanceof HTMLButtonElement)) {
      throw new Error("Returning-user sign-in button not found");
    }
    returning.click();
  });
  try {
    await page.waitForSelector('input[name="password"]', {
      timeout: 30_000,
      visible: true,
    });
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4_000));
    throw new Error(`Recovery-key input did not appear. Page text:\n${bodyText}`, {
      cause: error,
    });
  }
  await page.type('input[name="password"]', secret);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !document.querySelector('input[name="password"]'),
    { timeout: 20_000 },
  );
}

async function login(page: Page, secret: string, port: number, withLivenessCache: boolean): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle2" });
  await page.evaluate((seedCache) => {
    localStorage.setItem("chama_community", "us-blf");
    localStorage.removeItem("chama_liveness_diagnostics_v1");
    localStorage.removeItem("chama_liveness_verified_cache_v1");
    if (seedCache) {
      localStorage.setItem("chama_liveness_verified_cache_v1", JSON.stringify({
        "us-blf": {
          at: Date.now(),
          value: {
            community: "us-blf",
            isLive: true,
            arbiterCount: 1,
            totalBondSats: "100000",
            bondWeightSatBlocks: "1000000000",
            avgRemainingBlocks: 10000,
            ratings: { count: 10, positive: 10, negative: 0, positiveRate: 1 },
            score: 72,
          },
        },
      }));
    }
  }, withLivenessCache);
  await signIn(page, secret);
}

async function invokeLivenessScenario(page: Page): Promise<void> {
  await page.waitForSelector('[data-coach="nav-dashboard"]', { timeout: 30_000 });
  await page.click('[data-coach="nav-dashboard"]');
  await page.waitForFunction(
    () => document.body.innerText.includes("Your standing"),
    { timeout: 30_000 },
  );
  // The mount starts generation one. Focus callers must join it rather than
  // creating parallel per-community work in the same tab.
  await new Promise(resolve => setTimeout(resolve, 250));
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(
    () => {
      const rows = JSON.parse(localStorage.getItem("chama_liveness_diagnostics_v1") ?? "[]");
      return rows.length === 1 && rows[0]?.finishedAt !== null;
    },
    { timeout: 20_000 },
  );
}

interface TabMetrics {
  jsHeapUsed: number;
  jsHeapTotal: number;
  /** ArrayBuffer/WASM backing stores — external to the V8 heap. Newer CDP
   *  only; 0 when the field is absent. */
  backingStorage: number;
  embedderHeapUsed: number;
  documents: number;
  nodes: number;
  listeners: number;
  taskDuration: number;
}

async function readTabMetrics(session: import("puppeteer-core").CDPSession): Promise<TabMetrics> {
  const [performance, heap, dom] = await Promise.all([
    session.send("Performance.getMetrics"),
    session.send("Runtime.getHeapUsage"),
    session.send("Memory.getDOMCounters"),
  ]);
  const metric = Object.fromEntries(performance.metrics.map(item => [item.name, item.value]));
  const heapExtra = heap as typeof heap & {
    backingStorageSize?: number;
    embedderHeapUsedSize?: number;
  };
  return {
    jsHeapUsed: heap.usedSize,
    jsHeapTotal: heap.totalSize,
    backingStorage: heapExtra.backingStorageSize ?? 0,
    embedderHeapUsed: heapExtra.embedderHeapUsedSize ?? 0,
    documents: dom.documents,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    taskDuration: metric.TaskDuration ?? 0,
  };
}

interface RendererProcessSample {
  pid: number;
  rssBytes: number;
  vszBytes: number;
}

// OS-level truth the CDP heap metrics cannot see: PartitionAlloc, ArrayBuffers
// and Blink memory all land in the renderer's resident set. Walk this Chrome
// instance's process tree (renderers are descendants of the browser process)
// so a second user Chrome running alongside never pollutes the measurement.
function sampleRendererProcesses(browserPid: number): RendererProcessSample[] {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,vsz=,command="], { encoding: "utf8" });
  if (ps.status !== 0 || !ps.stdout) return [];
  const rows: Array<{ pid: number; ppid: number; rssBytes: number; vszBytes: number; command: string }> = [];
  for (const line of ps.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      vszBytes: Number(match[4]) * 1024,
      command: match[5]!,
    });
  }
  const childrenByParent = new Map<number, typeof rows>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid) ?? [];
    siblings.push(row);
    childrenByParent.set(row.ppid, siblings);
  }
  const renderers: RendererProcessSample[] = [];
  const queue = [browserPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of childrenByParent.get(pid) ?? []) {
      queue.push(child.pid);
      if (child.command.includes("--type=renderer")) {
        renderers.push({ pid: child.pid, rssBytes: child.rssBytes, vszBytes: child.vszBytes });
      }
    }
  }
  return renderers;
}

function slopePerMinute(points: Array<{ at: number; value: number }>): number {
  if (points.length < 2) return 0;
  const first = points[0]!;
  const last = points.at(-1)!;
  const minutes = Math.max(1 / 60, (last.at - first.at) / 60_000);
  return (last.value - first.value) / minutes;
}

interface SamplingProfileNode {
  callFrame?: { functionName?: string; url?: string; lineNumber?: number };
  selfSize?: number;
  children?: SamplingProfileNode[];
}

function summarizeTopAllocators(head: SamplingProfileNode, limit: number): Array<{ frame: string; selfBytes: number }> {
  const totals = new Map<string, number>();
  const stack: SamplingProfileNode[] = [head];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const callFrame = node.callFrame ?? {};
    const frame = `${callFrame.functionName || "(anonymous)"} @ ${callFrame.url || "?"}:${(callFrame.lineNumber ?? -1) + 1}`;
    const selfSize = node.selfSize ?? 0;
    if (selfSize > 0) totals.set(frame, (totals.get(frame) ?? 0) + selfSize);
    for (const child of node.children ?? []) stack.push(child);
  }
  return [...totals.entries()]
    .map(([frame, selfBytes]) => ({ frame, selfBytes }))
    .sort((a, b) => b.selfBytes - a.selfBytes)
    .slice(0, limit);
}

async function fieldMain(): Promise<void> {
  const userDataDir = process.env.CHAMA_PROFILE_USER_DATA_DIR
    ?? await mkdtemp(join(tmpdir(), "chama-field-profile-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: FIELD_HEADLESS,
    userDataDir,
    // Start9 .local interfaces use the box's own CA; automation trusts it
    // for measurement only.
    acceptInsecureCerts: true,
    args: [
      "--ignore-certificate-errors",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  activeBrowser = browser;
  const browserPid = browser.process()?.pid;
  if (!browserPid) throw new Error("Chrome process PID unavailable — cannot sample renderer footprint");

  const crashes: Array<{ url: string; at: number; message: string }> = [];

  interface TrackedTab {
    id: number;
    page: Page;
    session: CDPSession | null;
    lastUrl: string;
    lastDumpAt: number | null;
    allocDumps: string[];
    /** Ring buffer of recent console output — captures retry-loop error
     *  storms (the field consoles showed repeating bridge 500s) without
     *  needing DevTools open in the profiled tab. */
    consoleRing: Array<{ at: number; type: string; text: string }>;
  }
  const tracked: TrackedTab[] = [];
  let nextTabId = 1;

  const startSamplingOn = async (session: CDPSession): Promise<void> => {
    await session.send("Performance.enable");
    await session.send("HeapProfiler.enable");
    try {
      await session.send("HeapProfiler.startSampling", { samplingInterval: 65536 });
    } catch (error) {
      // Same-document/same-process navigations leave the profiler running —
      // that's the accumulation we want, not a failure.
      if (!/already/i.test(String(error))) throw error;
    }
  };

  const armSampling = async (tab: TrackedTab): Promise<void> => {
    try {
      if (!tab.session) tab.session = await tab.page.createCDPSession();
      await startSamplingOn(tab.session);
    } catch {
      // Cross-process navigation (or a crash) killed the old session.
      try {
        tab.session = await tab.page.createCDPSession();
        await startSamplingOn(tab.session);
      } catch (error) {
        tab.session = null;
        console.warn(`[field] sampling arm failed for ${tab.lastUrl}: ${String(error)}`);
      }
    }
  };

  const dumpAllocations = async (tab: TrackedTab, reason: string): Promise<void> => {
    if (!tab.session) return;
    // A sampling profile accumulates since arm time, so a later dump strictly
    // supersedes an earlier one — but don't hammer: at most one per interval.
    if (tab.lastDumpAt !== null && Date.now() - tab.lastDumpAt < ALLOC_REDUMP_INTERVAL_MS) return;
    tab.lastDumpAt = Date.now();
    try {
      const { profile } = await tab.session.send("HeapProfiler.getSamplingProfile");
      const topAllocators = summarizeTopAllocators(profile.head, 15);
      const path = join(tmpdir(), `chama-start9-alloc-tab${tab.id}-${Date.now()}.json`);
      await writeFile(path, JSON.stringify(
        {
          url: tab.lastUrl, reason, at: Date.now(), topAllocators,
          recentConsole: tab.consoleRing.slice(-60),
          profile,
        },
        null,
        2,
      ));
      tab.allocDumps.push(path);
      console.error(`[field] ALLOCATION DUMP (${reason}) for ${tab.lastUrl}: ${path}`);
      for (const row of topAllocators.slice(0, 8)) {
        console.error(`  ${(row.selfBytes / MiB).toFixed(1)} MiB  ${row.frame}`);
      }
    } catch (error) {
      tab.lastDumpAt = null; // dump failed — allow a retry next sample
      console.warn(`[field] allocation dump failed for ${tab.lastUrl}: ${String(error)}`);
    }
  };

  const attachTab = async (page: Page): Promise<TrackedTab> => {
    const tab: TrackedTab = {
      id: nextTabId++,
      page,
      session: null,
      lastUrl: page.url(),
      lastDumpAt: null,
      allocDumps: [],
      consoleRing: [],
    };
    const pushConsole = (type: string, text: string) => {
      tab.consoleRing.push({ at: Date.now(), type, text: text.slice(0, 400) });
      if (tab.consoleRing.length > CONSOLE_RING_LIMIT) {
        tab.consoleRing.splice(0, tab.consoleRing.length - CONSOLE_RING_LIMIT);
      }
    };
    page.on("console", (message) => pushConsole(message.type(), message.text()));
    page.on("pageerror", (error) => pushConsole("pageerror", error.message));
    page.on("error", (error) => {
      crashes.push({ url: tab.lastUrl, at: Date.now(), message: error.message });
      console.error(`[field] RENDERER CRASH on ${tab.lastUrl}: ${error.message}`);
      console.error(`[field] last console lines before the crash on tab ${tab.id}:`);
      for (const row of tab.consoleRing.slice(-12)) {
        console.error(`  ${new Date(row.at).toISOString()} [${row.type}] ${row.text.slice(0, 200)}`);
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame.parentFrame() !== null) return;
      tab.lastUrl = frame.url() || tab.lastUrl;
      tab.lastDumpAt = null; // a new document may earn its own dump
      void armSampling(tab);
    });
    await armSampling(tab);
    tracked.push(tab);
    return tab;
  };

  // One shared profile, one tab per origin — the real lab shape. Same-site
  // tabs may share a renderer process; the per-PID series captures that too.
  for (const [index, url] of TARGET_URLS.entries()) {
    const page = index === 0
      ? ((await browser.pages())[0] ?? await browser.newPage())
      : await browser.newPage();
    const tab = await attachTab(page);
    tab.lastUrl = url;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    } catch (error) {
      console.warn(`[field] initial load of ${url} did not settle: ${String(error)} — sampling anyway`);
    }
  }

  // Tabs the operator opens by hand (tonight's third-tab repro) get the same
  // crash listener + allocation sampling as harness-managed tabs.
  browser.on("targetcreated", (target) => {
    void (async () => {
      try {
        if (target.type() !== "page") return;
        const page = await target.page();
        if (!page || tracked.some(tab => tab.page === page)) return;
        const tab = await attachTab(page);
        console.log(`[field] attached to manually opened tab ${tab.id} (${tab.lastUrl || "about:blank"})`);
      } catch {
        // A tab that vanished before attach carries no evidence.
      }
    })();
  });

  if (FIELD_NSECS.length > 0) {
    for (const [index, tab] of tracked.entries()) {
      const secret = FIELD_NSECS[index] ?? FIELD_NSECS[0]!;
      try {
        await signIn(tab.page, secret);
        console.log(`[field] signed in on ${TARGET_URLS[index]}`);
      } catch (error) {
        console.warn(`[field] auto-login failed on ${TARGET_URLS[index]}: ${String(error)}`);
      }
    }
  } else if (!FIELD_HEADLESS) {
    console.log("[field] no CHAMA_PROFILE_NSEC — log in manually in the Chrome window; sampling is already running.");
  } else {
    console.warn("[field] headless without CHAMA_PROFILE_NSEC — measuring the signed-out surface only.");
  }

  interface FieldSample {
    at: number;
    renderers: RendererProcessSample[];
    tabs: Array<{ id: number; url: string; metrics: TabMetrics }>;
  }
  const samples: FieldSample[] = [];
  const started = Date.now();
  let lastProgressAt = 0;
  while (Date.now() - started < DURATION_MS) {
    const tabs: FieldSample["tabs"] = [];
    for (const tab of [...tracked]) {
      if (!tab.session) continue;
      try {
        tab.lastUrl = tab.page.url() || tab.lastUrl;
      } catch {
        // keep the last known URL for crash attribution
      }
      try {
        const metrics = await readTabMetrics(tab.session);
        tabs.push({ id: tab.id, url: tab.lastUrl, metrics });
        if (metrics.jsHeapUsed > ALLOC_DUMP_TRIGGER_BYTES) {
          void dumpAllocations(
            tab,
            `jsHeapUsed ${(metrics.jsHeapUsed / MiB).toFixed(0)} MiB crossed the ${(ALLOC_DUMP_TRIGGER_BYTES / MiB).toFixed(0)} MiB trigger`,
          );
        } else if (metrics.backingStorage > ALLOC_DUMP_TRIGGER_BYTES) {
          // External ArrayBuffer growth — the shape of the 12:38/20:50 crashes,
          // invisible to jsHeapUsed.
          void dumpAllocations(
            tab,
            `backingStorage ${(metrics.backingStorage / MiB).toFixed(0)} MiB crossed the ${(ALLOC_DUMP_TRIGGER_BYTES / MiB).toFixed(0)} MiB trigger`,
          );
        }
      } catch {
        // crashed / detached tab — the crash listener records it
      }
    }
    const renderers = sampleRendererProcesses(browserPid);
    samples.push({ at: Date.now(), renderers, tabs });
    // Backstop: RSS sees PartitionAlloc/Blink growth no CDP heap figure
    // reports. Renderer PIDs don't map cleanly to tabs, so a breach dumps
    // every tracked tab — sampling-profile dumps are cheap.
    const fattest = renderers.reduce((max, r) => Math.max(max, r.rssBytes), 0);
    if (fattest > ALLOC_DUMP_RSS_TRIGGER_BYTES) {
      for (const tab of [...tracked]) {
        void dumpAllocations(
          tab,
          `renderer RSS ${(fattest / MiB).toFixed(0)} MiB crossed the ${(ALLOC_DUMP_RSS_TRIGGER_BYTES / MiB).toFixed(0)} MiB backstop`,
        );
      }
    }
    if (Date.now() - lastProgressAt >= 60_000) {
      lastProgressAt = Date.now();
      const tabBits = tabs.map(item =>
        `tab${item.id} heap ${(item.metrics.jsHeapUsed / MiB).toFixed(0)}M backing ${(item.metrics.backingStorage / MiB).toFixed(0)}M`);
      console.log(
        `[field] +${Math.round((Date.now() - started) / 60_000)}min maxRSS ${(fattest / MiB).toFixed(0)}M · ${tabBits.join(" · ") || "no live tabs"}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, SAMPLE_MS));
  }

  // Per-renderer-PID footprint series. steadySlope uses the second half of the
  // window so first-boot hydration growth doesn't mask (or fake) a leak.
  const pidSeries = new Map<number, Array<{ at: number; rssBytes: number; vszBytes: number }>>();
  for (const sample of samples) {
    for (const renderer of sample.renderers) {
      const series = pidSeries.get(renderer.pid) ?? [];
      series.push({ at: sample.at, rssBytes: renderer.rssBytes, vszBytes: renderer.vszBytes });
      pidSeries.set(renderer.pid, series);
    }
  }
  const midpoint = samples.length > 0
    ? samples[0]!.at + (samples.at(-1)!.at - samples[0]!.at) / 2
    : 0;
  const rendererResults = [...pidSeries.entries()].map(([pid, series]) => {
    const rss = series.map(point => ({ at: point.at, value: point.rssBytes }));
    const steady = rss.filter(point => point.at >= midpoint);
    return {
      pid,
      samples: series.length,
      startRssBytes: series[0]!.rssBytes,
      endRssBytes: series.at(-1)!.rssBytes,
      maxRssBytes: Math.max(...series.map(point => point.rssBytes)),
      maxVszBytes: Math.max(...series.map(point => point.vszBytes)),
      rssSlopeBytesPerMin: slopePerMinute(rss),
      steadyRssSlopeBytesPerMin: slopePerMinute(steady),
    };
  });
  const finalAllocators = await Promise.all(tracked.map(async (tab) => {
    if (!tab.session) return null;
    try {
      const { profile } = await tab.session.send("HeapProfiler.getSamplingProfile");
      return summarizeTopAllocators(profile.head, 10);
    } catch {
      return null;
    }
  }));
  const tabResults = tracked.map((tab, index) => {
    const points = samples.flatMap(sample =>
      sample.tabs
        .filter(item => item.id === tab.id)
        .map(item => ({ at: sample.at, metrics: item.metrics })),
    );
    const heaps = points.map(point => ({ at: point.at, value: point.metrics.jsHeapUsed }));
    return {
      id: tab.id,
      url: tab.lastUrl,
      samples: points.length,
      allocDumps: tab.allocDumps,
      topAllocators: finalAllocators[index],
      recentConsole: tab.consoleRing.slice(-120),
      ...(points.length >= 2
        ? {
          startHeap: heaps[0]!.value,
          endHeap: heaps.at(-1)!.value,
          maxHeap: Math.max(...heaps.map(point => point.value)),
          heapSlopeBytesPerMin: slopePerMinute(heaps),
          taskDurationDeltaSeconds:
            points.at(-1)!.metrics.taskDuration - points[0]!.metrics.taskDuration,
          nodesDelta: points.at(-1)!.metrics.nodes - points[0]!.metrics.nodes,
          listenersDelta: points.at(-1)!.metrics.listeners - points[0]!.metrics.listeners,
        }
        : {}),
    };
  });
  const diagnostics = await Promise.all(tracked.map(async (tab) => {
    try {
      const rings = await tab.page.evaluate(() => ({
        liveness: JSON.parse(localStorage.getItem("chama_liveness_diagnostics_v1") ?? "[]"),
        hydration: JSON.parse(localStorage.getItem("chama_hydration_diagnostics_v1") ?? "[]"),
      }));
      return { url: tab.lastUrl, ...rings };
    } catch {
      return null; // a crashed tab yields no diagnostics — the crash entry stands
    }
  }));

  const pass = crashes.length === 0
    && rendererResults.length > 0
    && rendererResults.every(result =>
      result.maxRssBytes < MAX_FOOTPRINT_BYTES
        && result.steadyRssSlopeBytesPerMin < MAX_FOOTPRINT_SLOPE_BYTES_PER_MIN
    )
    && tabResults.every(result =>
      result.maxHeap === undefined
        || (result.maxHeap < MAX_HEAP_BYTES && result.heapSlopeBytesPerMin! < MAX_SLOPE_BYTES_PER_MIN)
    );

  const summary = {
    mode: "field",
    pass,
    durationMs: DURATION_MS,
    targets: TARGET_URLS,
    thresholds: {
      maxFootprintBytes: MAX_FOOTPRINT_BYTES,
      maxSteadyFootprintSlopeBytesPerMin: MAX_FOOTPRINT_SLOPE_BYTES_PER_MIN,
      maxHeapBytes: MAX_HEAP_BYTES,
      maxHeapSlopeBytesPerMin: MAX_SLOPE_BYTES_PER_MIN,
      allocDumpTriggerBytes: ALLOC_DUMP_TRIGGER_BYTES,
    },
    crashes,
    rendererResults,
    tabResults,
    diagnostics,
    userDataDir,
  };
  const artifactPath = join(tmpdir(), `chama-start9-field-profile-${Date.now()}.json`);
  await writeFile(artifactPath, JSON.stringify({ ...summary, samples }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[field] full sample series: ${artifactPath}`);

  await cleanup();
  if (!pass) process.exitCode = 1;
}

async function main(): Promise<void> {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_CHAMA_NATIVE_BRIDGE_REQUIRED: "1",
      VITE_CHAMA_NATIVE_BRIDGE_URL: "/bridge",
      VITE_CHAMA_PROFILE_RELAY: PROFILE_RELAY_URLS.join(","),
    },
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const events = await fixture();
  const relayHttp = createServer();
  activeServers.push(relayHttp);
  const relay = new WebSocketServer({ noServer: true });
  type RelayReq = {
    at: number;
    relayIndex: number;
    subId: string;
    filters: Array<Record<string, any>>;
  };
  const relayRequests: RelayReq[] = [];
  const relayDeliveries: Array<{
    at: number;
    relayIndex: number;
    subId: string;
    eventId: string;
    kind: number;
    contentBytes: number;
    escrowFiltered: boolean;
  }> = [];
  const relaySockets = new Map<number, Set<import("ws").WebSocket>>();
  for (let index = 0; index < PROFILE_RELAY_COUNT; index++) {
    relaySockets.set(index, new Set());
  }
  relayHttp.on("upgrade", (request, socket, head) => {
    const match = request.url?.match(/^\/relay\/(\d+)$/);
    const relayIndex = match ? Number(match[1]) : -1;
    if (relayIndex < 0 || relayIndex >= PROFILE_RELAY_COUNT) return socket.destroy();
    relay.handleUpgrade(request, socket, head, ws => {
      (ws as any).__profileRelayIndex = relayIndex;
      relay.emit("connection", ws, request);
    });
  });
  relay.on("connection", ws => {
    const relayIndex = Number((ws as any).__profileRelayIndex);
    relaySockets.get(relayIndex)!.add(ws);
    ws.on("close", () => relaySockets.get(relayIndex)!.delete(ws));
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message[0] !== "REQ") return;
      const [, subId, ...filters] = message;
      relayRequests.push({
        at: Date.now(),
        relayIndex,
        subId: String(subId),
        filters,
      });
      for (const event of events) {
        if (filters.some((filter: Record<string, any>) => matches(event, filter))) {
          relayDeliveries.push({
            at: Date.now(),
            relayIndex,
            subId: String(subId),
            eventId: event.id,
            kind: event.kind,
            contentBytes: event.content.length,
            escrowFiltered: filters.some((filter: Record<string, any>) =>
              filter["#d"]?.includes(ESCROW_ID)
            ),
          });
          ws.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await new Promise<void>(resolve => relayHttp.listen(RELAY_PORT, "127.0.0.1", resolve));
  const servers = ORIGIN_PORTS.map(port => {
    const server = createServer((req, res) => void serveStatic(req, res));
    activeServers.push(server);
    return { server, ready: new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)) };
  });
  await Promise.all(servers.map(item => item.ready));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  activeBrowser = browser;
  const contexts = await Promise.all([browser.createBrowserContext(), browser.createBrowserContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of pages) {
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (/mempool\.space/.test(request.url())) {
        // Deliberately outlive the app's 12s generation deadline. Chrome will
        // cancel the intercepted request when AbortController fires.
        setTimeout(() => {
          if (!request.isInterceptResolutionHandled()) void request.abort("timedout");
        }, 30_000);
        return;
      }
      void request.continue();
    });
  }

  await Promise.all([
    login(pages[0]!, SELLER_SECRET, ORIGIN_PORTS[0]!, true),
    login(pages[1]!, BUYER_SECRET, ORIGIN_PORTS[1]!, false),
  ]);
  await Promise.all(pages.map(page => invokeLivenessScenario(page)));
  await Promise.all(pages.map(page => page.waitForFunction(
    () => {
      const client = (globalThis as any).__CHAMA_PROFILE_CLIENT__;
      const snapshot = client?.getProfileMemorySnapshot?.();
      return snapshot?.parsedChatMessages >= 1;
    },
    { timeout: 30_000 },
  )));

  const closeRelay = (index: number): void => {
    for (const ws of [...(relaySockets.get(index) ?? [])]) {
      try { ws.close(1012, "profile flap"); } catch {}
    }
  };
  const fetchReqCount = (): number => relayRequests.filter(request =>
    request.subId.startsWith("sm_fetch_") &&
    request.filters.some(filter => filter["#d"]?.includes(ESCROW_ID))
  ).length;

  // Discriminator A: one redundant relay flap must only resume its own
  // subscription and must not schedule global watched-trade recovery.
  const scenarioStartedAt = Date.now();
  const beforeSingleFlapFetches = fetchReqCount();
  closeRelay(3);
  await new Promise(resolve => setTimeout(resolve, 6_000));
  const afterSingleFlapFetches = fetchReqCount();

  // Discriminator B: falling from four relays to two crosses the configured
  // read quorum (3). Restoring it must schedule bounded delta recovery.
  closeRelay(1);
  closeRelay(2);
  await new Promise(resolve => setTimeout(resolve, 8_000));
  const afterQuorumFlapFetches = fetchReqCount();

  const sessions = await Promise.all(pages.map(page => page.createCDPSession()));
  await Promise.all(sessions.map(session => session.send("Performance.enable")));
  // Blink's listener counter includes unreachable listeners on closed
  // WebSocket wrappers until V8 collects them. Keep the normal, unforced
  // samples below for heap slope/peak, but compare a collected baseline and
  // endpoint so the listener gate measures retained listeners rather than GC
  // scheduling.
  await Promise.all(sessions.map(session => session.send("HeapProfiler.collectGarbage")));
  const retainedStart = await Promise.all(sessions.map(session => readTabMetrics(session)));
  const samples: Array<{ at: number; tabs: Array<Record<string, number>> }> = [];
  const started = Date.now();
  let nextQuorumFlapAt = started + 70_000;
  let sustainedQuorumFlaps = 0;
  while (Date.now() - started < DURATION_MS) {
    const tabs: Array<Record<string, number>> = await Promise.all(
      sessions.map(session => readTabMetrics(session) as Promise<Record<string, number> & TabMetrics>),
    );
    samples.push({ at: Date.now(), tabs });
    if (Date.now() >= nextQuorumFlapAt) {
      closeRelay(1);
      closeRelay(2);
      sustainedQuorumFlaps++;
      nextQuorumFlapAt += 70_000;
    }
    await new Promise(resolve => setTimeout(resolve, SAMPLE_MS));
  }
  await Promise.all(sessions.map(session => session.send("HeapProfiler.collectGarbage")));
  const retainedEnd = await Promise.all(sessions.map(session => readTabMetrics(session)));

  const elapsedMinutes = Math.max(1 / 60, (samples.at(-1)!.at - samples[0]!.at) / 60_000);
  const results = samples[0]!.tabs.map((_, tab) => {
    const heaps = samples.map(sample => sample.tabs[tab]!.jsHeapUsed);
    const slope = (heaps.at(-1)! - heaps[0]!) / elapsedMinutes;
    const first = samples[0]!.tabs[tab]!;
    const last = samples.at(-1)!.tabs[tab]!;
    return {
      tab: tab + 1,
      startHeap: heaps[0],
      endHeap: heaps.at(-1),
      maxHeap: Math.max(...heaps),
      slope,
      taskDurationDeltaSeconds: last.taskDuration - first.taskDuration,
      documents: { start: first.documents, end: last.documents, delta: last.documents - first.documents },
      nodes: { start: first.nodes, end: last.nodes, delta: last.nodes - first.nodes },
      listeners: {
        start: retainedStart[tab]!.listeners,
        end: retainedEnd[tab]!.listeners,
        delta: retainedEnd[tab]!.listeners - retainedStart[tab]!.listeners,
        uncollectedEnd: last.listeners,
      },
    };
  });
  const diagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
    liveness: JSON.parse(localStorage.getItem("chama_liveness_diagnostics_v1") ?? "[]"),
    hydration: JSON.parse(localStorage.getItem("chama_hydration_diagnostics_v1") ?? "[]"),
    livenessCache: JSON.parse(localStorage.getItem("chama_liveness_verified_cache_v1") ?? "{}"),
    memory: (globalThis as any).__CHAMA_PROFILE_CLIENT__
      ?.getProfileMemorySnapshot?.() ?? null,
    bodyText: document.body.innerText,
  }))));
  const scenarioRequests = relayRequests.filter(request => request.at >= scenarioStartedAt);
  const reconnectTradeRequests = scenarioRequests.filter(request =>
    request.filters.some(filter => filter["#d"]?.includes(ESCROW_ID))
  );
  const reconnectWithoutSince = reconnectTradeRequests.filter(request =>
    request.filters.some(filter =>
      filter["#d"]?.includes(ESCROW_ID) && filter.since === undefined
    )
  );
  const recoveryFetchRequests = reconnectTradeRequests.filter(request =>
    request.subId.startsWith("sm_fetch_")
  );
  const scenarioTradeDeliveries = relayDeliveries.filter(delivery =>
    delivery.at >= scenarioStartedAt && delivery.escrowFiltered
  );
  const relayScenario = {
    relayCount: PROFILE_RELAY_COUNT,
    singleFlapRecoveryFetchDelta: afterSingleFlapFetches - beforeSingleFlapFetches,
    quorumFlapRecoveryFetchDelta: afterQuorumFlapFetches - afterSingleFlapFetches,
    sustainedQuorumFlaps,
    reconnectTradeRequestCount: reconnectTradeRequests.length,
    reconnectWithoutSinceCount: reconnectWithoutSince.length,
    recoveryFetchRequestCount: recoveryFetchRequests.length,
    recoveryFetchWithoutSinceCount: recoveryFetchRequests.filter(request =>
      request.filters.some(filter =>
        filter["#d"]?.includes(ESCROW_ID) && filter.since === undefined
      )
    ).length,
    deliveredTradeEventsAfterScenarioStart: scenarioTradeDeliveries.length,
    deliveredTradeContentBytesAfterScenarioStart: scenarioTradeDeliveries.reduce(
      (sum, delivery) => sum + delivery.contentBytes,
      0,
    ),
    deliveredChatEventsAfterScenarioStart: scenarioTradeDeliveries.filter(
      delivery => delivery.kind === EscrowEventKind.CHAT,
    ).length,
    minSince: Math.min(...reconnectTradeRequests.flatMap(request =>
      request.filters
        .filter(filter => filter["#d"]?.includes(ESCROW_ID))
        .map(filter => Number(filter.since))
        .filter(Number.isFinite)
    )),
  };
  const pass = results.every(result =>
    result.maxHeap < MAX_HEAP_BYTES
      && result.slope < MAX_SLOPE_BYTES_PER_MIN
      && result.documents.delta <= 0
      && result.nodes.delta <= MAX_NODE_GROWTH
      && result.listeners.delta <= MAX_LISTENER_GROWTH
  ) && diagnostics.every(item =>
    item.liveness.length >= 1
      && item.liveness[0].joinedCallers >= 2
      && item.liveness.every((run: any) =>
        run.finishedAt !== null
          && run.durationMs <= 12_500
          && run.maxSimultaneous === 1
          && run.outcome === "error"
      )
  ) && diagnostics[0]!.liveness.length >= 1
    && !!diagnostics[0]!.livenessCache["us-blf"]
    && diagnostics[0]!.bodyText.includes("1 arbiter")
    && !diagnostics[1]!.livenessCache["us-blf"]
    && diagnostics[1]!.bodyText.includes("liveness lights up once you're in")
    && relayScenario.singleFlapRecoveryFetchDelta === 0
    && relayScenario.quorumFlapRecoveryFetchDelta > 0
    && relayScenario.reconnectWithoutSinceCount === 0
    && relayScenario.recoveryFetchWithoutSinceCount === 0
    && relayScenario.deliveredChatEventsAfterScenarioStart === 0
    && diagnostics.every(item =>
      item.memory?.parsedChatMessages >= 1
        && item.memory?.hotRawChatEvents === 0
        && item.memory?.parsedChatRawContentBytes === 0
    );
  const summary = {
    pass,
    durationMs: DURATION_MS,
    results,
    relayScenario,
    diagnostics,
  };
  const artifactPath = join(tmpdir(), `chama-start9-relay-profile-${Date.now()}.json`);
  await writeFile(artifactPath, JSON.stringify({
    ...summary,
    relayRequests,
    relayDeliveries,
    samples,
  }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[fixture] full sample series: ${artifactPath}`);

  await cleanup();
  if (!pass) process.exitCode = 1;
}

(TARGET_URLS.length > 0 ? fieldMain() : main()).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await cleanup();
});
