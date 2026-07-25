// GET /api/news?ticker=XXX&name=... — Tarea 7: noticias en dos capas (macro RSS + empresa).

import { buildNewsReport } from "@/lib/news";
import { normalizeTicker } from "@/lib/tickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");
  const name = searchParams.get("name");

  if (!ticker) {
    return Response.json({ error: "Falta el ticker." }, { status: 400 });
  }

  try {
    const report = await buildNewsReport(ticker, name, new Date());
    return Response.json(report);
  } catch {
    return Response.json({ error: "No se pudieron leer las noticias." }, { status: 502 });
  }
}
