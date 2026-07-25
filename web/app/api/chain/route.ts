// GET /api/chain?ticker=XXX — transmite los pasos del proceso por SSE y al final los datos.

import { applySchwabBid, countExpirations, sortByOpenInterestDesc, toRow } from "@/lib/compute";
import type { BidQuote } from "@/lib/compute";
import { structureScore } from "@/lib/structure";
import { saveChainSnapshot, type ChainSnapshot } from "@/lib/chainStore";
import { fetchCompany, fetchOptionChain, MassiveError } from "@/lib/massive";
import {
  fetchIndexCompany,
  fetchOptionChain as fetchSchwabChain,
  SchwabError,
} from "@/lib/schwab";
import { isIndexTicker, normalizeTicker } from "@/lib/tickers";
import type { ChainEvent, ChainMeta, Row } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: ChainEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChainEvent) =>
        controller.enqueue(encoder.encode(sse(event)));

      try {
        if (!ticker) {
          send({ type: "error", message: "Escribe un ticker (p. ej. AAPL)." });
          controller.close();
          return;
        }

        const isIndex = isIndexTicker(ticker);

        send({ type: "step", label: `Buscando información de ${ticker}…` });
        const company = isIndex ? await fetchIndexCompany(ticker) : await fetchCompany(ticker);
        send({ type: "company", company });

        send({ type: "step", label: "Conectando con Massive…" });

        const { contracts, underlyingPrice: massiveUnderlyingPrice, pages, truncated } =
          await fetchOptionChain(ticker, {
            onPage: (page, accumulated) => {
              send({
                type: "step",
                label: `Descargando option chain de ${ticker} — página ${page}`,
                detail: `${accumulated} contratos`,
              });
            },
          });

        if (contracts.length === 0) {
          send({ type: "error", message: `Sin contratos para "${ticker}".` });
          controller.close();
          return;
        }

        let rows: Row[] = contracts.map(toRow);
        const expirations = countExpirations(rows);
        send({
          type: "step",
          label: `Consolidando ${rows.length} contratos en ${expirations} vencimientos…`,
        });

        send({ type: "step", label: "Buscando BID real en Schwab…" });
        try {
          const schwabContracts = await fetchSchwabChain(ticker);
          const quotes: BidQuote[] = schwabContracts.map((c) => ({
            contractType: c.contractType === "PUT" ? "put" : "call",
            expiration: c.expiration,
            strike: c.strike,
            bid: c.bidPrice,
          }));
          rows = applySchwabBid(rows, quotes);
        } catch {
          // Schwab es un plus, no un requisito — si falla, se queda con el proxy de Massive.
        }

        send({ type: "step", label: "Calculando Open Premium por strike…" });
        send({ type: "step", label: "Calculando Valor Nocional…" });

        send({ type: "step", label: "Ordenando por Open Interest (mayor → menor)…" });
        rows = sortByOpenInterestDesc(rows);

        send({ type: "step", label: "Analizando acumulación por strike y vencimiento…" });
        const structure = structureScore(rows);

        // Foto diaria de la cadena: el historial de 45 días se acumula hacia adelante.
        send({ type: "step", label: "Guardando foto diaria de la cadena…" });
        let history: ChainSnapshot[] = [];
        try {
          history = (await saveChainSnapshot(ticker, structure)).snapshots;
        } catch {
          // el guardado no debe romper el reporte
        }

        // Massive no da underlying_asset.price para índices (producto "Indices" aparte,
        // no incluido en el plan actual) — el precio de la empresa/índice (ya resuelto
        // arriba, vía Schwab para índices) sirve de respaldo.
        const meta: ChainMeta = {
          ticker,
          underlyingPrice: massiveUnderlyingPrice ?? company.price,
          contractCount: rows.length,
          expirationCount: expirations,
          pages,
          truncated,
        };
        send({ type: "done", rows, meta, structure, history });
      } catch (err) {
        const message =
          err instanceof MassiveError || err instanceof SchwabError
            ? err.message
            : "Error inesperado al consultar Massive.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
