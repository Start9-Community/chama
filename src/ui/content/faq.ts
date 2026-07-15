// ══════════════════════════════════════════════════════════════════════════
// In-app Help & FAQ content — language selector
// ══════════════════════════════════════════════════════════════════════════
//
// SINGLE SOURCE OF TRUTH = docs/FAQ.md, mirrored per language in faq.en.ts /
// faq.fr.ts / faq.es.ts (FaqContent shape). This module picks the viewer's
// language at RENDER time via getCurrentLang() — the Help screen calls the
// getFaq* functions inside its render (it already re-renders on a language
// switch through useT), so switching language reflows the FAQ live.
//
// FAQ_HELP is language-NEUTRAL (URLs + npub, identical everywhere) so it stays a
// plain const. Plain text only in the content — no markdown — so the Help screen
// renders these verbatim.

import { getCurrentLang } from "../../i18n/index.js";
import type { FaqContent } from "./faq-types.js";
import { faqEn } from "./faq.en.js";
import { faqFr } from "./faq.fr.js";
import { faqEs } from "./faq.es.js";

export type { FaqItem, FaqSection, FaqContent } from "./faq-types.js";

const BY_LANG: Record<string, FaqContent> = { en: faqEn, fr: faqFr, es: faqEs };

function pick(): FaqContent {
  return BY_LANG[getCurrentLang()] ?? faqEn;
}

export function getFaqIntro(): string {
  return pick().intro;
}
export function getFaqSections(): FaqContent["sections"] {
  return pick().sections;
}
export function getFaqGlossary(): FaqContent["glossary"] {
  return pick().glossary;
}

// "Need help?" footer (mirrors the website's "Still need a hand?"). The npub is
// the SAME one on the site and in docs/FAQ.md — copied verbatim; keep in sync.
export const FAQ_HELP = {
  app: "getchama.app",
  zapstore: "https://zapstore.dev/apps/app.chama.market",
  npub: "npub1m7nypkfk259h5h0dqwj9px0pqq7nz0cs7gjdhr7g793wspskeavqrljsln",
  njump: "https://njump.me/npub1m7nypkfk259h5h0dqwj9px0pqq7nz0cs7gjdhr7g793wspskeavqrljsln",
};
