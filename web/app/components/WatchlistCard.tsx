"use client";

import { useState } from "react";
import {
  BROKERS,
  brokerById,
  outboxLabel,
  quoteLink,
  tickerList,
  ROBINHOOD_MCP_COMMAND,
  type OutboxItem,
  type WatchlistEntry,
} from "@/lib/watchlist";

const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});
const px = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function contractLabel(e: WatchlistEntry): string {
  const t = e.type === "call" ? "C" : "P";
  return `$${e.strike != null ? px.format(e.strike) : "?"}${t}`;
}

function expiryLabel(e: WatchlistEntry): string {
  if (!e.expiration) return "—";
  const d = new Date(`${e.expiration}T00:00:00Z`);
  return d.toLocaleDateString("es-ES", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

function addedLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
  } catch {
    return "";
  }
}

/** Botón de copiar con acuse. Sin dependencias: el portapapeles ya es API del navegador. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "✓ copiado" : label}
    </button>
  );
}

export default function WatchlistCard({
  entries,
  broker,
  pending,
  failed = [],
  lastSyncedAt = null,
  onBrokerChange,
  onRemove,
}: {
  entries: WatchlistEntry[];
  broker: string;
  pending: OutboxItem[];
  /** Aparcados por el drenador: no se reintentan solos (ver `markOutboxFailed`). */
  failed?: OutboxItem[];
  lastSyncedAt?: string | null;
  onBrokerChange: (id: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const chosen = brokerById(broker);
  const [showConnect, setShowConnect] = useState(false);

  return (
    <section className="watchlist-card">
      <div className="risk-head">
        <h2>⭐ Mi watchlist</h2>
        <span className="muted">
          {entries.length === 0
            ? "Marca una idea con ⭐ para guardarla con tu sizing del momento."
            : `${entries.length} ${entries.length === 1 ? "contrato guardado" : "contratos guardados"}`}
        </span>
      </div>

      <div className="watchlist-broker">
        <label className="risk-field">
          <span>Broker</span>
          <select
            className="broker-select"
            value={broker}
            onChange={(e) => onBrokerChange(e.target.value)}
            aria-label="Broker donde sincronizar el watchlist"
          >
            {BROKERS.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>

        {chosen?.kind === "mcp" && (
          <button className="connect-btn" onClick={() => setShowConnect((v) => !v)}>
            {showConnect ? "Ocultar" : "🔗 Conectar " + chosen.name}
          </button>
        )}

        {chosen?.caveat && <p className="broker-caveat">⚠️ {chosen.caveat}</p>}
      </div>

      {showConnect && chosen?.kind === "mcp" && (
        <div className="connect-panel">
          <strong>Conectar {chosen.name} a tu Claude</strong>
          <p className="muted">
            La conexión se autoriza con OAuth dentro de Claude, no en esta página —
            {" "}<strong>tu contraseña nunca pasa por aquí</strong>. Pega este comando en tu
            terminal y luego escribe <code>/mcp</code> en Claude Code para autenticarte:
          </p>
          <div className="connect-cmd">
            <code>{ROBINHOOD_MCP_COMMAND}</code>
            <CopyButton text={ROBINHOOD_MCP_COMMAND} label="copiar" />
          </div>
          <p className="muted">
            Autorizar da a tu agente lectura de tus cuentas, posiciones e historial de
            órdenes. <strong>No es un permiso menor</strong> — léelo antes de aceptar.
            Tito solo lo usa para añadir contratos a tu watchlist: <strong>nunca coloca una
            orden</strong>. Si además quieres operar, eso lo configuras tú en tu propio Claude.
          </p>
        </div>
      )}

      {chosen && chosen.kind === "mcp" && pending.length > 0 && (
        <div className="sync-pending">
          <strong>Pendiente de sincronizar con {chosen.name}:</strong>{" "}
          <code>{pending.map(outboxLabel).join(" · ")}</code>
          <p className="muted">
            {chosen.granularity === "contracts"
              ? "Son los contratos completos, tal cual entrarán en tu watchlist de opciones."
              : "Son los subyacentes, no los contratos — es lo que este broker acepta."}{" "}
            Entran solos en el próximo pase (cada 15 min). Si tienes prisa, pídemelo en el
            chat («sincroniza mi watchlist»).
          </p>
          {lastSyncedAt && (
            <p className="muted">Último pase: {new Date(lastSyncedAt).toLocaleString()}</p>
          )}
        </div>
      )}

      {chosen && chosen.kind === "mcp" && failed.length > 0 && (
        <div className="sync-pending sync-failed">
          <strong>No se pudieron sincronizar:</strong>{" "}
          <code>{failed.map(outboxLabel).join(" · ")}</code>
          <p className="muted">
            {failed[0]?.failReason ?? "No se pudo resolver el contrato en el broker."}{" "}
            No se reintentan solos. Desmarca y vuelve a marcar ⭐ para reencolarlos con el
            contrato completo.
          </p>
        </div>
      )}

      {chosen && chosen.kind === "copy" && entries.length > 0 && (
        <div className="sync-pending">
          <strong>Para {chosen.name}:</strong>{" "}
          <code>{tickerList(entries)}</code>{" "}
          <CopyButton text={tickerList(entries)} label="copiar tickers" />
        </div>
      )}

      {entries.length > 0 && (
        <div className="table-wrap">
          <table className="ideas-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Contrato</th>
                <th>Vencimiento</th>
                <th>Marcada</th>
                <th className="num">Spot entrada</th>
                <th className="num">Precio entrada</th>
                <th className="num">Tu límite</th>
                <th>{chosen?.kind === "link" ? "Abrir" : "Sync"}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const link = chosen ? quoteLink(e.ticker, chosen) : null;
                return (
                  <tr key={e.symbol}>
                    <td><a className="idea-ticker" href={`/?ticker=${e.ticker}`}>{e.ticker}</a></td>
                    <td>{contractLabel(e)}</td>
                    <td className="muted">{expiryLabel(e)}</td>
                    <td className="muted">{addedLabel(e.addedAt)}</td>
                    <td className="num">${px.format(e.entrySpot)}</td>
                    <td className="num">${px.format(e.entryPrice)}</td>
                    <td className="num">
                      {e.maxContracts}
                      <span className="muted"> · {money.format(e.accountSizeAtEntry)} al {e.tolerancePctAtEntry}%</span>
                    </td>
                    <td>
                      {chosen?.kind === "link" && link ? (
                        <a
                          className="broker-link"
                          href={link}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {chosen.name} ↗
                        </a>
                      ) : e.brokerSync?.status === "sincronizado" ? (
                        <span className="chip chip-ask">✓ {e.brokerSync.broker}</span>
                      ) : (
                        <span className="chip chip-neutral">solo Tito</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="unstar"
                        onClick={() => onRemove(e.symbol)}
                        aria-label={`Quitar ${e.ticker} ${contractLabel(e)} del watchlist`}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {entries.length > 0 && (
        <p className="muted watchlist-note">
          Tu watchlist se guarda en este navegador, no en el servidor — igual que tu saldo.
          Eso significa que no te sigue a otro dispositivo y que se borra si limpias el
          navegador. Tito <strong>nunca coloca una orden</strong> por ti.
        </p>
      )}
    </section>
  );
}
