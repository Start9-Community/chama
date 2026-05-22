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

export const BP_FEDERATION_ID =
  "b21068c84f5b12ca4fdf93f3e443d3bd7c27e8642d0d52ea2e4dce6fdbbee9df";

/**
 * Afribit Kibera — Kenya KES route used for the Adopting Bitcoin Nairobi
 * demo partner community. This invite resolves to its own federation ID;
 * keep it distinct from BP so the Chama bar does not mislabel Kenya as the
 * browser fallback route.
 */
export const AFRIBIT_KIBERA_FEDERATION_NAME = "Afribit Kibera";

export const AFRIBIT_KIBERA_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309ucrxe35vgcryvesxf3nyepsv3jnyepsvgcnxdpjv5urjcfkv4nrydmxxvervef3xcmxxce5x5ergwfnxcukzetr8qen2vnpvsmr2vrzqyqjplegdfhg4qq8f0zeuvjxn8e49sa3tnep7w08dca79wecgjkyszrufgwesp";

export const AFRIBIT_KIBERA_FEDERATION_ID =
  "ff286a6e8a80074bc59e324699f352c3b15cf21f39e76e3be2bb3844ac48087c";

/**
 * Bitcoin Life Federation — an explicit federation option, NOT the
 * universal fallback. Iroh-only transport: now reliable from browsers
 * after the v0.5.0 canary iroh-relay 0.90 bump (see registry entry's
 * `browserReliable: true`). Selecting BLF in the registry or via a
 * pasted invite is intentional, not ambient.
 */
export const BLF_FEDERATION_NAME = "Bitcoin Life Federation";

export const BLF_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309ajrwvmxvenxgvpkvyursenxxvur2c3sv4jkxdfcxf3kgdmyvs6nzcehvc6xzctzxumrxdmr89jnwdtpv5enqwtpxqmrsvfh89skxv34qqqjpzytwrkr28r8mjas4ej467utd7excr7fapj7ukgc4ugacm6nu2u73k7ram";

export const BLF_FEDERATION_ID =
  "888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e";
