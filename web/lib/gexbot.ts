// Cliente de GexBot (gex.bot) — Call Wall / Put Wall / Zero Gamma REALES, calculados
// por ellos (no estimados por el agente). Solo servidor. Requiere plan pago del
// usuario (Classic o superior) y GEXBOT_API_KEY en .env.local — si falla o no está
// configurado, es un plus, no un requisito: el agente sigue con su propia
// estimación (lib/gex.ts), igual que con el BID de Schwab.

const BASE_URL = "https://api.gex.bot";

export class GexBotError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GexBotError";
    this.status = status;
  }
}

function apiKey(): string {
  const k = process.env.GEXBOT_API_KEY;
  if (!k || !k.trim()) throw new GexBotError("Falta GEXBOT_API_KEY en el entorno (.env.local).");
  return k.trim();
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "User-Agent": "TitoMetralleta/1.0",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GexBotError(`GexBot respondió ${res.status}. ${body.slice(0, 200)}`.trim(), res.status);
  }
  return (await res.json()) as T;
}

export interface GexBotMajors {
  zeroGamma: number;
  callWall: number;
  putWall: number;
  netGex: number;
  spot: number;
  timestamp: number;
}

interface RawMajors {
  zero_gamma: number;
  mpos_vol: number;
  mpos_oi: number;
  mneg_vol: number;
  mneg_oi: number;
  net_gex_vol: number;
  net_gex_oi: number;
  timestamp: number;
  ticker: string;
  spot: number;
}

/** Call Wall / Put Wall / Zero Gamma reales para un ticker (índice, ETF o acción soportada). */
export async function fetchGexMajors(ticker: string): Promise<GexBotMajors> {
  const raw = await getJson<RawMajors>(`/${ticker.trim().toLowerCase()}/classic/gex_full/majors`);
  // mpos_vol/mneg_vol (por volumen) es lo mismo que pinta el dashboard de GexBot —
  // mpos_oi/mneg_oi (por open interest) puede diferir; se usa vol para calzar con
  // lo que el usuario ve en su pantalla.
  return {
    zeroGamma: raw.zero_gamma,
    callWall: raw.mpos_vol,
    putWall: raw.mneg_vol,
    netGex: raw.net_gex_vol,
    spot: raw.spot,
    timestamp: raw.timestamp,
  };
}

export interface GexBotChangePoint {
  strike: number;
  value: number;
}

export interface GexBotMaxChange {
  current: GexBotChangePoint;
  oneMin: GexBotChangePoint;
  fiveMin: GexBotChangePoint;
  tenMin: GexBotChangePoint;
  fifteenMin: GexBotChangePoint;
  thirtyMin: GexBotChangePoint;
}

interface RawMaxChange {
  timestamp: number;
  ticker: string;
  current: [number, number];
  one: [number, number];
  five: [number, number];
  ten: [number, number];
  fifteen: [number, number];
  thirty: [number, number];
}

const point = (p: [number, number]): GexBotChangePoint => ({ strike: p[0], value: p[1] });

/** El strike que más cambió su GEX en cada ventana (1/5/10/15/30 min) — igual a "max change gex". */
export async function fetchGexMaxChange(ticker: string): Promise<GexBotMaxChange> {
  const raw = await getJson<RawMaxChange>(`/${ticker.trim().toLowerCase()}/classic/gex_full/maxchange`);
  return {
    current: point(raw.current),
    oneMin: point(raw.one),
    fiveMin: point(raw.five),
    tenMin: point(raw.ten),
    fifteenMin: point(raw.fifteen),
    thirtyMin: point(raw.thirty),
  };
}
