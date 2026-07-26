// Persistencia del buzón de salida hacia el broker. web/data/outbox.json (gitignored).
// Solo servidor. La lógica pura vive en `watchlist.ts`.
//
// Ojo con lo que NO guarda: los griegos, tu sizing y tu saldo se quedan en el navegador
// del estudiante. Aquí solo cae la identidad del contrato (ticker y, si el broker los
// acepta, tipo/strike/vencimiento), que es lo mínimo para resolverlo en el broker.

import { promises as fs } from "fs";
import path from "path";
import type { OutboxItem } from "./watchlist";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "outbox.json");

export interface StoredOutbox {
  updatedAt: string;
  items: OutboxItem[];
}

const EMPTY: StoredOutbox = { updatedAt: "", items: [] };

export async function loadOutbox(): Promise<StoredOutbox> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredOutbox;
    return Array.isArray(parsed.items) ? { ...EMPTY, ...parsed } : EMPTY;
  } catch {
    return EMPTY; // aún no hay nada encolado
  }
}

export async function saveOutbox(items: OutboxItem[]): Promise<StoredOutbox> {
  const payload: StoredOutbox = { updatedAt: new Date().toISOString(), items };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}
