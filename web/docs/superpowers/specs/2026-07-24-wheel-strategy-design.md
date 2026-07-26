# Módulo Wheel Strategy — screener de cash-secured puts

**Fecha:** 2026-07-24
**Estado:** diseño aprobado, pendiente de implementar
**Alcance:** v1 = screener. La segunda mitad de la rueda (covered calls) y el seguimiento de posiciones quedan fuera, con su propio spec futuro.

## 1. Qué resuelve

La Wheel genera ingreso vendiendo prima: vendes un cash-secured put sobre una acción que no te importaría poseer; si expira sin valor te quedas la prima y repites; si te asignan, compras las 100 acciones y pasas a vender covered calls hasta que te las llamen.

Este módulo responde **una** pregunta: *«¿qué put puedo vender hoy, cuánto efectivo inmoviliza y qué cobro por él?»*. No lleva seguimiento de posiciones ni recomienda operar — presenta candidatos con sus números y su riesgo escrito.

## 2. Hallazgos que condicionan el diseño

Verificados contra la API el 2026-07-24, no supuestos:

1. **`last_quote` (bid/ask) SÍ viene en `/v3/snapshot/options/{ticker}`.** 126/126 contratos lo traían, 98 con `bid > 0`. La nota de `CLAUDE.md` que dice lo contrario está obsoleta y **debe corregirse** como parte de este trabajo.
2. **`greeks` e `implied_volatility` NO vienen** (0/126). El delta hay que calcularlo.
3. **Los filtros de servidor funcionan.** `contract_type=put&expiration_date.gte=…&expiration_date.lte=…&strike_price.lte=…` devolvió 48 contratos en **una sola página**, sin `next_url`. Escanear 40 tickers cuesta ~40 peticiones ligeras, no 40 cadenas paginadas completas.
4. **No hay calendario de earnings.** `/benzinga/v1/earnings` → 403 (sin derecho en este plan); `/v1/reference/earnings/{t}` → 404. `/vX/reference/financials` → 200, con `filing_date` de reportes pasados.
5. **Las cotizaciones vienen marcadas `DELAYED`** en `last_trade.timeframe`. El bid mostrado es retrasado y la UI debe decirlo.

Consecuencia de (1) y (2): la prima sale de datos reales de mercado, y el delta de invertir Black-Scholes sobre esos mismos datos reales — mucho mejor que estimar IV desde volatilidad realizada.

## 3. Arquitectura

### Módulos nuevos

| Archivo | Responsabilidad | Depende de |
|---|---|---|
| `lib/blackScholes.ts` | Primitivas puras: `normCdf`, `bsPrice`, `bsDelta`, `bsGamma`, `impliedVol` | — |
| `lib/wheel.ts` | **Todo el criterio Wheel, puro y sin I/O**: presets, métricas, score compuesto, salvaguarda de iliquidez | `blackScholes`, `expectedMove`, `levels`, `ivcontext` |
| `lib/wheelUniverse.ts` | Lista curada de ~40 tickers con la razón de estar de cada uno (§ 4.1) | — |
| `lib/barsStore.ts` | Cache en disco de barras diarias por día de mercado (`data/bars/{TICKER}.json`) | — |
| `app/api/wheel/route.ts` | Orquesta el escaneo por SSE. **No decide criterio** | `massive`, `wheel`, `levels`, `ivcontext` |
| `app/wheel/page.tsx` | UI y estado de la vista | componentes |
| `app/components/WheelPresetCard.tsx` | Selector de preset + explicación | — |
| `app/components/WheelTable.tsx` | Candidatos en dos densidades (Estudiante / Pro) | — |

### Cambios en módulos existentes

- **`lib/massive.ts`** — nueva `fetchWheelChain(ticker, { dteMin, dteMax })` que usa los filtros de servidor del hallazgo (3). `fetchOptionChain` queda intacta.
- **`lib/gex.ts`** — `phi` y `bsGamma` se mudan a `blackScholes.ts` y `gex.ts` **las re-exporta**, así nada río abajo cambia y sus tests siguen pasando. Es la mejora mínima que sirve al trabajo actual; no se refactoriza nada más de `gex.ts`.
- **`app/components/NavTabs.tsx`** — cuarta pestaña `🎡 Wheel` → `/wheel` (hoy son Ticker, Ideas y Time & Sales).
- **`CLAUDE.md`** — corregir la limitación obsoleta sobre `last_quote` y documentar el módulo.

### Flujo de un escaneo

Por cada ticker del universo, con concurrencia limitada a 6:

```
1. fetchWheelChain      → puts en la ventana de DTE del preset, con last_quote y OI.
                          El spot sale del propio snapshot (underlying_asset.price).
2. barras diarias       → barsStore, cache en disco por día de mercado.
                          Alimentan findLevels (soportes) e ivContextScore (IV rank).
                          Hoy `fetchDailyBars` no tiene cache y lo llaman 5 rutas;
                          el store es nuevo y solo lo usa Wheel en v1.
3. financials           → cache en disco 30 días. La cadencia de filing_date
                          (~91 días) estima el próximo reporte.
4. lib/wheel.ts (puro)  → por strike: impliedVol(mid) → bsDelta → filtro por preset
                          → métricas → score compuesto → razones en llano.
```

**El saldo nunca llega al servidor.** Misma regla que `/ideas`: la ruta devuelve candidatos con métricas; la asequibilidad (`colateral ≤ efectivo`) se calcula en el cliente leyendo `tito.risk.*` de `localStorage`. Los alcanzables se ordenan arriba; el resto aparece abajo marcado «te faltan $X», para que se vea hacia dónde crece la cuenta.

## 4. Los tres presets

Viven en `lib/wheel.ts` como constante y se explican en la UI. No hay sliders: un novato no sabe dónde ponerlos.

| Preset | Delta objetivo | DTE | Cerrar al | Rolar a |
|---|---|---|---|---|
| Conservador | 0.10 – 0.20 | 30 – 45 | 50% de la prima | 21 DTE |
| Balanceado | 0.20 – 0.30 | 30 – 45 | 50% | 21 DTE |
| Agresivo | 0.30 – 0.40 | 7 – 21 | 50% | 7 DTE |

`Cerrar al` y `Rolar a` son guía mostrada en la ficha del candidato, no automatismos: v1 no sigue posiciones.

### 4.1 El universo curado

Vive en `lib/wheelUniverse.ts` como array de `{ ticker, tier, razon }`. Criterios de admisión, en este orden:

1. **Opcionabilidad real:** cadena con vencimientos semanales y OI agregado alto. Sin esto la Wheel no se puede ejecutar aunque la acción sea buena.
2. **Sería aceptable poseerla.** La Wheel te puede dejar con 100 acciones durante meses. Nada de nombres en quiebra ni biotecnológicas binarias por muy gorda que sea la prima.
3. **Cobertura de tres tramos de precio**, para que una cuenta pequeña tenga algo que hacer:
   - `barato` (< $15 → colateral < $1,500)
   - `medio` ($15 – $60)
   - `caro` (> $60, casi siempre fuera del alcance de cuentas chicas pero útil como referencia)
4. **ETFs de índice** aparte, por ser el caso de menor riesgo idiosincrático.

Lista inicial (se edita a mano; el `tier` es el tramo de precio):

- **ETFs:** SPY, QQQ, IWM, DIA, XLF, XLE
- **Caro:** NVDA, MSFT, META, NFLX, AVGO, COST, LLY
- **Medio:** AAPL, AMZN, GOOGL, TSLA, AMD, DIS, BAC, KO, PFE, INTC, UBER, COIN, MU, CVX
- **Barato:** F, SOFI, PLTR, NIO, WULF, RIOT, MARA, CCL, SNAP, T, VALE, HOOD, LCID

Son 40. El módulo no valida la lista contra el mercado: si un ticker deja de cumplir, se saca a mano y se anota por qué.

## 5. Matemática

Con `P` = prima por acción, `K` = strike, `S` = spot:

```
crédito      = P × 100
colateral    = K × 100
retorno      = crédito / colateral × 100        (= P/K × 100)
anualizado   = retorno × 365 / DTE
breakeven    = K − P
colchón      = (S − breakeven) / S × 100
prob. de expirar sin valor = probAbove(K)
```

`probAbove` sale de `lib/expectedMove.ts` (lognormal, ya testeado), alimentado con la **IV implícita de ese mismo strike** (§ siguiente) y `T = DTE / 365`. **No se usa el atajo `1 − |Δ|`**, que se desvía justo en los strikes lejanos del preset conservador.

### Delta e IV implícita

`mid = (bid + ask) / 2` → bisección sobre `σ ∈ [0.01, 5.0]`, tolerancia `1e-6`, máximo 60 iteraciones → IV implícita real del strike → `bsDelta`. Si el mid viola los límites de no-arbitraje y la bisección no converge, se cae a la IV estimada de `gex.ts` (`estimateIV`) y **la fila se marca como estimada**.

Tasa libre de riesgo: constante `RISK_FREE = 0.04` en código. A 30-45 días su efecto sobre el delta es de segundo orden; se documenta en el propio archivo.

### Cascada de prima

Cada fila muestra de dónde salió su precio — mismo patrón que `PriceSource` en la tabla de la cadena:

| Orden | Fuente | Etiqueta | Recorte |
|---|---|---|---|
| 1 | `last_quote.bid` | `bid` | ninguno |
| 2 | `last_trade.price` | `ultimo` | 10% |
| 3 | Black-Scholes | `modelo` | 15% |

Los recortes existen porque **vendes al bid**: un mid o un último precio te haría creer que cobras más de lo que cobrarías.

## 6. Score compuesto Wheel (0-100)

Cada componente devuelve puntos **y una frase en llano** que explica por qué.

| Componente | Pts | Bandas |
|---|---|---|
| Rendimiento anualizado | 30 | `<8%` → 5 · `8-15%` → 18 · `15-35%` → 30 · `35-60%` → 22 · `>60%` → 10 |
| IV Rank | 20 | `>70` → 20 · `50-70` → 16 · `30-50` → 10 · `<30` → 4 |
| Colchón hasta soporte | 25 | strike bajo soporte fuerza ≥35 → 25 · bajo soporte débil → 15 · sin soporte pero colchón >10% → 12 · strike por encima del soporte más cercano → 5 |
| Liquidez del contrato | 15 | `OI≥500 y spread ≤10%` → 15 · `OI≥250 y spread ≤15%` → 10 · `OI≥100 y spread ≤25%` → 5 |
| Earnings | 10 | reporte estimado después del vencimiento → 10 · cae dentro → 3 · cae dentro **y** el skew del frente lo confirma → 0 |

**Las bandas se evalúan en orden y gana la primera que se cumple.** Un contrato con `OI = 800` pero spread del 20% no cobra los 15 puntos de la primera banda: cae a la tercera y cobra 5.

**Los ETFs y cualquier ticker sin `financials` cobran los 10 puntos de Earnings** y no llevan bandera. Un ETF de índice no reporta resultados; tratarlo como «fecha desconocida» lo penalizaría por algo que no existe.

Dos decisiones que hay que dejar escritas porque son fáciles de romper después:

**El castigo por encima del 60% anualizado es deliberado.** Un screener de Wheel ingenuo ordena por prima y pone arriba justo las acciones que están a punto de desplomarse. Prima así de gorda significa que el mercado sabe algo que tú no.

**La banda de IV Rank va invertida respecto a `ivcontext.ts`.** Allí el pico está en 16-30 porque el resto del agente **compra** opciones y quiere vega barata; la Wheel **vende** y quiere lo contrario. Por eso `wheel.ts` lleva su propia banda y solo reusa `ivContextScore` para *obtener* el rank, nunca sus puntos.

## 7. Earnings: doble proxy

No hay calendario (hallazgo 4), así que se combinan dos señales y **la UI declara que es estimación**:

1. **Cadencia de `filing_date`** de `/vX/reference/financials` (~91 días entre reportes) → fecha estimada del próximo. Cacheado 30 días en disco.
2. **Skew del frente** que `ivcontext.ts` ya calcula: `> +10 pts` significa que el mercado está pagando por un evento inminente. Confirma (o desmiente) al proxy 1.

El candidato **no se descarta** por esto: se marca. Una fecha estimada mal no debe esconder una buena oportunidad.

## 8. Salvaguarda de liquidez

Regla crítica del proyecto ([Instrucciones y Referencias](../../../../Intrucciones%20Referencias.md)): ante la duda, no operar y avisar.

Un candidato sale `blocked` — **sin número de prima y fuera de la lista de operables** — si se cumple cualquiera de:

- no hay `bid` (o `bid = 0`),
- spread relativo `(ask − bid) / mid > 25%`,
- `OI < 100`.

Y todo el copy dice «candidato» y «si vendieras esto, cobrarías X» — **nunca «vende esto»**. El módulo presenta números y criterios; la decisión es del usuario.

## 9. UI

Cuarta pestaña `🎡 Wheel` en `NavTabs` → `/wheel`.

- **`WheelPresetCard`** — los 3 presets con su explicación en llano. Se persiste en `tito.wheel.preset`.
- **`RiskProfileCard`** — el mismo componente de `/ideas`, mismo `tito.risk.*`. No se duplica el capital.
- **Toggle Estudiante/Pro** leyendo el mismo `tito.view`.
- **`WheelTable`** en dos densidades:
  - *Estudiante:* tarjetas en español llano — «Put de F a $11, vence 14 ago (21 días). Cobrarías $32. Necesitas $1,100 en efectivo retenido. Empiezas a perder por debajo de $10.68. 82% de que expire sin valor.»
  - *Pro:* tabla densa con Δ, IV implícita, IV rank, OI, spread, colchón, anualizado y el desglose de los 5 componentes del score.
- **Fila expandible con los tres desenlaces**, con números concretos:
  1. Expira sin valor (prob X%) → te quedas la prima, se libera el colateral.
  2. Asignado (prob Y%) → compras 100 acciones a `K`, base ajustada `K − P`, y ahí empieza la otra mitad de la rueda.
  3. Se desploma → pérdida concreta si cae 20%. El riesgo real, escrito.
- **Barra de estado:** «Escaneadas 40 · 12 candidatos · 5 alcanzables con tu efectivo».
- **Limitación visible:** las cotizaciones son `DELAYED`; confirma el precio en tu broker antes de vender.

## 10. Errores

- Un ticker que falle (403, timeout, sin cadena) **no tumba el escaneo**: se reporta como paso SSE («AAPL: sin datos») y continúa.
- Si falla **más de la mitad** del universo, la UI lo dice en vez de mostrar una lista corta que parezca completa.
- Sin `MASSIVE_API_KEY` → error claro, igual que las rutas existentes.
- Cache en memoria de 5 minutos por `(preset, ventana DTE)`.

## 11. Testing

Puro, con `npm test`, siguiendo el patrón del resto de `lib/`. Sin tests de la ruta SSE ni de la UI.

**`lib/blackScholes.test.ts`**
- `normCdf` contra valores conocidos.
- Paridad put-call.
- Ida y vuelta: precio → `impliedVol` → `bsPrice` reproduce el precio.
- El caso que **no** converge (mid fuera de los límites de no-arbitraje).

**`lib/wheel.test.ts`**
- Cada preset filtra por su rango de delta y de DTE.
- La cascada de prima elige la fuente correcta y aplica el recorte correcto.
- `anualizado` y `breakeven` con números a mano.
- Las cinco bandas del score, **incluido el castigo por encima del 60%**.
- La banda de IV Rank invertida (rank alto puntúa más que rank bajo).
- Los tres modos de `blocked`: sin bid, spread ancho, OI bajo.
- Asequibilidad: colateral mayor que el efectivo → marcado, no filtrado.

## 12. Fuera de alcance en v1

Explícitamente, y cada uno merece su propio spec:

- Covered calls tras la asignación (la segunda mitad de la rueda).
- Seguimiento de posiciones abiertas y su ciclo.
- Rolar y cerrar automáticamente.
- Historial de resultados de la Wheel.

v1 responde «qué put vendo hoy y cuánto inmoviliza», y deja el terreno preparado para lo demás.
