// Helpers de clasificación de ticker. Los índices (SPX, NDX, ...) no tienen
// snapshot/velas en el plan de Massive (eso es el producto "Indices", aparte
// de "Options") — para esos usamos Schwab en su lugar. Ver lib/schwab.ts.

const INDEX_TICKERS = new Set(["SPX", "NDX", "RUT", "VIX", "DJX"]);

// Alias de tickers que la gente escribe naturalmente pero no son el símbolo
// "oficial" del subyacente — ej. SPXW es el root de los contratos semanales/0DTE
// de SPX, pero el subyacente y la cadena se piden como "SPX" en Massive y Schwab.
const TICKER_ALIASES: Record<string, string> = {
  SPXW: "SPX",
};

/** Normaliza mayúsculas/espacios y resuelve alias (ej. SPXW → SPX). */
export function normalizeTicker(ticker: string): string {
  const clean = ticker.trim().toUpperCase();
  return TICKER_ALIASES[clean] ?? clean;
}

export function isIndexTicker(ticker: string): boolean {
  return INDEX_TICKERS.has(normalizeTicker(ticker));
}
