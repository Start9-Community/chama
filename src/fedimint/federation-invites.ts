// ══════════════════════════════════════════════════════════════════════════
// Chama — Federation Invite Constants
// ══════════════════════════════════════════════════════════════════════════
//
// Pure data, no imports. Lives in its own file so both the community
// registry and federation-config can pull from it without forming a
// circular import (registry needs invite strings at top-level array
// construction; federation-config needs registry's getCommunityBySlug).

/**
 * Bitcoin Principles — the universal browser-friendly fallback. Used as
 * the silent backing federation when a community has `federationInvite:
 * null`, when the user's community slug is unknown, and when there is
 * no community context at all. Reachable from browsers because BP
 * guardians expose WebSocket endpoints.
 */
export const BP_FEDERATION_NAME = "Bitcoin Principles";

export const BP_FEDERATION_INVITE =
  "fed11qgqzxgthwden5te0v9cxjtnzd96xxmmfdckhqunfde3kjurvv4ejucm0d5hsqqfqkggx3jz0tvfv5n7lj0e7gs7nh47z06ry95x4963wfh8xlka7a80su3952t";

/**
 * Bitcoin Life Federation — an explicit federation option, NOT the
 * universal fallback. Iroh-only transport: works perfectly on the APK
 * but is unreliable from browsers (see registry entry's
 * `browserReliable: false`). Selecting BLF in the registry or via a
 * pasted invite is intentional, not ambient.
 */
export const BLF_FEDERATION_NAME = "Bitcoin Life Federation";

export const BLF_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309ajrwvmxvenxgvpkvyursenxxvur2c3sv4jkxdfcxf3kgdmyvs6nzcehvc6xzctzxumrxdmr89jnwdtpv5enqwtpxqmrsvfh89skxv34qqqjpzytwrkr28r8mjas4ej467utd7excr7fapj7ukgc4ugacm6nu2u73k7ram";
