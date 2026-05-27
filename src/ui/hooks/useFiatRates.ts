import { useEffect, useState } from "react";
import {
  getFiatRatesSnapshot,
  subscribeFiatRates,
  type FiatRatesSnapshot,
} from "../../markets/fiat-rates.js";

export function useFiatRates(): FiatRatesSnapshot {
  const [rates, setRates] = useState<FiatRatesSnapshot>(() => getFiatRatesSnapshot());

  useEffect(() => subscribeFiatRates(setRates), []);

  return rates;
}
