// GET  /api/active-ticker  → { ticker, companyName, setAt } | { ticker: null }
// POST /api/active-ticker  { ticker, companyName }  → lo guarda
//
// El monitor de Financial Juice (proceso aparte) hace GET periódicamente para
// saber a qué ticker avisar. El navegador hace POST cada vez que cambias de ticker.

import { getActiveTicker, setActiveTicker } from "@/lib/activeTicker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const current = getActiveTicker();
  return Response.json(current ?? { ticker: null, companyName: null, setAt: null });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { ticker?: string; companyName?: string | null }
    | null;
  if (!body?.ticker) {
    return Response.json({ error: "Falta el ticker." }, { status: 400 });
  }
  const saved = setActiveTicker(body.ticker, body.companyName ?? null);
  return Response.json(saved);
}
