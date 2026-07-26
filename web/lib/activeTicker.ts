// Qué ticker está viendo el estudiante ahora mismo — el puente entre el navegador
// y el monitor de Financial Juice (proceso aparte, ver scripts/financialjuice-monitor.mjs).
//
// En memoria a propósito: es información de "ahora mismo", no un historial que
// tenga que sobrevivir un reinicio del server. El monitor la lee por HTTP
// (GET /api/active-ticker) igual que cualquier otro cliente — no toca disco.

export interface ActiveTicker {
  ticker: string;
  companyName: string | null;
  setAt: string;
}

let current: ActiveTicker | null = null;

export function setActiveTicker(ticker: string, companyName: string | null): ActiveTicker {
  current = { ticker: ticker.trim().toUpperCase(), companyName, setAt: new Date().toISOString() };
  return current;
}

export function getActiveTicker(): ActiveTicker | null {
  return current;
}
