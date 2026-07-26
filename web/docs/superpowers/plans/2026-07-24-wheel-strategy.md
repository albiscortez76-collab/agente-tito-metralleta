# Wheel Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir `/wheel`, un screener que responde «qué cash-secured put puedo vender hoy, cuánto efectivo inmoviliza y qué cobro por él» sobre un universo curado de 40 tickers.

**Architecture:** Toda la decisión vive en funciones puras (`lib/blackScholes.ts`, `lib/wheel.ts`, `lib/earnings.ts`) con tests; la ruta SSE `app/api/wheel/route.ts` solo orquesta I/O y no decide criterio; la UI lee el saldo de `localStorage` y calcula la asequibilidad en el cliente, de modo que el saldo nunca llega al servidor.

**Tech Stack:** Next.js 15 (App Router, TS), vitest, API de Massive (`api.massive.com`).

**Spec:** [2026-07-24-wheel-strategy-design.md](../specs/2026-07-24-wheel-strategy-design.md)

## Global Constraints

- **Idioma:** todo el código, comentarios, nombres de bandas y copy de UI en **español**. Es la convención del proyecto (CLAUDE.md).
- **Pureza:** `lib/blackScholes.ts`, `lib/wheel.ts`, `lib/wheelUniverse.ts` y `lib/earnings.ts` (salvo su fetch) no tocan red ni disco. Todo lo que decide criterio es testeable sin mocks.
- **El saldo nunca llega al servidor.** La ruta devuelve métricas; la asequibilidad se calcula en el cliente con `tito.risk.*` de `localStorage`.
- **Salvaguarda de liquidez:** sin bid, o `spread > 25%`, o `OI < 100` → candidato `blocked`, **sin número de prima** y fuera de la lista de operables.
- **Copy:** siempre «candidato» y «si vendieras esto, cobrarías X». **Nunca** «vende esto» ni ninguna forma de recomendación personalizada.
- **Tests:** `npm test` (vitest). Cada archivo `lib/X.ts` con lógica lleva `lib/X.test.ts`. No hay tests de rutas SSE ni de UI — es el patrón del proyecto.
- **API key:** `MASSIVE_API_KEY` es server-only. Nunca se expone al cliente.
- **Unidades, verificadas contra el código existente:**
  - `impliedVol` y `bsDelta` trabajan en **decimal** (`0.42` = 42%).
  - `probAbove(spot, strike, iv, days)` espera IV **decimal** y devuelve **0-1**.
  - `realizedVolSeries(closes, w)` devuelve **porcentaje** (×100); `rankWithin(series, current)` espera `current` también en porcentaje.

---

### Task 1: Primitivas Black-Scholes

**Files:**
- Create: `web/lib/blackScholes.ts`
- Create: `web/lib/blackScholes.test.ts`
- Modify: `web/lib/gex.ts` (mover `phi`/`bsGamma`, re-exportar)

**Interfaces:**
- Consumes: `normCdf` de `lib/expectedMove.ts` (ya existe, línea 14 — **no lo redefinas**).
- Produces: `RISK_FREE`, `bsPrice(spot, strike, T, iv, type, r?)`, `bsDelta(spot, strike, T, iv, type, r?)`, `bsGamma(spot, strike, T, iv)`, `impliedVol(price, spot, strike, T, type, r?)`. `T` en años, `iv` decimal, `type: "call" | "put"`. `impliedVol` devuelve `number | null`.

- [ ] **Step 1: Write the failing test**

Crea `web/lib/blackScholes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/blackScholes.test.ts
```

Esperado: FAIL — `Failed to resolve import "./blackScholes"`.

- [ ] **Step 3: Write the implementation**

Crea `web/lib/blackScholes.ts`:

```ts
// Primitivas de Black-Scholes, puras y compartidas.
//
// Viven aquí y no dentro de gex.ts porque la Wheel necesita delta e IV implícita
// de la misma familia de fórmulas. `normCdf` NO se redefine: ya está en
// expectedMove.ts y está testeada allí.

import { normCdf } from "./expectedMove";

/**
 * Tasa libre de riesgo. Constante a propósito: a 7-45 días su efecto sobre el
 * delta es de segundo orden, y una llamada extra por una curva de tasas no se
 * paga sola.
 */
export const RISK_FREE = 0.04;

export type OptionType = "call" | "put";

/** Densidad normal estándar φ(x). */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function d1Of(spot: number, strike: number, T: number, iv: number, r: number): number {
  return (Math.log(spot / strike) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
}

const invalid = (spot: number, strike: number, T: number, iv: number): boolean =>
  !(spot > 0) || !(strike > 0) || !(T > 0) || !(iv > 0);

/** Precio teórico de una europea. Devuelve 0 si los insumos no son válidos. */
export function bsPrice(
  spot: number, strike: number, T: number, iv: number,
  type: OptionType, r = RISK_FREE,
): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const d1 = d1Of(spot, strike, T, iv, r);
  const d2 = d1 - iv * Math.sqrt(T);
  const disc = strike * Math.exp(-r * T);
  return type === "call"
    ? spot * normCdf(d1) - disc * normCdf(d2)
    : disc * normCdf(-d2) - spot * normCdf(-d1);
}

/** Delta. Call ∈ (0,1), put ∈ (−1,0). Devuelve 0 si los insumos no son válidos. */
export function bsDelta(
  spot: number, strike: number, T: number, iv: number,
  type: OptionType, r = RISK_FREE,
): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const nd1 = normCdf(d1Of(spot, strike, T, iv, r));
  return type === "call" ? nd1 : nd1 - 1;
}

/**
 * Gamma de Black-Scholes (r = 0). Se mudó tal cual desde gex.ts —misma fórmula,
 * mismo resultado— para no alterar el GEX ya calibrado.
 */
export function bsGamma(spot: number, strike: number, T: number, iv: number): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * sqrtT);
  return phi(d1) / (spot * iv * sqrtT);
}

const IV_LO = 0.01;
const IV_HI = 5;
const IV_TOL = 1e-6;
const IV_ITERS = 60;

/**
 * IV implícita por bisección sobre σ. Devuelve null si el precio viola los
 * límites de no-arbitraje (pasa con quotes anchas o cruzadas) — el que llama
 * debe caer a una IV estimada y marcar la fila.
 */
export function impliedVol(
  price: number, spot: number, strike: number, T: number,
  type: OptionType, r = RISK_FREE,
): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(T > 0)) return null;

  const disc = strike * Math.exp(-r * T);
  const intrinsic = type === "put" ? Math.max(0, disc - spot) : Math.max(0, spot - disc);
  const upper = type === "put" ? disc : spot;
  if (price <= intrinsic || price >= upper) return null;

  let lo = IV_LO;
  let hi = IV_HI;
  if (bsPrice(spot, strike, T, lo, type, r) > price) return null;
  if (bsPrice(spot, strike, T, hi, type, r) < price) return null;

  for (let i = 0; i < IV_ITERS; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(spot, strike, T, mid, type, r);
    if (Math.abs(p - price) < IV_TOL) return mid;
    if (p < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/blackScholes.test.ts
```

Esperado: PASS, 11 tests.

- [ ] **Step 5: Reapuntar gex.ts a la primitiva compartida**

En `web/lib/gex.ts`, **borra** la función local `phi` y la función `bsGamma` (están sobre la línea 62-77), y en su lugar añade el re-export junto a los demás imports del archivo:

```ts
// bsGamma vive en blackScholes.ts (la Wheel usa las mismas primitivas).
// Se re-exporta para no romper a quien la importa desde aquí.
export { bsGamma } from "./blackScholes";
```

Si `phi` se usara en otro punto de `gex.ts`, impórtala; si no, se borra.

- [ ] **Step 6: Verificar que el GEX no cambió de comportamiento**

```bash
cd web && npx vitest run lib/gex.test.ts && npx tsc --noEmit
```

Esperado: los tests de `gex` pasan sin tocarlos, y `tsc` sin salida. **Si algún test de gex falla, la mudanza alteró la fórmula — revísala, no ajustes el test.**

- [ ] **Step 7: Commit**

```bash
cd web && git add lib/blackScholes.ts lib/blackScholes.test.ts lib/gex.ts
git commit -m "feat(wheel): primitivas Black-Scholes compartidas (precio, delta, IV implícita)"
```

---

### Task 2: Universo curado

**Files:**
- Create: `web/lib/wheelUniverse.ts`
- Create: `web/lib/wheelUniverse.test.ts`

**Interfaces:**
- Produces: `WheelTier = "etf" | "barato" | "medio" | "caro"`, `WheelSymbol { ticker, tier, razon }`, `WHEEL_UNIVERSE: WheelSymbol[]`.

- [ ] **Step 1: Write the failing test**

Crea `web/lib/wheelUniverse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WHEEL_UNIVERSE } from "./wheelUniverse";

describe("WHEEL_UNIVERSE", () => {
  it("no tiene tickers repetidos", () => {
    const seen = new Set(WHEEL_UNIVERSE.map((s) => s.ticker));
    expect(seen.size).toBe(WHEEL_UNIVERSE.length);
  });

  it("cubre los cuatro tramos, para que una cuenta chica tenga algo que hacer", () => {
    const tiers = new Set(WHEEL_UNIVERSE.map((s) => s.tier));
    expect(tiers).toEqual(new Set(["etf", "barato", "medio", "caro"]));
    expect(WHEEL_UNIVERSE.filter((s) => s.tier === "barato").length).toBeGreaterThanOrEqual(8);
  });

  it("cada entrada declara por qué está", () => {
    for (const s of WHEEL_UNIVERSE) {
      expect(s.ticker).toMatch(/^[A-Z.]{1,6}$/);
      expect(s.razon.length).toBeGreaterThan(8);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/wheelUniverse.test.ts
```

Esperado: FAIL — `Failed to resolve import "./wheelUniverse"`.

- [ ] **Step 3: Write the implementation**

Crea `web/lib/wheelUniverse.ts`:

```ts
// Universo curado del screener de Wheel. Se edita A MANO.
//
// Criterios de admisión, en orden (§4.1 del spec):
//   1. Opcionabilidad real: vencimientos semanales y OI agregado alto.
//   2. Sería aceptable poseerla: la Wheel te puede dejar con 100 acciones
//      durante meses. Nada de quiebras ni biotecnológicas binarias.
//   3. Cobertura de tramos de precio, para que una cuenta chica opere.
//   4. Los ETFs de índice van aparte: menor riesgo idiosincrático.
//
// El módulo NO valida esta lista contra el mercado. Si un ticker deja de
// cumplir, se saca a mano y se anota por qué.

export type WheelTier = "etf" | "barato" | "medio" | "caro";

export interface WheelSymbol {
  ticker: string;
  tier: WheelTier;
  razon: string;
}

export const WHEEL_UNIVERSE: WheelSymbol[] = [
  // ── ETFs de índice: el caso de menor riesgo idiosincrático ──
  { ticker: "SPY", tier: "etf", razon: "S&P 500 — la cadena más líquida del mundo" },
  { ticker: "QQQ", tier: "etf", razon: "Nasdaq 100 — muy líquido, más prima que SPY" },
  { ticker: "IWM", tier: "etf", razon: "Small caps — colateral moderado" },
  { ticker: "DIA", tier: "etf", razon: "Dow 30 — prima baja pero estable" },
  { ticker: "XLF", tier: "etf", razon: "Financieras — colateral bajo para un ETF" },
  { ticker: "XLE", tier: "etf", razon: "Energía — IV alta con frecuencia" },

  // ── Caro: casi siempre fuera del alcance de cuentas chicas, útil de referencia ──
  { ticker: "NVDA", tier: "caro", razon: "Mega cap con la prima más gorda del índice" },
  { ticker: "MSFT", tier: "caro", razon: "Mega cap estable, cadena profunda" },
  { ticker: "META", tier: "caro", razon: "Mega cap con IV alta" },
  { ticker: "NFLX", tier: "caro", razon: "Cadena líquida, prima alta" },
  { ticker: "AVGO", tier: "caro", razon: "Semis de mega cap, opciones activas" },
  { ticker: "COST", tier: "caro", razon: "Defensiva de calidad, poseerla no duele" },
  { ticker: "LLY", tier: "caro", razon: "Farmacéutica grande, no binaria" },

  // ── Medio ──
  { ticker: "AAPL", tier: "medio", razon: "La cadena de acción individual más líquida" },
  { ticker: "AMZN", tier: "medio", razon: "Mega cap con colateral alcanzable" },
  { ticker: "GOOGL", tier: "medio", razon: "Mega cap, cadena profunda" },
  { ticker: "TSLA", tier: "medio", razon: "IV alta de forma persistente" },
  { ticker: "AMD", tier: "medio", razon: "Semis con IV alta y cadena líquida" },
  { ticker: "DIS", tier: "medio", razon: "Marca consolidada, prima decente" },
  { ticker: "BAC", tier: "medio", razon: "Banco grande, colateral bajo" },
  { ticker: "KO", tier: "medio", razon: "Defensiva con dividendo — cómoda de poseer" },
  { ticker: "PFE", tier: "medio", razon: "Farmacéutica grande con dividendo" },
  { ticker: "INTC", tier: "medio", razon: "Semis barata, cadena muy activa" },
  { ticker: "UBER", tier: "medio", razon: "Cadena líquida, IV media" },
  { ticker: "COIN", tier: "medio", razon: "IV muy alta — prima gorda, riesgo real" },
  { ticker: "MU", tier: "medio", razon: "Memoria, cíclica con IV alta" },
  { ticker: "CVX", tier: "medio", razon: "Energía integrada con dividendo" },

  // ── Barato: donde una cuenta pequeña puede operar de verdad ──
  { ticker: "F", tier: "barato", razon: "Colateral bajo y cadena sorprendentemente líquida" },
  { ticker: "SOFI", tier: "barato", razon: "Fintech barata con opciones activas" },
  { ticker: "PLTR", tier: "barato", razon: "IV alta y cadena muy negociada" },
  { ticker: "NIO", tier: "barato", razon: "Colateral bajo, IV alta — riesgo país declarado" },
  { ticker: "WULF", tier: "barato", razon: "Minería de bitcoin, colateral muy bajo" },
  { ticker: "RIOT", tier: "barato", razon: "Proxy de bitcoin con IV alta" },
  { ticker: "MARA", tier: "barato", razon: "Proxy de bitcoin, cadena activa" },
  { ticker: "CCL", tier: "barato", razon: "Cruceros, colateral bajo" },
  { ticker: "SNAP", tier: "barato", razon: "Colateral bajo, IV alta" },
  { ticker: "T", tier: "barato", razon: "Telecom con dividendo — cómoda de poseer" },
  { ticker: "VALE", tier: "barato", razon: "Minera con dividendo y colateral bajo" },
  { ticker: "HOOD", tier: "barato", razon: "Bróker, IV alta" },
  { ticker: "LCID", tier: "barato", razon: "Colateral mínimo — el más especulativo de la lista" },
];
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/wheelUniverse.test.ts
```

Esperado: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/wheelUniverse.ts lib/wheelUniverse.test.ts
git commit -m "feat(wheel): universo curado de 40 tickers con criterio de admisión"
```

---

### Task 3: Presets, cascada de prima, liquidez y métricas

**Files:**
- Create: `web/lib/wheel.ts`
- Create: `web/lib/wheel.test.ts`

**Interfaces:**
- Consumes: `probAbove` de `lib/expectedMove.ts` — firma `probAbove(spot, strike, iv, days): number` con `iv` **decimal** y retorno **0-1**.
- Produces: `PresetId`, `WheelPreset`, `WHEEL_PRESETS`, `PremiumSource`, `HAIRCUT`, `PremiumPick`, `pickPremium`, `WheelBlockReason`, `MAX_SPREAD_PCT`, `MIN_OI`, `spreadPctOf`, `liquidityBlock`, `WheelMetrics`, `wheelMetrics`.

- [ ] **Step 1: Write the failing test**

Crea `web/lib/wheel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  HAIRCUT,
  MIN_OI,
  WHEEL_PRESETS,
  liquidityBlock,
  pickPremium,
  spreadPctOf,
  wheelMetrics,
} from "./wheel";

describe("WHEEL_PRESETS", () => {
  it("los tres presets van de menos a más delta", () => {
    expect(WHEEL_PRESETS.conservador.deltaMax).toBeLessThanOrEqual(WHEEL_PRESETS.balanceado.deltaMin);
    expect(WHEEL_PRESETS.balanceado.deltaMax).toBeLessThanOrEqual(WHEEL_PRESETS.agresivo.deltaMin);
  });

  it("todos cierran al 50% de la prima", () => {
    for (const p of Object.values(WHEEL_PRESETS)) expect(p.takeProfitPct).toBe(50);
  });
});

describe("pickPremium", () => {
  it("prefiere el bid real y no le aplica recorte", () => {
    const pick = pickPremium({ bid: 0.32, ask: 0.36, lastTrade: 0.5, model: 0.6 });
    expect(pick).toEqual({ price: 0.32, source: "bid", raw: 0.32 });
  });

  it("cae al último precio con recorte del 10% cuando no hay bid", () => {
    const pick = pickPremium({ bid: 0, ask: 0.36, lastTrade: 0.5, model: 0.6 });
    expect(pick?.source).toBe("ultimo");
    expect(pick?.price).toBeCloseTo(0.5 * (1 - HAIRCUT.ultimo), 10);
    expect(pick?.raw).toBe(0.5);
  });

  it("cae al modelo con recorte del 15% cuando no hay bid ni último", () => {
    const pick = pickPremium({ model: 0.6 });
    expect(pick?.source).toBe("modelo");
    expect(pick?.price).toBeCloseTo(0.6 * (1 - HAIRCUT.modelo), 10);
  });

  it("devuelve null si no hay ninguna fuente", () => {
    expect(pickPremium({})).toBeNull();
    expect(pickPremium({ bid: 0, lastTrade: 0, model: 0 })).toBeNull();
  });
});

describe("spreadPctOf", () => {
  it("mide el spread contra el mid", () => {
    expect(spreadPctOf(0.9, 1.1)).toBeCloseTo(20, 10);
  });

  it("devuelve null si falta un lado", () => {
    expect(spreadPctOf(0, 1.1)).toBeNull();
  });
});

describe("liquidityBlock — la salvaguarda del proyecto", () => {
  it("bloquea si no hay bid", () => {
    expect(liquidityBlock({ bid: 0, ask: 1.1, openInterest: 900 })).toBe("sin_bid");
  });

  it("bloquea si el spread pasa del 25%", () => {
    expect(liquidityBlock({ bid: 0.5, ask: 0.9, openInterest: 900 })).toBe("spread_ancho");
  });

  it("bloquea si el OI es menor a 100", () => {
    expect(liquidityBlock({ bid: 1, ask: 1.05, openInterest: MIN_OI - 1 })).toBe("oi_bajo");
  });

  it("deja pasar un contrato líquido", () => {
    expect(liquidityBlock({ bid: 1, ask: 1.05, openInterest: 900 })).toBeNull();
  });
});

describe("wheelMetrics", () => {
  it("calcula crédito, colateral, retorno, anualizado y breakeven", () => {
    // Put de F a $11, prima $0.32, spot $11.60, 21 días.
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 21, iv: 0.45 });
    expect(m.credit).toBeCloseTo(32, 10);
    expect(m.collateral).toBeCloseTo(1100, 10);
    expect(m.returnPct).toBeCloseTo((32 / 1100) * 100, 10);
    expect(m.annualizedPct).toBeCloseTo((32 / 1100) * 100 * (365 / 21), 10);
    expect(m.breakeven).toBeCloseTo(10.68, 10);
  });

  it("el colchón se mide desde el breakeven, no desde el strike", () => {
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 21, iv: 0.45 });
    expect(m.cushionPct).toBeCloseTo(((11.6 - 10.68) / 11.6) * 100, 10);
  });

  it("la probabilidad de expirar sin valor sale de probAbove y va en 0-100", () => {
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 21, iv: 0.45 });
    expect(m.probExpireWorthless).toBeGreaterThan(50);
    expect(m.probExpireWorthless).toBeLessThanOrEqual(100);
  });

  it("un DTE de 0 no revienta el anualizado", () => {
    const m = wheelMetrics({ strike: 11, price: 0.32, spot: 11.6, dte: 0, iv: 0.45 });
    expect(Number.isFinite(m.annualizedPct)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/wheel.test.ts
```

Esperado: FAIL — `Failed to resolve import "./wheel"`.

- [ ] **Step 3: Write the implementation**

Crea `web/lib/wheel.ts`:

```ts
// Criterio de la Wheel: presets, prima, liquidez, métricas y score.
//
// PURO — no toca red ni disco. La ruta orquesta I/O; aquí solo se decide.
// Un contrato son 100 acciones y el colateral de un cash-secured put es
// strike × 100: ese efectivo queda inmovilizado hasta el vencimiento.

import { probAbove } from "./expectedMove";

const MULTIPLIER = 100;

// ── Presets ────────────────────────────────────────────────────────────

export type PresetId = "conservador" | "balanceado" | "agresivo";

export interface WheelPreset {
  id: PresetId;
  label: string;
  /** |delta| objetivo del put a vender. */
  deltaMin: number;
  deltaMax: number;
  dteMin: number;
  dteMax: number;
  /** % de la prima al que conviene recomprar y cerrar. */
  takeProfitPct: number;
  /** DTE al que conviene rolar en vez de esperar. */
  rollDte: number;
  explain: string;
}

export const WHEEL_PRESETS: Record<PresetId, WheelPreset> = {
  conservador: {
    id: "conservador", label: "Conservador",
    deltaMin: 0.10, deltaMax: 0.20, dteMin: 30, dteMax: 45,
    takeProfitPct: 50, rollDte: 21,
    explain: "Strikes lejos del precio: cobras menos, pero te asignan pocas veces.",
  },
  balanceado: {
    id: "balanceado", label: "Balanceado",
    deltaMin: 0.20, deltaMax: 0.30, dteMin: 30, dteMax: 45,
    takeProfitPct: 50, rollDte: 21,
    explain: "El punto medio clásico de la Wheel: prima decente y asignación ocasional.",
  },
  agresivo: {
    id: "agresivo", label: "Agresivo",
    deltaMin: 0.30, deltaMax: 0.40, dteMin: 7, dteMax: 21,
    takeProfitPct: 50, rollDte: 7,
    explain: "Cerca del precio y a poco plazo: cobras más y te asignan mucho más seguido.",
  },
};

// ── Cascada de prima ───────────────────────────────────────────────────

export type PremiumSource = "bid" | "ultimo" | "modelo";

/**
 * Recorte por fuente. Existe porque VENDES AL BID: un mid o un último precio
 * te haría creer que cobras más de lo que realmente cobrarías.
 */
export const HAIRCUT: Record<PremiumSource, number> = {
  bid: 0,
  ultimo: 0.10,
  modelo: 0.15,
};

export interface PremiumPick {
  /** Prima por acción ya recortada — la que se usa en todos los cálculos. */
  price: number;
  source: PremiumSource;
  /** El valor antes del recorte, para poder mostrarlo. */
  raw: number;
}

export function pickPremium(input: {
  bid?: number | null;
  ask?: number | null;
  lastTrade?: number | null;
  model?: number | null;
}): PremiumPick | null {
  const pick = (raw: number | null | undefined, source: PremiumSource): PremiumPick | null =>
    raw != null && raw > 0
      ? { price: raw * (1 - HAIRCUT[source]), source, raw }
      : null;

  return pick(input.bid, "bid") ?? pick(input.lastTrade, "ultimo") ?? pick(input.model, "modelo");
}

// ── Liquidez: la salvaguarda ───────────────────────────────────────────

export type WheelBlockReason = "sin_bid" | "spread_ancho" | "oi_bajo";

export const MAX_SPREAD_PCT = 25;
export const MIN_OI = 100;

/** Spread relativo al mid, en %. null si falta un lado de la horquilla. */
export function spreadPctOf(bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (!(bid != null && bid > 0) || !(ask != null && ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / mid) * 100;
}

/**
 * Regla crítica del proyecto: ante la duda, no operar y avisar. Un candidato
 * bloqueado se muestra SIN número de prima y fuera de la lista de operables.
 */
export function liquidityBlock(input: {
  bid?: number | null;
  ask?: number | null;
  openInterest: number;
}): WheelBlockReason | null {
  if (!(input.bid != null && input.bid > 0)) return "sin_bid";
  const spread = spreadPctOf(input.bid, input.ask);
  if (spread == null || spread > MAX_SPREAD_PCT) return "spread_ancho";
  if (input.openInterest < MIN_OI) return "oi_bajo";
  return null;
}

// ── Métricas del candidato ─────────────────────────────────────────────

export interface WheelMetrics {
  /** Prima que cobras por un contrato, en $. */
  credit: number;
  /** Efectivo que queda inmovilizado, en $. */
  collateral: number;
  /** Retorno sobre el colateral en el periodo, en %. */
  returnPct: number;
  /** El mismo retorno llevado a un año, en %. */
  annualizedPct: number;
  /** Por debajo de este precio empiezas a perder. */
  breakeven: number;
  /** Distancia del spot al breakeven, en % del spot. */
  cushionPct: number;
  /** P(expire sin valor) en 0-100. */
  probExpireWorthless: number;
}

export function wheelMetrics(input: {
  strike: number;
  /** Prima por acción, ya recortada. */
  price: number;
  spot: number;
  dte: number;
  /** IV decimal del strike. */
  iv: number;
}): WheelMetrics {
  const { strike, price, spot, dte, iv } = input;
  const credit = price * MULTIPLIER;
  const collateral = strike * MULTIPLIER;
  const returnPct = collateral > 0 ? (credit / collateral) * 100 : 0;
  // Un DTE de 0 haría infinito el anualizado: se trata como 1 día.
  const annualizedPct = returnPct * (365 / Math.max(dte, 1));
  const breakeven = strike - price;
  const cushionPct = spot > 0 ? ((spot - breakeven) / spot) * 100 : 0;
  const probExpireWorthless = probAbove(spot, strike, iv, dte) * 100;

  return { credit, collateral, returnPct, annualizedPct, breakeven, cushionPct, probExpireWorthless };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/wheel.test.ts
```

Esperado: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/wheel.ts lib/wheel.test.ts
git commit -m "feat(wheel): presets, cascada de prima con recorte, salvaguarda de liquidez y métricas"
```

---

### Task 4: Score compuesto Wheel

**Files:**
- Modify: `web/lib/wheel.ts` (añadir al final)
- Modify: `web/lib/wheel.test.ts` (añadir al final)

**Interfaces:**
- Consumes: `Level` de `lib/levels.ts` — campos usados: `price`, `kind` (`"soporte" | "resistencia"`), `strength` (0-100).
- Produces: `EarningsFlag`, `ScorePart`, `WheelScore`, `ScoreInput`, `scoreCandidate`.

- [ ] **Step 1: Write the failing test**

Añade al final de `web/lib/wheel.test.ts`:

```ts
import { scoreCandidate, type ScoreInput } from "./wheel";
import type { Level } from "./levels";

function soporte(price: number, strength: number): Level {
  return {
    price, kind: "soporte", strength, distancePct: 0, flipped: false, why: "test",
    sources: { touches: 2, lastTouch: "2026-07-01", openInterest: 0, notional: 0, flowPremium: 0, netGex: 0 },
  };
}

const BASE: ScoreInput = {
  annualizedPct: 25,
  ivRank: 80,
  strike: 11,
  spot: 11.6,
  cushionPct: 8,
  supports: [soporte(11.5, 60)],
  openInterest: 900,
  spreadPct: 5,
  earnings: "fuera",
};

describe("scoreCandidate", () => {
  it("suma 100 en el caso perfecto", () => {
    const s = scoreCandidate(BASE);
    expect(s.total).toBe(100);
  });

  it("castiga el rendimiento por encima del 60% anualizado", () => {
    // Prima así de gorda significa que el mercado sabe algo que tú no.
    const bueno = scoreCandidate({ ...BASE, annualizedPct: 25 }).annualized.points;
    const sospechoso = scoreCandidate({ ...BASE, annualizedPct: 90 }).annualized.points;
    expect(sospechoso).toBeLessThan(bueno);
    expect(sospechoso).toBe(10);
  });

  it("premia el IV Rank ALTO — invertido respecto a ivcontext.ts", () => {
    const alto = scoreCandidate({ ...BASE, ivRank: 80 }).ivRank.points;
    const bajo = scoreCandidate({ ...BASE, ivRank: 20 }).ivRank.points;
    expect(alto).toBeGreaterThan(bajo);
    expect(alto).toBe(20);
    expect(bajo).toBe(4);
  });

  it("premia el strike por debajo de un soporte fuerte", () => {
    const bajoSoporteFuerte = scoreCandidate({ ...BASE, supports: [soporte(11.5, 60)] }).cushion.points;
    const porEncima = scoreCandidate({ ...BASE, strike: 12, supports: [soporte(11.5, 60)] }).cushion.points;
    expect(bajoSoporteFuerte).toBe(25);
    expect(porEncima).toBe(5);
  });

  it("sin soportes pero con buen colchón da puntuación intermedia", () => {
    const s = scoreCandidate({ ...BASE, supports: [], cushionPct: 12 });
    expect(s.cushion.points).toBe(12);
  });

  it("las bandas de liquidez se evalúan en orden y gana la primera", () => {
    // OI alto pero spread del 20%: NO cobra los 15 puntos, cae a la tercera banda.
    const s = scoreCandidate({ ...BASE, openInterest: 800, spreadPct: 20 });
    expect(s.liquidity.points).toBe(5);
  });

  it("penaliza el reporte dentro del vencimiento y lo anula si el skew lo confirma", () => {
    expect(scoreCandidate({ ...BASE, earnings: "fuera" }).earnings.points).toBe(10);
    expect(scoreCandidate({ ...BASE, earnings: "dentro" }).earnings.points).toBe(3);
    expect(scoreCandidate({ ...BASE, earnings: "dentro_confirmado" }).earnings.points).toBe(0);
  });

  it("un ETF sin financials cobra los 10 puntos: no reporta resultados", () => {
    expect(scoreCandidate({ ...BASE, earnings: "no_aplica" }).earnings.points).toBe(10);
  });

  it("sin IV Rank puntúa la banda baja pero no rompe", () => {
    const s = scoreCandidate({ ...BASE, ivRank: null });
    expect(s.ivRank.points).toBe(4);
    expect(Number.isFinite(s.total)).toBe(true);
  });

  it("cada componente explica su porqué en llano", () => {
    const s = scoreCandidate(BASE);
    for (const part of [s.annualized, s.ivRank, s.cushion, s.liquidity, s.earnings]) {
      expect(part.why.length).toBeGreaterThan(10);
      expect(part.points).toBeLessThanOrEqual(part.max);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/wheel.test.ts
```

Esperado: FAIL — `scoreCandidate is not a function` / error de importación.

- [ ] **Step 3: Write the implementation**

Añade al final de `web/lib/wheel.ts`:

```ts
// ── Score compuesto Wheel (0-100) ──────────────────────────────────────

import type { Level } from "./levels";

/** Estado del riesgo de reporte dentro del vencimiento. */
export type EarningsFlag = "fuera" | "dentro" | "dentro_confirmado" | "no_aplica";

export interface ScorePart {
  points: number;
  max: number;
  band: string;
  /** Por qué, en llano. Se muestra tal cual en la UI. */
  why: string;
}

export interface WheelScore {
  total: number;
  annualized: ScorePart;
  ivRank: ScorePart;
  cushion: ScorePart;
  liquidity: ScorePart;
  earnings: ScorePart;
}

export interface ScoreInput {
  annualizedPct: number;
  /** 0-100. null si no hay historia suficiente. */
  ivRank: number | null;
  strike: number;
  spot: number;
  cushionPct: number;
  /** Soportes del ticker, de findLevels. */
  supports: Level[];
  openInterest: number;
  /** Spread relativo en %, de spreadPctOf. */
  spreadPct: number | null;
  earnings: EarningsFlag;
}

/** Fuerza mínima para considerar que un soporte de verdad sostiene. */
const STRONG_SUPPORT = 35;

function annualizedPart(pct: number): ScorePart {
  // El castigo por encima del 60% es DELIBERADO: un screener que ordena por
  // prima pone arriba justo las acciones que están a punto de desplomarse.
  if (pct > 60)
    return { points: 10, max: 30, band: ">60%",
      why: "Prima sospechosamente alta: el mercado descuenta una caída fuerte." };
  if (pct >= 35)
    return { points: 22, max: 30, band: "35-60%",
      why: "Rendimiento muy alto — bien pagado, pero comprueba por qué paga tanto." };
  if (pct >= 15)
    return { points: 30, max: 30, band: "15-35%",
      why: "Rendimiento en el rango sano para vender puts." };
  if (pct >= 8)
    return { points: 18, max: 30, band: "8-15%",
      why: "Rendimiento modesto pero razonable." };
  return { points: 5, max: 30, band: "<8%",
    why: "Lo que cobras no paga el riesgo de quedarte con las acciones." };
}

function ivRankPart(rank: number | null): ScorePart {
  // OJO: banda INVERTIDA respecto a ivcontext.ts. Allí el pico está en 16-30
  // porque el resto del agente COMPRA opciones y quiere vega barata. La Wheel
  // VENDE: quiere que la volatilidad esté cara.
  if (rank == null)
    return { points: 4, max: 20, band: "sin datos",
      why: "Sin historia suficiente para saber si la volatilidad está cara o barata." };
  if (rank > 70)
    return { points: 20, max: 20, band: ">70",
      why: "La volatilidad está cara frente a su propio año: buen momento para vender prima." };
  if (rank >= 50)
    return { points: 16, max: 20, band: "50-70",
      why: "Volatilidad por encima de su media anual." };
  if (rank >= 30)
    return { points: 10, max: 20, band: "30-50",
      why: "Volatilidad en su zona media." };
  return { points: 4, max: 20, band: "<30",
    why: "La volatilidad está barata: te pagan poco por asumir el riesgo." };
}

function cushionPart(input: ScoreInput): ScorePart {
  const below = input.supports.filter((s) => s.price >= input.strike);
  const strongest = below.reduce<Level | null>(
    (best, s) => (best == null || s.strength > best.strength ? s : best), null);

  if (strongest && strongest.strength >= STRONG_SUPPORT)
    return { points: 25, max: 25, band: "bajo soporte fuerte",
      why: `El strike queda bajo un soporte de fuerza ${Math.round(strongest.strength)}: el precio ya rebotó ahí antes.` };
  if (strongest)
    return { points: 15, max: 25, band: "bajo soporte débil",
      why: "El strike queda bajo un soporte, pero flojo." };
  if (input.cushionPct > 10)
    return { points: 12, max: 25, band: "colchón >10%",
      why: "Sin soporte identificado, pero la acción tendría que caer más de un 10% para hacerte daño." };
  return { points: 5, max: 25, band: "sin colchón",
    why: "El strike está por encima del soporte más cercano: te pueden asignar con facilidad." };
}

function liquidityPart(oi: number, spreadPct: number | null): ScorePart {
  // Las bandas se evalúan EN ORDEN y gana la primera que se cumple: un OI de
  // 800 con spread del 20% cae a la tercera, no cobra la primera.
  const s = spreadPct ?? Infinity;
  if (oi >= 500 && s <= 10)
    return { points: 15, max: 15, band: "excelente",
      why: "Contrato muy negociado y con horquilla estrecha: entras y sales sin regalar dinero." };
  if (oi >= 250 && s <= 15)
    return { points: 10, max: 15, band: "buena",
      why: "Liquidez suficiente para entrar y salir." };
  if (oi >= MIN_OI && s <= MAX_SPREAD_PCT)
    return { points: 5, max: 15, band: "justa",
      why: "Liquidez ajustada: la horquilla te va a costar al cerrar." };
  return { points: 0, max: 15, band: "insuficiente",
    why: "Liquidez insuficiente." };
}

function earningsPart(flag: EarningsFlag): ScorePart {
  switch (flag) {
    case "no_aplica":
      return { points: 10, max: 10, band: "no aplica",
        why: "No reporta resultados: no hay riesgo de reporte." };
    case "fuera":
      return { points: 10, max: 10, band: "fuera",
        why: "El reporte estimado cae después del vencimiento." };
    case "dentro":
      return { points: 3, max: 10, band: "dentro",
        why: "El reporte estimado cae ANTES del vencimiento — es una estimación, verifícala." };
    case "dentro_confirmado":
      return { points: 0, max: 10, band: "dentro, confirmado",
        why: "El reporte cae antes del vencimiento y la volatilidad del frente lo confirma." };
  }
}

export function scoreCandidate(input: ScoreInput): WheelScore {
  const annualized = annualizedPart(input.annualizedPct);
  const ivRank = ivRankPart(input.ivRank);
  const cushion = cushionPart(input);
  const liquidity = liquidityPart(input.openInterest, input.spreadPct);
  const earnings = earningsPart(input.earnings);
  const total = annualized.points + ivRank.points + cushion.points + liquidity.points + earnings.points;
  return { total, annualized, ivRank, cushion, liquidity, earnings };
}
```

**Nota:** el `import type { Level }` debe subir junto a los demás imports al inicio del archivo — TypeScript lo permite en medio, pero el proyecto agrupa imports arriba.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/wheel.test.ts
```

Esperado: PASS, 25 tests (15 de la Task 3 + 10 nuevos).

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/wheel.ts lib/wheel.test.ts
git commit -m "feat(wheel): score compuesto con banda de IV Rank invertida y castigo al rendimiento sospechoso"
```

---

### Task 5: Ensamblado de candidatos

**Files:**
- Modify: `web/lib/wheel.ts` (añadir al final)
- Modify: `web/lib/wheel.test.ts` (añadir al final)

**Interfaces:**
- Consumes: `impliedVol`, `bsDelta`, `bsPrice` de `lib/blackScholes.ts`; todo lo de las Tasks 3-4.
- Produces: `ChainQuote`, `WheelCandidate`, `CandidatesInput`, `wheelCandidates`, `atmIv`.

- [ ] **Step 1: Write the failing test**

Añade al final de `web/lib/wheel.test.ts`:

```ts
import { atmIv, wheelCandidates, type ChainQuote } from "./wheel";

function quote(p: Partial<ChainQuote>): ChainQuote {
  return {
    strike: 11, expiration: "2026-08-21", dte: 35,
    bid: 0.30, ask: 0.34, lastTrade: 0.32, openInterest: 900, ...p,
  };
}

const CAND_BASE = {
  ticker: "F",
  spot: 11.6,
  preset: WHEEL_PRESETS.balanceado,
  ivRank: 60,
  supports: [] as Level[],
  earnings: "fuera" as const,
  fallbackIv: 0.45,
};

describe("wheelCandidates", () => {
  it("descarta los strikes cuyo delta cae fuera del preset", () => {
    // Strike muy lejano: |delta| bajísimo, fuera del rango 0.20-0.30.
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ strike: 5, bid: 0.01, ask: 0.02 })],
    });
    expect(out).toHaveLength(0);
  });

  it("descarta los vencimientos fuera de la ventana de DTE del preset", () => {
    const out = wheelCandidates({ ...CAND_BASE, quotes: [quote({ dte: 3 })] });
    expect(out).toHaveLength(0);
  });

  it("marca como blocked, y sin prima, un contrato ilíquido", () => {
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ bid: 0, ask: 0.34, openInterest: 5 })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].blocked).toBe(true);
    expect(out[0].blockReason).toBe("sin_bid");
    expect(out[0].premium).toBeNull();
    expect(out[0].metrics).toBeNull();
  });

  it("un candidato válido trae delta negativo, métricas y score", () => {
    const out = wheelCandidates({ ...CAND_BASE, quotes: [quote({})] });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.blocked).toBe(false);
    expect(c.delta).toBeLessThan(0);
    expect(c.premium?.source).toBe("bid");
    expect(c.metrics?.collateral).toBeCloseTo(1100, 10);
    expect(c.score?.total).toBeGreaterThan(0);
  });

  it("marca la fila cuando la IV implícita no converge y cae al fallback", () => {
    // Quote cruzada e imposible: la bisección no puede converger.
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [quote({ bid: 20, ask: 21, lastTrade: 20.5 })],
    });
    expect(out[0]?.ivSource).toBe("estimada");
  });

  it("ordena de mayor a menor score y deja los bloqueados al final", () => {
    const out = wheelCandidates({
      ...CAND_BASE,
      quotes: [
        quote({ strike: 11, bid: 0, ask: 0.34, openInterest: 5 }),
        quote({ strike: 10.5, bid: 0.28, ask: 0.30, openInterest: 2000 }),
      ],
    });
    expect(out[0].blocked).toBe(false);
    expect(out[out.length - 1].blocked).toBe(true);
  });
});

describe("atmIv", () => {
  it("devuelve la IV del strike más cercano al spot", () => {
    const iv = atmIv([
      { strike: 8, iv: 0.9 },
      { strike: 11.5, iv: 0.45 },
      { strike: 20, iv: 0.7 },
    ], 11.6);
    expect(iv).toBe(0.45);
  });

  it("devuelve null sin datos", () => {
    expect(atmIv([], 11.6)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/wheel.test.ts
```

Esperado: FAIL — `wheelCandidates is not a function`.

- [ ] **Step 3: Write the implementation**

Añade al final de `web/lib/wheel.ts` (y sube el import junto a los demás):

```ts
// ── Ensamblado de candidatos ───────────────────────────────────────────

import { bsDelta, bsPrice, impliedVol } from "./blackScholes";

/** Una fila de la cadena, ya normalizada desde el snapshot de Massive. */
export interface ChainQuote {
  strike: number;
  expiration: string; // YYYY-MM-DD
  dte: number;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  openInterest: number;
}

export type IvSource = "implicita" | "estimada";

export interface WheelCandidate {
  ticker: string;
  strike: number;
  expiration: string;
  dte: number;
  spot: number;
  /** Negativo (es un put). 0 si no se pudo calcular. */
  delta: number;
  /** IV decimal usada en todos los cálculos de esta fila. */
  iv: number;
  ivSource: IvSource;
  openInterest: number;
  spreadPct: number | null;
  /** null si el candidato está bloqueado: no se muestra prima que no puedes cobrar. */
  premium: PremiumPick | null;
  metrics: WheelMetrics | null;
  score: WheelScore | null;
  blocked: boolean;
  blockReason: WheelBlockReason | null;
}

export interface CandidatesInput {
  ticker: string;
  spot: number;
  quotes: ChainQuote[];
  preset: WheelPreset;
  ivRank: number | null;
  supports: Level[];
  earnings: EarningsFlag;
  /** IV de respaldo (volatilidad realizada) cuando la bisección no converge. */
  fallbackIv: number;
}

/** IV del strike más cercano al spot — el proxy de "la IV de esta cadena". */
export function atmIv(rows: { strike: number; iv: number }[], spot: number): number | null {
  if (rows.length === 0) return null;
  const best = rows.reduce((a, b) =>
    Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a);
  return best.iv;
}

export function wheelCandidates(input: CandidatesInput): WheelCandidate[] {
  const { ticker, spot, quotes, preset, ivRank, supports, earnings, fallbackIv } = input;
  if (!(spot > 0)) return [];

  const out: WheelCandidate[] = [];

  for (const q of quotes) {
    if (q.dte < preset.dteMin || q.dte > preset.dteMax) continue;

    const T = Math.max(q.dte, 1) / 365;
    const mid = q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0
      ? (q.bid + q.ask) / 2
      : null;

    const implied = mid != null ? impliedVol(mid, spot, q.strike, T, "put") : null;
    const iv = implied ?? fallbackIv;
    const ivSource: IvSource = implied != null ? "implicita" : "estimada";

    const delta = bsDelta(spot, q.strike, T, iv, "put");
    const absDelta = Math.abs(delta);
    if (absDelta < preset.deltaMin || absDelta > preset.deltaMax) continue;

    const spreadPct = spreadPctOf(q.bid, q.ask);
    const blockReason = liquidityBlock({ bid: q.bid, ask: q.ask, openInterest: q.openInterest });

    if (blockReason) {
      // Bloqueado: sin prima y sin métricas. No se enseña un número que no puedes cobrar.
      out.push({
        ticker, strike: q.strike, expiration: q.expiration, dte: q.dte, spot,
        delta, iv, ivSource, openInterest: q.openInterest, spreadPct,
        premium: null, metrics: null, score: null, blocked: true, blockReason,
      });
      continue;
    }

    const premium = pickPremium({
      bid: q.bid,
      ask: q.ask,
      lastTrade: q.lastTrade,
      model: bsPrice(spot, q.strike, T, iv, "put"),
    });
    if (!premium) continue;

    const metrics = wheelMetrics({ strike: q.strike, price: premium.price, spot, dte: q.dte, iv });
    const score = scoreCandidate({
      annualizedPct: metrics.annualizedPct,
      ivRank, strike: q.strike, spot,
      cushionPct: metrics.cushionPct,
      supports, openInterest: q.openInterest, spreadPct, earnings,
    });

    out.push({
      ticker, strike: q.strike, expiration: q.expiration, dte: q.dte, spot,
      delta, iv, ivSource, openInterest: q.openInterest, spreadPct,
      premium, metrics, score, blocked: false, blockReason: null,
    });
  }

  // Operables primero, y dentro de ellos el mejor score.
  return out.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return (b.score?.total ?? 0) - (a.score?.total ?? 0);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/wheel.test.ts && npx tsc --noEmit
```

Esperado: PASS, 33 tests. `tsc` sin salida.

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/wheel.ts lib/wheel.test.ts
git commit -m "feat(wheel): ensamblado de candidatos con IV implícita, filtro por preset y orden por score"
```

---

### Task 6: Cadena filtrada y cache de barras

**Files:**
- Modify: `web/lib/massive.ts` (añadir `fetchWheelChain` al final)
- Create: `web/lib/barsStore.ts`

**Interfaces:**
- Consumes: `getJson` (privada de `massive.ts`), `MassiveError`, `DailyBar`, `fetchDailyBars(ticker, days)`, `marketDateStr(now)` de `lib/occ.ts`.
- Produces: `fetchWheelChain(ticker, opts): Promise<WheelChainResult>` con `WheelChainResult { spot: number | null; quotes: ChainQuote[] }`; `loadBars(ticker)`, `saveBars(ticker, bars)`, `cachedDailyBars(ticker, days)`.

No hay test unitario: es I/O puro y el proyecto no testea la capa de red. Se valida con una llamada real en el paso 4.

- [ ] **Step 1: Escribir `fetchWheelChain`**

Añade al final de `web/lib/massive.ts`:

```ts
/**
 * Cadena de PUTS filtrada en el servidor para el screener de Wheel.
 *
 * Los filtros (`contract_type`, `expiration_date.gte/lte`, `strike_price.lte`)
 * los resuelve Massive, así que un ticker cabe en UNA página en vez de exigir
 * la cadena completa paginada. Verificado el 2026-07-24: 48 contratos, sin
 * next_url.
 *
 * `last_quote` (bid/ask) SÍ viene en este plan; `greeks` e `implied_volatility`
 * NO — el delta se calcula por Black-Scholes en lib/wheel.ts.
 */
export interface WheelChainResult {
  spot: number | null;
  quotes: WheelChainQuote[];
}

export interface WheelChainQuote {
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  openInterest: number;
}

interface WheelRawContract {
  details?: { strike_price?: number; expiration_date?: string; contract_type?: string };
  last_quote?: { bid?: number; ask?: number };
  last_trade?: { price?: number };
  open_interest?: number;
  underlying_asset?: { price?: number };
}

export async function fetchWheelChain(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<WheelChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const from = toDateStr(now.getTime() + opts.dteMin * day);
  const to = toDateStr(now.getTime() + opts.dteMax * day);

  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?contract_type=put&expiration_date.gte=${from}&expiration_date.lte=${to}&limit=250`;

  const json = await getJson<{ results?: WheelRawContract[] }>(path);
  const results = json?.results ?? [];

  let spot: number | null = null;
  const quotes: WheelChainQuote[] = [];

  for (const c of results) {
    const strike = c.details?.strike_price;
    const expiration = c.details?.expiration_date;
    if (!(strike != null && strike > 0) || !expiration) continue;
    if (spot == null && c.underlying_asset?.price) spot = c.underlying_asset.price;

    const dte = Math.round(
      (new Date(`${expiration}T00:00:00Z`).getTime() - new Date(`${toDateStr(now.getTime())}T00:00:00Z`).getTime()) / day,
    );

    quotes.push({
      strike,
      expiration,
      dte,
      bid: c.last_quote?.bid ?? null,
      ask: c.last_quote?.ask ?? null,
      lastTrade: c.last_trade?.price ?? null,
      openInterest: c.open_interest ?? 0,
    });
  }

  // Solo puts OTM: los ITM no son cash-secured puts de Wheel, son otra cosa.
  const otm = spot != null ? quotes.filter((q) => q.strike <= spot) : quotes;
  return { spot, quotes: otm };
}
```

- [ ] **Step 2: Escribir `barsStore.ts`**

Crea `web/lib/barsStore.ts`:

```ts
// Cache en disco de barras diarias, por día de mercado.
//
// Las barras diarias solo cambian una vez al día, pero el escaneo de Wheel
// las pide para 40 tickers en cada pasada. Sin cache serían 40 llamadas
// repetidas por escaneo. Solo servidor.
//
// `fetchDailyBars` sigue sin cache para el resto de rutas: este store es
// nuevo y en v1 solo lo usa Wheel.

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";
import { fetchDailyBars } from "./massive";
import type { DailyBar } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "bars");

interface BarsFile {
  ticker: string;
  /** Día de mercado (ET) en que se guardó. */
  date: string;
  bars: DailyBar[];
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function loadBars(ticker: string): Promise<BarsFile | null> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    return JSON.parse(raw) as BarsFile;
  } catch {
    return null;
  }
}

export async function saveBars(ticker: string, bars: DailyBar[], now = new Date()): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: BarsFile = { ticker: ticker.toUpperCase(), date: marketDateStr(now), bars };
  await fs.writeFile(fileFor(ticker), JSON.stringify(payload), "utf8");
}

/** Barras diarias con cache de un día de mercado. Si falla la red, devuelve []. */
export async function cachedDailyBars(ticker: string, days = 365, now = new Date()): Promise<DailyBar[]> {
  const today = marketDateStr(now);
  const cached = await loadBars(ticker);
  if (cached && cached.date === today && cached.bars.length > 0) return cached.bars;

  const bars = await fetchDailyBars(ticker, days).catch(() => [] as DailyBar[]);
  if (bars.length > 0) await saveBars(ticker, bars, now);
  return bars;
}
```

- [ ] **Step 3: Ignorar el cache en git**

Comprueba que `data/` ya esté en `.gitignore`:

```bash
cd web && grep -n "data" .gitignore || echo "data/" >> .gitignore
```

Esperado: una línea que cubra `data/`. Si no existe, el comando la añade.

- [ ] **Step 4: Verificar contra la API real**

```bash
cd web && npx tsc --noEmit && cat > /tmp/wheel-probe.mjs <<'EOF'
const key = process.env.MASSIVE_API_KEY;
const url = "https://api.massive.com/v3/snapshot/options/F"
  + "?contract_type=put&expiration_date.gte=2026-08-14&expiration_date.lte=2026-09-08&limit=250";
const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
const j = await r.json();
const n = (j.results ?? []).length;
const conBid = (j.results ?? []).filter((c) => c.last_quote?.bid > 0).length;
console.log({ status: j.status, contratos: n, conBid, hayNextUrl: Boolean(j.next_url) });
EOF
export $(grep MASSIVE_API_KEY .env.local | xargs) && node /tmp/wheel-probe.mjsexport $(grep MASSIVE_API_KEY .env.local | xargs) && node /tmp/wheel-probe.mjs
```

Esperado: `contratos` > 0, `conBid` > 0, `hayNextUrl: false`. Confirma que los filtros de servidor funcionan y que una página basta.

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/massive.ts lib/barsStore.ts .gitignore
git commit -m "feat(wheel): cadena de puts filtrada en servidor y cache de barras diarias"
```

---

### Task 7: Estimador de earnings (doble proxy)

**Files:**
- Create: `web/lib/earnings.ts`
- Create: `web/lib/earnings.test.ts`

**Interfaces:**
- Consumes: `getJson` NO — este archivo hace su propio fetch a `/vX/reference/financials`, pero la parte pura (`estimateNextEarnings`, `earningsFlag`) se testea sin red.
- Produces: `estimateNextEarnings(filingDates, now): string | null`, `earningsFlag(input): EarningsFlag`, `fetchFilingDates(ticker): Promise<string[]>`, `earningsForTicker(input): Promise<EarningsFlag>`.
- La función `earningsFlag` devuelve el tipo `EarningsFlag` de `lib/wheel.ts`.

- [ ] **Step 1: Write the failing test**

Crea `web/lib/earnings.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/earnings.test.ts
```

Esperado: FAIL — `Failed to resolve import "./earnings"`.

- [ ] **Step 3: Write the implementation**

Crea `web/lib/earnings.ts`:

```ts
// Estimador del próximo reporte de resultados.
//
// El plan de Massive NO trae calendario de earnings (verificado: /benzinga/v1/earnings
// da 403, /v1/reference/earnings da 404). Se usan DOS proxies y la UI declara que
// es estimación:
//   1. Cadencia de filing_date de /vX/reference/financials (~91 días entre reportes).
//   2. El skew del frente que ivcontext ya calcula (>+10 pts = evento inminente).
//
// La parte pura (estimateNextEarnings, earningsFlag) no toca red.

import type { EarningsFlag } from "./wheel";

const QUARTER_DAYS = 91;
const DAY = 24 * 60 * 60 * 1000;

function toDay(d: string | number): string {
  return new Date(typeof d === "number" ? d : `${d}T00:00:00Z`).toISOString().slice(0, 10);
}

/**
 * Estima la fecha del próximo reporte a partir de los filing_date pasados.
 * Toma el más reciente y avanza en saltos de ~91 días hasta pasar HOY.
 */
export function estimateNextEarnings(filingDates: string[], now: Date): string | null {
  const times = filingDates
    .map((d) => new Date(`${d}T00:00:00Z`).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return null;

  let next = times[times.length - 1];
  const nowT = now.getTime();
  while (next <= nowT) next += QUARTER_DAYS * DAY;
  return toDay(next);
}

export function earningsFlag(input: {
  nextEarnings: string | null;
  expiration: string;
  /** Skew del frente en puntos, de ivcontext. null si no hay dato. */
  frontSkew: number | null;
}): EarningsFlag {
  if (!input.nextEarnings) return "no_aplica";
  const earnings = new Date(`${input.nextEarnings}T00:00:00Z`).getTime();
  const exp = new Date(`${input.expiration}T00:00:00Z`).getTime();
  if (earnings > exp) return "fuera";
  // Cae dentro del vencimiento. ¿Lo confirma el mercado?
  return (input.frontSkew ?? 0) > 10 ? "dentro_confirmado" : "dentro";
}

// ── Fetch (I/O — no se testea) ─────────────────────────────────────────

interface FinancialsResult {
  results?: { filing_date?: string }[];
}

/** Fechas de reporte pasadas de un ticker. Devuelve [] si el ticker no reporta (ETF). */
export async function fetchFilingDates(ticker: string): Promise<string[]> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) return [];
  const clean = ticker.trim().toUpperCase();
  const url =
    `https://api.massive.com/vX/reference/financials?ticker=${encodeURIComponent(clean)}` +
    `&timeframe=quarterly&limit=6&order=desc&sort=filing_date`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" })
    .catch(() => null);
  if (!res || !res.ok) return [];
  const json = (await res.json().catch(() => null)) as FinancialsResult | null;
  return (json?.results ?? [])
    .map((r) => r.filing_date)
    .filter((d): d is string => Boolean(d));
}

export async function earningsForTicker(input: {
  ticker: string;
  expiration: string;
  frontSkew: number | null;
  now: Date;
}): Promise<EarningsFlag> {
  const filings = await fetchFilingDates(input.ticker);
  const nextEarnings = estimateNextEarnings(filings, input.now);
  return earningsFlag({ nextEarnings, expiration: input.expiration, frontSkew: input.frontSkew });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/earnings.test.ts && npx tsc --noEmit
```

Esperado: PASS, 7 tests. `tsc` sin salida.

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/earnings.ts lib/earnings.test.ts
git commit -m "feat(wheel): estimador de earnings por doble proxy (cadencia de filing + skew)"
```

---

### Task 8: Ruta SSE del escaneo

**Files:**
- Create: `web/app/wheel/types.ts`
- Create: `web/app/api/wheel/route.ts`

**Interfaces:**
- Consumes: `WHEEL_UNIVERSE`, `WHEEL_PRESETS`, `PresetId`, `wheelCandidates`, `WheelCandidate`, `atmIv` de `lib/wheel.ts`; `fetchWheelChain` de `lib/massive.ts`; `cachedDailyBars` de `lib/barsStore.ts`; `findLevels` de `lib/levels.ts`; `realizedVolSeries`, `rankWithin` de `lib/ivcontext.ts`; `earningsForTicker` de `lib/earnings.ts`.
- Produces: en `types.ts` → `WheelSseEvent`, `WheelDoneEvent`, `WheelStepEvent`, `WheelErrorEvent`, `WheelTickerResult`. La ruta responde `GET /api/wheel?preset=<PresetId>` con `text/event-stream`.

No hay test unitario (patrón del proyecto para rutas SSE). Se valida corriendo el dev server en el paso 4.

- [ ] **Step 1: Definir los tipos del evento**

Crea `web/app/wheel/types.ts`:

```ts
import type { WheelCandidate } from "@/lib/wheel";

/** Un candidato con lo que el CLIENTE necesita para juzgar asequibilidad. */
export type WheelIdea = WheelCandidate;

export interface WheelStepEvent {
  type: "step";
  label: string;
}

export interface WheelDoneEvent {
  type: "done";
  candidates: WheelIdea[];
  meta: {
    preset: string;
    scanned: number;
    failed: number;
    withCandidates: number;
    /** true si falló más de la mitad del universo. */
    degraded: boolean;
  };
}

export interface WheelErrorEvent {
  type: "error";
  message: string;
}

export type WheelSseEvent = WheelStepEvent | WheelDoneEvent | WheelErrorEvent;
```

- [ ] **Step 2: Escribir la ruta**

Crea `web/app/api/wheel/route.ts`:

```ts
// GET /api/wheel?preset=balanceado — Screener de cash-secured puts por SSE.
//
// Orquesta I/O y NADA de criterio: todo lo que decide vive en lib/wheel.ts.
// El saldo NO llega aquí: la ruta devuelve candidatos con métricas y la
// asequibilidad se calcula en el cliente con tito.risk.* de localStorage.

import { fetchWheelChain } from "@/lib/massive";
import { cachedDailyBars } from "@/lib/barsStore";
import { findLevels, type LvlBar } from "@/lib/levels";
import { realizedVolSeries, rankWithin } from "@/lib/ivcontext";
import { earningsForTicker } from "@/lib/earnings";
import {
  WHEEL_PRESETS, WHEEL_UNIVERSE, atmIv, wheelCandidates,
  type PresetId, type WheelCandidate,
} from "@/lib/wheel";
import type { WheelSseEvent } from "@/app/wheel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONCURRENCY = 6;

function sse(event: WheelSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isPreset(v: string | null): v is PresetId {
  return v === "conservador" || v === "balanceado" || v === "agresivo";
}

/** Corre `worker` sobre `items` con como mucho `limit` en vuelo a la vez. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const presetParam = url.searchParams.get("preset");
  const preset = WHEEL_PRESETS[isPreset(presetParam) ? presetParam : "balanceado"];
  const now = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: WheelSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      let failed = 0;
      const all: WheelCandidate[] = [];

      try {
        send({ type: "step", label: `Escaneando ${WHEEL_UNIVERSE.length} tickers · preset ${preset.label}` });

        await mapLimit(WHEEL_UNIVERSE, CONCURRENCY, async (sym) => {
          try {
            const chain = await fetchWheelChain(sym.ticker, {
              dteMin: preset.dteMin, dteMax: preset.dteMax, now,
            });
            if (chain.spot == null || chain.quotes.length === 0) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin cadena` });
              return;
            }

            const bars = await cachedDailyBars(sym.ticker, 365, now);
            const lvlBars: LvlBar[] = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
            const levels = findLevels({ bars: lvlBars, spot: chain.spot, now });

            // IV Rank propio: proxy de volatilidad realizada (no hay serie de IV).
            const rvSeries = realizedVolSeries(bars.map((b) => b.close), 30);
            const currentRv = rvSeries.length > 0 ? rvSeries[rvSeries.length - 1] : null;
            const ivRank = currentRv != null ? rankWithin(rvSeries, currentRv) : null;

            // Earnings sobre el vencimiento más cercano de la ventana.
            const nearExp = chain.quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
            const earnings = await earningsForTicker({
              ticker: sym.ticker, expiration: nearExp, frontSkew: null, now,
            });

            const fallbackIv = currentRv != null ? currentRv / 100 : 0.4;
            const cands = wheelCandidates({
              ticker: sym.ticker, spot: chain.spot, quotes: chain.quotes,
              preset, ivRank, supports: levels.supports, earnings, fallbackIv,
            });
            all.push(...cands);
            send({ type: "step", label: `${sym.ticker}: ${cands.filter((c) => !c.blocked).length} candidatos` });
          } catch {
            failed++;
            send({ type: "step", label: `${sym.ticker}: error` });
          }
        });

        all.sort((a, b) => {
          if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
          return (b.score?.total ?? 0) - (a.score?.total ?? 0);
        });

        const withCandidates = new Set(all.filter((c) => !c.blocked).map((c) => c.ticker)).size;
        send({
          type: "done",
          candidates: all,
          meta: {
            preset: preset.label,
            scanned: WHEEL_UNIVERSE.length,
            failed,
            withCandidates,
            degraded: failed > WHEEL_UNIVERSE.length / 2,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado en el escaneo.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 3: Verificar compilación**

```bash
cd web && npx tsc --noEmit
```

Esperado: sin salida.

- [ ] **Step 4: Probar la ruta contra el dev server**

Con el dev server corriendo en :3000 (usa el que ya existe, no arranques otro):

```bash
curl -sN "http://localhost:3000/api/wheel?preset=balanceado" --max-time 90 | grep -c '"type":"step"'
```

Esperado: un número > 0 (llegaron pasos por SSE). Si el server no está corriendo, arráncalo con `npm run dev` en `web/` y repite. El escaneo completo puede tardar 30-60 s la primera vez (sin cache de barras).

- [ ] **Step 5: Commit**

```bash
cd web && git add app/wheel/types.ts app/api/wheel/route.ts
git commit -m "feat(wheel): ruta SSE del escaneo con concurrencia limitada y degradación honesta"
```

---

### Task 9: Asequibilidad en el cliente

**Files:**
- Create: `web/lib/wheelAfford.ts`
- Create: `web/lib/wheelAfford.test.ts`

**Interfaces:**
- Consumes: `WheelCandidate` de `lib/wheel.ts`; `RiskProfile` de `lib/risk.ts`.
- Produces: `AffordResult`, `affordOf(candidate, cash): AffordResult`, `sortByAffordThenScore(candidates, cash): (WheelCandidate & { afford: AffordResult })[]`.

Esta lógica es pura y va en el cliente (recibe el saldo, que nunca sale del navegador). Por eso se aísla de la ruta y se testea sola.

- [ ] **Step 1: Write the failing test**

Crea `web/lib/wheelAfford.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { affordOf, sortByAffordThenScore } from "./wheelAfford";
import type { WheelCandidate } from "./wheel";

function cand(p: Partial<WheelCandidate> & { collateral: number; score: number }): WheelCandidate {
  return {
    ticker: "F", strike: p.collateral / 100, expiration: "2026-08-21", dte: 35, spot: 12,
    delta: -0.25, iv: 0.45, ivSource: "implicita", openInterest: 900, spreadPct: 5,
    premium: { price: 0.3, source: "bid", raw: 0.3 },
    metrics: {
      credit: 30, collateral: p.collateral, returnPct: 2, annualizedPct: 25,
      breakeven: 10.7, cushionPct: 8, probExpireWorthless: 75,
    },
    score: {
      total: p.score, annualized: { points: 0, max: 30, band: "", why: "" },
      ivRank: { points: 0, max: 20, band: "", why: "" },
      cushion: { points: 0, max: 25, band: "", why: "" },
      liquidity: { points: 0, max: 15, band: "", why: "" },
      earnings: { points: 0, max: 10, band: "", why: "" },
    },
    blocked: false, blockReason: null,
  };
}

describe("affordOf", () => {
  it("alcanza cuando el colateral cabe en el efectivo", () => {
    const a = affordOf(cand({ collateral: 1100, score: 80 }), 2000);
    expect(a.affordable).toBe(true);
    expect(a.shortfall).toBe(0);
  });

  it("no alcanza y reporta cuánto falta", () => {
    const a = affordOf(cand({ collateral: 1100, score: 80 }), 800);
    expect(a.affordable).toBe(false);
    expect(a.shortfall).toBe(300);
  });

  it("un candidato bloqueado nunca es asequible", () => {
    const blocked = { ...cand({ collateral: 1100, score: 0 }), blocked: true, metrics: null };
    const a = affordOf(blocked, 5000);
    expect(a.affordable).toBe(false);
  });
});

describe("sortByAffordThenScore", () => {
  it("pone los asequibles arriba y ordena por score dentro de cada grupo", () => {
    const rows = sortByAffordThenScore([
      cand({ collateral: 5000, score: 95 }), // caro pero mejor score
      cand({ collateral: 1000, score: 60 }), // asequible, peor score
    ], 1500);
    expect(rows[0].metrics?.collateral).toBe(1000); // el asequible va primero
    expect(rows[0].afford.affordable).toBe(true);
    expect(rows[1].afford.affordable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run lib/wheelAfford.test.ts
```

Esperado: FAIL — `Failed to resolve import "./wheelAfford"`.

- [ ] **Step 3: Write the implementation**

Crea `web/lib/wheelAfford.ts`:

```ts
// Asequibilidad del candidato frente al efectivo del usuario.
//
// PURO y pensado para correr en el CLIENTE: recibe el saldo, que vive en
// localStorage y nunca llega al servidor. Aislado de la ruta a propósito.

import type { WheelCandidate } from "./wheel";

export interface AffordResult {
  affordable: boolean;
  /** Cuánto efectivo falta para cubrir el colateral, en $. 0 si alcanza. */
  shortfall: number;
}

export function affordOf(candidate: WheelCandidate, cash: number): AffordResult {
  const collateral = candidate.metrics?.collateral ?? Infinity;
  if (candidate.blocked || !Number.isFinite(collateral)) {
    return { affordable: false, shortfall: 0 };
  }
  const affordable = collateral <= cash;
  return { affordable, shortfall: affordable ? 0 : collateral - cash };
}

export type AffordableCandidate = WheelCandidate & { afford: AffordResult };

export function sortByAffordThenScore(candidates: WheelCandidate[], cash: number): AffordableCandidate[] {
  return candidates
    .map((c) => ({ ...c, afford: affordOf(c, cash) }))
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      if (a.afford.affordable !== b.afford.affordable) return a.afford.affordable ? -1 : 1;
      return (b.score?.total ?? 0) - (a.score?.total ?? 0);
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run lib/wheelAfford.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd web && git add lib/wheelAfford.ts lib/wheelAfford.test.ts
git commit -m "feat(wheel): asequibilidad en cliente — asequibles arriba, el saldo no sale del navegador"
```

---

### Task 10: Preset card y tabla de candidatos

**Files:**
- Create: `web/app/components/WheelPresetCard.tsx`
- Create: `web/app/components/WheelTable.tsx`
- Modify: `web/app/globals.css` (estilos `.wheel-*`)

**Interfaces:**
- Consumes: `WHEEL_PRESETS`, `PresetId`, `WheelPreset` de `lib/wheel.ts`; `AffordableCandidate` de `lib/wheelAfford.ts`.
- Produces: `WheelPresetCard` (default export) props `{ preset: PresetId; onChange: (p: PresetId) => void }`; `WheelTable` (default export) props `{ rows: AffordableCandidate[]; view: "estudiante" | "pro" }`.

Componentes de UI: sin test unitario, se validan en la Task 11 con el navegador.

- [ ] **Step 1: Escribir `WheelPresetCard.tsx`**

Crea `web/app/components/WheelPresetCard.tsx`:

```tsx
"use client";

import { WHEEL_PRESETS, type PresetId } from "@/lib/wheel";

const ORDER: PresetId[] = ["conservador", "balanceado", "agresivo"];

export default function WheelPresetCard({
  preset,
  onChange,
}: {
  preset: PresetId;
  onChange: (p: PresetId) => void;
}) {
  const active = WHEEL_PRESETS[preset];
  return (
    <div className="card wheel-preset">
      <div className="wheel-preset-head">
        <h2>Cómo quieres vender puts</h2>
        <p>Elige un perfil. No hay que tocar números — cada uno ya trae su delta y su plazo.</p>
      </div>
      <div className="wheel-preset-tabs">
        {ORDER.map((id) => {
          const p = WHEEL_PRESETS[id];
          return (
            <button
              key={id}
              className={`wheel-preset-tab ${preset === id ? "on" : ""}`}
              onClick={() => onChange(id)}
              type="button"
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p className="wheel-preset-explain">{active.explain}</p>
      <div className="wheel-preset-facts">
        <span>Delta objetivo <b>{active.deltaMin.toFixed(2)}–{active.deltaMax.toFixed(2)}</b></span>
        <span>Vencimiento <b>{active.dteMin}–{active.dteMax} días</b></span>
        <span>Cierra al <b>{active.takeProfitPct}%</b> de la prima</span>
        <span>Rola a los <b>{active.rollDte} días</b></span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Escribir `WheelTable.tsx`**

Crea `web/app/components/WheelTable.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { AffordableCandidate } from "@/lib/wheelAfford";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;

const SOURCE_LABEL: Record<string, string> = {
  bid: "bid real",
  ultimo: "último precio −10%",
  modelo: "modelo −15%",
};

export default function WheelTable({
  rows,
  view,
}: {
  rows: AffordableCandidate[];
  view: "estudiante" | "pro";
}) {
  if (rows.length === 0) {
    return <div className="card wheel-empty">Sin candidatos con este perfil. Prueba otro preset.</div>;
  }
  return (
    <div className="wheel-list">
      {rows.map((c) => (
        <WheelRow key={`${c.ticker}-${c.strike}-${c.expiration}`} c={c} view={view} />
      ))}
    </div>
  );
}

function WheelRow({ c, view }: { c: AffordableCandidate; view: "estudiante" | "pro" }) {
  const [open, setOpen] = useState(false);

  if (c.blocked) {
    return (
      <div className="card wheel-row blocked">
        <div className="wheel-row-head">
          <b>{c.ticker}</b> ${c.strike} · {c.expiration}
          <span className="wheel-tag danger">Ilíquido — no operable</span>
        </div>
        <p className="wheel-blocked-why">
          {c.blockReason === "sin_bid" && "Nadie está poniendo precio de compra: no podrías vender."}
          {c.blockReason === "spread_ancho" && "La horquilla es demasiado ancha: perderías dinero al entrar."}
          {c.blockReason === "oi_bajo" && "Muy pocos contratos abiertos: no hay con quién operar."}
        </p>
      </div>
    );
  }

  const m = c.metrics!;
  const s = c.score!;
  const p = c.premium!;

  return (
    <div className={`card wheel-row ${c.afford.affordable ? "" : "unafford"}`}>
      <button className="wheel-row-head" onClick={() => setOpen((v) => !v)} type="button">
        <span><b>{c.ticker}</b> ${c.strike} put · {c.expiration} ({c.dte}d)</span>
        <span className="wheel-score">{s.total}<small>/100</small></span>
      </button>

      {view === "estudiante" ? (
        <p className="wheel-plain">
          Si vendieras este put, cobrarías <b>{money(m.credit)}</b> y necesitas{" "}
          <b>{money(m.collateral)}</b> en efectivo retenido. Empiezas a perder por debajo de{" "}
          <b>{money2(m.breakeven)}</b>. Hay <b>{Math.round(m.probExpireWorthless)}%</b> de que expire sin valor y te quedes la prima.
          {!c.afford.affordable && <> Te faltan <b>{money(c.afford.shortfall)}</b> para poder venderlo.</>}
        </p>
      ) : (
        <div className="wheel-grid">
          <span>Prima <b>{money2(p.price)}</b> <small>({SOURCE_LABEL[p.source]})</small></span>
          <span>Δ <b>{c.delta.toFixed(2)}</b></span>
          <span>IV <b>{pct(c.iv * 100)}</b> <small>{c.ivSource === "estimada" ? "est." : "impl."}</small></span>
          <span>Anualizado <b>{pct(m.annualizedPct)}</b></span>
          <span>Colchón <b>{pct(m.cushionPct)}</b></span>
          <span>OI <b>{c.openInterest.toLocaleString()}</b></span>
          <span>Colateral <b>{money(m.collateral)}</b></span>
          {!c.afford.affordable && <span className="wheel-tag warn">faltan {money(c.afford.shortfall)}</span>}
        </div>
      )}

      {open && (
        <div className="wheel-outcomes">
          <div><b>Si expira sin valor</b> ({Math.round(m.probExpireWorthless)}%): te quedas {money(m.credit)} y se libera tu colateral.</div>
          <div><b>Si te asignan</b>: compras 100 acciones a ${c.strike}. Tu costo real queda en {money2(m.breakeven)} y empiezas a vender calls sobre ellas.</div>
          <div><b>Si se desploma 20%</b>: tendrías las acciones valiendo ~{money2(c.spot * 0.8)}, con pérdida no realizada frente a tu costo de {money2(m.breakeven)}.</div>
          <div className="wheel-why">
            {[s.annualized, s.ivRank, s.cushion, s.liquidity, s.earnings].map((part, i) => (
              <div key={i}>· {part.why}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Añadir estilos**

Añade al final de `web/app/globals.css`:

```css
/* ── Módulo Wheel ────────────────────────────────────── */
.wheel-preset-head h2 { margin: 0 0 4px; font-size: 18px; }
.wheel-preset-head p { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.wheel-preset-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.wheel-preset-tab {
  font-family: inherit; font-size: 13px; font-weight: 600;
  padding: 8px 16px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border); background: #fff; color: #344054;
}
.wheel-preset-tab.on { background: #101828; color: #fff; border-color: #101828; }
.wheel-preset-explain { margin: 0 0 12px; font-size: 14px; }
.wheel-preset-facts { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; color: var(--muted); }
.wheel-preset-facts b { color: var(--text); }

.wheel-list { display: flex; flex-direction: column; gap: 10px; }
.wheel-row { padding: 16px 20px; }
.wheel-row.unafford { opacity: 0.72; }
.wheel-row.blocked { border-color: #fecaca; background: #fff7f7; }
.wheel-row-head {
  width: 100%; display: flex; justify-content: space-between; align-items: center;
  font-family: inherit; font-size: 15px; background: none; border: none;
  cursor: pointer; text-align: left; padding: 0; color: var(--text);
}
.wheel-score { font-weight: 700; font-size: 20px; }
.wheel-score small { font-size: 12px; color: var(--muted); font-weight: 500; }
.wheel-plain { margin: 10px 0 0; font-size: 14px; line-height: 1.5; }
.wheel-grid { display: flex; flex-wrap: wrap; gap: 6px 20px; margin-top: 10px; font-size: 13px; color: var(--muted); }
.wheel-grid b { color: var(--text); }
.wheel-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.wheel-tag.danger { background: #fee2e2; color: #b42318; }
.wheel-tag.warn { background: #fef0c7; color: #b54708; }
.wheel-outcomes { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.wheel-why { margin-top: 6px; color: var(--muted); font-size: 12px; }
.wheel-blocked-why { margin: 8px 0 0; font-size: 13px; color: #b42318; }
.wheel-empty { color: var(--muted); }
```

- [ ] **Step 4: Verificar compilación**

```bash
cd web && npx tsc --noEmit
```

Esperado: sin salida.

- [ ] **Step 5: Commit**

```bash
cd web && git add app/components/WheelPresetCard.tsx app/components/WheelTable.tsx app/globals.css
git commit -m "feat(wheel): preset card y tabla de candidatos en dos densidades"
```

---

### Task 11: Página, navegación y documentación

**Files:**
- Create: `web/app/wheel/page.tsx`
- Modify: `web/app/components/NavTabs.tsx` (cuarta pestaña)
- Modify: `CLAUDE.md` (corregir nota de last_quote + documentar el módulo)

**Interfaces:**
- Consumes: todo lo anterior. `loadProfile`, `DEFAULT_PROFILE`, `RiskProfileCard` de `lib/`/componentes existentes; `sortByAffordThenScore` de `lib/wheelAfford.ts`; `WheelSseEvent` de `app/wheel/types.ts`.

- [ ] **Step 1: Escribir la página**

Crea `web/app/wheel/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RiskProfileCard, { DEFAULT_PROFILE, loadProfile } from "@/app/components/RiskProfileCard";
import WheelPresetCard from "@/app/components/WheelPresetCard";
import WheelTable from "@/app/components/WheelTable";
import NavTabs from "@/app/components/NavTabs";
import { sortByAffordThenScore } from "@/lib/wheelAfford";
import type { PresetId, WheelCandidate } from "@/lib/wheel";
import type { RiskProfile } from "@/lib/risk";
import type { WheelSseEvent } from "./types";

const KEY_VIEW = "tito.view";
const KEY_PRESET = "tito.wheel.preset";

type WheelMeta = { scanned: number; failed: number; withCandidates: number; degraded: boolean };

export default function WheelPage() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_PROFILE);
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  const [preset, setPreset] = useState<PresetId>("balanceado");

  const [candidates, setCandidates] = useState<WheelCandidate[] | null>(null);
  const [meta, setMeta] = useState<WheelMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setProfile(loadProfile());
    const v = window.localStorage.getItem(KEY_VIEW);
    if (v === "pro" || v === "estudiante") setView(v);
    const p = window.localStorage.getItem(KEY_PRESET);
    if (p === "conservador" || p === "balanceado" || p === "agresivo") setPreset(p);
  }, []);

  const scan = useCallback((which: PresetId) => {
    esRef.current?.close();
    setBusy(true); setError(null); setSteps([]); setCandidates(null); setMeta(null);
    const es = new EventSource(`/api/wheel?preset=${which}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as WheelSseEvent;
      if (data.type === "step") setSteps((s) => [...s, data.label]);
      else if (data.type === "done") { setCandidates(data.candidates); setMeta(data.meta); setBusy(false); es.close(); }
      else if (data.type === "error") { setError(data.message); setBusy(false); es.close(); }
    };
    es.onerror = () => { setError("Se cortó la conexión con el escáner."); setBusy(false); es.close(); };
  }, []);

  useEffect(() => { scan(preset); return () => esRef.current?.close(); }, [scan, preset]);

  const pickPreset = (p: PresetId) => { setPreset(p); window.localStorage.setItem(KEY_PRESET, p); };
  const pickView = (v: "estudiante" | "pro") => { setView(v); window.localStorage.setItem(KEY_VIEW, v); };

  const rows = useMemo(() => {
    if (!candidates) return [];
    return sortByAffordThenScore(candidates, profile.accountSize);
  }, [candidates, profile.accountSize]);

  const operables = rows.filter((r) => !r.blocked && r.afford.affordable).length;

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo">T</div>
          <div className="hb-name">Tito Metralleta</div>
          <div className="hb-chip">Wheel · ingreso con puts</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <WheelPresetCard preset={preset} onChange={pickPreset} />
        <RiskProfileCard profile={profile} onChange={setProfile} />

        <div className="ideas-controls">
          <div className="view-toggle">
            <button className={view === "estudiante" ? "active" : ""} onClick={() => pickView("estudiante")}>👤 Estudiante</button>
            <button className={view === "pro" ? "active" : ""} onClick={() => pickView("pro")}>⚡ Pro</button>
          </div>
          <button className="rescan" onClick={() => scan(preset)} disabled={busy}>↻ Volver a escanear</button>
        </div>

        {busy && (
          <div className="card wheel-empty">
            {steps.length > 0 ? steps[steps.length - 1] : "Escaneando el mercado…"}
          </div>
        )}
        {error && <div className="error">⚠ {error}</div>}

        {candidates && meta && (
          <>
            <div className="wheel-status">
              Escaneadas {meta.scanned} · {operables} alcanzables con tu efectivo · {rows.filter((r) => !r.blocked).length} candidatos
              {meta.degraded && <span className="wheel-tag warn"> datos parciales: falló más de la mitad</span>}
            </div>
            <p className="wheel-disclaimer">
              Las cotizaciones de Massive son <b>retrasadas</b>. Estos son candidatos, no órdenes: confirma el precio en tu bróker antes de vender.
            </p>
            <WheelTable rows={rows} view={view} />
          </>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Añadir estilos de estado**

Añade a `web/app/globals.css`:

```css
.wheel-status { font-size: 14px; font-weight: 600; margin: 4px 0; }
.wheel-disclaimer { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
.rescan { font-family: inherit; font-size: 13px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--border); background: #fff; cursor: pointer; }
.rescan:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 3: Añadir la pestaña Wheel a NavTabs**

En `web/app/components/NavTabs.tsx`, añade la entrada al array `TABS` después de Ideas:

```tsx
  { href: "/wheel", label: "Wheel", icon: "🎡" },
```

El orden final debe ser: Ticker, Ideas, Wheel, Time & Sales.

- [ ] **Step 4: Verificar compilación y tests completos**

```bash
cd web && npx tsc --noEmit && npx vitest run
```

Esperado: `tsc` sin salida; todos los tests del proyecto pasan (los nuevos de blackScholes, wheel, wheelUniverse, earnings, wheelAfford + los preexistentes).

- [ ] **Step 5: Verificar en el navegador**

Con el dev server en :3000, abrir `http://localhost:3000/wheel`, comprobar:
- La cuarta pestaña 🎡 Wheel aparece y queda resaltada.
- El escaneo muestra pasos en vivo y luego la lista.
- El toggle Estudiante/Pro cambia la densidad.
- Cambiar de preset relanza el escaneo.
- Con la cuenta por defecto ($10.000), los alcanzables salen arriba.

- [ ] **Step 6: Corregir y documentar CLAUDE.md**

Dos ediciones en `CLAUDE.md`:

1. Corregir la línea obsoleta de la sección "Limitación del plan actual". Cambiar:
   > Massive no devuelve `last_quote` (bid/ask) ni greeks en este plan.

   por:
   > Massive **sí** devuelve `last_quote` (bid/ask) en el Option Chain Snapshot (verificado jul 2026), pero **no** `greeks` ni `implied_volatility`. Open Premium sigue usando `last_trade.price ?? day.close ?? day.vwap` como proxy; el delta de la Wheel se calcula por Black-Scholes (`lib/blackScholes.ts`).

2. Añadir una viñeta de módulo en la sección de la app web, en el mismo estilo que las demás:
   > - **Wheel Strategy (`/wheel`, jul 2026):** screener de cash-secured puts que responde "qué put vendo hoy y cuánto efectivo inmoviliza". Universo curado de 40 tickers (`lib/wheelUniverse.ts`), 3 presets (`WHEEL_PRESETS` en `lib/wheel.ts`), score compuesto 0-100 que reusa `findLevels` (soportes), proxy de IV Rank y estimador de earnings (`lib/earnings.ts`). Criterio PURO y testeado en `lib/{blackScholes,wheel,earnings,wheelAfford}.ts`; ruta SSE `app/api/wheel/route.ts` solo orquesta I/O. El saldo vive en `localStorage` y la asequibilidad se calcula en el cliente (`sortByAffordThenScore`), nunca en el servidor. **Ojo:** la banda de IV Rank en `wheel.ts` va INVERTIDA respecto a `ivcontext.ts` — la Wheel vende volatilidad, el resto del agente la compra. Spec: [docs/superpowers/specs/2026-07-24-wheel-strategy-design.md](web/docs/superpowers/specs/2026-07-24-wheel-strategy-design.md).

- [ ] **Step 7: Commit final**

```bash
cd web && cd .. && git add web/app/wheel/page.tsx web/app/components/NavTabs.tsx web/app/globals.css CLAUDE.md
git commit -m "feat(wheel): página /wheel, pestaña de navegación y documentación del módulo"
```

---

## Notas de ejecución

- **Orden:** las tasks van en secuencia; cada una compila y pasa tests antes de la siguiente. Las Tasks 1-5, 7 y 9 son puras y no necesitan red. Las Tasks 6, 8 y 11 tocan API/navegador.
- **Dev server:** reusa el `tito-web` existente (o `npm run dev` en `web/`); no arranques un segundo servidor en el mismo puerto.
- **Si un test de `gex` se rompe en la Task 1:** la mudanza de `bsGamma` alteró la fórmula. Es un bug de la task, no del test — revísalo.
