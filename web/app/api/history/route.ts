// GET /api/history?ticker=XXX — barras diarias del subyacente para la gráfica.

import { MassiveError } from "@/lib/massive";
import { SchwabError } from "@/lib/schwab";
import { fetchDailyBarsAny } from "@/lib/underlyingBars";
import { normalizeTicker } from "@/lib/tickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");
  if (!ticker) {
    return Response.json({ error: "ticker requerido" }, { status: 400 });
  }
  try {
    const bars = await fetchDailyBarsAny(ticker);
    return Response.json({ ticker, bars });
  } catch (err) {
    const message =
      err instanceof MassiveError || err instanceof SchwabError
        ? err.message
        : "Error al cargar histórico.";
    return Response.json({ error: message }, { status: 502 });
  }
}
