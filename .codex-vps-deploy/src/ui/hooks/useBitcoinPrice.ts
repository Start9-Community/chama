import { useEffect, useState } from "react";
import {
  getBitcoinPriceSnapshot,
  subscribeBitcoinPrice,
  type BitcoinPriceSnapshot,
} from "../../markets/bitcoin-price.js";

export function useBitcoinPrice(): BitcoinPriceSnapshot {
  const [price, setPrice] = useState<BitcoinPriceSnapshot>(() => getBitcoinPriceSnapshot());

  useEffect(() => subscribeBitcoinPrice(setPrice), []);

  return price;
}
