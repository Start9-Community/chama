# Chama — private community federations over Nostr

**Status:** direction brief (2026-07-03). Decision + the cross-fed lockdown LOCKED in `DECISIONS.md`
(2026-07-03). No code yet. Post-launch vertical; captured while hot.

## The idea

Let a user privately share a **Fedimint federation invite** with *their* community over Nostr, so a
group can spin up (or adopt) their own federation and hand it peer-to-peer to exactly the people
they choose — invisible to every other Chama client, absent from any public list. Ultra-private,
self-sovereign chamas.

The invite is carried as a **NIP-44-encrypted event `#p`-tagged to the chosen members** — the same
recompute-don't-trust envelope pattern the bond descriptor (kind 38133) already uses. Recipients
decrypt, add the federation locally, and now that group trades / pools / saves on their own
sovereign fed.

## Prior art, and our twist

The Nostr ecosystem already started standardizing the *public* half of this — draft **NIP-87**
("Ecash Mint Discoverability"): kind **38173** = a Fedimint federation announcement (invite codes in
`u` tags, federation id as `d`), **38172** = Cashu mints, **38000** = "I recommend this mint" from
someone you follow. That's public, discoverable-by-anyone federation discovery.

**Our contribution is the encrypted, scoped variant** — the cypherpunk half NIP-87 leaves open:
a federation invite that is *only* visible to the community it's addressed to. Where NIP-87 is a
billboard, this is a sealed letter. We can still align with 38173's shape (federation id, invite
codes, module list) *inside* the encrypted payload, so we're extending the standard's semantics
privately rather than inventing an incompatible one.

## ⭐ LOCKED: a private fed is a self-contained economy — fed-switching inside it is OFF

The "but cross-fed trading is hard" caveat is a **non-issue** here, and the resolution is a firm
product rule: **within a private community fed, fed-switching is disabled by design.** Nobody in a
trust-scoped private fed wants to switch out — the boundary *is* the privacy and trust model. So a
private-fed member gets **no switch-out surface**; that fed is the whole world for the group. This
isn't a limitation to apologize for — it's what makes the group's economy sovereign and its privacy
airtight. (The multi-fed switcher stays for users on the public/shared feds; it's simply not exposed
inside a private-fed context.)

## Why it's on-ethos (not scope creep)

- **The name.** "chama" *means* a community savings/economic group. A group running its own
  federation is the most literal possible expression of the app.
- **Fedimint's own thesis.** Community self-custody by guardians the members personally know is what
  Fedimint is *for*. Joining a *private* fed is strictly **safer** than discovering an unknown public
  one — you know whose federation you're trusting with your ecash.
- **Reuses what exists.** Multi-fed support is already live (BP, Afribit, Bitsacco, BLF, GBF) with a
  `federation-invites.ts`; the NIP-44 envelope is shipped; the peg-out rail (2026-07-02) lets any
  member graduate their sats to on-chain self-custody. The only genuinely new bits are the
  encrypted-invite kind + a "join from invite" surface + the private-fed switch lockdown.

## Recruitment thesis (Jetty)

Over time this may be the **best new-user on-ramp**: you join Chama because a friend hands you their
community's private fed, not because you found a public marketplace. Trust travels through the
invite. Private community feds become the primary top-of-funnel; the public marketplace is the outer
ring people graduate outward to (or never need to).

## Open design (before any build)

- The **encrypted-invite event**: reuse the bond-descriptor envelope; carry a 38173-shaped payload
  (federation id + invite codes + modules) inside the NIP-44 ciphertext; `#p`-tag the members; a
  clear `d`/type tag for routing without leaking the fed.
- The **"join from invite" surface**: decrypt → show the fed + its guardians → recompute-don't-trust
  (verify the invite code resolves to the claimed federation) → add locally.
- The **hard fed-switch lockdown** for private-fed members (no switch UI; the fed is implicit).
- How **trades / CPS / a savings circle scope cleanly to the single fed** (they already are
  fed-scoped, so this mostly falls out — state it explicitly).
- Membership changes (add/remove a member from the private group) — invite is additive; revocation
  is social + fed-level, not cryptographic (you can't un-tell someone an invite code).

## Non-goals

- Not a public fed directory (that's NIP-87's public kinds; we may support *reading* those someday,
  separately). This is the private, scoped path.
- Not custody of anyone's sats by anyone else — each member holds their own ecash in the shared fed;
  the fed's guardians are the custody model, exactly as today.
