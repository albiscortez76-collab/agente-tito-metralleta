#!/usr/bin/env node
// Monitor de Truth Social (@realDonaldTrump) — corre aparte, todo el día, mientras operas.
//
// Truth Social no tiene API pública oficial, pero su endpoint de estilo
// Mastodon responde sin autenticación si se piden headers de navegador real
// (verificado jul 2026). Como no hay streaming, se hace polling cada
// POLL_MS: cuando aparece una publicación nueva de la cuenta, se asume que
// es un catalizador de mercado (Trump mueve SPX/el mercado en general, no
// solo tickers puntuales), así que:
//   1. Se traduce al español (MyMemory, igual que lib/translate.ts).
//   2. Se manda por Telegram al instante (SIEMPRE, sin filtrar por ticker).
//   3. Si hay un ticker activo en la app, también se avisa el banner en pantalla.
//
// Uso (desde web/): node scripts/truthsocial-monitor.mjs
//
// OJO: es un endpoint no documentado de un tercero — puede cambiar de forma
// o empezar a bloquear sin aviso. Si el monitor deja de traer publicaciones
// nuevas, revisar primero si el endpoint sigue respondiendo 200 (con curl y
// los mismos headers de abajo) antes de asumir que es un bug del script.
//
// Por qué curl y no fetch(): Cloudflare bloquea con 403 "Attention Required"
// las requests hechas con el fetch nativo de Node (undici) aunque lleven
// exactamente los mismos headers que curl — es fingerprinting de TLS/HTTP2,
// no de headers. curl.exe (viene con Windows 10+) sí pasa. Verificado jul 2026.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");
const stateDir = path.join(__dirname, "..", "data");
const statePath = path.join(stateDir, "truthsocial-state.json");
const APP_URL = "http://localhost:3000";
const ACCOUNT_ID = "107780257626128497"; // @realDonaldTrump
const POLL_MS = 45_000;
const MAX_BURST = 5; // tope de alertas por vuelta, para no inundar Telegram si hay backlog

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
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = env.TELEGRAM_CHAT_ID;

// ---------- estado (último id visto, para no repetir alertas al reiniciar) ----------

function readState() {
  if (!existsSync(statePath)) return { lastId: null };
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { lastId: null };
  }
}

function writeState(state) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

// ---------- traducción (misma idea que lib/translate.ts) ----------

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

// ---------- Truth Social ----------

function stripHtml(html) {
  return html
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function fetchLatestStatuses() {
  const url = `https://truthsocial.com/api/v1/accounts/${ACCOUNT_ID}/statuses?limit=10`;
  const { stdout } = await execFileAsync(
    "curl",
    [
      "-s",
      "--max-time",
      "10",
      url,
      "-H",
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "-H",
      "Accept: application/json, text/plain, */*",
      "-H",
      "Referer: https://truthsocial.com/@realDonaldTrump",
      "-H",
      "Origin: https://truthsocial.com",
      "-H",
      "Accept-Language: en-US,en;q=0.9",
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const json = JSON.parse(stdout);
  if (!Array.isArray(json)) throw new Error("respuesta inesperada (¿bloqueo de Cloudflare?)");
  return json;
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("[ts] (sin TELEGRAM_BOT_TOKEN/CHAT_ID configurado, no se manda Telegram)");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error("[ts] error mandando Telegram:", err.message ?? err);
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

async function postAlert(ticker, headline, headlineOriginal, url) {
  try {
    await fetch(`${APP_URL}/api/news-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker,
        headline,
        headlineOriginal,
        matchedBy: "Truth Social",
        source: "truthsocial",
        url,
      }),
    });
  } catch (err) {
    console.error("[ts] error avisando el banner:", err.message ?? err);
  }
}

/**
 * Extrae el texto de una publicación (o del original si es repost) y su URL.
 * Devuelve null si no hay texto real — Trump republica memes/imágenes sin
 * caption todo el tiempo, y "(sin texto)" no es un catalizador de nada, solo
 * ruido en Telegram. Sin texto, no hay nada que traducir ni que alertar.
 */
function extractPost(status) {
  const source = status.reblog ?? status;
  const rawText = stripHtml(source.content ?? "");
  const isRepost = Boolean(status.reblog);
  if (!rawText) return null;
  const text = isRepost ? `(repost) ${rawText}` : rawText;
  return { text, url: status.url ?? source.url };
}

async function handleNewStatus(status) {
  const post = extractPost(status);
  if (!post) return;

  console.log(`[ts] 🚨 nueva publicación: ${post.text.slice(0, 120)}`);
  const headline = await translate(post.text);

  const active = await getActiveTicker();
  await Promise.all([
    sendTelegram(`🚨 Truth Social — @realDonaldTrump\n\n${headline}\n\n${post.url}`),
    active ? postAlert(active.ticker, headline, post.text, post.url) : Promise.resolve(),
  ]);
}

async function poll() {
  let statuses;
  try {
    statuses = await fetchLatestStatuses();
  } catch (err) {
    console.error("[ts] error consultando Truth Social:", err.message ?? err);
    return;
  }
  if (!Array.isArray(statuses) || statuses.length === 0) return;

  const state = readState();
  if (state.lastId == null) {
    // Primera corrida: solo se marca el punto de partida, no se alerta el historial completo.
    const newestId = statuses.reduce((max, s) => (BigInt(s.id) > BigInt(max) ? s.id : max), statuses[0].id);
    writeState({ lastId: newestId });
    console.log(`[ts] arrancando desde el id ${newestId} (sin alertar publicaciones previas)`);
    return;
  }

  const lastId = BigInt(state.lastId);
  let fresh = statuses
    .filter((s) => BigInt(s.id) > lastId)
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1)); // más viejas primero

  if (fresh.length === 0) return;

  // Si el monitor estuvo apagado un rato y se acumuló backlog, no revienta
  // Telegram con una ráfaga entera — solo alerta las MAX_BURST más recientes
  // (las viejas ya perdieron valor como catalizador del momento).
  if (fresh.length > MAX_BURST) {
    console.log(`[ts] ${fresh.length} publicaciones nuevas de golpe (backlog) — alertando solo las últimas ${MAX_BURST}`);
    fresh = fresh.slice(-MAX_BURST);
  }

  for (const status of fresh) {
    await handleNewStatus(status).catch((err) => console.error("[ts] error procesando publicación:", err.message ?? err));
  }
  writeState({ lastId: statuses.reduce((max, s) => (BigInt(s.id) > BigInt(max) ? s.id : max), state.lastId) });
}

console.log("Monitor de Truth Social (@realDonaldTrump) — Ctrl+C para detener.");
console.log(`Avisando por Telegram: ${TG_TOKEN && TG_CHAT ? "sí" : "no (faltan credenciales)"}`);
poll();
setInterval(poll, POLL_MS);
