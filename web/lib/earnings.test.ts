import { describe, expect, it } from "vitest";
import { earningsFlag, estimateNextEarnings } from "./earnings";

describe("estimateNextEarnings", () => {
  it("proyecta el siguiente reporte a ~91 días del último filing", () => {
    const next = estimateNextEarnings(
      ["2026-01-30", "2026-05-01"], new Date("2026-07-24T12:00:00Z"));
    // 2026-05-01 + 91 días ≈ 2026-07-31
    expect(next).toBe("2026-07-31");
  });

  it("avanza en pasos de 91 días hasta caer en el futuro", () => {
    const next = estimateNextEarnings(["2026-01-30"], new Date("2026-07-24T12:00:00Z"));
    expect(next).not.toBeNull();
    expect(new Date(next as string).getTime()).toBeGreaterThan(new Date("2026-07-24").getTime());
  });

  it("devuelve null sin fechas", () => {
    expect(estimateNextEarnings([], new Date("2026-07-24"))).toBeNull();
  });
});

describe("earningsFlag", () => {
  it("no_aplica cuando no hay estimación (ETF o sin financials)", () => {
    expect(earningsFlag({ nextEarnings: null, expiration: "2026-08-21", frontSkew: null })).toBe("no_aplica");
  });

  it("fuera cuando el reporte cae después del vencimiento", () => {
    expect(earningsFlag({ nextEarnings: "2026-09-15", expiration: "2026-08-21", frontSkew: 2 })).toBe("fuera");
  });

  it("dentro cuando el reporte cae antes del vencimiento", () => {
    expect(earningsFlag({ nextEarnings: "2026-08-10", expiration: "2026-08-21", frontSkew: 2 })).toBe("dentro");
  });

  it("dentro_confirmado si además el skew del frente lo respalda (>10 pts)", () => {
    expect(earningsFlag({ nextEarnings: "2026-08-10", expiration: "2026-08-21", frontSkew: 14 })).toBe("dentro_confirmado");
  });
});
