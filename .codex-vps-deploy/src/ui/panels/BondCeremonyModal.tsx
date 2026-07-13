// ══════════════════════════════════════════════════════════════════════════
// Chama — Bond ceremony (single-key TIMELOCK COMMITMENT — the sealed v1 model)
// ══════════════════════════════════════════════════════════════════════════
//
// An arbiter posts a bond by locking THEIR OWN sats to THEIR OWN key until a
// term-end block height T — one Taproot CLTV leaf, no cabinet, no custody, no
// co-sign. Collusion-impossible by construction. The bond is a public, costly
// COMMITMENT signal, not a seizure pool (PHILOSOPHY §2.11, DECISIONS 2026-07-03).
// "Bonded" is how much × how long.
//
// Shape: a small "Your bonds" LIST (an arbiter can hold several — post another,
// watch each, reclaim each), with per-bond detail flows hanging off it:
//   describe (amount + term, min-term enforced) → funding (auto-polled — deposits
//   are DETECTED, not button-mashed) → locked (live countdown) → reclaimed.
//
// Chain-facing rules baked in (not patched on):
//   • the tip is polled once for the whole modal and is MONOTONIC — Mutinynet's
//     load-balanced Esplora jitters up/down, but a timelock only ever passes;
//   • the countdown is informational only — CONSENSUS is the reclaim authority
//     (the hook broadcasts and translates a genuine too-early rejection calmly);
//   • reclaim is a deliberate, confirmed, secondary action — never the reflexive
//     primary (that's Done), so a stray tap can't end a bond.
//
// Gated by SHOW_BOND_CEREMONY — LIVE for all users as of v5.0 (real mainnet bonds).
// Any arbiter can self-bond; there is no cabinet gate.

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { T } from "../theme.js";
import { CopyButton } from "../components/CopyButton.js";
import { listCommitmentBonds, getCommitmentBond, type CommitmentRecord } from "../../bond-multisig/commitment-store.js";
import { MIN_COMMITMENT_TERM_BLOCKS } from "../../bond-multisig/commitment-bond.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getAllPickerCountries, type PickerCountry } from "../../communities/countries.js";
import { countryMatchesSearch, countrySubline, resolveCountryCommunitySlug } from "../../communities/country-resolve.js";
import { getUserCommunitySlug } from "../../communities/storage.js";

const QRCode = lazy(() => import("../QRCode.js"));

/** Ship gate — LIVE for all users as of v5.0: anyone can post a real mainnet
 *  Bitcoin bond and become an assignable arbiter. Independent of BONDS_ENFORCED. */
export const SHOW_BOND_CEREMONY = true;

const SEED_AMOUNT_SATS = 21_000;
/** Term presets in BLOCKS (what the CLTV leaf commits to). Mainnet mines ~10-min
 *  blocks → ~144/day. The shortest preset IS the enforced minimum — anything shorter
 *  can expire before funding confirms. */
const TERM_PRESETS: { label: string; blocks: number }[] = [
  { label: `~1 day (${MIN_COMMITMENT_TERM_BLOCKS} blocks · the minimum)`, blocks: MIN_COMMITMENT_TERM_BLOCKS },
  { label: "~1 week (1008 blocks)", blocks: 1008 },
  { label: "~1 month (4320 blocks)", blocks: 4320 },
  { label: "~3 months (12960 blocks)", blocks: 12960 },
];
/** Warn on the funding screen when fewer than this many blocks remain. */
const NEAR_END_BLOCKS = 10;
const TIP_POLL_MS = 15_000;
const FUNDING_POLL_MS = 10_000;

export interface BondCeremonyModalProps {
  createCommitmentBond: (p: { amountSats: bigint; termBlocks: number }) =>
    Promise<{ bondId: string; address: string; lockUntil: number; amountSats: bigint; tipAtCreate: number }>;
  checkCommitmentFunding: (bondId: string) => Promise<{ locked: boolean; txid?: string; lockedSats?: bigint; deposits?: number }>;
  reclaimCommitmentBond: (bondId: string) => Promise<{ txid: string; alreadyReclaimed?: boolean }>;
  getBondChainTip: () => Promise<number>;
  /** Publish the chain-verifiable kind:38135 bond announcement FOR a community —
   *  the data source for that community's live-chama liveness. Optional so the
   *  ceremony still renders where a caller hasn't wired it. */
  publishBondAnnouncement?: (bondId: string, community: string) => Promise<{ community: string; address: string }>;
  onClose: () => void;
}

type View =
  | { kind: "list" }
  | { kind: "describe" }
  | { kind: "working"; label: string }
  | { kind: "funding"; bondId: string }
  | { kind: "locked"; bondId: string; foundNote?: string }
  | { kind: "reclaimed"; bondId: string; txid: string }
  | { kind: "error"; message: string };

export function BondCeremonyModal({ createCommitmentBond, checkCommitmentFunding, reclaimCommitmentBond, getBondChainTip, publishBondAnnouncement, onClose }: BondCeremonyModalProps) {
  // Open on the list when any bond exists; straight to describe on a first run.
  const [view, setView] = useState<View>(() => (listCommitmentBonds().length > 0 ? { kind: "list" } : { kind: "describe" }));
  const [amountStr, setAmountStr] = useState(String(SEED_AMOUNT_SATS));
  const [termBlocks, setTermBlocks] = useState(TERM_PRESETS[0].blocks);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tip, setTip] = useState<number | null>(null);
  const [confirmReclaim, setConfirmReclaim] = useState(false);
  // Announce-to-community state (locked screen). Default to the user's own community.
  const [announceSlug, setAnnounceSlug] = useState<string>(() => getUserCommunitySlug());
  const [announcing, setAnnouncing] = useState(false);
  const [announcedTo, setAnnouncedTo] = useState<string | null>(null);
  const [announceErr, setAnnounceErr] = useState<string | null>(null);
  // Bump to re-read the store after a check/reclaim mutates it.
  const [storeRev, setStoreRev] = useState(0);

  // Pin the action props in refs so the poll effects' identities never change
  // (else the intervals are torn down every render and never fire).
  const tipFnRef = useRef(getBondChainTip);
  tipFnRef.current = getBondChainTip;
  const checkFnRef = useRef(checkCommitmentFunding);
  checkFnRef.current = checkCommitmentFunding;
  // Bonds already auto-announced this session (so opening a locked bond from the
  // list doesn't re-fire — only a fresh on-chain lock detection does).
  const autoAnnouncedRef = useRef<Set<string>>(new Set());

  // ── ONE monotonic chain tip for the whole modal ──────────────────────────────
  // Mutinynet's Esplora is load-balanced across nodes at slightly different
  // heights, so raw polls jitter up/down; a timelock only ever passes, so never
  // let a lower reading re-lock a ready bond. Informational only — consensus is
  // the reclaim authority.
  useEffect(() => {
    let cancelled = false;
    const pull = () => { tipFnRef.current().then((t) => { if (!cancelled && Number.isFinite(t)) setTip((prev) => (prev == null ? t : Math.max(prev, t))); }).catch(() => {}); };
    pull();
    const id = setInterval(pull, TIP_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Funding auto-poll: deposits are DETECTED, not button-mashed ──────────────
  const fundingBondId = view.kind === "funding" ? view.bondId : null;
  useEffect(() => {
    if (!fundingBondId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await checkFnRef.current(fundingBondId);
        if (cancelled) return;
        setStoreRev((n) => n + 1);
        if (r.locked) {
          const n = r.deposits ?? 1;
          setNote(null);
          autoAnnounceOnLock(fundingBondId);
          setView({ kind: "locked", bondId: fundingBondId, foundNote: `Found ${n} deposit${n === 1 ? "" : "s"} totaling ${(r.lockedSats ?? 0n).toString()} sats — locked.` });
        }
      } catch { /* transient — keep watching */ }
    };
    void poll();
    const id = setInterval(() => void poll(), FUNDING_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [fundingBondId]);

  const bonds = (() => { void storeRev; return listCommitmentBonds(); })();
  const backToList = () => { setNote(null); setConfirmReclaim(false); setAnnouncedTo(null); setAnnounceErr(null); setStoreRev((n) => n + 1); setView({ kind: "list" }); };

  const amountSats = (() => { const n = Math.floor(Number(amountStr)); return Number.isFinite(n) && n > 0 ? BigInt(n) : 0n; })();

  const post = async () => {
    if (amountSats <= 0n) { setView({ kind: "error", message: "Enter a bond amount greater than zero." }); return; }
    setView({ kind: "working", label: "Building your timelock bond…" });
    try {
      const r = await createCommitmentBond({ amountSats, termBlocks });
      setStoreRev((n) => n + 1);
      setView({ kind: "funding", bondId: r.bondId });
    } catch (e: any) {
      setView({ kind: "error", message: e?.message || "Couldn’t build the bond. Reconnect and try again." });
    }
  };

  const checkNow = async (bondId: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await checkFnRef.current(bondId);
      setStoreRev((n) => n + 1);
      if (r.locked) {
        const n = r.deposits ?? 1;
        autoAnnounceOnLock(bondId);
        setView({ kind: "locked", bondId, foundNote: `Found ${n} deposit${n === 1 ? "" : "s"} totaling ${(r.lockedSats ?? 0n).toString()} sats — locked.` });
      } else setNote("Nothing confirmed at this address yet — Mutinynet confirms in ~30–60s. Watching…");
    } catch (e: any) { setNote(e?.message || "Couldn’t reach the chain."); }
    finally { setBusy(false); }
  };

  const reclaim = async (bondId: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await reclaimCommitmentBond(bondId);
      setStoreRev((n) => n + 1);
      setView({ kind: "reclaimed", bondId, txid: r.txid });
    } catch (e: any) { setNote(e?.message || "Reclaim failed."); }
    finally { setBusy(false); }
  };

  // Fire the liveness announcement the instant a bond locks — a funded bond IS
  // the signal, so it publishes to the arbiter's HOME community automatically,
  // no button press. Once per bond; the manual picker below stays for
  // re-announcing or announcing to ANOTHER community. Fails soft (retry re-arms).
  const autoAnnounceOnLock = (bondId: string) => {
    if (!publishBondAnnouncement || autoAnnouncedRef.current.has(bondId)) return;
    // Never auto-publish a DEAD signal: once a bond's term ends it reads
    // active=false on-chain, so it wouldn't count toward liveness anyway.
    const recForBond = getCommitmentBond(bondId);
    if (recForBond && tip != null && tip >= recForBond.bond.lockUntil) return;
    autoAnnouncedRef.current.add(bondId);
    const slug = getUserCommunitySlug();
    void publishBondAnnouncement(bondId, slug)
      .then(() => { setAnnounceSlug(slug); setAnnouncedTo(getCommunityBySlug(slug)?.displayName ?? slug); })
      .catch(() => { autoAnnouncedRef.current.delete(bondId); });
  };

  const announce = async (bondId: string, slug: string) => {
    if (!publishBondAnnouncement) return;
    setAnnouncing(true); setAnnounceErr(null); setAnnouncedTo(null);
    try {
      const r = await publishBondAnnouncement(bondId, slug);
      setAnnouncedTo(getCommunityBySlug(r.community)?.displayName ?? r.community);
    } catch (e: any) {
      setAnnounceErr(e?.message || "Couldn’t publish the announcement. Reconnect and try again.");
    } finally { setAnnouncing(false); }
  };

  const closeable = view.kind !== "working";

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000c", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget && closeable) onClose(); }}>
      <div style={{ background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, width: "100%", maxWidth: 380, maxHeight: "90vh", overflow: "auto", padding: 20 }}>
        <Header onClose={onClose} closeable={closeable} />

        {view.kind === "list" && (
          <BondList
            bonds={bonds}
            tip={tip}
            onOpen={(rec) => {
              setNote(null); setConfirmReclaim(false);
              if (rec.phase === "created") setView({ kind: "funding", bondId: rec.bondId });
              else if (rec.phase === "locked") setView({ kind: "locked", bondId: rec.bondId });
              else if (rec.reclaimTxid) setView({ kind: "reclaimed", bondId: rec.bondId, txid: rec.reclaimTxid });
            }}
            onPostNew={() => { setNote(null); setView({ kind: "describe" }); }}
          />
        )}

        {view.kind === "describe" && (
          <>
            {bonds.length > 0 && <BackToBonds onClick={backToList} />}
            <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 16, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "12px 14px" }}>
              You lock <b>your own sats</b>, to <b>your own key</b>, on-chain, for a term. Nobody else can
              touch it, and <b>you can’t pull it back until the term ends</b> — that’s the whole signal.
              It’s <b style={{ color: T.accent }}>how much × how long</b> that says you’re serious.
            </div>
            <label style={labelStyle}>Bond amount (sats)</label>
            <input value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric"
              style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 15, padding: "10px 12px", marginBottom: 12 }} />
            <label style={labelStyle}>Term (until you can reclaim)</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {TERM_PRESETS.map((p) => (
                <button key={p.blocks} onClick={() => setTermBlocks(p.blocks)}
                  style={{ ...secondaryBtn, marginBottom: 0, textAlign: "left", border: `1px solid ${termBlocks === p.blocks ? T.accent : T.border}`, color: termBlocks === p.blocks ? T.text : T.muted }}>
                  {termBlocks === p.blocks ? "◉ " : "○ "}{p.label}
                </button>
              ))}
            </div>
            <button onClick={post} disabled={amountSats <= 0n} style={primaryBtn(amountSats > 0n)}>Post my bond</button>
          </>
        )}

        {view.kind === "working" && (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <div style={{ fontSize: 26, marginBottom: 12 }}>⚙️</div>
            <div style={{ fontSize: 13, color: T.text, fontFamily: T.mono }}>{view.label}</div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 6 }}>No sats move — this only builds the address.</div>
          </div>
        )}

        {view.kind === "funding" && (() => {
          const rec = getCommitmentBond(view.bondId);
          if (!rec) return <MissingBond onBack={backToList} />;
          const toGo = tip != null ? rec.bond.lockUntil - tip : null;
          return (
            <div>
              <BackToBonds onClick={backToList} />
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.mono, marginBottom: 4 }}>Fund your bond</div>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 12, lineHeight: 1.5 }}>
                Send <b style={{ color: T.text }}>at least {rec.amountSats.toString()} sats</b> on-chain to this address — more is a bigger bond, and several sends all count. Whatever lands here locks until block <b style={{ color: T.text }}>{rec.bond.lockUntil}</b>.
              </div>
              {toGo != null && toGo <= 0 && (
                <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginBottom: 10, lineHeight: 1.5, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px" }}>
                  ⚠ This bond’s term has <b>already ended</b> — a deposit now would be instantly reclaimable and signals nothing. Post a fresh bond instead.
                </div>
              )}
              {toGo != null && toGo > 0 && toGo <= NEAR_END_BLOCKS && (
                <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, marginBottom: 10, lineHeight: 1.5 }}>
                  ⚠ Only ~{toGo} block{toGo === 1 ? "" : "s"} (~{humanTime(toGo)}) left on this term — a deposit needs a block to confirm, so it may lock already-reclaimable.
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                <Suspense fallback={<div style={{ width: 180, height: 180, background: T.surface, borderRadius: T.rs }} />}>
                  <QRCode data={rec.bond.address} size={180} />
                </Suspense>
              </div>
              <div style={{ fontSize: 10.5, color: T.text, fontFamily: T.mono, wordBreak: "break-all", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", marginBottom: 8 }}>{rec.bond.address}</div>
              <CopyButton value={rec.bond.address} label="Copy address" style={secondaryBtn} />
              <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, textAlign: "center", marginTop: 4, lineHeight: 1.5 }}>
                👀 Watching the chain — deposits are detected automatically (checks every {FUNDING_POLL_MS / 1000}s).
              </div>
              <button onClick={() => void checkNow(view.bondId)} disabled={busy} style={{ ...secondaryBtn, marginTop: 8 }}>
                {busy ? "Checking…" : "Check now"}
              </button>
              {note && <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5, textAlign: "center" }}>{note}</div>}
            </div>
          );
        })()}

        {view.kind === "locked" && (() => {
          const rec = getCommitmentBond(view.bondId);
          if (!rec) return <MissingBond onBack={backToList} />;
          const deposits = rec.utxos ?? [];
          const notYet = tip != null && tip < rec.bond.lockUntil;
          const expired = tip != null && !notYet; // term ended — the signal is dead until renewed
          const toGo = tip != null ? Math.max(0, rec.bond.lockUntil - tip) : null;
          return (
            <div style={{ padding: "2px 0", textAlign: "center" }}>
              <BackToBonds onClick={backToList} />
              <div style={{ fontSize: 30, marginBottom: 10 }}>{expired ? "⏳" : "🔒"}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: expired ? T.accent : T.green, fontFamily: T.mono, marginBottom: 8 }}>{expired ? "Your bond’s term ended" : "Your bond is locked"}</div>
              {view.foundNote && <div style={{ fontSize: 10.5, color: T.green, fontFamily: T.mono, marginBottom: 8 }}>{view.foundNote}</div>}
              <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
                <b>{rec.amountSats.toString()} sats</b> committed on-chain{deposits.length > 1 ? <> across <b>{deposits.length} deposits</b></> : null} until block <b>{rec.bond.lockUntil}</b>. It cannot move before then — not by you, not by anyone. After the term, only you can reclaim it.
              </div>
              {!expired && <ArbiterDuties />}
              {deposits.length > 0 && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", marginBottom: 12 }}>
                  <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 }}>{deposits.length} DEPOSIT{deposits.length === 1 ? "" : "S"} AT THIS ADDRESS</div>
                  {deposits.map((d) => (
                    <div key={`${d.txid}:${d.index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: T.text, fontFamily: T.mono, marginBottom: 3 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.txid.slice(0, 10)}…{d.txid.slice(-6)}:{d.index}</span>
                      <span style={{ flexShrink: 0, color: T.muted }}>{d.amountSats.toString()}</span>
                    </div>
                  ))}
                  <button onClick={() => void checkNow(view.bondId)} disabled={busy}
                    style={{ background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 9.5, cursor: "pointer", padding: "4px 0 0", textDecoration: "underline" }}>
                    {busy ? "checking…" : "check for more deposits"}
                  </button>
                </div>
              )}
              {/* Informational countdown only (monotonic tip). Reclaim is a DELIBERATE
                  two-step action, never the reflexive primary button (which is Done),
                  so a stray tap after locking can't return the bond. Consensus is the
                  real gate: an early reclaim is rejected and surfaced as "almost". */}
              {notYet && (
                <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, marginBottom: 8, lineHeight: 1.5, textAlign: "center" }}>
                  Unlocks at block {rec.bond.lockUntil} — ~{toGo} block{toGo === 1 ? "" : "s"} to go (~{humanTime(toGo!)}).
                </div>
              )}
              {!notYet && tip != null && (
                <div style={{ fontSize: 10.5, color: T.accent, fontFamily: T.mono, marginBottom: 8, lineHeight: 1.5, textAlign: "center" }}>
                  ⏳ This term is up — the bond no longer counts toward any chama’s liveness. Reclaim your sats, then post a fresh bond to keep arbitrating.
                </div>
              )}
              {/* Announce this bond to a community — publishes the chain-verifiable
                  kind:38135 event so the community's live-chama score can count it.
                  A commitment made in public is the whole point of the signal. */}
              {publishBondAnnouncement && !confirmReclaim && !expired && (
                <AnnounceBond
                  slug={announceSlug} onSlug={setAnnounceSlug}
                  announcing={announcing} announcedTo={announcedTo} error={announceErr}
                  onAnnounce={() => void announce(view.bondId, announceSlug)}
                />
              )}
              {confirmReclaim ? (
                <>
                  <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, marginBottom: 8, lineHeight: 1.5 }}>
                    Reclaim now? This <b>ends the bond</b> and returns your sats to your own key.
                  </div>
                  <button onClick={() => { setConfirmReclaim(false); void reclaim(view.bondId); }} disabled={busy} style={{ ...primaryBtn(!busy), background: T.amber, borderColor: T.amber }}>
                    {busy ? "Reclaiming…" : "Yes, reclaim my bond"}
                  </button>
                  <button onClick={() => setConfirmReclaim(false)} disabled={busy} style={{ ...secondaryBtn, marginTop: 6 }}>Cancel</button>
                </>
              ) : expired ? (
                <>
                  <button onClick={() => { setNote(null); setConfirmReclaim(true); }}
                    style={{ ...primaryBtn(true), background: T.accent, borderColor: T.accent, boxShadow: `0 0 14px ${T.accent}66` }}>
                    Reclaim my bond
                  </button>
                  <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 6 }}>Not now</button>
                </>
              ) : (
                <>
                  <button onClick={onClose} style={primaryBtn(true)}>Done</button>
                  <button onClick={() => { setNote(null); setConfirmReclaim(true); }} style={{ ...secondaryBtn, marginTop: 6 }}>Reclaim my bond</button>
                </>
              )}
              {note && <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
            </div>
          );
        })()}

        {view.kind === "reclaimed" && (
          <div style={{ padding: "6px 0", textAlign: "center" }}>
            <BackToBonds onClick={backToList} />
            <div style={{ fontSize: 30, marginBottom: 10 }}>🎉</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: T.green, fontFamily: T.mono, marginBottom: 8 }}>Bond reclaimed</div>
            <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
              The term is up and your sats are on their way back to your own key.
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, wordBreak: "break-all", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "6px 8px", marginBottom: 8 }}>{view.txid}</div>
            <CopyButton value={view.txid} label="Copy txid" style={secondaryBtn} />
            <button onClick={() => setView({ kind: "describe" })} style={primaryBtn(true)}>Post a fresh bond</button>
            <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 6 }}>Done</button>
          </div>
        )}

        {view.kind === "error" && (
          <div style={{ padding: "8px 0" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: T.mono, marginBottom: 8 }}>Something went wrong</div>
            <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 16 }}>{view.message}</div>
            <button onClick={() => setView({ kind: "describe" })} style={primaryBtn(true)}>Back</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── The "Your bonds" list — post another · watch each · reclaim each ─────────
function BondList({ bonds, tip, onOpen, onPostNew }: {
  bonds: CommitmentRecord[];
  tip: number | null;
  onOpen: (rec: CommitmentRecord) => void;
  onPostNew: () => void;
}) {
  const active = bonds.filter((b) => b.phase !== "reclaimed");
  const past = bonds.filter((b) => b.phase === "reclaimed");
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.mono, marginBottom: 10 }}>Your bonds</div>
      {active.length === 0 && (
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
          No live bond right now. Post one — locked capital, in the open, is the signal.
        </div>
      )}
      {active.map((b) => <BondRow key={b.bondId} rec={b} tip={tip} onOpen={onOpen} />)}
      <button onClick={onPostNew} style={{ ...primaryBtn(true), marginTop: 6 }}>Post a new bond</button>
      {past.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 }}>PAST BONDS</div>
          {past.map((b) => <BondRow key={b.bondId} rec={b} tip={tip} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

function BondRow({ rec, tip, onOpen }: { rec: CommitmentRecord; tip: number | null; onOpen: (rec: CommitmentRecord) => void }) {
  const toGo = tip != null ? rec.bond.lockUntil - tip : null;
  const status = (() => {
    if (rec.phase === "created") return { chip: "AWAITING FUNDING", color: T.amber, line: "send sats to activate" };
    if (rec.phase === "reclaimed") return { chip: "RECLAIMED", color: T.muted, line: rec.reclaimTxid ? `swept · ${rec.reclaimTxid.slice(0, 10)}…` : "swept" };
    if (toGo != null && toGo <= 0) return { chip: "TERM ENDED", color: T.accent, line: "reclaimable — or leave it locked" };
    return { chip: "LOCKED", color: T.green, line: toGo != null ? `unlocks in ~${toGo} blocks (~${humanTime(toGo)})` : `unlocks at block ${rec.bond.lockUntil}` };
  })();
  return (
    <button onClick={() => onOpen(rec)}
      style={{ display: "block", width: "100%", textAlign: "left", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "10px 12px", marginBottom: 8, cursor: "pointer" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.mono }}>
          {rec.phase === "created" ? `${rec.amountSats.toString()} sats planned` : `${rec.amountSats.toString()} sats`}
        </span>
        <span style={{ fontSize: 8.5, fontWeight: 800, color: status.color, fontFamily: T.mono, letterSpacing: 1, border: `1px solid ${status.color}`, borderRadius: 99, padding: "2px 8px", flexShrink: 0 }}>
          {status.chip}
        </span>
      </div>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
        until block {rec.bond.lockUntil} · {status.line}
      </div>
    </button>
  );
}

// What a bonded arbiter is actually signing up for — shown the moment they lock,
// so "place your sats here while you perform your duties" states the duties plainly.
// Your bond is a commitment TO these; it's the stake behind your word.
function ArbiterDuties() {
  const duties: { icon: string; text: string }[] = [
    { icon: "⚖️", text: "Step in on disputes — when a trade stalls, either side can call you to judge it." },
    { icon: "💬", text: "Stay reachable — answer in the trade chat when a decision is needed." },
    { icon: "🤝", text: "Judge honestly — release to whoever the evidence favors. Your ratings and bond ride on it." },
  ];
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "10px 12px", marginBottom: 12, textAlign: "left" }}>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>WHILE IT’S LOCKED, YOU ARBITER</div>
      <div style={{ display: "grid", gap: 8 }}>
        {duties.map((d) => (
          <div key={d.text} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
            <span style={{ fontSize: 13, lineHeight: 1.3, flexShrink: 0 }}>{d.icon}</span>
            <span style={{ fontSize: 10.5, color: T.text, fontFamily: T.mono, lineHeight: 1.5 }}>{d.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The announce-to-community control on the locked screen. A search over ALL 190
// countries (NOT just the curated feds) — a Chama is any community living inside a
// country, with or without a G-Bot fed, so an arbiter can bond for any of them.
// Picking a country resolves it to a stable community slug (persisting a generated
// shell so it's real). One publish button; success is a calm line, never a modal.
// Re-announcing is fine (replaceable event — it just refreshes).
function AnnounceBond({ slug, onSlug, announcing, announcedTo, error, onAnnounce }: {
  slug: string;
  onSlug: (slug: string) => void;
  announcing: boolean;
  announcedTo: string | null;
  error: string | null;
  onAnnounce: () => void;
}) {
  const [query, setQuery] = useState("");
  const countries = getAllPickerCountries();
  const selected = getCommunityBySlug(slug);
  const search = query.trim().toLowerCase();
  const matches = search ? countries.filter((c) => countryMatchesSearch(c, search)).slice(0, 40) : [];
  const pick = (c: PickerCountry) => { onSlug(resolveCountryCommunitySlug(c)); setQuery(""); };
  return (
    <div style={{ marginTop: 12, marginBottom: 6, paddingTop: 12, borderTop: `1px solid ${T.border}`, textAlign: "left" }}>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 }}>ANNOUNCE TO A COMMUNITY</div>
      <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 8 }}>
        Publish this bond so a community counts it toward its <b style={{ color: T.text }}>liveness</b> — proof there’s a bonded arbiter here, verifiable against the chain. Any country, with or without a local fed.
      </div>
      {/* The chama this bond will announce for (defaults to your home). */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "9px 11px", marginBottom: 8 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>{selected?.flagEmoji ?? "🌍"}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected?.displayName ?? slug}</div>
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>announcing here</div>
        </div>
      </div>
      <input
        value={query} onChange={(e) => setQuery(e.target.value)} disabled={announcing}
        placeholder="Search 190+ countries…" autoComplete="off" autoCapitalize="off" spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 12, padding: "9px 11px", marginBottom: 8, outline: "none" }}
      />
      {search && (
        <div style={{ display: "grid", gap: 6, maxHeight: 176, overflowY: "auto", marginBottom: 8, paddingRight: 2 }}>
          {matches.length === 0 ? (
            <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, padding: "8px 4px" }}>No country matches “{query}”.</div>
          ) : matches.map((c) => (
            <button key={c.code} onClick={() => pick(c)} disabled={announcing}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", cursor: "pointer" }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>{c.flag}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 12, color: T.text, fontFamily: T.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ display: "block", fontSize: 9, color: T.muted, fontFamily: T.mono }}>{countrySubline(c)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <button onClick={onAnnounce} disabled={announcing || !slug} style={{ ...secondaryBtn, marginBottom: 0, borderColor: T.accent, color: T.accent }}>
        {announcing ? "Announcing…" : announcedTo ? "Announce again" : "Announce my bond"}
      </button>
      {announcedTo && (
        <div style={{ fontSize: 10.5, color: T.green, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5 }}>
          ✓ Announced to <b>{announcedTo}</b> — it now counts toward that chama’s liveness.
        </div>
      )}
      {error && <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

function BackToBonds({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 10.5, cursor: "pointer", padding: 0, marginBottom: 10, display: "block", textAlign: "left" }}>
      ← All bonds
    </button>
  );
}

function MissingBond({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
        This bond isn’t in local storage anymore (its record failed the tamper gate, or storage was cleared).
        Funded sats are still safe on-chain — they answer only to your key.
      </div>
      <button onClick={onBack} style={primaryBtn(true)}>Back to bonds</button>
    </div>
  );
}

function Header({ onClose, closeable }: { onClose: () => void; closeable: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>ARBITER BOND</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.3 }}>Your commitment, on-chain</div>
      </div>
      {closeable && <button onClick={onClose} style={{ background: "none", border: "none", color: T.muted, fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>}
    </div>
  );
}

// Rough human time for a block count (mainnet mines ~10-min blocks).
function humanTime(blocks: number): string {
  const mins = blocks * 10;
  if (mins < 90) return `${Math.max(1, Math.ceil(mins))} min`;
  const hrs = mins / 60;
  if (hrs < 48) return `${Math.round(hrs)} h`;
  return `${Math.round(hrs / 24)} days`;
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 };
const secondaryBtn: React.CSSProperties = { width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 12, padding: "9px 12px", cursor: "pointer", marginBottom: 8 };
function primaryBtn(enabled: boolean): React.CSSProperties {
  return { width: "100%", background: enabled ? T.accent : T.surface, border: `1px solid ${enabled ? T.accent : T.border}`, borderRadius: T.rs, color: enabled ? "#0a0a0f" : T.muted, fontFamily: T.mono, fontSize: 13, fontWeight: 700, padding: "11px 12px", cursor: enabled ? "pointer" : "default" };
}
