import { describe, expect, it } from "vitest";
import {
  BROKERS,
  addToOutbox,
  brokerById,
  buildEntry,
  contractQuery,
  contractRefLabel,
  failedOutbox,
  markOutboxFailed,
  markOutboxSynced,
  markSynced,
  outboxKey,
  outboxLabel,
  payloadFor,
  pendingOutbox,
  quoteLink,
  remove,
  removeFromOutbox,
  sortEntries,
  tickerList,
  underlyings,
  upsert,
  type BrokerAdapter,
  type EntrySource,
  type OutboxItem,
  type OutboxTarget,
  type WatchlistEntry,
} from "./watchlist";

const NOW = new Date("2026-07-24T17:00:00Z");
const PROFILE = { accountSize: 10_000, tolerancePct: 4 };
const SIZING = { maxContracts: 2, binding: "prima" as const };

function source(p: Partial<EntrySource> = {}): EntrySource {
  return {
    symbol: "WULF270115C00020000", ticker: "WULF", type: "call",
    strike: 20, expiration: "2027-01-15", dte: 175,
    price: 5.25, assetPrice: 19.27, premium: 5_250_000, thetaPctDaily: 0.3,
    ...p,
  };
}

describe("buildEntry", () => {
  it("congela la foto del momento: spot, precio y tu sizing", () => {
    const e = buildEntry(source(), SIZING, PROFILE, NOW);
    expect(e.symbol).toBe("WULF270115C00020000");
    expect(e.ticker).toBe("WULF");
    expect(e.entrySpot).toBe(19.27);
    expect(e.entryPrice).toBe(5.25);
    expect(e.maxContracts).toBe(2);
    expect(e.binding).toBe("prima");
    expect(e.accountSizeAtEntry).toBe(10_000);
    expect(e.tolerancePctAtEntry).toBe(4);
    expect(e.addedAt).toBe(NOW.toISOString());
    expect(e.brokerSync).toBeNull();
  });
});

describe("upsert", () => {
  it("añade al principio", () => {
    const a = buildEntry(source(), SIZING, PROFILE, NOW);
    expect(upsert([], a)).toHaveLength(1);
  });

  it("un contrato entra una sola vez", () => {
    const a = buildEntry(source(), SIZING, PROFILE, NOW);
    const list = upsert(upsert([], a), a);
    expect(list).toHaveLength(1);
  });

  it("volver a marcarlo NO pisa la foto original", () => {
    const original = buildEntry(source(), SIZING, PROFILE, NOW);
    const despues = buildEntry(
      source({ assetPrice: 25, price: 8 }),
      { maxContracts: 9, binding: "theta" },
      { accountSize: 50_000, tolerancePct: 10 },
      new Date("2026-08-01T17:00:00Z"),
    );
    const [only] = upsert(upsert([], original), despues);
    expect(only.entrySpot).toBe(19.27);
    expect(only.entryPrice).toBe(5.25);
    expect(only.maxContracts).toBe(2);
    expect(only.addedAt).toBe(NOW.toISOString());
  });

  it("re-marcar conserva el estado de sincronización", () => {
    const a = buildEntry(source(), SIZING, PROFILE, NOW);
    const synced = markSynced([a], a.symbol, {
      broker: "robinhood", status: "sincronizado", sent: "underlying", at: NOW.toISOString(),
    });
    const [only] = upsert(synced, a);
    expect(only.brokerSync?.status).toBe("sincronizado");
  });

  it("contratos distintos del mismo ticker conviven", () => {
    const c20 = buildEntry(source(), SIZING, PROFILE, NOW);
    const c25 = buildEntry(
      source({ symbol: "WULF270115C00025000", strike: 25 }), SIZING, PROFILE, NOW,
    );
    expect(upsert(upsert([], c20), c25)).toHaveLength(2);
  });
});

describe("remove", () => {
  it("quita por símbolo y deja el resto", () => {
    const a = buildEntry(source(), SIZING, PROFILE, NOW);
    const b = buildEntry(source({ symbol: "ZETA260918C00020000", ticker: "ZETA" }), SIZING, PROFILE, NOW);
    const list = remove(upsert(upsert([], a), b), a.symbol);
    expect(list).toHaveLength(1);
    expect(list[0].ticker).toBe("ZETA");
  });

  it("quitar algo que no está no rompe nada", () => {
    expect(remove([], "NADA")).toEqual([]);
  });
});

describe("payloadFor — qué se le puede mandar a cada broker", () => {
  const entry = buildEntry(source(), SIZING, PROFILE, NOW);

  it("un broker que acepta contratos recibe el OCC completo", () => {
    const p = payloadFor(entry, {
      id: "x", name: "X", kind: "mcp", granularity: "contracts",
    });
    expect(p).toEqual({ sent: "contract", value: "WULF270115C00020000" });
  });

  it("Robinhood acepta el contrato: tiene watchlist de opciones por MCP", () => {
    const rh = brokerById("robinhood")!;
    expect(rh.granularity).toBe("contracts");
    expect(payloadFor(entry, rh)).toEqual({
      sent: "contract", value: "WULF270115C00020000",
    });
  });

  it("un broker de solo subyacente recibe el ticker pelado", () => {
    expect(payloadFor(entry, brokerById("schwab")!)).toEqual({
      sent: "underlying", value: "WULF",
    });
  });

  it("un broker que no acepta nada devuelve null — la UI no finge que sincronizó", () => {
    expect(
      payloadFor(entry, { id: "none", name: "N", kind: "none", granularity: "none" }),
    ).toBeNull();
  });
});

describe("underlyings", () => {
  it("deduplica y ordena los tickers a sincronizar", () => {
    const list: WatchlistEntry[] = [
      buildEntry(source(), SIZING, PROFILE, NOW),
      buildEntry(source({ symbol: "WULF270115C00025000", strike: 25 }), SIZING, PROFILE, NOW),
      buildEntry(source({ symbol: "ZETA260918C00020000", ticker: "ZETA" }), SIZING, PROFILE, NOW),
    ];
    expect(underlyings(list)).toEqual(["WULF", "ZETA"]);
  });
});

describe("sortEntries", () => {
  it("las más recientes primero", () => {
    const viejo = buildEntry(source(), SIZING, PROFILE, new Date("2026-07-01T00:00:00Z"));
    const nuevo = buildEntry(
      source({ symbol: "ZETA260918C00020000", ticker: "ZETA" }),
      SIZING, PROFILE, new Date("2026-07-20T00:00:00Z"),
    );
    expect(sortEntries([viejo, nuevo])[0].ticker).toBe("ZETA");
  });
});

describe("BROKERS", () => {
  it("Robinhood declara la limitación que le queda: nada de varias patas", () => {
    const rh = brokerById("robinhood");
    expect(rh?.caveat).toMatch(/patas|spread/i);
  });

  it("Robinhood es el único que escribe de verdad en el broker", () => {
    expect(BROKERS.filter((b) => b.kind === "mcp").map((b) => b.id)).toEqual(["robinhood"]);
  });

  it("todos los brokers tienen id único", () => {
    expect(new Set(BROKERS.map((b) => b.id)).size).toBe(BROKERS.length);
  });

  it("un id desconocido devuelve null", () => {
    expect(brokerById("etrade")).toBeNull();
  });

  it("todo broker de tipo link trae su plantilla de URL", () => {
    for (const b of BROKERS.filter((x) => x.kind === "link")) {
      expect(b.quoteUrl, `${b.id} es link pero no tiene quoteUrl`).toBeTypeOf("function");
    }
  });

  it("los brokers de copiar NO traen URL — mandar a un 404 es peor que copiar", () => {
    for (const b of BROKERS.filter((x) => x.kind === "copy")) {
      expect(b.quoteUrl, `${b.id} es copy y no debería tener quoteUrl`).toBeUndefined();
      expect(b.caveat, `${b.id} debe explicar por qué no hay enlace`).toBeTruthy();
    }
  });
});

describe("quoteLink", () => {
  it("construye la URL del ticker en el broker", () => {
    expect(quoteLink("WULF", brokerById("schwab")!)).toBe(
      "https://www.schwab.com/research/stocks/quotes/summary/WULF",
    );
    expect(quoteLink("WULF", brokerById("fidelity")!)).toContain("symbol=WULF");
  });

  it("un broker sin ruta por símbolo devuelve null, no una URL inventada", () => {
    expect(quoteLink("WULF", brokerById("webull")!)).toBeNull();
    expect(quoteLink("WULF", brokerById("ibkr")!)).toBeNull();
  });

  it("escapa el ticker en vez de pegarlo crudo en la URL", () => {
    expect(quoteLink("A B", brokerById("robinhood")!)).toBe("https://robinhood.com/stocks/A%20B");
  });
});

describe("tickerList", () => {
  it("da los subyacentes listos para pegar en el buscador del broker", () => {
    const list = [
      buildEntry(source(), SIZING, PROFILE, NOW),
      buildEntry(source({ symbol: "WULF270115C00025000", strike: 25 }), SIZING, PROFILE, NOW),
      buildEntry(source({ symbol: "ZETA260918C00020000", ticker: "ZETA" }), SIZING, PROFILE, NOW),
    ];
    expect(tickerList(list)).toBe("WULF, ZETA");
  });

  it("un watchlist vacío da cadena vacía", () => {
    expect(tickerList([])).toBe("");
  });
});

describe("contractQuery — el puente OCC → id del broker", () => {
  it("arma la búsqueda que resuelve el contrato en el broker", () => {
    expect(contractQuery({ ticker: "wulf", type: "call", strike: 20, expiration: "2027-01-15" }))
      .toEqual({
        chain_symbol: "WULF",
        type: "call",
        strike_price: "20.0000",
        expiration_dates: "2027-01-15",
      });
  });

  it("el strike va con 4 decimales: es un filtro exacto y '20' no casa con '20.0000'", () => {
    const q = contractQuery({
      ticker: "SPY", type: "put", strike: 612.5, expiration: "2026-09-18",
    });
    expect(q?.strike_price).toBe("612.5000");
  });

  it("sin strike o sin vencimiento devuelve null en vez de adivinar el contrato", () => {
    const base = { ticker: "WULF", type: "call" as const };
    expect(contractQuery({ ...base, strike: null, expiration: "2027-01-15" })).toBeNull();
    expect(contractQuery({ ...base, strike: 20, expiration: null })).toBeNull();
  });
});

describe("buzón de salida hacia el agente", () => {
  const LATER = new Date("2026-07-25T17:00:00Z");
  const RH = brokerById("robinhood")!;
  const SCHWAB = brokerById("schwab")!;

  function target(p: Partial<OutboxTarget> = {}): OutboxTarget {
    return {
      symbol: "WULF270115C00020000", ticker: "WULF", type: "call",
      strike: 20, expiration: "2027-01-15",
      ...p,
    };
  }

  const C25 = target({ symbol: "WULF270115C00025000", strike: 25 });
  const ZETA = target({ symbol: "ZETA260918C00020000", ticker: "ZETA", expiration: "2026-09-18" });

  it("con granularidad de contratos encola el contrato entero", () => {
    const [only] = addToOutbox([], target(), RH, NOW);
    expect(only).toMatchObject({
      ticker: "WULF", symbol: "WULF270115C00020000", type: "call",
      strike: 20, expiration: "2027-01-15", broker: "robinhood", syncedAt: null,
    });
  });

  it("un broker de solo subyacente NO recibe strike ni vencimiento", () => {
    const [only] = addToOutbox([], target(), SCHWAB, NOW);
    expect(only.ticker).toBe("WULF");
    expect(only.symbol).toBeUndefined();
    expect(only.strike).toBeUndefined();
    expect(only.expiration).toBeUndefined();
  });

  it("dos strikes del mismo ticker son dos trabajos con contratos", () => {
    const box = addToOutbox(addToOutbox([], target(), RH, NOW), C25, RH, LATER);
    expect(box).toHaveLength(2);
  });

  it("…pero uno solo cuando el broker únicamente entiende el subyacente", () => {
    const box = addToOutbox(addToOutbox([], target(), SCHWAB, NOW), C25, SCHWAB, LATER);
    expect(box).toHaveLength(1);
  });

  it("marcar dos veces el mismo contrato no genera trabajo doble", () => {
    const box = addToOutbox(addToOutbox([], target(), RH, NOW), target(), RH, LATER);
    expect(box).toHaveLength(1);
  });

  it("no reencola algo que ya se sincronizó", () => {
    const synced = markOutboxSynced(
      addToOutbox([], target(), RH, NOW), ["WULF270115C00020000"], "robinhood", NOW,
    );
    const again = addToOutbox(synced, target(), RH, LATER);
    expect(again).toHaveLength(1);
    expect(pendingOutbox(again, "robinhood")).toEqual([]);
  });

  it("cada broker tiene su propia cola", () => {
    let box: OutboxItem[] = [];
    box = addToOutbox(box, target(), RH, NOW);
    box = addToOutbox(box, target(), SCHWAB, NOW);
    expect(pendingOutbox(box, "robinhood").map((i) => i.symbol)).toEqual([
      "WULF270115C00020000",
    ]);
    box = markOutboxSynced(box, ["WULF270115C00020000"], "robinhood", NOW);
    expect(pendingOutbox(box, "robinhood")).toEqual([]);
    expect(pendingOutbox(box, "schwab").map((i) => i.ticker)).toEqual(["WULF"]);
  });

  it("lo pendiente sale deduplicado y ordenado", () => {
    let box: OutboxItem[] = [];
    for (const t of [ZETA, C25, target()]) box = addToOutbox(box, t, RH, NOW);
    expect(pendingOutbox(box, "robinhood").map((i) => i.symbol)).toEqual([
      "WULF270115C00020000", "WULF270115C00025000", "ZETA260918C00020000",
    ]);
  });

  it("lo pendiente trae strike y vencimiento: sin ellos el agente no resuelve el id", () => {
    const [item] = pendingOutbox(addToOutbox([], target(), RH, NOW), "robinhood");
    expect(contractQuery({
      ticker: item.ticker, type: item.type!, strike: item.strike!, expiration: item.expiration!,
    })).not.toBeNull();
  });

  it("confirmar un contrato no toca la fecha de los ya confirmados", () => {
    let box = addToOutbox(addToOutbox([], target(), RH, NOW), ZETA, RH, NOW);
    box = markOutboxSynced(box, ["WULF270115C00020000"], "robinhood", NOW);
    box = markOutboxSynced(box, ["ZETA260918C00020000"], "robinhood", LATER);
    expect(box.find((i) => i.ticker === "WULF")?.syncedAt).toBe(NOW.toISOString());
    expect(box.find((i) => i.ticker === "ZETA")?.syncedAt).toBe(LATER.toISOString());
  });

  it("la cola vieja de solo-tickers sigue leyéndose y etiquetándose", () => {
    const legacy: OutboxItem[] = [
      { ticker: "WULF", broker: "robinhood", addedAt: NOW.toISOString(), syncedAt: null },
    ];
    expect(pendingOutbox(legacy, "robinhood")).toHaveLength(1);
    expect(outboxLabel(legacy[0])).toBe("WULF");
  });

  it("etiqueta el contrato entero cuando lo hay", () => {
    const [item] = addToOutbox([], target(), RH, NOW);
    expect(outboxLabel(item)).toBe("WULF $20 CALL 2027-01-15");
  });

  it("un broker que no sincroniza nada encola solo el ticker", () => {
    const none = brokerById("none") as BrokerAdapter;
    const [only] = addToOutbox([], target(), none, NOW);
    expect(only.symbol).toBeUndefined();
  });
});

describe("outboxKey — la clave que decide qué es el mismo trabajo", () => {
  it("con contrato manda el símbolo OCC", () => {
    expect(
      outboxKey({
        ticker: "WULF", broker: "robinhood", addedAt: NOW.toISOString(), syncedAt: null,
        symbol: "WULF270115C00020000", type: "call", strike: 20, expiration: "2027-01-15",
      }),
    ).toBe("WULF270115C00020000");
  });

  it("sin contrato cae al ticker — es como sobrevive la cola vieja", () => {
    expect(
      outboxKey({
        ticker: "WULF", broker: "robinhood", addedAt: NOW.toISOString(), syncedAt: null,
      }),
    ).toBe("WULF");
  });
});

describe("contractRefLabel", () => {
  it("nombra el contrato entero", () => {
    expect(
      contractRefLabel({ ticker: "WULF", type: "call", strike: 20, expiration: "2027-01-15" }),
    ).toBe("WULF $20 CALL 2027-01-15");
  });

  it("sin strike o sin vencimiento se queda en el ticker, no inventa", () => {
    expect(contractRefLabel({ ticker: "WULF", type: "call", strike: null, expiration: "2027-01-15" }))
      .toBe("WULF");
    expect(contractRefLabel({ ticker: "WULF", type: "put", strike: 20, expiration: null }))
      .toBe("WULF");
  });
});

/**
 * La cola de `data/outbox.json` es anterior a la granularidad por contrato, así que
 * conviven entradas de solo-ticker con entradas completas. Verificado en vivo: el panel
 * mostraba "SPX $8000 CALL 2028-12-15 · SPXW · SPY · WULF" sin romperse.
 */
describe("cola mixta: entradas viejas de solo-ticker junto a contratos", () => {
  const legacy: OutboxItem = {
    ticker: "WULF", broker: "robinhood", addedAt: "2026-07-24T17:55:45.721Z", syncedAt: null,
  };
  const RH = brokerById("robinhood")!;

  it("las viejas se siguen listando y se etiquetan con el ticker pelado", () => {
    const pending = pendingOutbox([legacy], "robinhood");
    expect(pending).toHaveLength(1);
    expect(outboxLabel(pending[0])).toBe("WULF");
  });

  it("una entrada vieja no bloquea encolar el contrato completo del mismo ticker", () => {
    const box = addToOutbox(
      [legacy],
      {
        symbol: "WULF270115C00020000", ticker: "WULF", type: "call",
        strike: 20, expiration: "2027-01-15",
      },
      RH,
      NOW,
    );
    // Claves distintas ("WULF" vs el OCC): son dos trabajos, no un duplicado.
    expect(box).toHaveLength(2);
  });

  it("confirmar la vieja por ticker no toca el contrato nuevo", () => {
    const box = markOutboxSynced(
      addToOutbox([legacy], {
        symbol: "WULF270115C00020000", ticker: "WULF", type: "call",
        strike: 20, expiration: "2027-01-15",
      }, RH, NOW),
      ["WULF"],
      "robinhood",
      NOW,
    );
    expect(box.find((i) => !i.symbol)?.syncedAt).toBe(NOW.toISOString());
    expect(box.find((i) => i.symbol)?.syncedAt).toBeNull();
  });
});

describe("removeFromOutbox — desencolar al desmarcar ⭐", () => {
  const legacy: OutboxItem = {
    ticker: "WULF", broker: "robinhood", addedAt: "2026-07-24T17:55:45.721Z", syncedAt: null,
  };
  const contract: OutboxItem = {
    ticker: "WULF", broker: "robinhood", addedAt: "2026-07-24T18:00:00.000Z", syncedAt: null,
    symbol: "WULF270115C00020000", type: "call", strike: 20, expiration: "2027-01-15",
  };
  const sibling: OutboxItem = {
    ticker: "WULF", broker: "robinhood", addedAt: "2026-07-24T18:01:00.000Z", syncedAt: null,
    symbol: "WULF270115C00025000", type: "call", strike: 25, expiration: "2027-01-15",
  };

  it("quita el contrato por su símbolo", () => {
    const box = removeFromOutbox([contract, sibling], {
      symbol: "WULF270115C00020000", ticker: "WULF",
    }, "robinhood");
    expect(box.map((i) => i.symbol)).toEqual(["WULF270115C00025000"]);
  });

  it("también barre la fila vieja de solo-ticker, que con el símbolo a secas era imborrable", () => {
    // La regresión real: `outboxKey(legacy)` vale "WULF", no el OCC, así que el filtro
    // por símbolo nunca casaba y SPXW/SPY se quedaban encoladas para siempre.
    const box = removeFromOutbox([legacy, sibling], {
      symbol: "WULF270115C00020000", ticker: "WULF",
    }, "robinhood");
    expect(box.map((i) => i.symbol)).toEqual(["WULF270115C00025000"]);
  });

  it("no se arrastra los strikes hermanos del mismo ticker", () => {
    const box = removeFromOutbox([contract, sibling], {
      symbol: "WULF270115C00020000", ticker: "WULF",
    }, "robinhood");
    expect(box).toHaveLength(1);
  });

  it("sin símbolo (broker underlying_only) quita todo lo de la empresa", () => {
    const box = removeFromOutbox([contract, sibling], { ticker: "WULF" }, "robinhood");
    expect(box).toHaveLength(0);
  });

  it("no toca la cola de otro broker", () => {
    const otro: OutboxItem = { ...contract, broker: "schwab" };
    const box = removeFromOutbox([contract, otro], {
      symbol: "WULF270115C00020000", ticker: "WULF",
    }, "robinhood");
    expect(box).toEqual([otro]);
  });
});

describe("markOutboxFailed — aparcar lo irresoluble", () => {
  const legacy: OutboxItem = {
    ticker: "SPXW", broker: "robinhood", addedAt: "2026-07-24T17:56:59.727Z", syncedAt: null,
  };

  it("lo saca de pendientes para que el drenador no lo reintente cada 15 min", () => {
    const box = markOutboxFailed([legacy], ["SPXW"], "robinhood", "Sin strike.", NOW);
    expect(pendingOutbox(box, "robinhood")).toHaveLength(0);
    expect(failedOutbox(box, "robinhood")[0].failReason).toBe("Sin strike.");
  });

  it("no pisa lo ya sincronizado — si entró, entró", () => {
    const done: OutboxItem = { ...legacy, syncedAt: NOW.toISOString() };
    const box = markOutboxFailed([done], ["SPXW"], "robinhood", "Sin strike.", NOW);
    expect(box[0].failedAt).toBeUndefined();
    expect(box[0].syncedAt).toBe(NOW.toISOString());
  });

  it("el motivo del primer fallo no se sobrescribe", () => {
    const once = markOutboxFailed([legacy], ["SPXW"], "robinhood", "Sin strike.", NOW);
    const twice = markOutboxFailed(once, ["SPXW"], "robinhood", "Otro motivo.", NOW);
    expect(twice[0].failReason).toBe("Sin strike.");
  });
});
