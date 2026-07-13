# Chama Brand

The philosophy underneath should always stay this: **Chama coordinates trust; it is not a wallet.** Lightning moves value in and out, ecash exists only briefly in escrow, communities create the social layer, and reputation is the backbone. That is why the mark feels like **three forces woven into one accountable system**, not like a generic fintech logo.

## Chama “Woven Trust” written spec

### Core concept

**Name:** Woven Trust
**Meaning:** Three independent roles become one trusted structure.

The mark represents:

* **Orange:** Seller / sats-locker
* **Purple:** Buyer / sats-claimer
* **Teal:** Arbiter / tie-breaker

The philosophy doc already defines the Trinity Ring as architectural truth and maps orange, purple, and teal to the three roles. The Woven Trust direction keeps that architecture but changes the expression from “three arcs with dots” into **three soft bands woven together**.

The emotional target is:

**Decisive, but not authoritarian.
Protective, but not paternalistic.
Technical, but not cold.
Collaborative, but not weak.**

The symbol should feel like **a community seal**, **a trust knot**, and **a protocol mark** at the same time.

---

## Logo anatomy

### 1. Overall shape

Use a **triadic woven loop**: three rounded ribbon forms overlap in a circular triangular rhythm.

The silhouette should feel close to a soft triangle or rounded knot:

* Orange band at the top.
* Teal band on the left.
* Purple band on the lower-right / right.
* A dark central negative space.
* A small glowing orange trust/reputation core in the center.

The mark should not look like three separate circles. It should look like **three participants woven into one cooperative structure**.

### 2. No white dots

For this direction, remove the white dots entirely.

The earlier Trinity Ring used white knot dots to show the three roles/state points. That still works beautifully as a **trade-status indicator**, but Woven Trust should be cleaner and more brand-like. Here, the “connection” is shown through **overlap, weaving, and shared structure**, not through nodes.

### 3. The weave rule

Use this over-under rhythm:

* **Teal passes over orange** on the upper-left side.
* **Orange passes over purple** on the upper-right side.
* **Purple passes over teal** near the lower/front area.

That creates a complete symbolic loop: no role dominates forever. Each role has power, and each role also participates in constraint.

This is important philosophically: Chama’s power is not one actor commanding the others. It is **structured cooperation**.

---

## Color system

Your current generated version is right to shift from blue to teal. The doc calls the arbiter color **Signal Teal**, and the role colors are sacred because they carry product meaning, not decoration.

I would define the Woven Trust palette like this:

```css
:root {
  /* Surface */
  --chama-black: #0A0A0A;
  --chama-card: rgba(255, 255, 255, 0.03);
  --chama-text-primary: #F5F5F7;
  --chama-text-secondary: #86868B;
  --chama-hairline: rgba(255, 255, 255, 0.10);

  /* Seller / sats-locker */
  --chama-orange-start: #F7931A;
  --chama-orange-end: #FFB340;

  /* Buyer / sats-claimer */
  --chama-purple-start: #BF5AF2;
  --chama-purple-end: #7A3CD0;

  /* Arbiter / tie-breaker — corrected visual teal */
  --chama-teal-start: #2EE6D6;
  --chama-teal-mid: #12C7B7;
  --chama-teal-end: #078C8C;

  /* Reputation core */
  --chama-core: #FFB340;
  --chama-core-deep: #7A3F00;
}
```

A useful note: the philosophy doc’s current teal hex pair, `#5AC8FA → #2997FF`, reads visually blue. For the logo direction, I would keep the **semantic name “Signal Teal”** but update the visual token to a true aqua-teal range like `#2EE6D6 → #078C8C`. That gives you clear separation from purple.

### Color hierarchy

Use the three role colors only when they mean something:

* Orange = seller, sats-locking, decision, settlement, warmth.
* Purple = buyer, claiming, Nostr identity, agency.
* Teal = arbiter, tie-break, calm judgment, mediation.
* White = clarity, text, truth.
* Black = trust surface, restraint, seriousness.

The doc is explicit that role colors should not become decorative filler; they carry semantic load.

---

## Figma / vector reconstruction recipe

Use a square canvas first.

**Canvas:** 1200 × 1200
**Background:** `#0A0A0A`
**Hero mark bounding box:** about 660 × 620
**Ribbon thickness:** 120–145 px
**Corner radius:** fully rounded / pill-like
**Visual style:** soft gradients, no hard bevels, no drop shadows.

### Step-by-step

1. **Create three thick loop bands.**
   Use stroked vector paths or thick ellipse-like paths, then expand strokes into shapes.

2. **Orange band:**
   Place it as the top loop. It should feel like a protective arch, not a hard crown. The orange band should enter from upper-left, curve across the top, and descend slightly on the right.

3. **Teal band:**
   Place it on the left. It should feel like a supportive arm rising into the structure. Make the teal visibly green-aqua, not sky blue.

4. **Purple band:**
   Place it on the lower-right. It should feel grounded and confident, forming the base of the weave.

5. **Create the over-under mask.**
   Do not just stack the three shapes. Cut and mask sections so the bands alternate:
   teal over orange, orange over purple, purple over teal.

6. **Create the central opening.**
   The center should be black negative space, roughly triangular/rounded. It should feel like a protected inner chamber.

7. **Add the reputation core.**
   Place a small orange four-point spark or diamond in the center. Use a soft radial glow behind it:
   `rgba(255, 179, 64, 0.18)` fading to transparent.

8. **Avoid literal icons inside the mark.**
   No shield, no lightning bolt, no people icon, no white dots. The abstraction is stronger.

9. **Small-size test.**
   At 32 px, the mark should still read as three colors woven into one object. If it turns into a blur, simplify the overlaps and increase inner negative space.

---

## Brand board layout

For the concept board you liked, use this layout:

```text
Top left:
Chama
Connecting people through
structured cooperation.
Reputation is the backbone.
Communities create trust.

Top right:
NEW DIRECTION
Woven Trust
Three forces, one weave.
Interwoven for trust,
built to last.

Center:
Large Woven Trust mark

Bottom:
Small icon + Chama wordmark
community • trust • reputation
```

Keep the app surface consistent with the philosophy doc: dark mode base, primary text near white, secondary text in muted gray, very subtle cards/borders, no skeuomorphic effects, and sentence case.

---

## Reusable AI prompt

Use this when recreating or iterating:

```text
Create a premium square brand concept board for Chama called “Woven Trust.”

Chama is a coordinator, not a wallet. It coordinates three-party trust between seller, buyer, and arbiter. Communities create trust, and reputation is the backbone. The logo should feel decisive but soft, powerful but collaborative, technical but human.

Use a black background with white and muted-gray typography. Create a large central woven triadic emblem made from three thick rounded ribbon bands. The top band is warm Bitcoin orange, the left band is true aqua-teal, and the right/lower band is rich violet-purple. The bands should weave over and under each other like a soft trust knot. Do not use white dots or node circles. Show connection through overlap, negative space, and interwoven structure.

Use orange for seller / sats-locker, purple for buyer / sats-claimer, and teal for arbiter / tie-breaker. Place a subtle glowing orange reputation core or four-point spark in the central negative space. The mark should feel like community, trust, and reputation woven into one resilient system.

Include a clean white Chama wordmark, a small icon lockup, and a short line: “community • trust • reputation.” Keep the composition minimal, premium, modern, vector-clean, friendly, and scalable for app icon use.
```

---

## Typography directions to test

Your current doc uses **Inter** for UI and **JetBrains Mono** for cryptographic strings, which is a very good baseline.  Inter is designed for computer screens, and JetBrains Mono is built around developer/code readability, so those choices fit the product well. ([Google Fonts][1]) ([Google Fonts][2])

Here are the font directions I would test.

| Direction             | Wordmark / Headline   | UI / Body        | Feeling                                                                                                                                           |
| --------------------- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flagship balance**  | **Sora**              | Inter            | Decisive, rounded, modern, protocol-native without being cold. Sora has a tech/economy association and a soft geometric feel. ([Google Fonts][3]) |
| **Soft authority**    | **Manrope**           | Manrope or Inter | Warm, confident, collaborative. Manrope is an open-source modern sans and feels less harsh than many geometric fonts. ([Google Fonts][4])         |
| **Community-tech**    | **Plus Jakarta Sans** | Inter            | Civic, clear, modern, slightly global. Good if Chama wants to feel like infrastructure for real communities. ([Google Fonts][5])                  |
| **Friendly product**  | **Outfit**            | Inter or DM Sans | Soft, approachable, clean. Outfit is a geometric sans, but less severe than Space Grotesk. ([Google Fonts][6])                                    |
| **Protocol power**    | **Space Grotesk**     | Inter            | Stronger, sharper, more technical. Use if you want the brand to feel more like Bitcoin/Nostr infrastructure. ([Google Fonts][7])                  |
| **Human institution** | **IBM Plex Sans**     | IBM Plex Sans    | Mature, trustworthy, less startup-ish. IBM Plex Sans is described as neutral yet friendly, which fits “power with softness.” ([Google Fonts][8])  |
| **Onboarding warmth** | **Nunito Sans**       | Inter            | Softer and more welcoming. Useful for education/onboarding, but maybe too gentle for the main wordmark. ([Google Fonts][9])                       |

## My strongest recommendation

Use this first:

```text
Wordmark: Sora SemiBold
Headlines: Sora SemiBold / Medium
UI: Inter
Numbers + invoices + npubs: JetBrains Mono
```

Sora gives you the decision-making power. Inter keeps the product clean and usable. JetBrains Mono preserves the technical honesty for BOLT11 invoices, npubs, and protocol strings.

Second-best direction:

```text
Wordmark: Manrope ExtraBold
Headlines: Manrope Bold
UI: Manrope or Inter
Crypto strings: JetBrains Mono
```

This one feels more collaborative and less sharp. It may be the best fit if you want Chama to feel like **community infrastructure**, not just a Bitcoin protocol product.

## What to avoid

Avoid fonts that are too aggressive, angular, or sci-fi. They will make Chama feel like a trading terminal or hacker tool. Also avoid overly bubbly fonts for the main identity; they will weaken the sense that Chama can make hard decisions around escrow, arbitration, and reputation.

The sweet spot is:

**rounded grotesk + clear geometry + generous spacing + calm dark mode.**

That gives you power without harshness.

[1]: https://fonts.google.com/specimen/Inter?utm_source=chatgpt.com "Inter"
[2]: https://fonts.google.com/specimen/JetBrains%2BMono?utm_source=chatgpt.com "JetBrains Mono - Google Fonts"
[3]: https://fonts.google.com/specimen/Sora?utm_source=chatgpt.com "Sora"
[4]: https://fonts.google.com/specimen/Manrope?utm_source=chatgpt.com "Manrope"
[5]: https://fonts.google.com/specimen/Plus%2BJakarta%2BSans?utm_source=chatgpt.com "Plus Jakarta Sans - Google Fonts"
[6]: https://fonts.google.com/specimen/Outfit?utm_source=chatgpt.com "Outfit"
[7]: https://fonts.google.com/specimen/Space%2BGrotesk?utm_source=chatgpt.com "Space Grotesk"
[8]: https://fonts.google.com/specimen/IBM%2BPlex%2BSans?utm_source=chatgpt.com "IBM Plex Sans"
[9]: https://fonts.google.com/specimen/Nunito%2BSans?utm_source=chatgpt.com "Nunito Sans"
