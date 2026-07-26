// Traducción de titulares/razonamiento de noticias (vienen en inglés de
// CNBC/Investing.com/Massive) a español, vía MyMemory (gratis, sin API key).
// Si falla o se acaba la cuota, se devuelve el texto original — nunca rompe el panel.

const ENDPOINT = "https://api.mymemory.translated.net/get";
const cache = new Map<string, string>();

interface MyMemoryResponse {
  responseData?: { translatedText?: string };
  quotaFinished?: boolean;
}

async function translateOne(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const hit = cache.get(trimmed);
  if (hit) return hit;

  try {
    const url = `${ENDPOINT}?q=${encodeURIComponent(trimmed)}&langpair=en|es`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!res.ok) return text;
    const json = (await res.json()) as MyMemoryResponse;
    const translated = json.responseData?.translatedText;
    if (!translated || json.quotaFinished) return text;
    cache.set(trimmed, translated);
    return translated;
  } catch {
    return text; // sin conexión o timeout: mejor mostrar el original que romper el panel
  }
}

/** Traduce una lista con concurrencia acotada — MyMemory es de uso libre, no hay que abusar. */
export async function translateMany(texts: (string | null)[], concurrency = 5): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(texts.length);
  let i = 0;
  async function run(): Promise<void> {
    while (i < texts.length) {
      const idx = i++;
      const t = texts[idx];
      out[idx] = t ? await translateOne(t) : t;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, run));
  return out;
}
