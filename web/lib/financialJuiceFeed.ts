// Titulares de Financial Juice acumulados en memoria — el monitor (proceso
// aparte) los manda por POST a medida que llegan, mencionen o no el ticker
// activo. `buildNewsReport` los mezcla con los feeds RSS macro (misma capa,
// publisher "Financial Juice"), así aparecen en el panel de Noticias sin
// necesitar UI nueva.

export interface FjHeadline {
  id: string;
  title: string;
  url: string | null;
  receivedAt: string;
}

const MAX_ITEMS = 40;
const items: FjHeadline[] = [];

export function addFjHeadline(input: { title: string; url?: string | null }): FjHeadline {
  const item: FjHeadline = {
    id: `fj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: input.title,
    url: input.url ?? null,
    receivedAt: new Date().toISOString(),
  };
  items.unshift(item);
  items.length = Math.min(items.length, MAX_ITEMS);
  return item;
}

export function getFjHeadlines(): FjHeadline[] {
  return items;
}
