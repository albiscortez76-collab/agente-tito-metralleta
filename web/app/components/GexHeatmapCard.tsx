"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GexHeatmap, HeatCell } from "@/lib/gexHeatmap";
import { money, px } from "../format";

/** Verde = gamma positiva (dealer estabiliza) · morado = negativa (amplifica). */
function cellColor(netGex: number, intensity: number): string {
  const a = 0.06 + Math.pow(intensity, 0.55) * 0.94;
  return netGex >= 0 ? `rgba(16,185,129,${a})` : `rgba(139,92,246,${a})`;
}

function fmtGex(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Heatmap de GEX por strike (filas) × vencimiento (columnas).
 * Cada celda dice cuánto dinero de gamma hay en ese strike para esa expiración —
 * es donde se ve qué vencimiento sostiene cada muro.
 */
export default function GexHeatmapCard({ h }: { h: GexHeatmap }) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);

  // Centrar la malla en el precio actual: aterrizar en strikes lejanos no dice nada.
  useEffect(() => {
    const box = scrollRef.current, row = spotRef.current;
    if (!box || !row) return;
    box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2);
  }, [h]);

  const byKey = useMemo(() => {
    const m = new Map<string, HeatCell>();
    for (const c of h.cells) m.set(`${c.strike}|${c.expiration}`, c);
    return m;
  }, [h.cells]);

  if (h.strikes.length === 0) return null;

  // El strike más cercano al spot marca la fila del precio actual.
  const spotStrike = h.strikes.reduce((best, s) =>
    Math.abs(s.strike - h.spot) < Math.abs(best.strike - h.spot) ? s : best, h.strikes[0]);

  const cols = `92px repeat(${h.expirations.length}, minmax(78px, 1fr)) 96px`;

  return (
    <section className="pro-card">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="pro-title">GEX Heatmap — por strike y vencimiento</div>
            <span className="pro-badge">PRO</span>
          </div>
          <div className="pro-sub">
            Cada celda es el dinero de gamma en ese precio para esa fecha. <b>Verde</b> = el
            dealer estabiliza (el precio tiende a revertir); <b>morado</b> = amplifica (el
            movimiento acelera). Cuanto más intenso, más dinero hay ahí.
          </div>
        </div>
        <div className="pro-legend" style={{ paddingTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: "rgba(16,185,129,0.9)" }} />γ+ estabiliza
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: "rgba(139,92,246,0.9)" }} />γ− amplifica
          </div>
        </div>
      </div>

      <div className="heat-scroll" ref={scrollRef}>
        <div className="heat-grid" style={{ gridTemplateColumns: cols }}>
          <div className="heat-corner">Strike</div>
          {h.expirations.map((e) => (
            <div key={e.expiration} className="heat-colhead">
              <div>{e.expiration}</div>
              <div className="heat-dte">{e.dte}d</div>
            </div>
          ))}
          <div className="heat-colhead"><div>Total</div><div className="heat-dte">strike</div></div>

          {h.strikes.map((s) => {
            const isSpot = s.strike === spotStrike.strike;
            return (
              <div key={s.strike} style={{ display: "contents" }}>
                <div className={`heat-rowhead ${isSpot ? "spot" : ""}`} ref={isSpot ? spotRef : undefined}>
                  {px.format(s.strike)}
                  <span className="heat-dist">
                    {s.distancePct >= 0 ? "+" : ""}{s.distancePct.toFixed(1)}%
                  </span>
                </div>
                {h.expirations.map((e) => {
                  const c = byKey.get(`${s.strike}|${e.expiration}`);
                  if (!c) return <div key={e.expiration} className="heat-cell empty" />;
                  return (
                    <div
                      key={e.expiration}
                      className="heat-cell"
                      style={{ background: cellColor(c.netGex, c.intensity) }}
                      onMouseEnter={() => setHover(c)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <span>{fmtGex(c.netGex)}</span>
                    </div>
                  );
                })}
                <div className="heat-cell total" style={{ color: s.netGex >= 0 ? "#34d399" : "#a78bfa" }}>
                  {fmtGex(s.netGex)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="heat-foot">
        <div>
          <span className="muted">GEX neto total: </span>
          <b style={{ color: h.totalNetGex >= 0 ? "#34d399" : "#a78bfa" }}>{fmtGex(h.totalNetGex)}</b>
          <span className="muted">
            {" "}— régimen {h.totalNetGex >= 0 ? "γ+ (rango: conviene desvanecer extremos)" : "γ− (tendencia: conviene seguir el movimiento)"}
          </span>
        </div>
        {hover ? (
          <div className="heat-hover">
            <b>${px.format(hover.strike)}</b> · vence {hover.expiration} · GEX{" "}
            <b>{fmtGex(hover.netGex)}</b> · calls {fmtGex(hover.callGex)} · puts {fmtGex(-hover.putGex)}
            {" "}· OI {money.format(hover.openInterest).replace("$", "")}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 11 }}>Pasa el cursor por una celda para ver el detalle.</div>
        )}
      </div>
    </section>
  );
}
