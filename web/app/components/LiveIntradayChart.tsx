"use client";

import { useEffect, useRef, useState } from "react";
import type { TfBar } from "@/lib/types";
import type { LevelsReport } from "@/lib/levels";
import type { GexAnalysis } from "@/lib/gex";
import type { GexBotMajors } from "@/lib/gexbot";
import { resampleBars } from "@/lib/resampleBars";
import { px } from "../format";

const MIN_STRENGTH = 35; // mismo umbral que las líneas punteadas de ProWallsCard

// 1/2/5/15 min corren con streaming real: el único push nativo de Schwab
// (CHART_EQUITY) es de 1 min, así que las demás se arman agrupando esos ticks
// en buckets de bucketSec — mismo mecanismo, solo cambia el tamaño del bucket.
// 1h/4h se quedan por sondeo REST: a esa escala mantener el WebSocket abierto
// no aporta nada que el sondeo cada 30-60s no dé igual de bien.
const TIMEFRAMES: { key: string; label: string; bucketSec?: number; pollMs?: number }[] = [
  { key: "1m2d", label: "1 min", bucketSec: 60 },
  { key: "2m2d", label: "2 min", bucketSec: 120 },
  { key: "5m5d", label: "5 min", bucketSec: 300 },
  { key: "15m10d", label: "15 min", bucketSec: 900 },
  { key: "60m20d", label: "1 hora", pollMs: 30_000 },
  { key: "240m60d", label: "4 horas", pollMs: 60_000 },
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
 * Velas intradía con los soportes/resistencias y muros de gamma automáticos
 * pintados encima — para ver el precio acercarse a un nivel sin dibujar nada a
 * mano. 1/2/5/15 min corren con streaming real de Schwab (CHART_EQUITY, push
 * por WebSocket vía /api/chart-stream, agrupado en el cliente al tamaño de
 * bucket elegido); 1h/4h por sondeo REST.
 */
export default function LiveIntradayChart({
  ticker,
  levels,
  gex,
  gexbot,
}: {
  ticker: string;
  levels: LevelsReport | null;
  gex: GexAnalysis | null;
  /** Call Wall/Put Wall/Zero Gamma REALES de GexBot — mandan sobre la estimación propia cuando existen. */
  gexbot?: GexBotMajors | null;
}) {
  const chartElRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<CandleSeries | null>(null);
  const priceLinesRef = useRef<PriceLine[]>([]);
  const bucketRef = useRef<Bar | null>(null); // vela en formación (streaming)

  const [tf, setTf] = useState("5m5d");
  const [bars, setBars] = useState<TfBar[] | null>(null);
  const [ready, setReady] = useState(false); // el chart ya existe y setData corrió
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [liveOk, setLiveOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cfg = TIMEFRAMES.find((t) => t.key === tf) ?? TIMEFRAMES[2];
  const live = cfg.bucketSec != null;

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
        height: 460,
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

  // ── Soportes/resistencias + muros de gamma como líneas horizontales ──
  useEffect(() => {
    if (!ready || !seriesRef.current) return;
    // `levels`/`gex` se recalculan cada 20s con el auto-refresco (sin recrear
    // el chart), así que hay que quitar las líneas viejas o se acumulan.
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

    // Call wall / put wall / zero gamma — GexBot manda cuando está disponible (es
    // el dato REAL, no una estimación); si no, se cae a lib/gex.ts (misma fuente
    // que el heatmap y Strike Walls). Ambos se mueven solos con cada refresco.
    const estCallWall = (gex?.nodes ?? [])
      .filter((n) => n.side === "call")
      .sort((a, b) => b.netGex - a.netGex)[0] ?? null;
    const estPutWall = (gex?.nodes ?? [])
      .filter((n) => n.side === "put")
      .sort((a, b) => a.netGex - b.netGex)[0] ?? null;

    const callWallPrice = gexbot?.callWall ?? estCallWall?.strike ?? null;
    const putWallPrice = gexbot?.putWall ?? estPutWall?.strike ?? null;
    const zeroGammaPrice = gexbot?.zeroGamma ?? gex?.flipStrike ?? null;
    const suffix = gexbot ? "(GexBot)" : "(estimado)";

    if (callWallPrice != null) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: callWallPrice, color: "#b8880f", lineWidth: 2, lineStyle: 3, axisLabelVisible: true,
          title: `Call Wall $${px.format(callWallPrice)} ${suffix}`,
        }),
      );
    }
    if (putWallPrice != null) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: putWallPrice, color: "#6b5cd6", lineWidth: 2, lineStyle: 3, axisLabelVisible: true,
          title: `Put Wall $${px.format(putWallPrice)} ${suffix}`,
        }),
      );
    }
    if (zeroGammaPrice != null) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: zeroGammaPrice, color: "#36bffa", lineWidth: 2, lineStyle: 3, axisLabelVisible: true,
          title: `Zero Gamma $${px.format(zeroGammaPrice)} ${suffix}`,
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, levels, gex, gexbot]);

  // ── Histórico inicial + datos en vivo (streaming agrupado o sondeo REST) ──
  useEffect(() => {
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;
    bucketRef.current = null;
    setError(null);
    setLiveOk(false);
    setBars(null);
    setLastUpdate(null);

    if (live) {
      const bucketSec = cfg.bucketSec!;
      // Histórico: siempre 1-min nativo (los streams de Schwab no dan backfill),
      // agrupado al mismo tamaño de bucket que se va a mostrar en vivo.
      fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=1m2d`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const raw: TfBar[] = Array.isArray(d.bars) ? d.bars : [];
          setBars(resampleBars(raw, Math.max(1, Math.round(bucketSec / 60))));
          setLastUpdate(Date.now());
        })
        .catch(() => { if (!cancelled) setBars([]); });

      es = new EventSource(`/api/chart-stream?ticker=${encodeURIComponent(ticker)}`);
      es.addEventListener("bar", (ev) => {
        if (cancelled) return;
        const b = JSON.parse((ev as MessageEvent).data) as Bar;
        setLiveOk(true);
        setLastUpdate(Date.now());

        const bucketTime = Math.floor(b.time / bucketSec) * bucketSec;
        const cur = bucketRef.current;
        const next: Bar =
          cur && cur.time === bucketTime
            ? { time: cur.time, open: cur.open, high: Math.max(cur.high, b.high), low: Math.min(cur.low, b.low), close: b.close }
            : { time: bucketTime, open: b.open, high: b.high, low: b.low, close: b.close };
        bucketRef.current = next;
        seriesRef.current?.update(next);
        setBars((prev) => appendOrReplace(prev, next));
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
      fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=${tf}`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) { setBars(Array.isArray(d.bars) ? d.bars : []); setLastUpdate(Date.now()); } })
        .catch(() => { if (!cancelled) setBars([]); });

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
  }, [ticker, tf, live, cfg.bucketSec, cfg.pollMs]);

  return (
    <section className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="card-title">
          Intradía en vivo · {ticker}
          {live && <span className={`pill ${liveOk ? "call" : "put"}`} style={{ marginLeft: 8, fontSize: 10 }}>{liveOk ? "● EN VIVO" : "conectando…"}</span>}
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
        {live
          ? "Streaming real (Schwab CHART_EQUITY, push por WebSocket) — sin sondeo."
          : `Se actualiza sola cada ${Math.round((cfg.pollMs ?? 20_000) / 1000)}s.`}
        {" "}Todas las líneas son automáticas y se mueven solas según cambia la cadena de opciones.
        {" "}Call Wall/Put Wall/Zero Gamma: {gexbot ? "dato real de GexBot." : "estimados por el agente (conecta GexBot para el dato real)."}
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
      <div ref={chartElRef} style={{ height: "clamp(380px, 48vh, 560px)", display: bars && bars.length > 0 ? "block" : "none" }} />
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
