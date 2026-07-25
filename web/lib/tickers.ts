// Helpers de clasificación de ticker. Los índices (SPX, NDX, ...) no tienen
// snapshot/velas en el plan de Massive (eso es el producto "Indices", aparte
// de "Options") — para esos usamos Schwab en su lugar. Ver lib/schwab.ts.

const INDEX_TICKERS = new Set(["SPX", "NDX", "RUT", "VIX", "DJX"]);

export function isIndexTicker(ticker: string): boolean {
  return INDEX_TICKERS.has(ticker.trim().toUpperCase());
}
