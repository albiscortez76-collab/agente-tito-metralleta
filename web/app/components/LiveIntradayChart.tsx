"use client";

import { useEffect, useRef, useState } from "react";
import type { TfBar } from "@/lib/types";
import type { LevelsReport } from "@/lib/levels";
import { px } from "../format";

const REFRESH_MS = 20_000;
const MIN_STRENGTH = 35; // mismo umbral que las líneas punteadas de ProWallsCard

/**
 * Velas de 5 min que se refrescan solas, con los soportes/resistencias automáticos
 * (lib/levels.ts) pintados como líneas horizontales — para ver el precio acercarse
 * a un nivel en vivo y precisar la salida, sin tener que dibujar nada a mano
 * (a diferencia de TradingView) ni cambiar de pantalla.
 */
export default function LiveIntradayChart({
  ticker,
  levels,
}: {
  ticker: string;
  levels: LevelsReport | null;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState<TfBar[] | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    function load() {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=5m5d`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          setBars(Array.isArray(d.bars) ? d.bars : []);
          setLastUpdate(Date.now());
        })
        .catch(() => { if (!cancelled) setBars((b) => b ?? []); })
        .finally(() => { refreshingRef.current = false; });
    }
    setBars(null);
    setLastUpdate(null);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [ticker]);

  useEffect(() => {
    const el = chartRef.current;
    if (!el || !bars || bars.length === 0) return;

    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const { createChart, ColorType, LineStyle } = await import("lightweight-charts");
      if (disposed || !chartRef.current) return;

      const chart = createChart(el, {
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
        upColor: "#1f9d68",
        downColor: "#d9524f",
        wickUpColor: "#1f9d6899",
        wickDownColor: "#d9524f99",
        borderVisible: false,
      });
      candles.setData(bars.map((b) => ({ time: b.time as never, open: b.open, high: b.high, low: b.low, close: b.close })));

      for (const l of levels?.resistances ?? []) {
        if (l.strength < MIN_STRENGTH) continue;
        candles.createPriceLine({
          price: l.price,
          color: "#f04438",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `R $${px.format(l.price)}`,
        });
      }
      for (const l of levels?.supports ?? []) {
        if (l.strength < MIN_STRENGTH) continue;
        candles.createPriceLine({
          price: l.price,
          color: "#12b76a",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `S $${px.format(l.price)}`,
        });
      }

      chart.timeScale().scrollToRealTime();
      cleanup = () => chart.remove();
    })();

    return () => { disposed = true; cleanup(); };
  }, [bars, levels]);

  return (
    <section className="card">
      <div className="card-title">Intradía en vivo · {ticker}</div>
      <div className="card-sub">
        Velas de 5 min, se actualizan solas cada 20s. Las líneas punteadas son tus soportes
        y resistencias automáticos — para ver el precio acercarse sin tener que dibujarlos tú.
        {lastUpdate && (
          <span className="muted"> — actualizado {new Date(lastUpdate).toLocaleTimeString("es-ES", { hour12: false })}</span>
        )}
      </div>
      {!bars && <div className="feed-empty">Cargando velas…</div>}
      {bars && bars.length === 0 && <div className="feed-empty">Sin datos intradía para {ticker}.</div>}
      <div ref={chartRef} style={{ height: 320, display: bars && bars.length > 0 ? "block" : "none" }} />
    </section>
  );
}
