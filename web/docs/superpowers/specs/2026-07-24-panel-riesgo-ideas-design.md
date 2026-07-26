# Panel de riesgo + screener de ideas tradeables (`/ideas`)

**Fecha:** 2026-07-24
**Estado:** implementado y verificado en vivo

## Problema

El dashboard responde muy bien a *"¿qué está pasando en NVDA?"* pero no a las dos preguntas que
siguen: **"¿qué puedo tradear hoy?"** y **"¿cuánto puedo poner sin volarme la cuenta?"**. Era
mono-ticker y ninguna cifra estaba referida al tamaño de cuenta, que es distinto para cada persona.

La observación que lo originó: *un flow inusual aparece y semanas después el movimiento pasa*. Eso ya
se medía en `lib/validation.ts` (`evaluateFlow` → MFE/MAE y `daysToMfe`) pero solo alimentaba un
score interno; nunca se mostraba como evidencia accionable.

## Decisiones

| Tema | Decisión |
|---|---|
| Filtro de theta | Dos capas en cascada: calidad por contrato, luego sizing contra la cuenta |
| Qué limita | `min(por prima, por quema de theta)`, reportando cuál frenó |
| Control | Un slider de tolerancia (% de cuenta) |
| Dónde | Página nueva `/ideas` |
| Universo | Todo el mercado, filtrado server-side por prima |
| Evidencia | Columna de historial por ticker (`validationScore`) |
| Perfil | `localStorage` — el saldo nunca llega al servidor |
| Datos no fiables | Bloqueo total del sizing, con el motivo |

## La matemática

```
presupuestoPrima  = accountSize × tolerancePct / 100      // el slider, 1-10%
presupuestoTheta  = accountSize × THETA_BUDGET_PCT / 100  // fijo 5%

costoPorContrato  = price × 100
díasQuema         = min(dte, horizonDays)
quemaPorContrato  = min(|theta| × 100 × díasQuema, costoPorContrato)

maxPorPrima = floor(presupuestoPrima / costoPorContrato)
maxPorTheta = floor(presupuestoTheta / quemaPorContrato)
límite      = min(maxPorPrima, maxPorTheta)
freno       = el que produjo el menor
```

### Por qué el theta tiene presupuesto propio

Éste fue el hallazgo que cambió el diseño, y salió de escribir los tests antes que el código.

El plan original daba a ambas restricciones **el mismo** presupuesto (la tolerancia). Pero la quema
está topada en el costo del contrato — una opción larga no puede perder más que su prima — así que:

```
quema ≤ costo  ⟹  presupuesto/quema ≥ presupuesto/costo  ⟹  maxPorTheta ≥ maxPorPrima  (siempre)
```

Con un solo presupuesto el `min` habría elegido la prima el **100%** de las veces y toda la capa de
theta habría sido código muerto. Dándole su propio presupuesto —anclado a la banda 3-5% de
`SCOREDCARD/Inusualidad.md`, que es de donde salió el requisito— el theta frena de verdad en cuanto
la tolerancia sube por encima del 5%. El caso trabajado (cuenta $10K, 4%) da el mismo resultado que
en el plan: 1 contrato, freno "prima".

### El tope de la quema

`min(quema, costo)` evita el absurdo de reportar una pérdida por decaimiento mayor que la pérdida
máxima real. Cuando la quema alcanza el costo se marca `fullyDecays` — señal útil ("se consume
entera dentro del horizonte"), no error.

## Arquitectura

- **`lib/risk.ts`** (puro, 22 tests) — `passesQualityFilter`, `isTradeableIdea`, `sizeFlow`,
  `budgetsOf`. Ningún acceso a red ni disco.
- **`lib/marketsnack.ts`** — `fetchMarketFlow` (sin `filter[symbol][]`) y `fetchFlow` comparten el
  cuerpo `paginate()`. El escaneo cross-ticker se verificó contra la API antes de diseñar nada.
- **`app/api/ideas/route.ts`** — SSE. Escanea → clasifica → capa 1 → historial → guarda. El sizing
  **no** se calcula aquí.
- **`app/ideas/page.tsx`** + `RiskProfileCard.tsx` + `IdeasTable.tsx`.

## Salvaguardas

- Iliquidez o falta de theta real → `blocked`, sin número de contratos. No se estima theta con
  Black-Scholes.
- El texto es siempre un **techo** ("tu límite es N"), nunca "compra N".
- Limitación declarada en la UI: el sizing usa el precio de ejecución del flow, no la quote viva
  (el feed no la entrega).

## Verificación

`npm test` → 317 pasando · `npx tsc --noEmit` → limpio.

Escaneo real (24 jul 2026): 400 operaciones de ≥$500K en 23 tickers, historial en 21. El filtro de
calidad tumbó 19 contratos por theta alto, 6 por vencer pronto, 4 sin theta y 80 por no ser inusual.
Slider, horizonte y ambas densidades verificados en vivo; preferencias persisten al recargar.

**Nota empírica:** con la tolerancia al 10% y horizonte de 30 días, el theta **no** llegó a frenar
ninguna fila — el θ% de los survivientes va de 0.1% a 1.4% (mediana 0.1%). Es coherente con el
dominio: el flujo institucional es de theta bajo por construcción, y la capa 1 ya expulsó las
loterías. El theta hace su trabajo como **filtro**, no como limitador de tamaño. El test unitario
confirma que sí frena cuando θ% ≈ 3.8%.

## Fuera de alcance

- Conexión a broker (Robinhood). La costura queda lista: `RiskProfile` tiene una sola
  implementación (manual + localStorage); un broker sería otra fuente del mismo tipo.
- Memoria/auto-evaluación del screener — se puede copiar el patrón de `MemoriaCard`.
