import { describe, expect, it } from "vitest";
import { resampleBars } from "./resampleBars";
import type { TfBar } from "./types";

function bar(time: number, o: number, h: number, l: number, c: number): TfBar {
  return { time, open: o, high: h, low: l, close: c };
}

describe("resampleBars", () => {
  it("devuelve las mismas barras si factor <= 1", () => {
    const bars = [bar(0, 1, 2, 0, 1)];
    expect(resampleBars(bars, 1)).toBe(bars);
    expect(resampleBars(bars, 0)).toBe(bars);
  });

  it("agrupa N velas en una: open de la primera, close de la última, high/low extremos", () => {
    const bars = [
      bar(0, 10, 12, 9, 11),
      bar(60, 11, 13, 10, 12),
      bar(120, 12, 12.5, 8, 9),
    ];
    const out = resampleBars(bars, 3);
    expect(out).toEqual([{ time: 0, open: 10, high: 13, low: 8, close: 9 }]);
  });

  it("el último grupo puede quedar incompleto y se agrega igual", () => {
    const bars = [bar(0, 1, 2, 0, 1), bar(60, 2, 3, 1, 2), bar(120, 3, 4, 2, 3)];
    const out = resampleBars(bars, 2);
    expect(out).toEqual([
      { time: 0, open: 1, high: 3, low: 0, close: 2 },
      { time: 120, open: 3, high: 4, low: 2, close: 3 },
    ]);
  });

  it("con lista vacía devuelve lista vacía", () => {
    expect(resampleBars([], 5)).toEqual([]);
  });
});
