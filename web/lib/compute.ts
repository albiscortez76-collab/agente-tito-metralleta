// Funciones puras: sin I/O, fáciles de testear. Aquí viven las fórmulas del agente.

import type { ContractType, PriceSource, RawContract, Row } from "./types";

/**
 * Precio del contrato para el cálculo de Open Premium.
 * La fórmula del agente pide BID, pero el plan actual de Massive no devuelve quotes,
 * así que caemos a last_trade → day.close → day.vwap. Cuando haya bid, cambiar aquí.
 */
export function contractPrice(raw: RawContract): {
  price: number | null;
  source: PriceSource;
} {
  const lt = raw.last_trade?.price;
  if (typeof lt === "number" && lt > 0) return { price: lt, source: "last_trade" };
  const close = raw.day?.close;
  if (typeof close === "number" && close > 0) return { price: close, source: "day_close" };
  const vwap = raw.day?.vwap;
  if (typeof vwap === "number" && vwap > 0) return { price: vwap, source: "day_vwap" };
  return { price: null, source: "none" };
}

/** Open Premium = Open Interest × Precio del Contrato. Null si no hay precio. */
export function openPremium(openInterest: number, price: number | null): number | null {
  if (price === null) return null;
  return openInterest * price;
}

/** Notional Value = Open Interest × 100 × Strike (zonas de relevancia si expira ITM). */
export function notionalValue(
  openInterest: number,
  strike: number,
  sharesPerContract = 100,
): number {
  return openInterest * sharesPerContract * strike;
}

function normalizeType(t: string | undefined): ContractType {
  return t === "put" ? "put" : "call";
}

/** Convierte un contrato crudo de Massive en una Row lista para la tabla. */
export function toRow(raw: RawContract): Row {
  const openInterest = raw.open_interest ?? 0;
  const strike = raw.details?.strike_price ?? 0;
  const shares = raw.details?.shares_per_contract ?? 100;
  const { price, source } = contractPrice(raw);
  return {
    optionTicker: raw.details?.ticker ?? "",
    contractType: normalizeType(raw.details?.contract_type),
    expiration: raw.details?.expiration_date ?? "",
    strike,
    openInterest,
    volume: raw.day?.volume ?? 0,
    price,
    priceSource: source,
    openPremium: openPremium(openInterest, price),
    notionalValue: notionalValue(openInterest, strike, shares),
  };
}

/** Clave de cruce entre un contrato y una cotización: tipo + vencimiento + strike. */
function contractKey(contractType: ContractType, expiration: string, strike: number): string {
  return `${contractType}|${expiration}|${strike}`;
}

export interface BidQuote {
  contractType: ContractType;
  expiration: string;
  strike: number;
  bid: number | null;
}

/**
 * Sobrescribe el precio de las filas con el BID real de Schwab cuando hay match
 * (mismo tipo + vencimiento + strike) y el bid es válido (> 0). Las que no
 * cruzan se quedan con el proxy de Massive tal cual. Pura — fácil de testear.
 */
export function applySchwabBid(rows: Row[], quotes: BidQuote[]): Row[] {
  const byKey = new Map<string, number>();
  for (const q of quotes) {
    if (typeof q.bid === "number" && q.bid > 0) {
      byKey.set(contractKey(q.contractType, q.expiration, q.strike), q.bid);
    }
  }
  if (byKey.size === 0) return rows;
  return rows.map((row) => {
    const bid = byKey.get(contractKey(row.contractType, row.expiration, row.strike));
    if (bid === undefined) return row;
    return {
      ...row,
      price: bid,
      priceSource: "schwab_bid",
      openPremium: openPremium(row.openInterest, bid),
    };
  });
}

/** Ordena por Open Interest de mayor a menor (Tarea 1). Devuelve un array nuevo. */
export function sortByOpenInterestDesc(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => b.openInterest - a.openInterest);
}

/** Cantidad de fechas de vencimiento distintas presentes. */
export function countExpirations(rows: Row[]): number {
  return new Set(rows.map((r) => r.expiration).filter(Boolean)).size;
}
