# Agente Tito Metralleta

Sistema **multi-agente de análisis de flujo de opciones** (options flow). Identifica actividad inusual en el mercado de opciones, la interpreta y la convierte en tres escenarios de precio con probabilidad.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![Tests](https://img.shields.io/badge/tests-262%20passing-brightgreen)

## Qué hace

Buscas un ticker y el agente responde tres preguntas: **dónde está el dinero grande, qué está apostando, y si el precio le ha dado la razón históricamente.**

### Scorecard — 6 sub-agentes

Cada uno responde una pregunta y da una nota de 0 a 10. Juntos forman un puntaje de 100.

| # | Sub-agente | Pregunta | Peso |
|---|-----------|----------|------|
| 1 | Agresividad | ¿Compran al *ask* con fuerza? | 20% |
| 2 | Convicción | ¿Cuánto dinero real entró y con qué ejecución? | 20% |
| 3 | Inusualidad | ¿Es flujo anormal? (se puntúa con los griegos) | 20% |
| 4 | Estructura | ¿En qué strikes y vencimientos se acumula? | 15% |
| 5 | Contexto IV | ¿La volatilidad implícita está limpia o inflada? | 10% |
| 6 | Confirmación de Precio | ¿El precio valida o absorbe el flujo? | 15% |

### Prediction Pro

Junta los 6 sub-agentes, el mapa de gamma y la matemática de desviación estándar en **tres escenarios** — bear / base / bull — cada uno con precio objetivo, % de cambio, probabilidad de toque y el motivo que lo sostiene. Horizontes de 10, 20 y 30 días.

El resumen se escribe en lenguaje llano, por ejemplo:

> A 30 días el escenario base apunta hacia $300.00 (−6.2%), dentro de un rango esperado de ±22.2% (1σ). El dinero está 93% en puts: apuesta a la baja. Históricamente, cuando aparece flujo así en este ticker el precio lo confirmó el 46% de las veces.

### Otras piezas

- **Mapa de nodos GEX** y **heatmap por strike × vencimiento** — dónde el dealer estabiliza (γ+) o amplifica (γ−).
- **Soportes y resistencias** — cruce de pivotes reales del precio con los muros de opciones (vender calls = resistencia, vender puts = soporte).
- **Movimiento esperado** — cono 1σ/2σ que se abre en √t, con probabilidades lognormales por nivel.
- **Noticias en dos capas** — feeds macro (CNBC, Investing.com) + noticias por empresa con sentimiento, y una **bandera de contradicción** cuando el flujo y las noticias apuntan a lados opuestos.
- **Backtest de validación** — mide cuánto tardó en desarrollarse el movimiento tras cada flow, a favor y en contra.

## Stack

- **Next.js 15** (App Router) + TypeScript + React 19
- CSS plano — sin framework de estilos
- **TradingView Lightweight Charts** para las velas
- **vitest** — 262 tests sobre la lógica pura
- Server-Sent Events para el progreso en vivo de cada consulta

## Fuentes de datos

| Fuente | Para qué |
|--------|----------|
| [Massive](https://massive.com) (antes Polygon.io) | Option chain, barras del subyacente, referencia y noticias por ticker |
| MarketSnack | Time & Sales con bid/ask, griegos e IV por operación |
| [Charles Schwab](https://developer.schwab.com) (Trader API, opcional) | BID real por contrato para Open Premium (Massive no lo da en el plan actual); solo lectura |
| CNBC · Investing.com | Feeds RSS de contexto macro |

## Cómo correrlo

```bash
cd web
npm install
cp .env.example .env.local   # pon tus credenciales
npm run dev
```

Abre <http://localhost:3000>.

**Schwab (opcional, para BID real):** con `SCHWAB_CLIENT_ID`/`SCHWAB_CLIENT_SECRET` ya en `.env.local`, corre `npm run schwab:auth` — pide abrir una URL de autorización en tu navegador (con tu sesión real de Schwab) y pegar de vuelta la URL de callback. Genera `SCHWAB_REFRESH_TOKEN`. **Caduca cada 7 días** — repite el comando cuando la cadena vuelva a mostrar solo precios proxy de Massive.

```bash
npm test          # 299 tests
npx tsc --noEmit  # typecheck
```

## Estructura

```
├── Agente Principal/     # Especificación del agente (7 tareas)
├── SCOREDCARD/           # Un documento por sub-agente + sus fuentes
├── RSS Feed.md           # Fuentes de noticias
├── GUIA-ESTUDIANTES.md   # Guía didáctica del sistema
├── CLAUDE.md             # Guía técnica de implementación
└── web/                  # App Next.js
    ├── lib/              # Lógica pura (toda con tests)
    ├── app/api/          # Rutas SSE y JSON
    └── app/components/   # Paneles del dashboard
```

La lógica de negocio vive en `web/lib/` y es pura y testeable: `flow.ts`, `structure.ts`, `ivcontext.ts`, `validation.ts`, `gex.ts`, `gexHeatmap.ts`, `expectedMove.ts`, `prediction.ts`, `levels.ts`, `news.ts`.

## Reglas de dominio

| Operación | Lectura |
|-----------|---------|
| Buy Call | Direccional alcista |
| Sell Call | Resistencia / posible "muro" |
| Buy Put | Cobertura **o** direccional — requiere validación de contexto |
| Sell Put | Soporte del subyacente |

```
Open Premium   = Open Interest × Precio del Contrato
Notional Value = Open Interest × 100 × Strike
```

**Salvaguarda de liquidez:** si la cadena es ilíquida, el sistema marca los datos como no fiables y no recomienda operar. Aplica también a la lectura del GEX.

## Aviso

Material educativo y de investigación. **No es consejo financiero.** Las predicciones son estimaciones estadísticas basadas en datos de mercado; la gamma y la volatilidad implícita son estimaciones ancladas a datos reales cuando existen.
