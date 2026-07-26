// POST /api/telegram — manda un mensaje de texto al bot de Telegram configurado.
// El token nunca sale del servidor; el cliente solo manda el texto ya armado.

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return Response.json(
      { error: "Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env.local." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) {
    return Response.json({ error: "Falta el texto del reporte." }, { status: 400 });
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `Telegram respondió ${res.status}. ${detail.slice(0, 200)}`.trim() },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
