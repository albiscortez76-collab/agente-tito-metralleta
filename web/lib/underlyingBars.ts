// Punto único para pedir velas del subyacente: Massive para acciones/ETFs,
// Schwab para índices (Massive no los cubre en el plan actual — ver lib/tickers.ts).

import { fetchBars, fetchDailyBars } from "./massive";
import { fetchIndexBars, fetchIndexDailyBars } from "./schwab";
import { isIndexTicker } from "./tickers";
import type { DailyBar, TfBar } from "./types";

export function fetchDailyBarsAny(ticker: string, days = 365): Promise<DailyBar[]> {
  return isIndexTicker(ticker) ? fetchIndexDailyBars(ticker, days) : fetchDailyBars(ticker, days);
}

export function fetchBarsAny(
  ticker: string,
  multiplier: number,
  timespan: "day" | "minute",
  days: number,
): Promise<TfBar[]> {
  return isIndexTicker(ticker)
    ? fetchIndexBars(ticker, multiplier, timespan, days)
    : fetchBars(ticker, multiplier, timespan, days);
}
