// GET /api/logo?ticker=XXX — sirve el logo de la empresa por proxy (la API key queda en el servidor).

import { fetchLogoImage } from "@/lib/massive";
import { normalizeTicker } from "@/lib/tickers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");
  if (!ticker) return new Response("ticker requerido", { status: 400 });

  try {
    const logo = await fetchLogoImage(ticker);
    if (!logo) return new Response("sin logo", { status: 404 });
    return new Response(logo.data, {
      headers: {
        "Content-Type": logo.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("error", { status: 502 });
  }
}
