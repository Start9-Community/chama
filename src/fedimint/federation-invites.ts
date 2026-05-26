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
 * Bitsacco — Kenya KES route. Added as a second first-class Kenya Chama
 * option alongside Afribit so users can choose their local federation
 * while preserving the same country/currency identity.
 */
export const BITSACCO_FEDERATION_NAME = "Bitsacco";

export const BITSACCO_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309uunyvehxg6nvef5xv6ngdp38y6r2ctzxumxzces8pskgef38qcxgdp3x4nxxe3h89jrwvnyxgcrzcfnv9jrycfsxsmkvcn9vc6rzcenqgqjqelswcv2kdaf3tvdpxdt2m56sr6vyha0tukuvyhn2g89ehy9rrxqs79ame";

export const BITSACCO_FEDERATION_ID: string | null = null;

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

/**
 * GBF / Global Bitcoin Federation — public observer-listed federation used
 * to prove Chama's native Rust Fedimint path. This federation exposes
 * reachable public gateways from the native client even though they are
 * announced as `vetted=false` to the SDK.
 */
export const GBF_FEDERATION_NAME = "Global Bitcoin Federation";

export const GBF_FEDERATION_INVITE =
  "fed11qgqyj3mfwfhksw309uergwf3vvuxyefcvgcrwcmyxaskvvnzxs6nzdrxv3jnxwrz8pjrgdesv5crwve5xv6xyvtyv56nqcfevsmrwv3kx5erwv3n8qcrvde5qyqjqx7tvnngau9nmcadjm9e3dp69lvh920l5rak7r3x4thxn5w5vwuhsc2yh9";

export const GBF_FEDERATION_ID =
  "1bcb64e68ef0b3de3ad96cb98b43a2fd972a9ffa0fb6f0e26aaee69d1d463b97";

export interface PublicFediFederation {
  slug: string;
  name: string;
  federationId: string;
  invite: string;
  flagEmoji: string;
  country: string | null;
}

/**
 * Public Fedi wallet services mirrored from Fedimint Observer on
 * 2026-05-26. GBF is already a first-class visible Chama route, so this
 * list carries the remaining public services from the same feed. Bitcoin
 * Principles is included here as a visible public Fedi choice while the
 * older `global-usd` BP community stays hidden for legacy listings.
 */
export const PUBLIC_FEDI_OBSERVER_FEDERATIONS: PublicFediFederation[] = [
  {
    slug: "fedi-victoria-btc",
    name: "Victoria BTC",
    federationId: "6b2bcd96ab83d6ba31e36b821c89f6cc7a57d2133cdf884018833d3770456fe6",
    invite: "fed11qgqyj3mfwfhksw309umrqvfjxd3nqvm9xsmrgcnrxvurjepsxcmnxwrrxg6nsc348yekvvf3xcunsvrxxvunvwfnvsuxxvmrvd3xxdpcx5uxzvfhvsunyvnrqqqjq6etekt2hq7khgc7x6uzrjyldnr62lfpx0xl3pqp3qeaxacy2mlxvv75v3",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-orange-club-africa",
    name: "Orange Club Africa",
    federationId: "718e421be177486639330d198e870b7345ebd07b2866b5fd3797d73e4bc4c9af",
    invite: "fed11qgqyj3mfwfhksw309ucnywf38yurwwf4x5unswf58pjxydpnx9jnxdpjvgurxdfjv4jkgd3hxguxvdekvsmrwd3nvc6r2ce3v93xyve4xsunwetxv56x2vfjqqqjquvwggd7za6gvcunxrge36rsku69a0g8k2rxkh7n097h8e9ufjd0nga6d4",
    flagEmoji: "🌍",
    country: null,
  },
  {
    slug: "fedi-latnet",
    name: "LatNet",
    federationId: "7c1edc0c6ac9bb4e581e06f5a8ca61c9ca1669ba16fbe644f9c63dc0fe47b908",
    invite: "fed11qgqyj3mfwfhksw309a3nydehv9nrvve3vgexvefevscnjc35v5unwvtxxpnxgdmpv93x2cnxvsurxv34xpsnvdtpvdnxxdtzx4jr2wrpx3jxzv3evg6rqdphqqqjqlq7msxx4jdmfevpuph44r9xrjw2ze5m59hmuez0n33acrly0wggfl2k80",
    flagEmoji: "🌎",
    country: null,
  },
  {
    slug: "fedi-marigold-trust-network",
    name: "Marigold Trust Network",
    federationId: "7dd868a86990cd27331a9e1b386b34cb9da2937a7b885d6bd6a0a6a39ca3c7bb",
    invite: "fed11qgqyj3mfwfhksw309ajrgdf389jnycmyxdjxgd3cvcunjvmyxu6rswpjxcmn2cmpv43n2drxv5mngdtyv56rsdfkvgcnvcmyx43rxdfsxuursvecv5unjwf4qqqjqlwcdz5xnyxdyue348sm8p4nfjua52fh57ugt44adg9x5ww283am5p2upv",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-e-cash-club",
    name: "E-Cash Club",
    federationId: "aeca6cc80ffc530bd2d54b09681f6edb9a415c362e4af2fe3d5e04137006fa21",
    invite: "fed11qgqzggnhwden5te0v9cxjtn9vd3jue3wvfkxjmnyva6kzunyd9skutnwv46z7qqpyzhv5mxgpl79xz7j649sj6qldmde5s2uxchy4uh7840qgymsqmazzp6sn43",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-bitcoin-principles",
    name: BP_FEDERATION_NAME,
    federationId: BP_FEDERATION_ID,
    invite: BP_FEDERATION_INVITE,
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-bitcoinomad",
    name: "Bitcoinomad",
    federationId: "d823ae7a21bb51727187f178f18c1b0bdd6f315195ccc676f6c2465d717e269e",
    invite: "fed11qgqyj3mfwfhksw309ucnydr9x33rxe3cv56njdrxx3jkxv35xq6rqerpx5er2epcvesngdesxvmnqwpnv9nrqde4x3jnxdrzvcurzvmrxvmxyvfkvs6rzetzqqqjpkpr4eazrw63wfcc0utc7xxpkz7aduc4r9wvcem0dsjxt4chuf57yx32hv",
    flagEmoji: "🌎",
    country: null,
  },
  {
    slug: "fedi-btc-brasil",
    name: "BTC Brasil",
    federationId: "e053caf955643bdd9936746f744843cdfd7c2cb60e54aadc26ffa4b093a8d53a",
    invite: "fed11qgqyj3mfwfhksw309uenvdehv9nrgvtpxy6xxwp3v5ukyefcxuerze3sxq6kxdmxv93xvwp58yungwp4x5erxwtpxs6x2e3exa3nwwpexdsnvenrv5cxxd3cqqqjpcznetu42epmmkvnvar0w3yy8n0a0sktvrj54twzdlaykzf634f6m6lfnw",
    flagEmoji: "🇧🇷",
    country: "BR",
  },
  {
    slug: "fedi-school-of-sats",
    name: "School of Sats",
    federationId: "e9a3a03fb399029340c0e8d39c12c6b79768926e028860dc6701abab8cb864de",
    invite: "fed11qgqpw9thwden5te0v9sjuctnvcczummjvuhhwue0qqqjp6dr5qlm8xgzjdqvp6xnnsfvdduhdzfxuq5gvrwxwqdt4wxtsex7587vs9",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-liberty-tree-network",
    name: "Liberty Tree Network",
    federationId: "3694b086bf3d7f5e64e2cbe44de9e6c4247e6c9d29e3d3c4625a79798f5f8d38",
    invite: "fed11qgqrcwnhwden5te0v9cxjtnpd3cxscfwd35kyetjw3uj6arjv4jj6mn9w3mk7unt95erqv34xqurzdpwvch8vctfx9nzummjvuhsqqfqx62tpp4l84l4ue8ze0jym60xcsj8umya983a83rztfuhnr6l35uqv7daky",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-alianza-btc",
    name: "Alianza BTC",
    federationId: "08ff9119365a7e36316cfdd2692705486df1fb1f923d7320a2448dd8326f9b40",
    invite: "fed11qgqrvdrhwden5te0v9cxjtnpd3cxscfwvekj6v3sxg6nqwf3xykkzmrfv9h85cfdvf6xxtnx9emxz6f3vchx7un89uqqzgqgl7g3jdj60cmrzm8a6f5jwp2gdhclk8uj84ejpgjy3hvrymumgqzefpgm",
    flagEmoji: "🌎",
    country: null,
  },
  {
    slug: "fedi-island-bitcoin-community",
    name: "Island Bitcoin Community",
    federationId: "9dc886ab35c45c162b27fa3da6fe356375b074b5496c7e9afa5b1c8e7fd61288",
    invite: "fed11qgqyj3mfwfhksw309uekyvesvenrzdpjx93xvdf4xcex2d33xajxycmzxf3nzdn9x9jxyctpxy6k2vnpv56nwvtpvsmxgepnx93kvvnzvscnjefn8qurxc3eqqqjp8wgs64nt3zuzc4j073a5mlr2cm4kp6t2jtv06d05kcu3elavy5g5h4kwl",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-odin-federation",
    name: "Odin Federation",
    federationId: "4b13a146ee4ba732b2b8914a72a0a2e5873e3e942da2d4eeefd85a5fe41f27ba",
    invite: "fed11qgqzutrhwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8gtn0v35kuen9v3jhyct5d9hkutnc09az7qqpyp938g2xae96wv4jhzg55u4q5tjcw037jsk6948walv95hlyrunm5tyfcdy",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-freedom-one-lowercase",
    name: "freedom one",
    federationId: "c944b2fd1e7fe04ca87f9a57d7894cb69116cec6264cb52faa71228f4ec54cd6",
    invite: "fed11qgqzwfthwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8gtnnwpskxetfvchxuet59uqqzgxfgje068nlupx2slu62ltcjn9kjytva33xfj6jl2n3y285a32v6cug2kgw",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-freedom-one",
    name: "Freedom One",
    federationId: "5a0ca072cffcdfe5ce2ce8a04f728e073ce179221dc2f88ca0ee39ffa607513b",
    invite: "fed11qgqyj3mfwfhksw309u6nqvej8p3rgc33xcmk2dp5vvckzvf4xfnxvef3xfskxces8q6nyvmrvc6nzdr9xcmkvdf5v93rjd3sxc6nwvrxvc6r2c3jxd3xve3sqqqjqksv5pevllxluh8ze69qfaegupeuu9ujy8wzlzx2pm3el7nqw5fmsvtkxf",
    flagEmoji: "🌐",
    country: null,
  },
  {
    slug: "fedi-code-orange",
    name: "Code Orange",
    federationId: "713d9b889b5e207a85d8632e2e5f6926cf74c532299bc313a5fc105534007fce",
    invite: "fed11qgqyj3mfwfhksw309uunxer9xajk2dpsv9jx2en98qeryef48yexyerpxcenjceev5crqvmyxqckgvp4ve3rwdmyxpjrzwfkvy6nqvtpxq6rwdehv3jnsvfhqqqjqufanwyfkh3q02zascew9e0kjfk0wnzny2vmcvf6tlqs256qql7wtlwuvj",
    flagEmoji: "🌐",
    country: null,
  },
];
