// POST /api/financial-juice { title, url? } — el monitor (proceso aparte) guarda
// aquí CADA titular que recibe, mencione o no el ticker activo. `buildNewsReport`
// (lib/news.ts) lo lee directo en memoria y lo mezcla con los feeds RSS macro.

import { addFjHeadline } from "@/lib/financialJuiceFeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { title?: string; url?: string } | null;
  if (!body?.title) return Response.json({ error: "Falta el titular." }, { status: 400 });
  const item = addFjHeadline({ title: body.title, url: body.url });
  return Response.json(item);
}
