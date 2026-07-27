// GET /api/chart-stream?ticker=XXX — SSE con velas de 1 minuto en vivo, empujadas
// por el streamer de Schwab (CHART_EQUITY) en cuanto llegan — no es sondeo, es
// push real. A diferencia de TIMESALE_OPTIONS (que no existe), CHART_EQUITY sí
// funciona, y funciona igual para acciones ("SPY") que para índices ("$SPX").
//
// Solo da velas de 1 min hacia ADELANTE desde que se conecta (como todo stream
// de Schwab, sin backfill) — el cliente ya trae el histórico por /api/bars y
// solo usa este canal para ir actualizando la vela más reciente en vivo.

import { getAccessToken, getStreamerInfo, SchwabError } from "@/lib/schwab";
import { isIndexTicker, normalizeTicker } from "@/lib/tickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChartEquityContent {
  key: string;
  "2": number; // open
  "3": number; // high
  "4": number; // low
  "5": number; // close
  "7": number; // chart time, epoch ms
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get("ticker") ?? "");
  if (!ticker) return new Response("ticker requerido", { status: 400 });
  const symbol = isIndexTicker(ticker) ? `$${ticker}` : ticker;

  const encoder = new TextEncoder();
  let ws: WebSocket | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // el controller ya se cerró (cliente se fue) — nada que hacer
        }
      };

      try {
        const token = await getAccessToken();
        const si = await getStreamerInfo();
        ws = new WebSocket(si.streamerSocketUrl);

        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout conectando al streamer")), 15_000);
          ws!.addEventListener("open", () => { clearTimeout(t); resolve(); });
          ws!.addEventListener("error", () => { clearTimeout(t); reject(new Error("error de conexión al streamer")); });
        });

        let requestId = 1;
        const sendReq = (obj: Record<string, unknown>) => ws!.send(JSON.stringify({ requests: [obj] }));

        ws.addEventListener("message", (ev) => {
          if (closed) return;
          let msg: {
            response?: { service: string; command: string; content?: { code: number; msg: string } }[];
            data?: { service: string; content?: ChartEquityContent[] }[];
          };
          try { msg = JSON.parse(ev.data.toString()); } catch { return; }

          if (msg.response) {
            for (const r of msg.response) {
              if (r.service === "ADMIN" && r.command === "LOGIN") {
                if (r.content?.code === 0) {
                  sendReq({
                    service: "CHART_EQUITY", requestid: String(requestId++), command: "SUBS",
                    SchwabClientCustomerId: si.schwabClientCustomerId, SchwabClientCorrelId: si.schwabClientCorrelId,
                    parameters: { keys: symbol, fields: "0,2,3,4,5,7" },
                  });
                } else {
                  send("error", { message: r.content?.msg ?? "Login rechazado por Schwab." });
                }
              } else if (r.service === "CHART_EQUITY" && r.content && r.content.code !== 0) {
                send("error", { message: r.content.msg ?? "No se pudo suscribir a CHART_EQUITY." });
              }
            }
          }

          if (msg.data) {
            for (const d of msg.data) {
              if (d.service !== "CHART_EQUITY") continue;
              for (const c of d.content ?? []) {
                if (c.key !== symbol) continue;
                send("bar", {
                  time: Math.floor(c["7"] / 1000),
                  open: c["2"], high: c["3"], low: c["4"], close: c["5"],
                });
              }
            }
          }
        });

        ws.addEventListener("close", () => { if (!closed) send("error", { message: "Conexión con Schwab cerrada." }); });
        ws.addEventListener("error", () => { if (!closed) send("error", { message: "Error de streaming con Schwab." }); });

        sendReq({
          service: "ADMIN", requestid: String(requestId++), command: "LOGIN",
          SchwabClientCustomerId: si.schwabClientCustomerId, SchwabClientCorrelId: si.schwabClientCorrelId,
          parameters: { Authorization: token, SchwabClientChannel: si.schwabClientChannel, SchwabClientFunctionId: si.schwabClientFunctionId },
        });
      } catch (err) {
        send("error", { message: err instanceof SchwabError ? err.message : "No se pudo conectar el streaming en vivo." });
      }

      request.signal.addEventListener("abort", () => {
        closed = true;
        ws?.close();
        try { controller.close(); } catch { /* ya cerrado */ }
      });
    },
    cancel() {
      closed = true;
      ws?.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
