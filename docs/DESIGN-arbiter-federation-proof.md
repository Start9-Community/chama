# Design — Arbiter Federation Proof (Level A: the federation-owner credential)

Status: DESIGN — **REPOSITIONED 2026-06-15.** Originally drafted as *the* C7-closer
(the "federation-owner credential"); it is now the **OPTIONAL, self-hosted-only**
path. The **primary** C7-closer is the **bonded cabinet's signed `kind:38120`
roster** (see DESIGN-arbiter-economy.md). What stays first-class in this doc: the
**invite decoder + squat-check** (§3). What demotes to an optional bonus: the
**meta-endorsement read** (§4 Level A / §5).

> **Why the demotion (read first).** On a Fedi **G-Bot** federation, OG approval is
> *template-gated* — Fedi's automation signs only fields already in its template, so
> a custom `chama:arbiters` proposal never reaches threshold (confirmed on BLF,
> 2026-06-15; see `reference_fedimint_meta_fields`). And even where it *does* work
> (feds whose guardians you control), a G-Bot endorsement is Fedi-operated anyway.
> So the bonded-cabinet roster — a registry-pinned trio of reputation-anchored
> Level-A founders with real money locked — is the **Fedi-independent** "authority
> outside the attacker's keyspace" that actually closes C7. Fed-meta Level-A remains
> a genuine *bonus* proof for self-hosted feds; the §8 "open decisions" are largely
> moot under this model (the role ladder is just Anchor vs Bonded — economy doc §1).

Money-path: read-only. Nothing here moves ecash or touches the 2-of-3. It feeds the
verified-roster green badge (C7), not the escrow state machine.

## 0. Provenance & a correction (so future-you trusts the facts below)

An early pass misattributed the satoshimarket.app invitation QR to **GBF**. That
was wrong, and the way it was wrong is instructive. The claim came from a
`WebFetch` whose summarizer model returned GBF's invite string — pulled out of
the app bundle (every federation constant in `src/fedimint/federation-invites.ts`
compiles in), not the invite the page actually renders. Two deterministic checks
corrected it:

- **Raw `curl https://satoshimarket.app/`** returns exactly one `fed1…` string,
  and it is **BLF** (`fed11…ajrwvmxv…k7ram` = `BLF_FEDERATION_INVITE`).
- **Local bech32m decode** of the raw constants (no network, no summarizer):

  | Constant | Commits to fed id | Matches its label? | Transport |
  |---|---|---|---|
  | `BLF_FEDERATION_INVITE` | `888b70ec…2b9e` | ✅ | `iroh://d73fffd0…` |
  | `GBF_FEDERATION_INVITE` | `1bcb64e6…3b97` | ✅ | `iroh://2491c8be…` |

Conclusion: the constants are **correctly labeled and internally consistent**,
and satoshimarket.app **correctly serves BLF**. There is no code/production
misconfiguration. **Lesson, load-bearing for the verifier itself: never trust a
summarizer for an exact string — decode/curl the raw bytes.** The verifier MUST
verify `calculate_federation_id(config) == claimed_id` itself, never via a
third-party description.

## 1. The problem (today)

Arbiter applications (kind:38121) carry a federation invite as **unvalidated free
text appended to the statement** (`src/ui/components/ArbiterApplyForm.tsx`). There
is no schema field, no uniqueness check, no proof. Two applicants can paste the
same invite; the steward sees both and decides by eyeball. Eyeballs can judge
*quality*; they cannot adjudicate a *cryptographic claim* — so "that federation
is mine" is unfalsifiable today, which is the squatting/impersonation hole.

Two problems hide here. Keep them separate:

- **(A) Impersonation / squatting** — *cryptographically solvable*. Whether an
  npub is endorsed by a federation is provable against the federation itself.
  This doc.
- **(B) Quality / Sybil** — *not* provable. A throwaway federation costs ~$10/mo
  solo or ~$30/mo for a turnkey G-Bot 4-guardian fed. Handled by the economic
  layer (ratings → exposure ramp → bonds) in `docs/DESIGN-arbiter-economy.md`,
  not here.

## 2. Protocol reality (verified against fedimint master + the shipped `@fedimint/core`)

- **FederationId = sha256 of the guardian API-endpoint set** (URLs + names),
  **NOT** the guardian keys. The in-tree code comment claiming "threshold public
  key" is stale; the implementation hashes `api_endpoints`. → see the resurrection
  caveat (§7).
- **Config fetch is unauthenticated.** `WalletDirector.previewFederation(invite)`
  returns the client config (`api_endpoints`, `modules`, `broadcast_public_keys`,
  static `meta`) **without joining or holding funds**. But static config `meta`
  carries only DKG-time fields (e.g. `federation_name`) — **not** the runtime
  meta you write in the admin console.
- **The meta MODULE (`kind: "meta"`) is the only guardian-threshold-writable AND
  threshold-readable channel.**
  - Write = each guardian submits a byte-identical value; the value changes only
    at ≥ threshold consensus. **This is exactly the guardian-UI "Propose New
    Metadata" + other-OG-approval flow.** (Confirmed: the maintainer has done
    this twice on BLF.)
  - Read = module `'meta'`, method `'get_consensus_value'`, key `0`
    (`DEFAULT_META_KEY`). SDK surface: `FederationService.getMetaConsensusValue(0)`
    — **only available on a JOINED wallet client.**
- **`meta_override_url` is poison for proofs.** It is a single webhost whose JSON
  *silently overrides* consensus meta in stock clients. The verifier must read
  `get_consensus_value` directly and **never** the merged/legacy meta source.
- **Fedimint Observer is not an oracle.** It reads the legacy meta channel and
  only indexes listed feds. BLF (private/L3) returns **HTTP 400** — unlisted.
  Even for listed feds its `/meta` shows static meta, not the module value.
- **Transport is Iroh, not WebSocket.** BLF and GBF guardians are addressed as
  `iroh://<nodeid>` (QUIC p2p). There is **no `wss://`/`https://` endpoint** in
  the invite. → You cannot probe with `curl`, `wscat`, or a plain `WebSocket`.
  Only a Fedimint-aware client that speaks Iroh — i.e. the `@fedimint/core` WASM
  client you already ship — can reach the guardians.

## 3. What already exists in the tree (don't rebuild it)

- `expectedFederationIdForInvite()` — `src/fedimint/federation-config.ts:167` —
  invite→id map for the pinned feds. **Half the anti-squat binding already.**
- `getMetaModuleConsensus()` — `src/fedimint/sdk-adapter.ts:950` — already calls
  `getMetaConsensusValue(0)` on the joined wallet, with a low-level
  `rpcSingle('meta','get_consensus_value',{key:0})` fallback, logged as the init
  `metaProbe`. **So the OWN-fed meta read is wired today** — it just hasn't been
  pointed at the arbiter use-case. (Confirm it returns your BLF writes by watching
  for `[chama] federation.getMetaConsensusValue key=0(default) -> …` in the
  console; if it logs `null`, the value isn't on key 0 — see §7 malformed-JSON.)
- Local trustless decode recipe (bech32m → fed id + guardian set), reproducible.

## 4. The proof ladder

- **Level A — federation-endorsed (gold) — now OPTIONAL / self-hosted-only** (repositioned 2026-06-15; the cabinet roster is the primary C7-closer — see the banner up top; on a G-Bot fed this is Fedi-template-gated and won't reach threshold). A meta-module field `chama:arbiters`
  (a JSON **list of npubs** — format locked 2026-06-13) lists the federation's
  endorsed arbiter keys; the applicant's npub must be among them.
  Threshold-written by the guardians, threshold-read by the chama client. Passing
  means the federation *as a governance body* endorses the npub. Closes C7. This
  is the DNS-Persist-01 pattern: a persistent record, re-checkable live, instead
  of a one-shot challenge. **Economic tie-in (revised 2026-06-13):** Level A is
  **identity only** — it earns the anti-squat green badge and ratings/trust weight
  (more for an *established* fed: guardian count ≥ threshold + age + activity, all
  observable — a throwaway solo fed earns little), but grants **no** bond
  exemption. Bonds are universal and self-selected by stake at every exposure
  tier, Gold included (DESIGN-arbiter-economy.md, locked 2026-06-13). Identity and
  skin-in-the-game are separate gates; Gold needs both.
- **Level B — guardian-verified (fallback).** *(Deprecated 2026-06-14: under the
  cabinet + commitment-bond model the role ladder collapses to 2 tiers — Anchor (A)
  vs Bonded arbiter — so B is no longer used; a non-anchor simply posts a bond.
  Kept for reference. See DESIGN-arbiter-economy.md, v3 2026-06-14 §1.)* Applicant produces a fresh
  `sign_guardian_metadata` / `sign_api_announcement` artifact (Schnorr,
  password-gated, timestamped) verifiable against the config's
  `broadcast_public_keys`. Proves control of **one** guardian, not threshold.
- **Level C — unverified.** Community link or claimed invite only. Listed,
  display-only, **never** green-badge eligible.

G-Bot caveat (verified 2026-06-13): on a **Fedi G-Bot** federation the Lead
Guardian is 1-of-4 with three Fedi-*matched, Fedi-hosted, anonymous* OGs, and the
3-of-4 approval is reportedly "semi-automated" by Fedi's infra — so a G-Bot
Level-A endorsement carries a **Fedi trust dependency** and is NOT proof of three
independent humans (see the Trust-boundary caveat in §7). It is fully meaningful
for a self-hosted, independently-guardianed fed. Level B is the everyday path;
Level A is worth doing once per anchor.

## 5. The read mechanism (how to probe from outside — precisely)

**Case A — own / registry-pinned fed (already joined):**
`wallet.federation.getMetaConsensusValue(0)`. Already wired (§3). One call.

**Case B — verify ANOTHER arbiter's claimed fed (the net-new verifier):**
1. `previewFederation(invite)` — **no join.** Assert
   `calculate_federation_id == claimed_id`; run the squat-check vs pinned feds
   (build on `expectedFederationIdForInvite`). Capture `broadcast_public_keys`.
2. Read the meta module. The shipped SDK exposes `get_consensus_value` **only on
   a joined `FederationService`**, so use an **isolated transient verifier
   wallet** (separate `clientName` / OPFS namespace) to join → read → discard.
   Keep it off the spending wallet to avoid `withMintLock` / OPFS collisions
   (see the v3.4.0 mint-mutex model). **Cache by fed id; re-verify on cadence.**
3. Longer-term: upstream a *preview-level* meta read (no join) — `get_consensus_value`
   is a public endpoint; there's no protocol reason it must require a join.

Then parse key-0 (a single JSON blob), extract `chama:arbiter(s)`, and assert the
named npub == the applicant's pubkey.

## 6. Squat / contested-claim policy (decide in writing, before launch)

Prior art is unanimous: ad-hoc adjudication destroys trust (npm, PEP-541), and
pure first-come-forever produces permanent squats (ENS).

1. **The seat follows the meta key.** Whoever the federation's threshold meta
   currently names holds it. Intra-federation disputes (two real guardians) go to
   the federation's own governance — never into chama's lap.
2. **Pinned feds auto-collision-check.** If a claimed invite's fed id == a pinned
   id (Afribit, Bitsacco, OCA, BLF, GBF, BP), require Level A against *that* fed;
   fail ⇒ silent auto-reject (the machine says no — no interrogation, no KYC
   vibe).
3. **Proof beats precedence.** A proven claim displaces an unproven earlier one,
   with a grandfather window for existing entries to upgrade.
4. **Re-verification cadence.** Web PKI is moving 398d→10d proof freshness
   because resources change hands; Level A makes re-read cheap — re-check on
   roster refresh and at trade time.

## 7. Caveats & sharp edges

- **Resurrection attack.** Fed id commits to guardian URLs/iroh-ids, not keys.
  If a dead fed's guardian ids ever lapsed and were re-registered, an attacker
  could reproduce the *same fed id with a different keyset*. Mitigation: on first
  successful proof, **pin `broadcast_public_keys` append-only**; a keyset change
  under the same id is a *new* claim — flagged loudly, never auto-inherited
  (the Keybase revocation-is-an-event lesson).
- **Malformed-JSON silent failure (confirmed: zero protocol validation).** The
  meta module stores `MetaValue(Vec<u8>)` — *"not interpreted by Fedimint"*; the
  submit handler does NO JSON/schema/UTF-8 check (only a ~1 GiB size cap), and
  `process_consensus_item` compares **byte-equality** and writes through. So a
  threshold of guardians can reach consensus on *garbage* and store it silently;
  it breaks only when a CLIENT reads and fails to parse (the guardian-ui read
  helper errors or drops the entry). That is the "failed with no error" you hit —
  there is no guardrail to throw. Also: key 0 is ONE shared JSON blob (all
  fields), so every guardian submits the **whole document** byte-identically.
  Mitigation: validate JSON before "Propose New Metadata," namespace under
  `chama:` so you never clobber `fedi:autojoin_communities`, keep the chama reader
  defensive (it is).
- **Trust boundary — genuine consensus, unverifiable independence (esp. G-Bot).**
  The meta module and the "Propose / Approve / Revoke" guardian admin are **core
  Fedimint** (open-source `fedimint/ui`, runs in `fedimintd`), and the 3-of-4
  threshold is real. BUT a meta endorsement only proves *"the federation's
  consensus named this npub"* — NOT that the guardians are independent of each
  other or of any operator, and that independence is **not externally verifiable**.
  On a **Fedi G-Bot** fed, Fedi hosts all guardian servers, matches the anonymous
  OGs, and reportedly auto-approves ("semi-automated") — so a G-Bot Level-A
  reduces closer to "Lead Guardian + Fedi's infra" than to four independent
  parties, and we cannot reliably tell G-Bot from self-hosted via the protocol.
  Consequence: treat Level A as an **identity / anti-squat signal backed by
  genuine consensus — not proof of N independent endorsers.** This is exactly why
  the **universal bond** (no Level-A bypass, locked 2026-06-13) is load-bearing:
  skin-in-the-game, not the endorsement, is the safety.
- **Community links are not proofs.** A `fedi:community…` code is a bech32 pointer
  to a webhost JSON file — free to forge, no federation binding, anyone can mint
  one. Accept as *optional unverified enrichment* (name, links); never as a gate.
  Requiring one adds friction without security (theater).
- **Don't trust summarizers for exact strings** (§0). The verifier re-derives the
  fed id from raw bytes itself.

## 8. Open decisions (need maintainer "Go")

1. **38121 schema:** additive fields (`federationInvite`, derived `federationId`,
   `proofLevel`, artifact) vs a new event version. *Rec: additive.*
2. **Meta key shape:** single `chama:arbiter` npub vs map `chama:arbiters`
   `{slug→npub}` (one fed anchoring arbiters in several communities argues for the
   map). *Rec: map.*
3. **Grandfather window** length for existing roster entries to upgrade. *Rec: 90d.*
4. **Can Level B alone earn the green badge,** or A-only? *Rec: A-only.*

## 9. Relationship to other docs

- **INVARIANTS.md C7** — this is the named "federation-owner credential" that
  closes the cross-identity-Sybil residual. (Suggested follow-up, not yet done:
  add a pointer in the C7 row once §8 is locked.)
- **docs/DESIGN-arbiter-economy.md** — the quality/Sybil + economic half
  (ratings → exposure tiers → bonds). Compose but stay **orthogonal**:
  proof-Level-A is the *identity/anti-squat* gate (more trust weight for an
  *established* fed — guardian count/age/activity, all observable); the
  **universal, self-selected bond** (no exception, no Level-A bypass — locked
  2026-06-13) is the *skin-in-the-game* gate. Gold requires BOTH, plus ratings.
  Level A buys trust, never a bond discount.
- **docs/DESIGN-arbiter-substitution.md** — assignment/priority, the consensus
  side of arbiter trust.

## Appendix — reproducible decode (trustless, no network)

bech32m-decode an invite, drop the 6-symbol checksum, regroup 5→8 bits; the
payload contains `iroh://…` guardian URL(s) (ASCII) and the 32-byte FederationId.
Verified outputs (2026-06-13):

```
BLF_const  → fed id 888b70ec…2b9e (matches BLF_FEDERATION_ID)  iroh://d73fffd0…
GBF_const  → fed id 1bcb64e6…3b97 (matches GBF_FEDERATION_ID)  iroh://2491c8be…
satoshimarket.app (raw curl) serves BLF_const   (NOT GBF — see §0)
```
