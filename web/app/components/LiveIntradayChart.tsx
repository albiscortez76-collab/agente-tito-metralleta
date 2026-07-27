"use client";

import { useEffect, useRef, useState } from "react";
import type { TfBar } from "@/lib/types";
import type { LevelsReport } from "@/lib/levels";
import type { GexAnalysis } from "@/lib/gex";
import { px } from "../format";

const MIN_STRENGTH = 35; // mismo umbral que las líneas punteadas de ProWallsCard

// 1 y 2 min usan streaming real (CHART_EQUITY de Schwab, push por WebSocket — sin
// sondeo). El resto sigue por REST con sondeo: a esa escala el precio no cambia
// lo bastante rápido como para que valga la pena mantener una conexión en vivo.
const TIMEFRAMES: { key: string; label: string; live: boolean; pollMs?: number }[] = [
  { key: "1m2d", label: "1 min", live: true },
  { key: "2m2d", label: "2 min", live: true },
  { key: "5m5d", label: "5 min", live: false, pollMs: 15_000 },
  { key: "15m10d", label: "15 min", live: false, pollMs: 20_000 },
  { key: "60m20d", label: "1 hora", live: false, pollMs: 30_000 },
  { key: "240m60d", label: "4 horas", live: false, pollMs: 60_000 },
];

type Bar = { time: number; open: number; high: number; low: number; close: number };
type PriceLine = { applyOptions: (o: Record<string, unknown>) => void };
type CandleSeries = {
  setData: (d: Bar[]) => void;
  update: (d: Bar) => void;
  createPriceLine: (opts: Record<string, unknown>) => PriceLine;
  removePriceLine: (line: PriceLine) => void;
};

/**
 * Velas intradía con los soportes/resistencias automáticos (lib/levels.ts)
 * pintados encima — para ver el precio acercarse a un nivel sin dibujar nada a
 * mano. 1 y 2 min corren con streaming real de Schwab (CHART_EQUITY, push por
 * WebSocket vía /api/chart-stream); el resto por sondeo REST a intervalos
 * cortos (el dato en sí es tan fresco como lo entregue Massive/Schwab — el
 * intervalo aquí es solo cada cuánto se vuelve a preguntar).
 */
export default function LiveIntradayChart({
  ticker,
  levels,
  gex,
}: {
  ticker: string;
  levels: LevelsReport | null;
  gex: GexAnalysis | null;
}) {
  const chartElRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<CandleSeries | null>(null);
  const priceLinesRef = useRef<PriceLine[]>([]);
  const bucketRef = useRef<Bar | null>(null); // vela en formación (para el modo 2min)

  const [tf, setTf] = useState("5m5d");
  const [bars, setBars] = useState<TfBar[] | null>(null);
  const [ready, setReady] = useState(false); // el chart ya existe y setData corrió
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [liveOk, setLiveOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cfg = TIMEFRAMES.find((t) => t.key === tf) ?? TIMEFRAMES[2];

  // ── Crea el chart UNA vez por ticker+tf (no en cada tick, para no parpadear) ──
  useEffect(() => {
    const el = chartElRef.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    setReady(false);
    seriesRef.current = null;
    priceLinesRef.current = [];

    (async () => {
      const { createChart, ColorType } = await import("lightweight-charts");
      if (disposed || !chartElRef.current) return;

      const chart = createChart(chartElRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#8a93a6",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        },
        grid: { vertLines: { visible: false }, horzLines: { color: "#26304228" } },
        rightPriceScale: { borderColor: "#26304260" },
        timeScale: { borderColor: "#26304260", timeVisible: true, secondsVisible: false },
        height: 320,
        autoSize: true,
      });
      const candles = chart.addCandlestickSeries({
        upColor: "#1f9d68", downColor: "#d9524f",
        wickUpColor: "#1f9d6899", wickDownColor: "#d9524f99",
        borderVisible: false,
      }) as unknown as CandleSeries;
      seriesRef.current = candles;
      setReady(true);

      cleanup = () => { seriesRef.current = null; chart.remove(); };
    })();

    return () => { disposed = true; cleanup(); };
  }, [ticker, tf]);

  // ── Vuelca el histórico al chart cuando cambian las barras ──
  useEffect(() => {
    if (!ready || !seriesRef.current || !bars || bars.length === 0) return;
    seriesRef.current.setData(bars);
  }, [ready, bars]);

  // ── Soportes/resistencias como líneas horizontales (se redibujan si cambian) ──
  useEffect(() => {
    if (!ready || !seriesRef.current) return;
    // `levels` se recalcula cada 20s con el auto-refresco (sin recrear el chart),
    // así que hay que quitar las líneas viejas o se van acumulando encimadas.
    for (const line of priceLinesRef.current) seriesRef.current.removePriceLine(line);
    priceLinesRef.current = [];
    for (const l of levels?.resistances ?? []) {
      if (l.strength < MIN_STRENGTH) continue;
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: l.price, color: "#f04438", lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
          title: `R $${px.format(l.price)}`,
        }),
      );
    }
    for (const l of levels?.supports ?? []) {
      if (l.strength < MIN_STRENGTH) continue;
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: l.price, color: "#12b76a", lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
          title: `S $${px.format(l.price)}`,
        }),
      );
    }

    // Call wall / put wall / zero gamma — dinámicos: se mueven solos cada 20s
    // según entra open interest y flujo nuevo (misma lógica de lib/gex.ts que
    // ya usa el heatmap y Strike Walls, no es un cálculo aparte).
    const callWall = (gex?.nodes ?? [])
      .filter((n) => n.side === "call")
      .sort((a, b) => b.netGex - a.netGex)[0] ?? null;
    const putWall = (gex?.nodes ?? [])
      .filter((n) => n.side === "put")
      .sort((a, b) => a.netGex - b.netGex)[0] ?? null;

    if (callWall) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: callWall.strike, color: "#b8880f", lineWidth: 2, lineStyle: 3, axisLabelVisible: true,
          title: `Call Wall $${px.format(callWall.strike)}`,
        }),
      );
    }
    if (putWall) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: putWall.strike, color: "#6b5cd6", lineWidth: 2, lineStyle: 3, axisLabelVisible: true,
          title: `Put Wall $${px.format(putWall.strike)}`,
        }),
      );
    }
    if (gex?.flipStrike != null) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: gex.flipStrike, color: "#36bffa", lineWidth: 2, lineStyle: 3, axisLabelVisible: true,
          title: `Zero Gamma $${px.format(gex.flipStrike)}`,
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, levels, gex]);

  // ── Histórico inicial + datos en vivo (streaming o sondeo, según la temporalidad) ──
  useEffect(() => {
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;
    bucketRef.current = null;
    setError(null);
    setLiveOk(false);
    setBars(null);
    setLastUpdate(null);

    // Histórico: siempre por REST (los streams de Schwab no dan backfill).
    const backfillTf = cfg.live ? "1m2d" : tf;
    fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=${backfillTf}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setBars(Array.isArray(d.bars) ? d.bars : []);
        setLastUpdate(Date.now());
      })
      .catch(() => { if (!cancelled) setBars([]); });

    if (cfg.live) {
      es = new EventSource(`/api/chart-stream?ticker=${encodeURIComponent(ticker)}`);
      es.addEventListener("bar", (ev) => {
        if (cancelled) return;
        const b = JSON.parse((ev as MessageEvent).data) as Bar;
        setLiveOk(true);
        setLastUpdate(Date.now());
        if (tf === "1m2d") {
          seriesRef.current?.update(b);
          setBars((prev) => appendOrReplace(prev, b));
        } else {
          // 2 min: agrupa dos velas de 1 min consecutivas en un solo bucket.
          const bucketTime = Math.floor(b.time / 120) * 120;
          const cur = bucketRef.current;
          const next: Bar =
            cur && cur.time === bucketTime
              ? { time: cur.time, open: cur.open, high: Math.max(cur.high, b.high), low: Math.min(cur.low, b.low), close: b.close }
              : { time: bucketTime, open: b.open, high: b.high, low: b.low, close: b.close };
          bucketRef.current = next;
          seriesRef.current?.update(next);
          setBars((prev) => appendOrReplace(prev, next));
        }
      });
      es.addEventListener("error", () => { if (!cancelled) setLiveOk(false); });
      es.addEventListener("message", (ev) => {
        // eventos "error" mandados por nuestro propio route (event: error)
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { message?: string };
          if (d?.message) setError(d.message);
        } catch { /* frames sin JSON, ignorar */ }
      });
    } else {
      const load = () => {
        fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=${tf}`)
          .then((r) => r.json())
          .then((d) => {
            if (cancelled) return;
            setBars(Array.isArray(d.bars) ? d.bars : []);
            setLastUpdate(Date.now());
          })
          .catch(() => {});
      };
      pollId = setInterval(load, cfg.pollMs ?? 20_000);
    }

    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
      es?.close();
    };
  }, [ticker, tf, cfg.live, cfg.pollMs]);

  return (
    <section className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="card-title">
          Intradía en vivo · {ticker}
          {cfg.live && <span className={`pill ${liveOk ? "call" : "put"}`} style={{ marginLeft: 8, fontSize: 10 }}>{liveOk ? "● EN VIVO" : "conectando…"}</span>}
        </div>
        <div className="view-toggle">
          {TIMEFRAMES.map((t) => (
            <button key={t.key} className={tf === t.key ? "active" : ""} onClick={() => setTf(t.key)} type="button">
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="card-sub">
        {cfg.live
          ? "Streaming real (Schwab CHART_EQUITY, push por WebSocket) — sin sondeo."
          : `Se actualiza sola cada ${Math.round((cfg.pollMs ?? 20_000) / 1000)}s.`}
        {" "}Todas las líneas son automáticas y se mueven solas según cambia la cadena de opciones.
        {lastUpdate && (
          <span className="muted"> — actualizado {new Date(lastUpdate).toLocaleTimeString("es-ES", { hour12: false })}</span>
        )}
      </div>
      <div className="pro-legend" style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 0, borderTop: "2px dotted #f04438" }} />Resistencia
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 0, borderTop: "2px dotted #12b76a" }} />Soporte
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 0, borderTop: "2px dashed #b8880f" }} />Call Wall
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 0, borderTop: "2px dashed #6b5cd6" }} />Put Wall
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 0, borderTop: "2px dashed #36bffa" }} />Zero Gamma
        </div>
      </div>
      {error && <div className="feed-empty">⚠ {error}</div>}
      {!bars && <div className="feed-empty">Cargando velas…</div>}
      {bars && bars.length === 0 && <div className="feed-empty">Sin datos intradía para {ticker}.</div>}
      <div ref={chartElRef} style={{ height: 320, display: bars && bars.length > 0 ? "block" : "none" }} />
    </section>
  );
}

function appendOrReplace(prev: TfBar[] | null, b: Bar): TfBar[] {
  const list = prev ?? [];
  if (list.length > 0 && list[list.length - 1].time === b.time) {
    return [...list.slice(0, -1), b];
  }
  return [...list, b];
}
