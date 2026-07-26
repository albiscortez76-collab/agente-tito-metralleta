// LEGADO — solo lectura, y solo para migrar una vez.
//
// El watchlist vivía aquí, en un archivo único del servidor. Eso significaba un solo
// watchlist para toda la clase en un despliegue compartido, y el saldo de cada
// estudiante aterrizando en el servidor. Ahora vive en el navegador (`watchlistLocal.ts`).
//
// Este módulo se queda para que quien ya tuviera data/watchlist.json no pierda lo
// marcado: la página lo importa una vez y no vuelve a mirarlo. Ya nadie escribe aquí.

import { promises as fs } from "fs";
import path from "path";
import type { WatchlistEntry } from "./watchlist";

const FILE = path.join(process.cwd(), "data", "watchlist.json");

export interface StoredWatchlist {
  updatedAt: string;
  broker: string;
  entries: WatchlistEntry[];
}

const EMPTY: StoredWatchlist = { updatedAt: "", broker: "none", entries: [] };

export async function loadWatchlist(): Promise<StoredWatchlist> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredWatchlist;
    return Array.isArray(parsed.entries) ? { ...EMPTY, ...parsed } : EMPTY;
  } catch {
    return EMPTY; // nunca hubo watchlist en servidor
  }
}
