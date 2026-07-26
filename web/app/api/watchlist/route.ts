// /api/watchlist — el puente entre el navegador del estudiante y el agente.
//
//   GET                           → { broker, granularity, pending, legacy }
//   POST { contract, broker }     → encola un contrato para empujarlo al broker
//   POST { synced: [...], broker } → el agente confirma lo que entró
//   DELETE ?symbol= | ?ticker=    → lo saca de la cola
//
// El watchlist en sí NO pasa por aquí: vive en localStorage (ver `watchlistLocal.ts`).
// Por este puente viaja lo mínimo para identificar el contrato en el broker —ticker y,
// si el broker acepta contratos, tipo/strike/vencimiento—. Los griegos, tu sizing y tu
// saldo se quedan en el navegador. `addToOutbox` recorta según la granularidad, así que
// un broker que solo entiende subyacentes recibe solo el ticker.
//
// La sincronización tampoco ocurre aquí: el MCP del broker lo conduce el agente, no el
// servidor web. Esta ruta expone `pending` para que el agente sepa qué falta.

import { loadOutbox, saveOutbox } from "@/lib/outboxStore";
import { loadWatchlist } from "@/lib/watchlistStore";
import {
  addToOutbox,
  brokerById,
  failedOutbox,
  markOutboxFailed,
  markOutboxSynced,
  pendingOutbox,
  removeFromOutbox,
  type OutboxItem,
  type OutboxTarget,
} from "@/lib/watchlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(items: OutboxItem[], broker: string) {
  return {
    broker,
    granularity: brokerById(broker)?.granularity ?? "none",
    pending: pendingOutbox(items, broker),
    failed: failedOutbox(items, broker),
    // Para que la UI diga cuándo pasó el drenador por última vez.
    lastSyncedAt:
      items
        .filter((i) => i.broker === broker && i.syncedAt)
        .map((i) => i.syncedAt!)
        .sort()
        .at(-1) ?? null,
  };
}

/**
 * `legacy` sirve a la migración única desde el viejo data/watchlist.json. En cuanto el
 * navegador lo importa y marca la bandera, deja de mirarlo.
 */
export async function GET(request: Request) {
  const broker = new URL(request.url).searchParams.get("broker") ?? "robinhood";
  const [outbox, legacy] = await Promise.all([loadOutbox(), loadWatchlist()]);
  return Response.json({
    ...payload(outbox.items, broker),
    legacy: { entries: legacy.entries, broker: legacy.broker },
  });
}

/** Un contrato válido trae al menos símbolo y ticker; el resto puede faltar. */
function readContract(raw: unknown): OutboxTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.symbol !== "string" || typeof c.ticker !== "string") return null;
  if (c.type !== "call" && c.type !== "put") return null;
  return {
    symbol: c.symbol,
    ticker: c.ticker.toUpperCase(),
    type: c.type,
    strike: typeof c.strike === "number" ? c.strike : null,
    expiration: typeof c.expiration === "string" ? c.expiration : null,
  };
}

export async function POST(request: Request) {
  let body: {
    contract?: unknown;
    broker?: string;
    synced?: string[];
    failed?: string[];
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Cuerpo inválido." }, { status: 400 });
  }

  const brokerId = body.broker ?? "robinhood";
  const broker = brokerById(brokerId);
  if (!broker) {
    return Response.json({ error: "Broker desconocido." }, { status: 400 });
  }

  const stored = await loadOutbox();
  let items = stored.items;

  if (Array.isArray(body.synced) && body.synced.length > 0) {
    items = markOutboxSynced(items, body.synced, brokerId, new Date());
  }

  // El drenador aparca lo irresoluble para no reintentarlo cada 15 minutos para siempre.
  if (Array.isArray(body.failed) && body.failed.length > 0) {
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "No se pudo resolver el contrato en el broker.";
    items = markOutboxFailed(items, body.failed, brokerId, reason, new Date());
  }

  if (body.contract !== undefined) {
    const contract = readContract(body.contract);
    if (!contract) {
      return Response.json({ error: "Contrato inválido." }, { status: 400 });
    }
    // Con granularidad `contracts` el broker resuelve por subyacente+tipo+strike+
    // vencimiento (ver `contractQuery`). Sin strike o sin vencimiento el contrato es
    // insincronizable, y aceptarlo solo aplaza el fallo hasta el drenador, donde ya no
    // hay a quién avisar. Se rechaza en la puerta.
    if (
      broker.granularity === "contracts" &&
      (contract.strike == null || !contract.expiration)
    ) {
      return Response.json(
        { error: "Faltan strike o vencimiento: sin ellos no se puede resolver en el broker." },
        { status: 400 },
      );
    }
    items = addToOutbox(items, contract, broker, new Date());
  }

  const saved = await saveOutbox(items);
  return Response.json(payload(saved.items, brokerId));
}

/**
 * Desencola. Con `symbol` quita ese contrato; con `ticker` quita todo lo de esa empresa
 * —que es lo que corresponde cuando el broker solo guarda subyacentes—.
 *
 * Conviene mandar **ambos** con granularidad `contracts`: el `ticker` es lo único que
 * alcanza a las filas viejas de solo-tickers, que con `symbol` a secas eran imborrables.
 * El filtrado vive en `removeFromOutbox`, que es puro y está cubierto por tests.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  const ticker = url.searchParams.get("ticker");
  const broker = url.searchParams.get("broker") ?? "robinhood";
  if (!symbol && !ticker) {
    return Response.json({ error: "Falta el símbolo o el ticker." }, { status: 400 });
  }

  const stored = await loadOutbox();
  const items = removeFromOutbox(stored.items, { symbol, ticker }, broker);
  const saved = await saveOutbox(items);
  return Response.json(payload(saved.items, broker));
}
