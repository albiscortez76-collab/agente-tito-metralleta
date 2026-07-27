// GET /api/bars?ticker=XXX&tf=1y|15m10d|5m5d|1m2d|2m2d|60m20d|240m60d — barras del subyacente.

import { MassiveError } from "@/lib/massive";
import { SchwabError } from "@/lib/schwab";
import { fetchBarsAny } from "@/lib/underlyingBars";
import { resampleBars } from "@/lib/resampleBars";
import { normalizeTicker } from "@/lib/tickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `m` es SIEMPRE una temporalidad nativa que Schwab acepta (frequencyType=minute
// solo permite frequency 1/5/10/15/30) — 2min/1h/4h se arman agrupando velas
// nativas con resampleBars, para no depender de un multiplier que Schwab rechace.
const TF: Record<string, { m: number; span: "day" | "minute"; days: number; resampleTo?: number }> = {
  "1y": { m: 1, span: "day", days: 365 },
  "1m2d": { m: 1, span: "minute", days: 2 },
  "2m2d": { m: 1, span: "minute", days: 2, resampleTo: 2 },
  "5m5d": { m: 5, span: "minute", days: 5 },
  "15m10d": { m: 15, span: "minute", days: 10 },
  "60m20d": { m: 30, span: "minute", days: 20, resampleTo: 60 },
  "240m60d": { m: 30, span: "minute", days: 60, resampleTo: 240 },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");
  const tf = searchParams.get("tf") ?? "5m5d";
  const cfg = TF[tf] ?? TF["5m5d"];
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
  try {
    const raw = await fetchBarsAny(ticker, cfg.m, cfg.span, cfg.days);
    const bars = cfg.resampleTo ? resampleBars(raw, cfg.resampleTo / cfg.m) : raw;
    return Response.json({ ticker, tf, bars });
  } catch (err) {
    const message =
      err instanceof MassiveError || err instanceof SchwabError
        ? err.message
        : "Error al cargar barras.";
    return Response.json({ error: message }, { status: 502 });
  }
}
