import { describe, expect, it } from "vitest";
import { RISK_FREE, bsDelta, bsPrice, impliedVol } from "./blackScholes";

describe("bsPrice", () => {
  it("cumple la paridad put-call: C − P = S − K·e^(−rT)", () => {
    const S = 100, K = 95, T = 0.25, iv = 0.4;
    const call = bsPrice(S, K, T, iv, "call");
    const put = bsPrice(S, K, T, iv, "put");
    expect(call - put).toBeCloseTo(S - K * Math.exp(-RISK_FREE * T), 6);
  });

  it("devuelve 0 con insumos inválidos", () => {
    expect(bsPrice(0, 95, 0.25, 0.4, "put")).toBe(0);
    expect(bsPrice(100, 95, 0, 0.4, "put")).toBe(0);
    expect(bsPrice(100, 95, 0.25, 0, "put")).toBe(0);
  });
});

describe("bsDelta", () => {
  it("el delta de un put está entre −1 y 0", () => {
    const d = bsDelta(100, 95, 0.1, 0.4, "put");
    expect(d).toBeGreaterThan(-1);
    expect(d).toBeLessThan(0);
  });

  it("un put muy OTM tiene delta cercano a 0 y uno muy ITM cercano a −1", () => {
    expect(Math.abs(bsDelta(100, 50, 0.1, 0.4, "put"))).toBeLessThan(0.02);
    expect(bsDelta(100, 200, 0.1, 0.4, "put")).toBeLessThan(-0.95);
  });

  it("delta de call − delta de put = 1 (mismo strike)", () => {
    const c = bsDelta(100, 95, 0.25, 0.4, "call");
    const p = bsDelta(100, 95, 0.25, 0.4, "put");
    expect(c - p).toBeCloseTo(1, 6);
  });
});

describe("impliedVol", () => {
  it("ida y vuelta: precio → σ → precio reproduce el precio", () => {
    const S = 100, K = 92, T = 30 / 365, iv = 0.55;
    const price = bsPrice(S, K, T, iv, "put");
    const back = impliedVol(price, S, K, T, "put");
    expect(back).not.toBeNull();
    expect(back as number).toBeCloseTo(iv, 4);
  });

  it("devuelve null si el precio viola el límite superior de no-arbitraje", () => {
    // Un put nunca puede valer más que el strike descontado.
    expect(impliedVol(200, 100, 92, 30 / 365, "put")).toBeNull();
  });

  it("devuelve null si el precio está por debajo del valor intrínseco", () => {
    // Put ITM: intrínseco ≈ 120·e^(−rT) − 100. Un precio de 1 es imposible.
    expect(impliedVol(1, 100, 120, 30 / 365, "put")).toBeNull();
  });

  it("devuelve null con precio no positivo o T = 0", () => {
    expect(impliedVol(0, 100, 92, 0.1, "put")).toBeNull();
    expect(impliedVol(2, 100, 92, 0, "put")).toBeNull();
  });
});
