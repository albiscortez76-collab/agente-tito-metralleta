#!/usr/bin/env node
// Autorización OAuth2 de Schwab. Correr una vez, y de nuevo cada vez que caduque
// el refresh token (dura 7 días — es una limitación del lado de Schwab).
//
// Uso (desde web/): node scripts/schwab-auth.mjs

import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");

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

function writeEnvValue(key, value) {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, `${key}=${value}`);
  } else {
    text += `${text.endsWith("\n") || text === "" ? "" : "\n"}${key}=${value}\n`;
  }
  writeFileSync(envPath, text, "utf8");
}

const env = readEnv();
const clientId = env.SCHWAB_CLIENT_ID;
const clientSecret = env.SCHWAB_CLIENT_SECRET;
const redirectUri = env.SCHWAB_REDIRECT_URI || "https://127.0.0.1";

if (!clientId || !clientSecret) {
  console.error("Falta SCHWAB_CLIENT_ID y/o SCHWAB_CLIENT_SECRET en .env.local. Agrégalos primero.");
  process.exit(1);
}

const authUrl =
  `https://api.schwabapi.com/v1/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}`;

console.log("\n1. Abre esta URL en TU navegador (con tu sesión real de Schwab) y autoriza la app:\n");
console.log(authUrl);
console.log(
  "\n2. Después de aceptar, el navegador va a intentar cargar tu Callback URL y probablemente falle" +
    " (normal — no hay servidor escuchando ahí).",
);
console.log(
  "   Copia la URL COMPLETA que quedó en la barra de direcciones (incluye ?code=...) y pégala abajo.\n",
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = await rl.question("Pega la URL de redirección aquí: ");
rl.close();

let code;
try {
  const u = new URL(pasted.trim());
  code = u.searchParams.get("code");
} catch {
  console.error("No pude interpretar esa URL.");
  process.exit(1);
}
if (!code) {
  console.error("No encontré '?code=' en la URL pegada.");
  process.exit(1);
}

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const res = await fetch("https://api.schwabapi.com/v1/oauth/token", {
  method: "POST",
  headers: {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }),
});

if (!res.ok) {
  console.error(`Schwab respondió ${res.status}:`, await res.text());
  process.exit(1);
}

const json = await res.json();
writeEnvValue("SCHWAB_REFRESH_TOKEN", json.refresh_token);
console.log("\n✓ Listo. SCHWAB_REFRESH_TOKEN guardado en .env.local.");
console.log("  El refresh token de Schwab caduca cada 7 días — vuelve a correr este script cuando deje de funcionar.\n");
