// Alertas de Financial Juice que sí mencionan el ticker activo. En memoria — son
// avisos del momento, no un archivo histórico. El monitor (proceso aparte) las
// manda por POST; la app las lee por GET para pintar el banner en pantalla.

export interface NewsAlert {
  id: string;
  ticker: string;
  headline: string;
  headlineOriginal: string;
  source: "financialjuice";
  matchedBy: string;
  receivedAt: string;
}

const MAX_ALERTS = 200;
const alerts: NewsAlert[] = [];

export function addAlert(input: Omit<NewsAlert, "id" | "receivedAt">): NewsAlert {
  const alert: NewsAlert = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
  };
  alerts.unshift(alert);
  alerts.length = Math.min(alerts.length, MAX_ALERTS);
  return alert;
}

/** Alertas de un ticker, opcionalmente solo las posteriores a `sinceIso`. */
export function getAlerts(ticker: string, sinceIso?: string | null): NewsAlert[] {
  const t = ticker.trim().toUpperCase();
  const since = sinceIso ? Date.parse(sinceIso) : null;
  return alerts.filter(
    (a) => a.ticker === t && (since == null || Date.parse(a.receivedAt) > since),
  );
}
