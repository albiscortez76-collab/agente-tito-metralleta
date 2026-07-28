// GET /api/gexbot?ticker=XXX — Call Wall/Put Wall/Zero Gamma reales de GexBot + el
// cambio de GEX por ventana de tiempo. Es un plus: si GexBot falla, no está
// configurado, o el ticker no está en su cobertura, se devuelve todo en null y el
// front cae a su propia estimación (lib/gex.ts) sin romper nada.

import { fetchGexMajors, fetchGexMaxChange, GexBotError } from "@/lib/gexbot";
import { normalizeTicker } from "@/lib/tickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  const [majorsRes, maxChangeRes] = await Promise.allSettled([
    fetchGexMajors(ticker),
    fetchGexMaxChange(ticker),
  ]);

  const errorMessage =
    majorsRes.status === "rejected"
      ? (majorsRes.reason instanceof GexBotError ? majorsRes.reason.message : "Error consultando GexBot.")
      : undefined;

  return Response.json({
    majors: majorsRes.status === "fulfilled" ? majorsRes.value : null,
    maxChange: maxChangeRes.status === "fulfilled" ? maxChangeRes.value : null,
    error: errorMessage,
  });
}
