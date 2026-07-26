// Watchlist propio — las ideas que marcas, con la foto del momento en que las marcaste.
//
// Es el sustrato del que cualquier broker sincroniza: guarda el CONTRATO completo
// (strike, vencimiento, griegos, tu sizing), que es más de lo que hoy acepta ningún
// broker por API. Los adaptadores de broker leen de aquí, nunca al revés.
//
// Funciones puras. La persistencia vive en `watchlistStore.ts`.

import type { Sizing } from "./risk";

/** Qué granularidad acepta un broker en su watchlist. */
export type BrokerGranularity = "contracts" | "underlying_only" | "none";

/**
 * Cómo llega la idea al broker.
 *
 * - `mcp`  — escritura real en su watchlist, la conduce el agente por MCP.
 * - `link` — abrimos la página del ticker en el broker; el estudiante lo añade de un toque.
 * - `copy` — el broker no enruta por símbolo desde una URL: copiamos la lista al portapapeles.
 * - `none` — el watchlist se queda solo en Tito.
 */
export type SyncKind = "mcp" | "link" | "copy" | "none";

export interface BrokerAdapter {
  id: string;
  name: string;
  kind: SyncKind;
  /** `contracts` = guarda el contrato exacto; `underlying_only` = solo el ticker. */
  granularity: BrokerGranularity;
  /** Página de cotización del broker. Solo la tienen los `link`. */
  quoteUrl?: (ticker: string) => string;
  /** Nota para la UI cuando no puede guardar el contrato completo. */
  caveat?: string;
}

/**
 * Brokers conocidos. El usuario elige el suyo; añadir uno es añadir una entrada aquí.
 *
 * Robinhood es el único `mcp`: tiene MCP oficial (`agent.robinhood.com/mcp/trading`,
 * OAuth). Su granularidad es `contracts`, verificado contra la API real: el servidor
 * expone `get_option_watchlist` / `add_option_to_watchlist` sobre una lista propia de
 * opciones (`allowed_object_types: ["option_strategy"]`), distinta de la de acciones.
 * Lo que sigue en beta solo-acciones es la **ejecución de órdenes**, no el watchlist —
 * y Tito nunca coloca una orden, así que no nos limita.
 *
 * Las URLs de los `link` se verificaron una a una con peticiones reales. Webull e IBKR
 * son `copy` a propósito y no por pereza: Webull exige el prefijo de bolsa en la ruta
 * (`nasdaq-wulf` responde, `nyse-wulf` da 404) y el feed no nos dice en qué bolsa cotiza
 * cada ticker; la página de IBKR responde 200 pero es genérica, no enruta por símbolo.
 * Mandar a un estudiante a un 404 es peor que darle el ticker para pegar.
 */
export const BROKERS: BrokerAdapter[] = [
  {
    id: "robinhood",
    name: "Robinhood",
    kind: "mcp",
    granularity: "contracts",
    quoteUrl: (t) => `https://robinhood.com/stocks/${encodeURIComponent(t)}`,
    caveat:
      "Se sincroniza el contrato completo a tu watchlist de opciones. Robinhood no acepta estrategias de varias patas por API: si tienes un spread, sigue viéndose solo en su app.",
  },
  {
    id: "schwab",
    name: "Schwab / thinkorswim",
    kind: "link",
    granularity: "underlying_only",
    quoteUrl: (t) =>
      `https://www.schwab.com/research/stocks/quotes/summary/${encodeURIComponent(t)}`,
  },
  {
    id: "fidelity",
    name: "Fidelity",
    kind: "link",
    granularity: "underlying_only",
    quoteUrl: (t) =>
      `https://digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol=${encodeURIComponent(t)}`,
  },
  {
    id: "tastytrade",
    name: "Tastytrade",
    kind: "link",
    granularity: "underlying_only",
    quoteUrl: (t) => `https://my.tastytrade.com/app.html#/trade/${encodeURIComponent(t)}`,
    caveat:
      "El enlace abre la app de Tastytrade en el ticker. Es una SPA, así que si la sesión está cerrada caerás en el login y tendrás que volver a pulsar.",
  },
  {
    id: "webull",
    name: "Webull",
    kind: "copy",
    granularity: "underlying_only",
    caveat:
      "Webull necesita la bolsa en la URL (nasdaq-WULF vs nyse-WULF) y el feed no la trae, así que en vez de mandarte a un 404 te copiamos los tickers para pegarlos en su buscador.",
  },
  {
    id: "ibkr",
    name: "Interactive Brokers",
    kind: "copy",
    granularity: "underlying_only",
    caveat:
      "La web de IBKR no abre una página por símbolo, así que te copiamos los tickers para pegarlos en el buscador de TWS o del portal.",
  },
  {
    id: "none",
    name: "Solo en Tito",
    kind: "none",
    granularity: "none",
  },
];

export function brokerById(id: string): BrokerAdapter | null {
  return BROKERS.find((b) => b.id === id) ?? null;
}

export type SyncStatus = "pendiente" | "sincronizado" | "no_soportado" | "error";

export interface BrokerSync {
  broker: string;
  status: SyncStatus;
  /** Qué se mandó realmente: el contrato o solo el subyacente. */
  sent: "contract" | "underlying" | null;
  at: string | null;
  detail?: string;
}

export interface WatchlistEntry {
  /** El símbolo OCC identifica el contrato: un contrato entra una sola vez. */
  symbol: string;
  ticker: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
  addedAt: string;

  /** Foto del momento de marcarla — es contra esto que se mide después. */
  entrySpot: number;
  entryPrice: number;
  entryDte: number | null;
  entryPremium: number;
  entryThetaPctDaily: number | null;

  /** Tu sizing en ese momento, para poder juzgar la decisión y no solo la idea. */
  maxContracts: number;
  binding: string | null;
  accountSizeAtEntry: number;
  tolerancePctAtEntry: number;

  brokerSync: BrokerSync | null;
}

/** Lo mínimo que necesita `buildEntry` — evita acoplar el watchlist al tipo Idea completo. */
export interface EntrySource {
  symbol: string;
  ticker: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  price: number;
  assetPrice: number;
  premium: number;
  thetaPctDaily: number | null;
}

export function buildEntry(
  source: EntrySource,
  sizing: Pick<Sizing, "maxContracts" | "binding">,
  profile: { accountSize: number; tolerancePct: number },
  now: Date,
): WatchlistEntry {
  return {
    symbol: source.symbol,
    ticker: source.ticker,
    type: source.type,
    strike: source.strike,
    expiration: source.expiration,
    addedAt: now.toISOString(),
    entrySpot: source.assetPrice,
    entryPrice: source.price,
    entryDte: source.dte,
    entryPremium: source.premium,
    entryThetaPctDaily: source.thetaPctDaily,
    maxContracts: sizing.maxContracts,
    binding: sizing.binding,
    accountSizeAtEntry: profile.accountSize,
    tolerancePctAtEntry: profile.tolerancePct,
    brokerSync: null,
  };
}

/**
 * Añade o reemplaza por símbolo. Volver a marcar un contrato NO pisa la foto original
 * —esa es la que da valor al histórico— pero conserva el estado de sincronización.
 */
export function upsert(entries: WatchlistEntry[], entry: WatchlistEntry): WatchlistEntry[] {
  const existing = entries.find((e) => e.symbol === entry.symbol);
  if (existing) {
    return entries.map((e) =>
      e.symbol === entry.symbol ? { ...existing, brokerSync: e.brokerSync } : e,
    );
  }
  return [entry, ...entries];
}

export function remove(entries: WatchlistEntry[], symbol: string): WatchlistEntry[] {
  return entries.filter((e) => e.symbol !== symbol);
}

export function markSynced(
  entries: WatchlistEntry[],
  symbol: string,
  sync: BrokerSync,
): WatchlistEntry[] {
  return entries.map((e) => (e.symbol === symbol ? { ...e, brokerSync: sync } : e));
}

/**
 * Qué mandar a un broker dado su granularidad. Devuelve `null` cuando el broker no
 * puede recibir nada — así la UI dice la verdad en vez de fingir que sincronizó.
 *
 * Ojo: `value` es el símbolo OCC, que es como identificamos el contrato aquí. Ningún
 * broker lo acepta tal cual; el agente lo traduce a su id interno con `contractQuery`.
 */
export function payloadFor(
  entry: WatchlistEntry,
  broker: BrokerAdapter,
): { sent: "contract" | "underlying"; value: string } | null {
  if (broker.granularity === "contracts") return { sent: "contract", value: entry.symbol };
  if (broker.granularity === "underlying_only") {
    return { sent: "underlying", value: entry.ticker };
  }
  return null;
}

/** Los cuatro campos que identifican un contrato, con o sin foto de entrada. */
export interface ContractRef {
  ticker: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
}

/**
 * Traduce un contrato nuestro a la consulta que resuelve su id en el broker.
 *
 * Los brokers no direccionan por símbolo OCC: Robinhood pide un UUID de instrumento,
 * que solo se obtiene buscando por subyacente + tipo + strike + vencimiento
 * (`get_option_instruments`). Esta función arma esa búsqueda; el agente la ejecuta.
 *
 * El strike va con **4 decimales** porque es un filtro exacto sobre cadena: `"20"` no
 * casa con `"20.0000"` y la búsqueda vuelve vacía sin decir por qué.
 *
 * Devuelve `null` si falta strike o vencimiento — sin ellos la búsqueda daría decenas
 * de contratos y elegir uno sería adivinar. Quien recibe `null` cae al subyacente.
 */
export function contractQuery(c: ContractRef): {
  chain_symbol: string;
  type: "call" | "put";
  strike_price: string;
  expiration_dates: string;
} | null {
  if (c.strike == null || !c.expiration) return null;
  return {
    chain_symbol: c.ticker.toUpperCase(),
    type: c.type,
    strike_price: c.strike.toFixed(4),
    expiration_dates: c.expiration,
  };
}

/** Etiqueta legible de un contrato: `WULF $20 CALL 2027-01-15`. */
export function contractRefLabel(c: ContractRef): string {
  if (c.strike == null || !c.expiration) return c.ticker;
  return `${c.ticker} $${c.strike} ${c.type.toUpperCase()} ${c.expiration}`;
}

/** Los tickers únicos a sincronizar cuando el broker solo acepta subyacentes. */
export function underlyings(entries: WatchlistEntry[]): string[] {
  return [...new Set(entries.map((e) => e.ticker))].sort();
}

/** Las más recientes primero. */
export function sortEntries(entries: WatchlistEntry[]): WatchlistEntry[] {
  return [...entries].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

// ── Enlaces al broker ────────────────────────────────────────────────────────

/**
 * La URL del ticker en el broker, o `null` si ese broker no enruta por símbolo.
 * Devolver `null` es parte del contrato: la UI enseña "copiar" en vez de un enlace roto.
 */
export function quoteLink(ticker: string, broker: BrokerAdapter): string | null {
  return broker.quoteUrl ? broker.quoteUrl(ticker) : null;
}

/** Los tickers listos para pegar en el buscador del broker. */
export function tickerList(entries: WatchlistEntry[]): string {
  return underlyings(entries).join(", ");
}

/** El comando que conecta el MCP de Robinhood. El OAuth ocurre en Claude, no en la web. */
export const ROBINHOOD_MCP_COMMAND =
  "claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading";

// ── Buzón de salida hacia el agente ──────────────────────────────────────────
//
// El watchlist completo vive en el navegador del estudiante. El buzón es el único
// puente hacia el agente, y viaja **lo mínimo que el broker necesita para identificar
// el contrato**: ticker, y con granularidad `contracts` también tipo, strike y
// vencimiento. Lo que nunca cruza es lo tuyo: ni griegos, ni sizing, ni saldo.
//
// Con un broker `underlying_only` la entrada sigue siendo solo el ticker, así que
// elegir un broker menos capaz también manda menos datos.

export interface OutboxItem {
  ticker: string;
  broker: string;
  addedAt: string;
  syncedAt: string | null;

  /** Solo con granularidad `contracts`. Ausentes en la cola vieja de solo-tickers. */
  symbol?: string;
  type?: "call" | "put";
  strike?: number | null;
  expiration?: string | null;

  /**
   * Estado terminal: el contrato no se puede resolver en el broker y no se reintenta.
   * Sin contador de intentos a propósito — cuando `contractQuery` devuelve `null` o el
   * broker no encuentra el instrumento, ya se sabe que no va a resolverse nunca. Los
   * fallos transitorios (red, servidor caído) no marcan nada y se reintentan solos.
   */
  failedAt?: string;
  failReason?: string;
}

/** Lo que se encola: un contrato del watchlist, recortado por la granularidad. */
export interface OutboxTarget {
  symbol: string;
  ticker: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
}

/**
 * La clave de deduplicación. Con `contracts` es el contrato (dos strikes del mismo
 * ticker son dos trabajos); con `underlying_only` es el ticker (son el mismo trabajo).
 */
export function outboxKey(item: OutboxItem): string {
  return item.symbol ?? item.ticker;
}

/** Cómo se anuncia una entrada de la cola en la UI. */
export function outboxLabel(item: OutboxItem): string {
  if (!item.symbol || item.type == null) return item.ticker;
  return contractRefLabel({
    ticker: item.ticker,
    type: item.type,
    strike: item.strike ?? null,
    expiration: item.expiration ?? null,
  });
}

/**
 * Encola un contrato con el detalle que ese broker sabe recibir. Si ya está pendiente
 * no lo duplica; si ya se sincronizó tampoco lo reencola — marcar dos veces lo mismo
 * no genera trabajo.
 */
export function addToOutbox(
  items: OutboxItem[],
  target: OutboxTarget,
  broker: BrokerAdapter,
  now: Date,
): OutboxItem[] {
  const ticker = target.ticker.toUpperCase();
  const full = broker.granularity === "contracts";
  const entry: OutboxItem = {
    ticker,
    broker: broker.id,
    addedAt: now.toISOString(),
    syncedAt: null,
    ...(full
      ? {
          symbol: target.symbol,
          type: target.type,
          strike: target.strike,
          expiration: target.expiration,
        }
      : {}),
  };
  const key = outboxKey(entry);
  if (items.some((i) => i.broker === broker.id && outboxKey(i) === key)) return items;
  return [...items, entry];
}

/**
 * Lo que el agente aún no ha empujado, deduplicado y ordenado. Devuelve los ítems
 * enteros —no solo el ticker— porque para resolver el contrato en el broker hacen
 * falta strike y vencimiento (ver `contractQuery`).
 */
export function pendingOutbox(items: OutboxItem[], broker: string): OutboxItem[] {
  const seen = new Set<string>();
  return items
    .filter((i) => {
      if (i.broker !== broker || i.syncedAt || i.failedAt) return false;
      const key = outboxKey(i);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => outboxKey(a).localeCompare(outboxKey(b)));
}

/**
 * El agente confirma lo que sí entró en el broker. Las claves son símbolos OCC con
 * granularidad `contracts` y tickers con `underlying_only` — lo mismo que devolvió
 * `pendingOutbox` vía `outboxKey`.
 */
export function markOutboxSynced(
  items: OutboxItem[],
  keys: string[],
  broker: string,
  now: Date,
): OutboxItem[] {
  const done = new Set(keys);
  return items.map((i) =>
    i.broker === broker && done.has(outboxKey(i)) && !i.syncedAt
      ? { ...i, syncedAt: now.toISOString() }
      : i,
  );
}

/**
 * El agente aparca lo que no se puede resolver en el broker: un contrato sin strike o
 * sin vencimiento (la cola vieja de solo-tickers), o uno que el broker no encuentra.
 *
 * Es terminal por diseño: sin esto el drenador reintentaría lo mismo cada 15 minutos
 * para siempre. No pisa lo ya sincronizado — si entró, entró.
 */
export function markOutboxFailed(
  items: OutboxItem[],
  keys: string[],
  broker: string,
  reason: string,
  now: Date,
): OutboxItem[] {
  const bad = new Set(keys);
  return items.map((i) =>
    i.broker === broker && bad.has(outboxKey(i)) && !i.syncedAt && !i.failedAt
      ? { ...i, failedAt: now.toISOString(), failReason: reason }
      : i,
  );
}

/** Los aparcados, para que la UI ofrezca volver a marcar ⭐ con el contrato completo. */
export function failedOutbox(items: OutboxItem[], broker: string): OutboxItem[] {
  return items
    .filter((i) => i.broker === broker && i.failedAt && !i.syncedAt)
    .sort((a, b) => outboxKey(a).localeCompare(outboxKey(b)));
}

/**
 * Desencola al desmarcar ⭐.
 *
 * Las dos condiciones no son redundancia: `outboxKey` vale el **símbolo OCC** en las
 * filas nuevas y el **ticker** en las viejas de solo-tickers, así que comparar solo
 * contra `symbol` dejaba las filas legado imborrables para siempre (`"WULF270115C00020000"
 * !== "WULF"`) — pasó de verdad con SPXW y SPY. La segunda condición exige `!i.symbol`
 * justamente para no arrastrarse los otros strikes del mismo subyacente: con granularidad
 * `contracts` dos strikes de WULF son dos trabajos distintos.
 *
 * Sin `symbol` (broker `underlying_only`) se quita todo lo de esa empresa, que ahí sí es
 * un solo trabajo.
 */
export function removeFromOutbox(
  items: OutboxItem[],
  target: { symbol?: string | null; ticker?: string | null },
  broker: string,
): OutboxItem[] {
  const symbol = target.symbol ?? null;
  const ticker = target.ticker?.toUpperCase() ?? null;
  return items.filter((i) => {
    if (i.broker !== broker) return true;
    if (symbol) {
      if (outboxKey(i) === symbol) return false;
      return !(!i.symbol && ticker != null && i.ticker === ticker);
    }
    return !(ticker != null && i.ticker === ticker);
  });
}
