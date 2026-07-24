// Cliente de Charles Schwab (Trader API) — solo servidor. Fuente de bid/ask real.
// Solo lectura de market data (quotes/chains). Nunca se usan endpoints de trading aquí.

const BASE_URL = "https://api.schwabapi.com";
const TOKEN_URL = `${BASE_URL}/v1/oauth/token`;
const AUTHORIZE_URL = `${BASE_URL}/v1/oauth/authorize`;

export class SchwabError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SchwabError";
    this.status = status;
  }
}

function clientId(): string {
  const v = process.env.SCHWAB_CLIENT_ID;
  if (!v) throw new SchwabError("Falta SCHWAB_CLIENT_ID en el entorno (.env.local).");
  return v;
}

function clientSecret(): string {
  const v = process.env.SCHWAB_CLIENT_SECRET;
  if (!v) throw new SchwabError("Falta SCHWAB_CLIENT_SECRET en el entorno (.env.local).");
  return v;
}

function redirectUri(): string {
  return process.env.SCHWAB_REDIRECT_URI ?? "https://127.0.0.1";
}

function basicAuthHeader(): string {
  const raw = `${clientId()}:${clientSecret()}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** URL que el usuario debe abrir en SU navegador (con su sesión real de Schwab) para autorizar la app. */
export function authorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // segundos
  token_type: string;
  scope?: string;
}

/** Intercambia el código de autorización (de la URL de callback) por tokens. Uso único por login. */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(
      `Schwab rechazó el intercambio de código (${res.status}). ${body.slice(0, 300)}`,
      res.status,
    );
  }
  return (await res.json()) as TokenResponse;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/** Devuelve un access token válido, refrescándolo con SCHWAB_REFRESH_TOKEN si hace falta. */
export async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 5_000) {
    return cachedAccessToken.token;
  }
  const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new SchwabError(
      "Falta SCHWAB_REFRESH_TOKEN en el entorno. Corre `node scripts/schwab-auth.mjs` para autorizar la app (el refresh token de Schwab caduca cada 7 días).",
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(
      `Schwab rechazó el refresh token (${res.status}). Puede haber caducado (dura 7 días) — vuelve a correr scripts/schwab-auth.mjs. ${body.slice(0, 300)}`,
      res.status,
    );
  }
  const json = (await res.json()) as TokenResponse;
  cachedAccessToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function getJson<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(describeStatus(res.status, body), res.status);
  }
  return (await res.json()) as T;
}

export interface SchwabQuote {
  symbol: string;
  bidPrice: number | null;
  askPrice: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastPrice: number | null;
  mark: number | null;
}

/** Bid/ask en vivo para uno o más símbolos de acciones (o índices). */
export async function fetchQuotes(symbols: string[]): Promise<SchwabQuote[]> {
  const clean = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (clean.length === 0) return [];
  const json = await getJson<Record<string, { quote?: Record<string, number> }>>(
    `/marketdata/v1/quotes?symbols=${encodeURIComponent(clean.join(","))}`,
  );
  return clean.map((symbol) => {
    const q = json[symbol]?.quote ?? {};
    return {
      symbol,
      bidPrice: q.bidPrice ?? null,
      askPrice: q.askPrice ?? null,
      bidSize: q.bidSize ?? null,
      askSize: q.askSize ?? null,
      lastPrice: q.lastPrice ?? null,
      mark: q.mark ?? null,
    };
  });
}

interface SchwabRawOption {
  symbol: string;
  strikePrice: number;
  expirationDate: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  openInterest?: number;
  totalVolume?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  volatility?: number;
}

export interface SchwabOptionQuote {
  symbol: string;
  strike: number;
  contractType: "CALL" | "PUT";
  expiration: string;
  bidPrice: number | null;
  askPrice: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  openInterest: number | null;
  volume: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatility: number | null;
}

/**
 * Cadena de opciones (bid/ask + griegos por contrato) para un ticker, acotada a los
 * strikes más cercanos al spot. Sin `strikeCount` Schwab devuelve 502 en subyacentes
 * líquidos con miles de contratos (ej. SPY) — 100 es el máximo que responde de forma
 * confiable, cubre sobra para lo que se opera de verdad y deja fuera solo los strikes
 * muy OTM (esos siguen usando el proxy de Massive).
 */
export async function fetchOptionChain(
  ticker: string,
  strikeCount = 100,
): Promise<SchwabOptionQuote[]> {
  const clean = ticker.trim().toUpperCase();
  const json = await getJson<{
    callExpDateMap?: Record<string, Record<string, SchwabRawOption[]>>;
    putExpDateMap?: Record<string, Record<string, SchwabRawOption[]>>;
  }>(
    `/marketdata/v1/chains?symbol=${encodeURIComponent(clean)}&contractType=ALL&strikeCount=${strikeCount}`,
  );

  const out: SchwabOptionQuote[] = [];
  const maps: [Record<string, Record<string, SchwabRawOption[]>> | undefined, "CALL" | "PUT"][] = [
    [json.callExpDateMap, "CALL"],
    [json.putExpDateMap, "PUT"],
  ];
  for (const [map, contractType] of maps) {
    for (const strikes of Object.values(map ?? {})) {
      for (const contracts of Object.values(strikes)) {
        for (const c of contracts) {
          out.push({
            symbol: c.symbol,
            strike: c.strikePrice,
            contractType,
            expiration: c.expirationDate.slice(0, 10),
            bidPrice: c.bid ?? null,
            askPrice: c.ask ?? null,
            bidSize: c.bidSize ?? null,
            askSize: c.askSize ?? null,
            last: c.last ?? null,
            openInterest: c.openInterest ?? null,
            volume: c.totalVolume ?? null,
            delta: c.delta ?? null,
            gamma: c.gamma ?? null,
            theta: c.theta ?? null,
            vega: c.vega ?? null,
            impliedVolatility: c.volatility ?? null,
          });
        }
      }
    }
  }
  return out;
}

function describeStatus(status: number, body: string): string {
  switch (status) {
    case 401:
    case 403:
      return "Autenticación rechazada por Schwab. El access/refresh token puede haber caducado — vuelve a correr scripts/schwab-auth.mjs.";
    case 429:
      return "Límite de tasa de Schwab alcanzado. Reintenta en unos segundos.";
    default:
      return `Schwab respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
