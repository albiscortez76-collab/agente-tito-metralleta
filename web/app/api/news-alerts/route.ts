// GET  /api/news-alerts?ticker=XXX&since=ISO  → alertas nuevas para ese ticker
// POST /api/news-alerts  { ticker, headline, headlineOriginal, matchedBy, source?, url? }  → la agrega
//
// Dos monitores (procesos aparte) hacen POST aquí: financialjuice-monitor.mjs
// cuando un titular menciona al ticker activo, y truthsocial-monitor.mjs con
// cada publicación nueva de @realDonaldTrump (etiquetada al ticker activo del
// momento, sin filtrar por mención — es un catalizador de mercado en general).
// La app hace GET cada pocos segundos para el banner.

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
    | {
        ticker?: string;
        headline?: string;
        headlineOriginal?: string;
        matchedBy?: string;
        source?: "financialjuice" | "truthsocial";
        url?: string;
      }
    | null;
  if (!body?.ticker || !body.headline) {
    return Response.json({ error: "Faltan datos de la alerta." }, { status: 400 });
  }
  const alert = addAlert({
    ticker: body.ticker,
    headline: body.headline,
    headlineOriginal: body.headlineOriginal ?? body.headline,
    source: body.source ?? "financialjuice",
    matchedBy: body.matchedBy ?? body.ticker,
    url: body.url,
  });
  return Response.json(alert);
}
