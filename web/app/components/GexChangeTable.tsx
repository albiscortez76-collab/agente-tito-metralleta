"use client";

import { useEffect, useRef, useState } from "react";
import type { GexAnalysis } from "@/lib/gex";
import { px } from "../format";

interface Snapshot {
  time: number;
  byStrike: Map<number, number>; // netGex por strike en ese momento
}

const WINDOWS = [
  { label: "1 min", ms: 60_000 },
  { label: "5 min", ms: 5 * 60_000 },
  { label: "10 min", ms: 10 * 60_000 },
  { label: "30 min", ms: 30 * 60_000 },
];
const MAX_HISTORY_MS = 31 * 60_000;
const TOP_N = 8;

function fmtGex(v: number): string {
  const abs = Math.abs(v);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Snapshot con `time` más cercano al objetivo (now - windowMs), sin pasarse de hace más tiempo del que hay historial. */
function closestSnapshot(history: Snapshot[], targetTime: number): Snapshot | null {
  if (history.length === 0) return null;
  let best = history[0];
  for (const s of history) {
    if (Math.abs(s.time - targetTime) < Math.abs(best.time - targetTime)) best = s;
  }
  return best;
}

/**
 * Cuánto cambió el GEX neto de cada strike clave en las últimas 1/5/10/30 min —
 * igual a la tabla "max change gex" de GexBot. Necesita ir acumulando fotos de
 * `gex` (cada vez que llega uno nuevo, por eso depende de que "Auto (20s)" esté
 * prendido arriba) — sin historial no hay "cambio" que mostrar, es matemática
 * básica, no un dato que un proveedor entregue ya calculado.
 */
export default function GexChangeTable({ ticker, gex }: { ticker: string; gex: GexAnalysis | null }) {
  const historyRef = useRef<Snapshot[]>([]);
  const prevTickerRef = useRef(ticker);
  const [, bump] = useState(0);

  useEffect(() => {
    if (prevTickerRef.current !== ticker) {
      historyRef.current = [];
      prevTickerRef.current = ticker;
    }
    if (!gex || gex.nodes.length === 0) return;
    const now = Date.now();
    const byStrike = new Map(gex.nodes.map((n) => [n.strike, n.netGex] as const));
    historyRef.current = [...historyRef.current, { time: now, byStrike }].filter(
      (s) => now - s.time <= MAX_HISTORY_MS,
    );
    bump((x) => x + 1);
  }, [ticker, gex]);

  if (!gex || gex.nodes.length === 0) return null;

  const topStrikes = [...gex.nodes].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, TOP_N);
  const now = Date.now();
  // Con solo 1-2 fotos casi simultáneas, "1 min" compararía el ahora contra sí
  // mismo (todo $0) — hay que esperar a tener de verdad al menos ~45s de
  // historial real antes de mostrar la tabla, o parece que el cálculo no sirve.
  const oldest = historyRef.current[0]?.time;
  const enoughHistory = oldest != null && now - oldest >= 45_000;

  return (
    <section className="pro-card">
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="pro-title">Cambio de GEX por ventana de tiempo</div>
          <span className="pro-badge">PRO</span>
        </div>
        <div className="pro-sub">
          Cuánto se movió el gamma neto de cada strike en los últimos minutos — <b>verde</b> = ganó
          peso de calls, <b>rojo</b> = ganó peso de puts. Necesita <b>&quot;🔄 Auto (20s)&quot;</b> prendido
          arriba para ir acumulando historial; recién buscado el ticker no hay nada que comparar todavía.
        </div>
      </div>

      {!enoughHistory && (
        <div className="feed-empty">Acumulando historial… (necesita al menos 2 refrescos con Auto prendido)</div>
      )}

      {enoughHistory && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="left">Strike</th>
                {WINDOWS.map((w) => <th key={w.label}>{w.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {topStrikes.map((n) => (
                <tr key={n.strike}>
                  <td className="left">${px.format(n.strike)}</td>
                  {WINDOWS.map((w) => {
                    const past = closestSnapshot(historyRef.current, now - w.ms);
                    const pastVal = past?.byStrike.get(n.strike);
                    const chg = pastVal != null ? n.netGex - pastVal : null;
                    return (
                      <td key={w.label} style={{ color: chg == null ? undefined : chg >= 0 ? "#12b76a" : "#f04438", fontWeight: 600 }}>
                        {chg == null ? "—" : fmtGex(chg)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
