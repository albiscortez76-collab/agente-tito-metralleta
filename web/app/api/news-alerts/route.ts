// GET  /api/news-alerts?ticker=XXX&since=ISO  → alertas nuevas de Financial Juice para ese ticker
// POST /api/news-alerts  { ticker, headline, headlineOriginal, matchedBy }  → la agrega
//
// El monitor (proceso aparte) hace POST cuando un titular de Financial Juice
// menciona al ticker activo; la app hace GET cada pocos segundos para el banner.

import { addAlert, getAlerts } from "@/lib/newsAlerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker") ?? "";
  const since = searchParams.get("since");
  if (!ticker) return Response.json({ error: "Falta el ticker." }, { status: 400 });
  return Response.json({ alerts: getAlerts(ticker, since) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { ticker?: string; headline?: string; headlineOriginal?: string; matchedBy?: string }
    | null;
  if (!body?.ticker || !body.headline) {
    return Response.json({ error: "Faltan datos de la alerta." }, { status: 400 });
  }
  const alert = addAlert({
    ticker: body.ticker,
    headline: body.headline,
    headlineOriginal: body.headlineOriginal ?? body.headline,
    source: "financialjuice",
    matchedBy: body.matchedBy ?? body.ticker,
  });
  return Response.json(alert);
}
