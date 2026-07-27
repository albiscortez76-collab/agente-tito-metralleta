import type { TfBar } from "./types";

/**
 * Agrupa velas nativas en velas de `factor` veces su tamaño (ej. 30 velas de 1min
 * → 1 vela de 30min con factor=30). Se usa para temporalidades que ni Massive ni
 * Schwab dan nativas (2min, 1h, 4h) sin pedir un multiplier fuera de lo que sus
 * APIs aceptan — Schwab en particular solo permite frequency 1/5/10/15/30 en
 * frequencyType=minute.
 */
export function resampleBars(bars: TfBar[], factor: number): TfBar[] {
  if (factor <= 1 || bars.length === 0) return bars;
  const out: TfBar[] = [];
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    if (chunk.length === 0) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return out;
}
