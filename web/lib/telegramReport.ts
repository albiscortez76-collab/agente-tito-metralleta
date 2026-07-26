// Arma el texto del reporte diario que se manda a Telegram. Pura — recibe lo que
// ya está calculado en pantalla (prediction, levels, sentiment) y solo formatea.

import type { ProPrediction } from "./prediction";
import type { LevelsReport } from "./levels";

export interface SentimentPartLite {
  name: string;
  score: number | null;
}

export interface TelegramReportInput {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  regime: "positive" | "negative" | null;
  prediction: ProPrediction | null;
  levels: LevelsReport | null;
  sentimentParts: SentimentPartLite[];
}

function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function scenarioLine(label: string, s: ProPrediction["bear"]): string {
  return `${label} $${fmtPrice(s.target)} (${fmtPct(s.changePct)}) · ${Math.round(s.probability * 100)}% de tocarlo`;
}

/** Arma el texto plano (sin markdown, para no pelear con el escapado de $/%/-). */
export function buildTelegramReport(input: TelegramReportInput): string {
  const { ticker, price, changePercent, regime, prediction, levels, sentimentParts } = input;
  const now = new Date();
  const fecha = now.toLocaleDateString("es-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const lines: string[] = [];
  lines.push(`📊 Reporte diario — ${ticker}`);
  lines.push(fecha);
  lines.push("");

  if (price != null) {
    const chg = changePercent != null ? ` (${fmtPct(changePercent)})` : "";
    lines.push(`Precio actual: $${fmtPrice(price)}${chg}`);
  }
  if (regime) {
    lines.push(
      regime === "negative"
        ? "Régimen GEX: γ− — el dealer amplifica el movimiento"
        : "Régimen GEX: γ+ — el dealer estabiliza el precio",
    );
  }
  lines.push("");

  if (prediction) {
    lines.push(`🧠 AI Sentiment: ${prediction.score}/100 (${prediction.active}/6 sub-agentes con dato)`);
    lines.push("");
    lines.push("Prediction Pro:");
    lines.push(`  🔴 ${scenarioLine("Bear", prediction.bear)}`);
    lines.push(`  🔵 ${scenarioLine("Base", prediction.base)}`);
    lines.push(`  🟢 ${scenarioLine("Bull", prediction.bull)}`);
    lines.push("");
    lines.push(prediction.summary);
    if (prediction.caveat) lines.push(`⚠ ${prediction.caveat}`);
    lines.push("");
  }

  const activeParts = sentimentParts.filter((p) => p.score != null);
  if (activeParts.length > 0) {
    lines.push("Desglose por señal:");
    for (const p of activeParts) lines.push(`  ${p.name}: ${p.score}/10`);
    lines.push("");
  }

  if (levels?.keyResistance) {
    const r = levels.keyResistance;
    lines.push(`🔴 Resistencia clave: $${fmtPrice(r.price)} (${fmtPct(r.distancePct)}) · fuerza ${Math.round(r.strength)}/100`);
  }
  if (levels?.keySupport) {
    const s = levels.keySupport;
    lines.push(`🟢 Soporte clave: $${fmtPrice(s.price)} (${fmtPct(s.distancePct)}) · fuerza ${Math.round(s.strength)}/100`);
  }

  lines.push("");
  lines.push("Estimaciones de IA. No es consejo financiero.");

  return lines.join("\n");
}
