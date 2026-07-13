# Native Fedimint Notes

## End-to-End Result

Date: 2026-05-24

### GBF

Invite:

```text
fed11qgqyj3mfwfhksw309uergwf3vvuxyefcvgcrwcmyxaskvvnzxs6nzdrxv3jnxwrz8pjrgdesv5crwve5xv6xyvtyv56nqcfevsmrwv3kx5erwv3n8qcrvde5qyqjqx7tvnngau9nmcadjm9e3dp69lvh920l5rak7r3x4thxn5w5vwuhsc2yh9
```

Result:

- Federation joined/opened as `Global Bitcoin Federation`.
- Federation id:
  `1bcb64e68ef0b3de3ad96cb98b43a2fd972a9ffa0fb6f0e26aaee69d1d463b97`.
- Network: `bitcoin`.
- Balance in the fresh smoke client: `0 msat`.
- Native bridge found 3 Lightning gateways.
- All 3 gateway APIs were reachable from native Rust, even though all were
  reported as `vetted=false`.
- The bridge created a 1 sat BOLT11 invoice through the Fedimint LN module.

Reachable gateways:

| Gateway ID | API | Vetted |
| --- | --- | --- |
| `0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4` | `https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1` | `false` |
| `02b820fdd4e3b88d44040c765743f68f7f51d46fdc8fcb3ed8cfed53e0f9a3c911` | `iroh://d312be0b1291d3730ca5dbe9220e3bb424de1fe1a95dc697eb004827e86a18fa` | `false` |
| `039d1e06e6b10f3d18bbb76bb67f38a7088679c9a5e5914f4efe839298cb17e5e1` | `https://gateway.henwen.net/v1` | `false` |

Full Chama UI flow result:

- Native bridge served GBF on `127.0.0.1:8787`.
- Browser app loaded with `?nativeFedimint=1`.
- Chama auto-selected the `us-gbf` community route.
- End-to-end trade completed: create, join, LN funding, ecash lock, votes,
  resolve, claim/reissue, complete.
- A successful run left a small post-flow balance of `910 msat`, showing the
  native adapter's balance stream and spend/reissue path were active in the UI.

### BLF

Invite:

```text
fed11qgqyj3mfwfhksw309ajrwvmxvenxgvpkvyursenxxvur2c3sv4jkxdfcxf3kgdmyvs6nzcehvc6xzctzxumrxdmr89jnwdtpv5enqwtpxqmrsvfh89skxv34qqqjpzytwrkr28r8mjas4ej467utd7excr7fapj7ukgc4ugacm6nu2u73k7ram
```

Result:

- Federation joined/opened as metadata name `Bitcrazy`; the UI labels the
  route as `Bitcoin Life Federation`.
- Federation id:
  `888b70ec351c67dcbb0ae655d7b8b6fb26c0fc9e865ee5918af11dc6f53e2b9e`.
- Network: `bitcoin`.
- Native bridge found 2 Lightning gateways.
- Both gateway APIs were reachable from native Rust, even though both were
  reported as `vetted=false`.
- The bridge created 1 sat BOLT11 invoices through the Fedimint LN module.

Reachable gateways:

| Gateway ID | API | Vetted |
| --- | --- | --- |
| `0284cf7053be11bb23e59381861299dbaf7670c60dd62c928479c235a53bd95fe4` | `https://gateway.mainnet-lnd-us-east-1.dev.fedibtc.com/v1` | `false` |
| `039d1e06e6b10f3d18bbb76bb67f38a7088679c9a5e5914f4efe839298cb17e5e1` | `https://gateway.henwen.net/v1` | `false` |

Full Chama UI flow result:

- Native bridge served BLF on `127.0.0.1:8788`.
- Browser app loaded with:
  `?nativeFedimint=1&nativeFedimintUrl=http%3A%2F%2F127.0.0.1%3A8788&nativeFedimintCommunity=us-blf`.
- End-to-end trade completed: create, join, LN funding, ecash lock, votes,
  resolve, claim/reissue, complete.
- A successful run left a small post-flow balance of `905 msat`.

## Conclusion

Both GBF and BLF completed Chama's real money flow through the native Rust
Fedimint sidecar. The earlier BLF failures are therefore not evidence that BLF
or public gateways are universally blocked outside Fedi. The failure boundary is
much narrower: browser WASM SDK transport/gateway selection could not reliably
drive this path, while native Rust Fedimint could.

Product implication: Chama should treat Rust-native Fedimint as the serious
production path for Lightning-backed escrow. Browser WASM can remain a
best-effort web mode, but it should not be the only implementation that carries
real LN-IN, ecash lock/reissue, and LN-OUT workflows.

## Product Direction

The native path is viable enough to continue:

1. Keep this crate as the reproducible test harness.
2. Use the localhost `serve` mode as the native sidecar boundary for desktop or
   mobile shell integration.
3. Point a Chama `IFedimintWallet` adapter at that sidecar: join/open, balance,
   list/probe gateways, create invoice, await invoice, pay invoice, spend notes,
   reissue notes, and parse notes.
4. Keep the browser Fedimint adapter as a best-effort web mode, but do not make
   it the only path for real Lightning operations.

## On-Chain Wallet Module Result

On-chain support is native Fedimint wallet-module support, not a Boltz/swapper
integration.

Verified locally on 2026-05-24:

- `GET /onchain/info` works against both GBF and BLF.
- Both federations report `network: bitcoin`.
- Both federations report `finality_delay: 10`; the UI reads this value from
  the federation instead of hard-coding 12 confirmations.
- The bridge now also exposes wallet-module fee consensus from
  `/onchain/info`: `peg_in_fee_sats`, `peg_out_fee_sats`, and
  `minimum_deposit_sats`. Fedimint 0.11.1 defaults the peg-in fee to
  `1000 sats`; deposits at or below that fee are not claimed.
- `POST /onchain/deposit-address` returns a real `bc1...` peg-in address on
  GBF.
- `POST /onchain/withdraw-fees` returns a peg-out fee quote. Example GBF quote:
  withdrawing `1000 sats` to a valid bitcoin address returned `521 sats` in
  fees, total wallet debit `1521 sats`.

Product implication: LN remains the default/recommended path, but native mode
can expose an explicit on-chain slow path. Funding waits for the federation
deposit to be claimed, then uses the same ecash `spendNotes` plus Shamir LOCK
path as Lightning. Claim-side on-chain payout asks the winner for a fresh
bitcoin address for that transaction only; Chama does not save it.

## Satoshi Market Reference

The old `federated-escrow` repo used a TypeScript process boundary around
`fedimint-cli`:

- `src/fedimint.ts` used `execFile` with `--data-dir` and parsed JSON stdout.
- Lightning lock used `module ln invoice`, then `await-invoice`.
- Lightning payout used `module ln pay`, then `await-ln-pay`.
- E-cash fee/payout flows used `reissue`, `spend --allow-overpay`, and note
  parsing/validation around Shamir shares.

This bridge keeps the same operational shape, but calls Fedimint Rust crates
directly instead of shelling out to `fedimint-cli`.

## BLF Working Theory

Superseded by the 2026-05-24 native sidecar UI test above. BLF works
end-to-end through native Rust Fedimint when served through Chama's localhost
bridge. Remaining BLF browser-only failures should be investigated as
browser-SDK transport/gateway-selection issues, not as a federation-wide policy
block.
