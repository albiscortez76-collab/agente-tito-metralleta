#!/usr/bin/env node
// Monitor de Financial Juice — corre aparte, todo el día, mientras operas.
//
// Se conecta al WebSocket de Financial Juice (plan gratis: 10 min de delay).
// CADA titular que llega se guarda en el feed de Noticias de la app (capa
// "Financial Juice", junto a CNBC/Investing.com — lib/financialJuiceFeed.ts).
// Además, si el titular menciona el ticker que tienes abierto en Tito
// Metralleta (lo pregunta por HTTP a la app, que debe estar corriendo en
// localhost:3000):
//   1. Lo traduce al español (MyMemory, igual que lib/translate.ts).
//   2. Te manda un mensaje de Telegram al instante.
//   3. Se lo avisa a la app para que salga el banner en pantalla.
//
// Uso (desde web/): node scripts/financialjuice-monitor.mjs
//
// OJO: el formato exacto de los mensajes "news" de Financial Juice no estaba
// 100% confirmado al escribir esto (su free tier tarda en mandar titulares
// reales, no cada pocos segundos) — por eso extractHeadline() prueba varios
// nombres de campo posibles. La primera vez que corras esto, si ves
// "[fj] mensaje de noticia sin headline reconocible" revisa el JSON crudo que
// se imprime debajo y ajusta extractHeadline().

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");
const APP_URL = "http://localhost:3000";

function readEnv() {
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)\r?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = readEnv();
const FJ_KEY = env.FINANCIALJUICE_API_KEY;
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = env.TELEGRAM_CHAT_ID;

if (!FJ_KEY) {
  console.error("Falta FINANCIALJUICE_API_KEY en .env.local.");
  process.exit(1);
}

// ---------- traducción (misma idea que lib/translate.ts) ----------

// Cuando se acaba la cuota gratis, MyMemory responde HTTP 200 pero mete el aviso
// DENTRO de responseData.translatedText como si fuera la traducción —
// quotaFinished sale null, no sirve. La señal confiable es responseStatus
// (dentro del JSON, no el código HTTP) distinto de 200.
async function translate(text) {
  if (!text) return text;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|es`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return text;
    const json = await res.json();
    const status = Number(json.responseStatus);
    const translated = json.responseData?.translatedText;
    if (!translated || (Number.isFinite(status) && status !== 200)) return text;
    return translated;
  } catch {
    return text;
  }
}

// ---------- match de empresa (versión chica de lib/news.ts) ----------

const NAME_NOISE = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|company|co|co\.|plc|ltd|ltd\.|limited|holdings?|group|the|common|ordinary|class\s+[a-c]|shares?|stock)\b/gi;

function companyAliases(ticker, name) {
  const out = new Set();
  const t = ticker.trim().toUpperCase();
  if (t.length >= 3) out.add(t);
  if (name) {
    const clean = name.replace(/[,.]/g, " ").replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 3) out.add(clean);
    const first = clean.split(" ")[0];
    if (first && first.length >= 4) out.add(first);
  }
  return [...out];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsCompany(text, aliases) {
  for (const a of aliases) {
    const isTicker = a === a.toUpperCase() && !a.includes(" ");
    const re = new RegExp(`(^|[^\\w])${escapeRe(a)}($|[^\\w])`, isTicker ? "" : "i");
    if (re.test(text)) return a;
  }
  return null;
}

// ---------- Financial Juice ----------

function extractHeadline(data) {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return null;
  return data.headline ?? data.title ?? data.text ?? data.body ?? data.message ?? null;
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("[fj] (sin TELEGRAM_BOT_TOKEN/CHAT_ID configurado, no se manda Telegram)");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error("[fj] error mandando Telegram:", err.message ?? err);
  }
}

async function getActiveTicker() {
  try {
    const res = await fetch(`${APP_URL}/api/active-ticker`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ticker ? json : null;
  } catch {
    return null; // la app no está corriendo ahora mismo — no es fatal, se reintenta
  }
}

async function postAlert(ticker, headline, headlineOriginal, matchedBy) {
  try {
    await fetch(`${APP_URL}/api/news-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, headline, headlineOriginal, matchedBy }),
    });
  } catch (err) {
    console.error("[fj] error avisando el banner:", err.message ?? err);
  }
}

/** Guarda CUALQUIER titular en el feed de Noticias (mencione o no el ticker activo). */
async function postFeedItem(title, url) {
  try {
    await fetch(`${APP_URL}/api/financial-juice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, url }),
    });
  } catch (err) {
    console.error("[fj] error guardando en el feed de Noticias:", err.message ?? err);
  }
}

async function handleNews(data) {
  const headlineOriginal = extractHeadline(data);
  if (!headlineOriginal) {
    console.log("[fj] mensaje de noticia sin headline reconocible, JSON crudo:", JSON.stringify(data).slice(0, 500));
    return;
  }
  const url = data && typeof data === "object" ? (data.url ?? data.link ?? null) : null;

  // Siempre al feed de Noticias (capa "Financial Juice", junto a CNBC/Investing.com) —
  // esto es independiente de si menciona o no el ticker que tienes abierto ahora mismo.
  postFeedItem(headlineOriginal, url).catch(() => {});

  const active = await getActiveTicker();
  if (!active) return; // sin ticker activo (o la app apagada) — nada más que hacer

  const aliases = companyAliases(active.ticker, active.companyName);
  const hit = mentionsCompany(headlineOriginal, aliases);
  if (!hit) return;

  const headline = await translate(headlineOriginal);
  console.log(`[fj] 🚨 ${active.ticker}: ${headline}`);

  await Promise.all([
    sendTelegram(`🚨 Financial Juice — mención de ${active.ticker}\n\n${headline}`),
    postAlert(active.ticker, headline, headlineOriginal, hit),
  ]);
}

function connect() {
  console.log("[fj] conectando a Financial Juice…");
  const ws = new WebSocket(`wss://stream.financialjuice.com/v1/stream?apikey=${FJ_KEY}`);

  ws.addEventListener("open", () => console.log("[fj] conectado, escuchando…"));

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data.toString());
    } catch {
      return;
    }
    if (msg.type === "hello") {
      console.log(`[fj] hello — canales: ${msg.channels?.join(", ")}, delay: ${msg.delay_seconds}s`);
      return;
    }
    if (msg.type === "ping") return;
    if (msg.type === "news") {
      handleNews(msg.data).catch((err) => console.error("[fj] error procesando noticia:", err.message ?? err));
      return;
    }
    // tipo desconocido (ej. "calendar" u otro nuevo): se ignora, no rompe el monitor
  });

  ws.addEventListener("error", (e) => console.error("[fj] error de conexión:", e.message ?? e));

  ws.addEventListener("close", (e) => {
    console.log(`[fj] conexión cerrada (${e.code}) — reintentando en 10s…`);
    setTimeout(connect, 10_000);
  });
}

console.log("Monitor de Financial Juice — Ctrl+C para detener.");
console.log(`Avisando por Telegram: ${TG_TOKEN && TG_CHAT ? "sí" : "no (faltan credenciales)"}`);
connect();
