// El watchlist del estudiante, en su navegador.
//
// Vive en localStorage por la misma razón que el perfil de riesgo (`tito.risk.*`): la
// entrada guarda tu saldo y tu sizing del momento, y eso no tiene por qué llegar al
// servidor. De paso resuelve el despliegue compartido — con un archivo único en el
// servidor toda la clase escribía en el mismo watchlist.
//
// Contrapartida asumida: no cruza dispositivos y limpiar el navegador lo borra.

import { sortEntries, type WatchlistEntry } from "./watchlist";

const KEY = "tito.watchlist";
const KEY_BROKER = "tito.watchlist.broker";
/** Marca de la importación única desde el viejo data/watchlist.json. */
const KEY_MIGRATED = "tito.watchlist.migrated";

export function loadEntries(): WatchlistEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WatchlistEntry[];
    return Array.isArray(parsed) ? sortEntries(parsed) : [];
  } catch {
    return []; // JSON corrupto: preferimos vacío a romper la página
  }
}

export function saveEntries(entries: WatchlistEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // cuota llena o modo privado: el watchlist sigue en memoria esta sesión
  }
}

export function loadBroker(): string {
  if (typeof window === "undefined") return "none";
  return window.localStorage.getItem(KEY_BROKER) ?? "none";
}

export function saveBroker(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_BROKER, id);
  } catch {
    // ver saveEntries
  }
}

/** ¿Ya importamos el watchlist viejo del servidor? Solo se hace una vez. */
export function hasMigrated(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(KEY_MIGRATED) === "1";
}

export function markMigrated(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_MIGRATED, "1");
  } catch {
    // si no se puede marcar, se reintentará la próxima vez: la importación es idempotente
  }
}
