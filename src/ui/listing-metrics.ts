import type { EscrowState, MenuItem } from "../escrow-engine/types.js";
import { premiumPercentForSats } from "../markets/bitcoin-price.js";

export function listingPremiumLine(state: EscrowState, usdPerBtc: number | null): string | null {
  if (state.category === "lending") return lendingPremiumLine(state);
  if (state.category !== "p2p-trade" && state.category !== "bill-pay") return null;
  if (!usdPerBtc) return null;
  const anchor = listingFiatAnchor(state);
  if (!anchor || anchor.currency !== "USD") return null;
  const premium = premiumPercentForSats({
    sats: anchor.sats,
    fiatAmount: anchor.fiatAmount,
    usdPerBtc,
  });
  if (premium === null) return null;
  const sign = premium >= 0 ? "+" : "";
  const display = Math.abs(premium) < 10 ? premium.toFixed(1) : premium.toFixed(0);
  return `${sign}${display}% premium`;
}

function lendingPremiumLine(state: EscrowState): string | null {
  const terms = firstMenuItem(state);
  if (terms?.aprBps && terms.aprBps > 0) {
    const apr = terms.aprBps / 100;
    const display = Number.isInteger(apr) ? apr.toFixed(0) : apr.toFixed(1);
    return `${display}% premium APR`;
  }
  if (terms?.trustTier) return `tier ${terms.trustTier} borrower`;
  return null;
}

function listingFiatAnchor(state: EscrowState): {
  sats: number;
  fiatAmount: number;
  currency: string;
} | null {
  if (state.fiatAmount !== undefined && state.fiatCurrency) {
    return {
      sats: Math.floor(state.amountMsats / 1000),
      fiatAmount: state.fiatAmount,
      currency: state.fiatCurrency,
    };
  }
  const item = (state.items ?? []).find((candidate) =>
    candidate.fiatAmount !== undefined && !!candidate.fiatCurrency
  );
  if (!item || item.fiatAmount === undefined || !item.fiatCurrency) return null;
  return {
    sats: Math.floor((item.minAmountMsats ?? item.amountMsats) / 1000),
    fiatAmount: item.fiatAmount,
    currency: item.fiatCurrency,
  };
}

function firstMenuItem(state: EscrowState): MenuItem | null {
  return state.items?.[0] ?? null;
}
