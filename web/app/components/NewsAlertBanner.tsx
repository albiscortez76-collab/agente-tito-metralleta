"use client";

import { useEffect, useRef, useState } from "react";

interface NewsAlert {
  id: string;
  ticker: string;
  headline: string;
  headlineOriginal: string;
  matchedBy: string;
  source?: "financialjuice" | "truthsocial";
  url?: string;
  receivedAt: string;
}

function alertTitle(alert: NewsAlert): string {
  if (alert.source === "truthsocial") return "Truth Social — @realDonaldTrump";
  return `Financial Juice — mención de ${alert.ticker}`;
}

const POLL_MS = 10_000;

/**
 * Banner de alertas (Financial Juice y Truth Social) para el ticker activo.
 * Poll simple (no SSE): un titular de mercado no necesita latencia de
 * milisegundos, y así el monitor (proceso aparte) no tiene que mantener
 * conexiones abiertas por cliente.
 */
export default function NewsAlertBanner({ ticker }: { ticker: string | null }) {
  const [alert, setAlert] = useState<NewsAlert | null>(null);
  const sinceRef = useRef<string>(new Date().toISOString());

  useEffect(() => {
    if (!ticker) return;
    // Nuevo ticker: no arrastrar alertas de otro activo, y no mostrar historial viejo.
    setAlert(null);
    sinceRef.current = new Date().toISOString();

    let cancelled = false;
    const poll = () => {
      const q = new URLSearchParams({ ticker, since: sinceRef.current });
      fetch(`/api/news-alerts?${q}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { alerts?: NewsAlert[] } | null) => {
          if (cancelled || !d?.alerts?.length) return;
          sinceRef.current = d.alerts[0].receivedAt;
          setAlert(d.alerts[0]);
        })
        .catch(() => {});
    };
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [ticker]);

  if (!alert) return null;

  return (
    <div className="card news-alert-banner" role="alert">
      <span className="news-alert-icon">🚨</span>
      <div className="news-alert-body">
        <div className="news-alert-title">{alertTitle(alert)}</div>
        <div className="news-alert-text">{alert.headline}</div>
        {alert.url && (
          <a className="news-alert-link" href={alert.url} target="_blank" rel="noreferrer">
            Ver publicación original ↗
          </a>
        )}
      </div>
      <button className="news-alert-close" onClick={() => setAlert(null)} aria-label="Cerrar alerta">✕</button>
    </div>
  );
}
