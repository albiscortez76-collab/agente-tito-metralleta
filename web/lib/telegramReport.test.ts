import { describe, expect, it } from "vitest";
import { buildTelegramReport } from "./telegramReport";
import type { ProPrediction } from "./prediction";
import type { LevelsReport } from "./levels";

const prediction: ProPrediction = {
  horizonDays: 20,
  spot: 7400,
  iv: 0.11,
  bear: { kind: "bear", target: 7300, changePct: -1.4, probability: 0.53, driver: "gamma en 7300" },
  base: { kind: "base", target: 7400, changePct: 0, probability: 0.93, driver: "nivel imán" },
  bull: { kind: "bull", target: 7450, changePct: 0.7, probability: 0.75, driver: "gamma en 7450" },
  score: 35,
  active: 2,
  confidence: 36,
  levels: [],
  direction: "flat",
  summary: "A 20 días el escenario base apunta lateral.",
  caveat: "Solo 2 de 6 sub-agentes tienen dato; la confianza está recortada.",
  calibration: { applied: false, shiftPct: 0, samples: 0 },
};

const levels: LevelsReport = {
  spot: 7400,
  supports: [],
  resistances: [],
  keySupport: {
    price: 6978.91, kind: "soporte", strength: 70, distancePct: -5.7,
    sources: { touches: 6, lastTouch: null, openInterest: 288095, notional: 0, flowPremium: 0, netGex: 0 },
    flipped: true, why: "el precio reaccionó 6 veces aquí",
  },
  keyResistance: {
    price: 7556.96, kind: "resistencia", strength: 68, distancePct: 2.1,
    sources: { touches: 4, lastTouch: null, openInterest: 386657, notional: 0, flowPremium: 0, netGex: 0 },
    flipped: false, why: "el precio reaccionó 4 veces aquí",
  },
  tolerancePct: 1,
};

describe("buildTelegramReport", () => {
  it("incluye ticker, precio, escenarios y niveles clave", () => {
    const text = buildTelegramReport({
      ticker: "SPX",
      price: 7411.98,
      changePercent: 0.02,
      regime: "negative",
      prediction,
      levels,
      sentimentParts: [
        { name: "Estructura", score: 7 },
        { name: "Agresividad", score: null },
      ],
    });
    expect(text).toContain("SPX");
    expect(text).toContain("7,411.98");
    expect(text).toContain("Bear");
    expect(text).toContain("7,300.00");
    expect(text).toContain("Resistencia clave");
    expect(text).toContain("Soporte clave");
    expect(text).toContain("Estructura: 7/10");
    expect(text).not.toContain("Agresividad");
    expect(text).toContain("No es consejo financiero");
  });

  it("no revienta sin prediction ni levels", () => {
    const text = buildTelegramReport({
      ticker: "AAPL",
      price: null,
      changePercent: null,
      regime: null,
      prediction: null,
      levels: null,
      sentimentParts: [],
    });
    expect(text).toContain("AAPL");
    expect(text).toContain("No es consejo financiero");
  });
});
