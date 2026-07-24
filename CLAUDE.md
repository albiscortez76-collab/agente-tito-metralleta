# CLAUDE.md — Agente Tito Metralleta

Guía para Claude Code al trabajar en este proyecto.

## Qué es este proyecto

**Agente Tito Metralleta** es un sistema **multi-agente de análisis de flujo de opciones** (options flow). Su propósito es identificar **actividad inusual** en el mercado de opciones —actual e histórica— e interpretarla para dar contexto operativo, incluyendo señales de soporte/resistencia, "muros", flujo direccional vs. cobertura, y noticias relevantes del subyacente.

**Estado actual:** en construcción. La documentación del agente está completa y existe un primer
incremento de la **web interactiva** (`web/`) que lee la option chain desde Massive y muestra
Open Interest, Open Premium y Valor Nocional con pasos de carga en vivo (cubre Tareas 1, 2 y 5).

## Estructura

```
Agente Tito Metralleta/
├── CLAUDE.md                        # Este archivo
├── Agente Principal/
│   ├── Proceso Principal.pdf        # Fuente original (Apple Pages/PDF)
│   └── Proceso Principal.md         # Especificación del agente de Opciones (7 tareas)
├── Intrucciones Referencias.md      # Advertencia de liquidez / GEX
├── Intrucciones Referencias.pages   # Fuente original
├── RSS Feed.md                      # Fuentes de noticias a monitorear
├── RSS Feed.pages                   # Fuente original
├── Sub Agentes/                     # (vacío — agentes secundarios por definir)
└── web/                             # App Next.js (lector interactivo) — ver web/SPEC.md
```

## App web (`web/`)

- **Diseño (jul 2026):** tema claro estilo "Options AI Dashboard" importado de Claude Design (proyecto `0017fa5c…`, `Options AI Dashboard.dc.html`). Fuente **Space Grotesk** (next/font). Layout: `HeaderBar` sticky (logo + pills de tickers + búsqueda + precio) → Sentiment/Prediction → Activity/MoneyFlow → **PRO Strike Walls** (oscuro) → TradesFeed → `<details>` "Detalle de sub-agentes" con TODOS los paneles de categorías (esas tablas/promedios alimentan Prediction Pro — no eliminarlas). PredictionCard y la pestaña Accuracy están en estado "próximamente" hasta que estén los 6 sub-agentes.

- **Noticias (Tarea 7):** `lib/news.ts` + `app/api/news/route.ts` + `app/components/NewsCard.tsx`. **Dos capas:** macro (los RSS de [RSS Feed.md](RSS%20Feed.md), cache 15 min) + empresa (`/v2/reference/news?ticker=` de Massive, que trae `insights[].sentiment` por ticker, cache 5 min). Los titulares macro que mencionan a la empresa se promueven a la capa de empresa. **Bandera de contradicción** (`contradictionFlag`) confronta la dirección del flujo contra el sesgo de noticias — **no toca los 100 pts del scorecard**. Tests en `lib/news.test.ts`.
- **Stack:** Next.js 15 (App Router, TS). Correr con el dev server `tito-web` (`.claude/launch.json` a nivel Desktop) o `npm run dev` en `web/` (puerto 3000).
- **Proveedor de datos:** Massive (`api.massive.com`, rebrand de Polygon.io). Endpoints: option chain `GET /v3/snapshot/options/{ticker}` (paginado), detalles empresa `GET /v3/reference/tickers/{ticker}`, snapshot acción `GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}`.
- **Vista Estudiante vs Pro (jul 2026):** toggle en `page.tsx` (`view`, default `estudiante`). La vista **Estudiante** es limpia para novatos y NO toca `lib/` (cálculos) — solo re-empaqueta lo ya calculado: `VeredictoCard` (frase llana desde `prediction.summary` + dirección + confianza; muestra "no fiable/no operar" si `prediction.caveat`), selector de horizonte llano (Esta semana/2 semanas/1 mes → 10/20/30), `SimpleChart`, `EscenariosCard` (los **3 targets** bajista/base/alcista con % y prob), `ContextoLinea` (noticias en 1 línea + bandera de contradicción), `NivelesSimples` (lista mínima con `probTouch` por nivel), y `MemoriaCard`. Sin jerga (GEX/gamma/notional viven solo en Pro). La vista **Pro** es el dashboard completo original sin cambios. Spec: [docs/superpowers/specs/2026-07-24-vista-simple-estudiantes-design.md](docs/superpowers/specs/2026-07-24-vista-simple-estudiantes-design.md).
  - **`SimpleChart`:** velas + los **3 escenarios** como líneas que SE MUEVEN (helper `wigglePath`: ruta `predictionPath` + oscilación ∝ σ con un sobre `sin(πf)` que vale 0 al inicio y al target, así ancla ambos extremos y "baila" dentro del cono; `seed` distinto por escenario, determinista). Se dibujan una vez (`stroke-dashoffset`) sobre `PriceChart`. Ruido reducido: solo los **2 soportes + 2 resistencias más cercanos** con fuerza ≥25. El **target base = nivel imán del GEX** (mayor probabilidad×premium) recortado al cono 2σ; por eso en flujo lateral la línea sale casi plana.
  - **Memoria del agente (auto-evaluación):** `lib/predictionStore.ts` (fs en `data/predictions/{TICKER}.json`, dedupe por fecha ET, se acumula hacia adelante) guarda una foto diaria con los 3 targets; `reviewPredictions` (PURA, tests en `predictionStore.test.ts`) la compara días después contra las barras reales: error del base, si tocó el nivel, acierto de dirección, **sesgo** (error medio firmado = si sistemáticamente apunta alto/bajo) y qué escenario acertó. Ruta `app/api/prediction/route.ts` (POST guarda al cargar desde `page.tsx`; GET revisa). Panel `app/components/MemoriaCard.tsx`. Al principio dirá "aún no hay predicciones vencidas" hasta que pase el horizonte.
  - **Auto-corrección por memoria (lazo de control):** `predictPro` acepta `calibration: { biasPct, samples }` y `calibrationShiftPct` (tests en `prediction.test.ts`) corrige el **target base** según el sesgo histórico. Amortiguado y acotado (`CALIBRATION = { minSamples: 5, gain: 0.6, capPct: 3 }`): solo con ≥5 vencidas, corrige el 60% del sesgo, tope ±3% del spot, y se recorta al cono 2σ. El imán crudo sigue anclando la búsqueda de bull/bear (no se arrastra el sesgo a los extremos). Converge: al mejorar, el sesgo baja y la corrección se apaga sola. `page.tsx` lee el sesgo (GET `/api/prediction`) ANTES de fijar el target y **guarda el target ya calibrado** (espera `calibReady`). Chip `🧠 ajustado ±X%` en `VeredictoCard` + nota en el resumen cuando aplica.
- **Panel de empresa:** antes de la tabla se muestra logo + info + stats (Stock Price, market cap, volumen, rango del día, cierre previo, empleados). El logo se sirve por proxy propio `GET /api/logo?ticker=` (la key nunca llega al cliente). La tabla tiene fila TOTAL con la sumatoria (incl. Notional).
- **Estructura / Acumulación y Rapidez (categoría 4 del scorecard):** `lib/structure.ts` → `structureScore` (nocional promedio por strike, dominio direccional calls/puts en los top-5 strikes, % volumen > OI; ver [SCOREDCARD/Acumulacion-Rapidez.md](SCOREDCARD/Acumulacion-Rapidez.md)). Panel en `app/components/StructureCard.tsx`. **Usa la cadena de opciones de Massive**, no el flujo de MarketSnack. Historial de 45 días: `lib/chainStore.ts` guarda una foto por día de mercado en `data/chain/{TICKER}.json` (dedupe por fecha ET) — se acumula hacia adelante porque Massive no expone OI histórico.
- **Confirmación de Precio / Validación de Flows (categoría 6 del scorecard):** `lib/validation.ts` → `validationScore` (backtest: para cada flow guardado mide MFE/MAE y cuántas sesiones tardó el movimiento a favor y en contra; ver [SCOREDCARD/Validacion-Flows.md](SCOREDCARD/Validacion-Flows.md)). Ruta `app/api/validation/route.ts`, panel `app/components/ValidationCard.tsx`. **El PDF no trae tabla de puntos** — las bandas de `validationPoints`/`speedPoints` son una propuesta y están aisladas para cambiarlas de un sitio. Umbral de movimiento **adaptativo** (rango diario típico × 1.5, piso 2%) porque un 2% fijo satura en tickers volátiles. Corre sobre `data/trades/{TICKER}.json`, que se acumula hacia adelante; avisa si no llega a los 60 días que pide el documento.
- **Soportes y resistencias:** `lib/levels.ts` → `findLevels` (puro, tests en `levels.test.ts`). Cruza **dos fuentes independientes**: (1) precio — `findPivots` (swing highs/lows con ventana k) + `clusterPivots` (agrupa por tolerancia %, así $299 y $301 son un solo nivel) con peso por `recencyFactor`; (2) opciones — según la tabla del Proceso Principal **vender calls = resistencia, vender puts = soporte**, así que solo cuentan calls para resistencias y puts para soportes, y solo la ejecución al **bid** (venta) suma como muro. Fuerza 0-100 = toques·frescura + OI + premium de flujo + |GEX| + **bonus de confluencia** cuando coinciden precio y opciones. Los strikes sin rebote previo deben superar el **percentil 70 de OI** para entrar, si no la lista se llena de ruido. Marca niveles `flipped` (era techo y ahora hace de suelo). Panel `app/components/LevelsCard.tsx` y líneas punteadas en `ProWallsCard` para los de fuerza ≥35.
- **Prediction Pro (cierre del sistema):** `lib/prediction.ts` → `predictPro` (puro, tests en `prediction.test.ts`). Junta los 6 sub-agentes + mapa GEX + σ en **tres escenarios**: `base` = nivel imán del heatmap, `bull`/`bear` = el nivel relevante arriba/abajo **excluyendo el base**, con fallback a las bandas de 1σ. Se fuerza el orden estricto **bear < base < bull** y todo se recorta al cono de 2σ. Cada escenario trae precio, %, probabilidad de toque y el porqué. `weightedScore` da el sentiment 0-100 con los pesos del scorecard; `confidenceOf` mezcla nitidez del imán + cobertura de sub-agentes + hit rate del sub-agente 6. Genera un **resumen en lenguaje llano** y avisos (baja liquidez → NO FIABLE; faltan categorías → confianza recortada). Panel `app/components/PredictionCard.tsx` con selector de horizonte **10/20/30 días** y los **top 3 flows** por premium. El horizonte vive en `page.tsx` y lo comparten PredictionCard y ProWallsCard.
- **Gráficas propias en SVG (jul 2026):** `SimpleChart` y `ProWallsCard` YA NO usan TradingView. Motor propio: `lib/chartGeometry.ts` (PURO, tests en `chartGeometry.test.ts`) + `app/components/chart/PriceChart.tsx` (dibujo, un solo `<svg>`) + `ChartCrosshair.tsx` (crosshair + tooltip, sin zoom ni paneo). Antes había **dos sistemas de coordenadas** peleándose —el canvas de la librería y un overlay HTML que cazaba píxeles con `priceToCoordinate`/`priceScale().width()`— y de ahí venían el futuro comprimido y los targets encimados. Tres funciones: `smartDomain` (encuadre que cubre velas + 1σ + targets con peso, y estira al 2σ solo mientras las velas conserven el 45% del alto), `buildScales` (reparto **60% histórico / 40% futuro** con `xNow` explícito; recorta el histórico a las velas que caben con ancho ≥3px), `packLabels` (anti-colisión de los chips en dos barridas; guarda `yAnchor` en el precio real para la guía punteada). La clave del layout es el **gutter derecho de 132px** reservado a los chips — el eje de precio se rotula dentro del área de dibujo. Alturas responsivas por CSS (`clamp`), no números fijos. Bonus: al ser SVG, los screenshots del preview ya no salen negros. Spec: [docs/superpowers/specs/2026-07-24-graficas-propias-svg-design.md](docs/superpowers/specs/2026-07-24-graficas-propias-svg-design.md). **`ChartPanel` y `FlowPriceChart` siguen con `lightweight-charts`**, así que la dependencia se queda.
- **Movimiento esperado y probabilidad por nivel:** `lib/expectedMove.ts` (puro, tests en `expectedMove.test.ts`) — `expectedMove` (σ = S·IV·√(T/365), bandas 1σ/2σ lognormales), `conePoints` (cono que se abre en √t), `probAbove`/`probInBand`/`probTouch` (lognormal sin deriva; el toque usa principio de reflexión ≈2× la de cierre) y `levelProbabilities` (mezcla normalizada de probabilidad de toque × concentración de dinero del GEX → el % de cada banda). `predictionPath` traza la ruta al nodo imán y la **recorta al cono de 2σ**. `ProWallsCard.tsx` ya no dibuja burbujas: pinta **bandas de heatmap con su probabilidad** + cono 1σ/2σ + ruta esperada, todo dentro del SVG propio (ver la viñeta de gráficas propias).
- **GEX Heatmap por strike × vencimiento:** `lib/gexHeatmap.ts` → `gexHeatmap` (celda = GEX neto de un strike en una expiración; gamma Black-Scholes anclada a la gamma real de MarketSnack donde ese strike/vencimiento operó). Panel `app/components/GexHeatmapCard.tsx`: filas = strikes (±18 alrededor del spot), columnas = 8 vencimientos más cercanos, verde γ+ / morado γ−, columna Total por strike, fila del spot resaltada y la malla se auto-centra en el precio actual.
- **Contexto IV (categoría 5 del scorecard):** `lib/ivcontext.ts` → `ivContextScore` (2 parámetros: IV actual con pico en 40-60%, e IV Rank con pico en 16-30%; ver [SCOREDCARD/Contexto-IV.md](SCOREDCARD/Contexto-IV.md)). Panel en `app/components/IvContextCard.tsx`. **La IV sale de MarketSnack** (`implied_volatility`, en decimal → ×100), ponderada por premium. El **IV Rank** usa un proxy de volatilidad realizada del subyacente hasta que `lib/ivStore.ts` acumule 60 fotos diarias en `data/iv/{TICKER}.json` (ventana 365 días), momento en que el rank real lo reemplaza solo. Deriva también el **skew del frente** (evento inminente si > +10 pts) y el régimen (dormida/compresión/normal/expansión/inflada). Tests en `lib/ivcontext.test.ts`.
- **Inusualidad (categoría 3 del scorecard):** `lib/flow.ts` → `unusualityScore` (6 parámetros de griegos: tamaño, delta, theta%, gamma, single/multileg, vencimiento; ver [SCOREDCARD/Inusualidad.md](SCOREDCARD/Inusualidad.md)). Panel en `app/components/UnusualityCard.tsx`. Usa la misma ventana de 30 días que Convicción.
- **Convicción (categoría 2 del scorecard):** `lib/flow.ts` → `convictionScore` (spread, dominancia ask/bid, fuerza de ejecución; ver [SCOREDCARD/Conviccion.md](SCOREDCARD/Conviccion.md)). Panel en `app/components/ConvictionCard.tsx`.
- **Time & Sales (sub-agente Agresividad):** vista `app/flow/` + `app/api/flow/route.ts` (SSE). Fuente de datos = **MarketSnack** (producto propio del usuario), endpoint interno `GET app.marketsnack.com/api/flow_feed?filter[scope]=all&filter[symbol][]=<T>&period=5d` (paginado por `next_page_token`), auth por cookie de sesión en `MARKETSNACK_COOKIE` (.env.local, caduca). Da bid/ask + `side` (ask/bid/mid) + greeks + premium — resuelve la agresividad que Massive no autoriza. Lógica pura en `lib/{marketsnack,flow,occ}.ts` (parseo OCC, clasificación, flags de "interesante": ≥$1M, ≥$100K & |Δ|>.60, above ask/below bid, repetidas 5min, multileg). Tests en `lib/{occ,flow}.test.ts`.
- **Mapa de nodos GEX & predicción (PRO):** `lib/gex.ts` → `gexAnalysis` (puro, tests en `lib/gex.test.ts`). Massive no da gamma/IV, así que la IV se estima de la volatilidad realizada de las barras diarias, la gamma con Black-Scholes por contrato, y se **ancla** a la gamma real de MarketSnack donde el strike operó. GEX por strike = `gamma × OI × 100 × spot² × 0.01` (+call/−put); **concentración** = 0.6·|GEX| + 0.4·premium de trades reales en ese strike. Deriva **nodo principal/imán** (precio objetivo), **zona de inversión gamma** (flip), **régimen** (γ+ revierte / γ− amplifica) y **confianza** (nitidez + scores de Convicción/Estructura). `ProWallsCard.tsx` dibuja las velas y los muros con `PriceChart` (SVG propio) y realimenta la predicción a `PredictionCard.tsx`. Hereda la salvaguarda de liquidez (si es ilíquida → "no fiable"). El GEX se calcula una vez en `page.tsx`.
- **Burbujas de repetición:** `app/components/RepeatBadge.tsx` (`🔁 ×N`) marca los trades repetitivos (`flags.repeated` — mismo strike ≥3× en 5 min) en TradesFeed, ConvictionTransactions y UnusualityCard.
- **Gráfica Top 5 por Notional:** `app/ChartPanel.tsx` usa TradingView **Lightweight Charts** (`lightweight-charts`) para dibujar el candlestick del subyacente (barras de `GET /api/history` → `/v2/aggs/...`) con una price line por cada uno de los 5 contratos de mayor Notional, más leyenda (contrato, vencimiento, OI, Open Premium, Notional). Nota: el canvas de la gráfica sale negro en screenshots del preview (limitación de captura), pero renderiza bien en el navegador real; verificar por análisis de píxeles si hace falta.
- **API key:** en `web/.env.local` como `MASSIVE_API_KEY` (server-only, gitignored). **Nunca** exponerla al cliente ni publicarla.
- **Progreso en vivo:** el route handler `app/api/chain/route.ts` transmite los pasos por SSE; el frontend usa `EventSource`.
- **Cálculos:** en `lib/compute.ts` (funciones puras, con tests en `lib/compute.test.ts`, `npm test`).
- **BID real (Schwab) sobre Open Premium (jul 2026):** el plan actual de Massive sigue sin `last_quote` (bid/ask) ni greeks, así que `lib/schwab.ts` (OAuth2 contra la Trader API de Schwab, solo lectura — nunca toca endpoints de trading) trae el BID real por contrato y `applySchwabBid()` en `compute.ts` (puro, tests en `compute.test.ts`) lo cruza contra las filas de Massive por tipo+vencimiento+strike, sobrescribiendo `price`/`priceSource`/`openPremium` cuando hay match (`priceSource: "schwab_bid"`). Se pide con `fetchOptionChain(ticker, strikeCount=100)` — **sin acotar por `strikeCount` Schwab devuelve 502** en subyacentes líquidos (SPY, etc.), así que solo los strikes cercanos al spot llegan a cruzar; los muy OTM se quedan con el proxy de Massive (`last_trade.price ?? day.close ?? day.vwap`, en `contractPrice()`) como antes. Si Schwab falla o no está configurado, `app/api/chain/route.ts` lo atrapa en un try/catch silencioso — es un plus, no un requisito, la cadena sigue funcionando solo con Massive. Credenciales en `.env.local`: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `SCHWAB_REDIRECT_URI`, `SCHWAB_REFRESH_TOKEN`. El refresh token **caduca cada 7 días** (limitación de Schwab, no del proyecto) — renovar con `npm run schwab:auth` (`scripts/schwab-auth.mjs`, pide abrir la URL de autorización en un navegador con sesión real de Schwab y pegar de vuelta la URL de callback con el `code`).
- Detalle completo en [web/SPEC.md](web/SPEC.md).

- **Agente Principal (de Opciones):** primer agente y núcleo del sistema. Su especificación completa está en [Proceso Principal](Agente%20Principal/Proceso%20Principal.md).
- **Sub Agentes:** aún no definidos. La Tarea 4 (Buy Put) menciona "validación de contexto con **otros agentes**", así que el diseño contempla sub-agentes de confirmación (p. ej. contexto macro, técnico o de noticias).

## Responsabilidades del Agente Principal (resumen)

1. **Open Interest** por fecha de vencimiento, ordenado de mayor a menor.
2. **Volumen más alto** por expiración + almacenar **≥5 días** de histórico para detectar patrones recurrentes.
3. **Comparación sectorial:** identificar las 5 líderes del sector y determinar si el flujo es **sectorial o individual** (con etiqueta).
4. **Interpretación de Call/Put** (ver tabla abajo).
5. **Segmentación con fórmulas** (Open Premium, Notional Value).
6. **Evaluación de liquidez** del Option Chain con alertas.
7. **Monitoreo RSS** de noticias.

Detalle completo en [Proceso Principal](Agente%20Principal/Proceso%20Principal.md).

## Reglas de dominio (críticas)

### Interpretación de flujo
| Operación | Señal |
|-----------|-------|
| Buy Call | Direccional (alcista) |
| Sell Call | Resistencia / posible "muro" en órdenes grandes |
| Buy Put | Hedge **o** direccional → **requiere validación de contexto con otros agentes** |
| Sell Put | Soporte del subyacente |

### Fórmulas
```
Open Premium   = Open Interest × Precio del Contrato (Bid)
Notional Value = Open Interest × 100 × Strike        # zonas de relevancia si expira ITM
```

### Liquidez — **regla de seguridad prioritaria**
- Comparar el nocional promedio de 5 días de las **"7 Magníficas"** contra la cadena consultada.
- **Alertar "datos no fiables"** si: disparidad de liquidez **20–40%** vs. líderes, **o** liquidez **< 60%** del promedio.
- **Nunca recomendar operar una opción ilíquida.** Si la cadena es ilíquida, marcarla explícitamente; esto aplica también a la interpretación del **GEX**. Ver [Instrucciones y Referencias](Intrucciones%20Referencias.md).

### Noticias
Monitorear los feeds definidos en [RSS Feed](RSS%20Feed.md) (CNBC + Investing.com) y adjuntar noticias relevantes al panel de resultados.

## Convenciones para trabajar aquí

- **Idioma:** la documentación y los prompts del agente están en **español**. Mantener ese idioma salvo indicación contraria.
- **Fuente de verdad:** los `.md` son la versión editable; los `.pages`/`.pdf` son los originales de referencia. Al actualizar reglas, editar el `.md` correspondiente y reflejar el cambio aquí.
- **Al implementar código:** este directorio es documentación de diseño. Cualquier implementación (parser de option chain, motor de flujo, lector RSS) debe respetar las fórmulas y umbrales exactos de arriba.
- La regla de **liquidez/GEX** es una salvaguarda: ante la duda, no operar y avisar.
