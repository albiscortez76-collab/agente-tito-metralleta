# Sincronización automática del watchlist con Robinhood

**Fecha:** 2026-07-24
**Estado:** aprobado, en implementación

## Problema

Hoy marcas ⭐ en `/ideas` y el contrato se queda en `data/outbox.json` esperando a que
un agente lo empuje a mano. Quieres que llegue solo a tu watchlist de opciones de
Robinhood.

## Por qué el servidor web no puede hacerlo (restricción, no pereza)

Se evaluó y se descartó la vía obvia —que Next.js llame a Robinhood— porque **no existe**:

- Robinhood **no tiene programa OAuth público para acciones ni opciones**. Su única API
  pública documentada es la de cripto (key desde su portal). Sus ToS prohíben el acceso
  automatizado por endpoints no oficiales. No se puede registrar Tito como app OAuth.
- El único token que existe lo emitió Robinhood **a Claude**, no a esta app, y vive en el
  keychain gestionado por Claude Code. Reutilizarlo desde el servidor sería: un token
  ajeno a su propósito, que caduca sin que controlemos su renovación, **de un solo
  usuario** (el ⭐ de cualquier estudiante escribiría en la cuenta de Víctor), y con
  lectura de todas las cuentas, posiciones e historial de órdenes metida en un proceso web.
- Los agregadores (Plaid, SnapTrade) hacen OAuth contra Robinhood pero exponen
  posiciones, saldos y órdenes — **no el watchlist**. Herramienta equivocada.

**Consecuencia asumida:** esto es una comodidad de la máquina de Víctor. Un estudiante sin
OAuth propio se queda en el flujo de enlace/copiar, y la UI no finge lo contrario.

**Verificado (2026-07-24):** el OAuth de Robinhood **sí sobrevive a una ejecución
headless**. `claude -p` con `--allowedTools mcp__robinhood-trading__get_option_watchlist`
resolvió y llamó la herramienta sin sesión interactiva (`OK:0`). Es la precondición de
todo este diseño.

## Arquitectura

El puente existente (navegador → `/api/watchlist` → `outbox.json`) no cambia. Lo nuevo es
quién vacía la cola: un cron de Claude Code.

```
⭐ en /ideas ──► POST /api/watchlist ──► outbox.json   (ya existe)
                                            │
                     cada 15 min, cron de Claude Code:
                                            ▼
   GET /api/watchlist?broker=robinhood   → pending[]
   contractQuery() → get_option_instruments → instrument id
   get_option_watchlist  → descarta lo que ya está      ← idempotencia
   add_option_to_watchlist(ids)
   POST /api/watchlist {synced:[...]} | {failed:[...]}
```

### Dos decisiones no obvias

**El drenador habla por HTTP con el servidor, no lee `outbox.json` del disco.** Mantiene
**un solo escritor** del archivo (Next.js). Si el cron escribiera a la vez que el servidor
atiende un ⭐, habría escritura corrupta. Con el servidor caído el cron sale sin hacer
nada; la cola persiste en disco y entra al siguiente tick. Cero pérdida.

**Consulta `get_option_watchlist` antes de añadir.** Idempotencia por construcción: si el
`POST synced` falla tras haber añadido, el siguiente tick ve el contrato ya presente y
solo marca, sin duplicar en la cuenta.

## Salvaguardas

Se pasa de "Claude pregunta antes de escribir" a "una máquina escribe en tu bróker sin que
nadie mire". Cuatro topes:

1. **Lista blanca literal de herramientas.** El cron corre con `--allowedTools` limitado a
   `get_option_instruments`, `get_option_watchlist`, `add_option_to_watchlist`.
   `place_option_order` y los `cancel_*` no están, así que el proceso es **incapaz** de
   colocar una orden. Lo aplica el harness, no la buena voluntad del modelo.
2. **Tope de 10 contratos por ejecución.** Un bug en la UI que encole 400 ideas no se
   convierte en 400 escrituras.
3. **Solo añade, nunca borra** del watchlist de Robinhood. Desmarcar ⭐ saca de la cola;
   lo ya sincronizado lo quitas tú. Mejor que sobre a que un bug borre lo tuyo.
4. **Bitácora** en `data/sync-log.jsonl`: una línea por push (fecha, contrato, id, resultado).

Coste: el drenador corre con **Haiku** y sale de inmediato si `pending` viene vacío.

## Cambios en el código existente

### 1. Arreglar el `DELETE` (bloqueante de seguridad)

`app/api/watchlist/route.ts` filtra por `outboxKey(i) !== symbol`. Para las filas viejas
de solo-ticker `outboxKey` vale el **ticker**, así que `"WULF270115C00020000" !== "WULF"`
y la fila **nunca se borra** — por eso SPXW y SPY siguieron encoladas tras desmarcarlas.

Con el drenador activo, una fila fantasma es **una escritura no supervisada en la cuenta
real**. Deja de ser cosmético.

Función pura nueva en `lib/watchlist.ts` (la ruta solo la llama):

```ts
removeFromOutbox(items, { symbol, ticker }, broker)
// quita si outboxKey(i) === symbol            → filas nuevas, por contrato
//     o si !i.symbol && i.ticker === ticker   → filas viejas de solo-ticker
```

La segunda condición mata la fila legado **sin arrastrar los otros strikes del mismo
subyacente**: dos WULF distintos siguen siendo dos trabajos. El cliente
(`app/ideas/page.tsx`) pasa a mandar `symbol` **y** `ticker` al desencolar con granularidad
`contracts`.

### 2. Rechazar en la puerta lo insincronizable

Si el bróker es `contracts` y llega un contrato sin `strike` o sin `expiration`, `POST`
devuelve **400**. Hoy se acepta y el fallo aparece mucho después en el drenador sin decir
por qué — justo lo que dejó WULF atascado. Fallar fuerte y temprano.

### 3. Estado terminal en la cola

`OutboxItem` gana `failedAt` y `failReason`; `pendingOutbox` los excluye. Nueva pura
`markOutboxFailed(items, keys, broker, reason, now)` y rama `{failed}` en el `POST`.

**Sin contador de reintentos ni backoff**: cuando `contractQuery()` devuelve `null` o
Robinhood no encuentra el instrumento, ya se sabe que no se resolverá nunca; un contador
solo añadiría maquinaria para redescubrir lo mismo 5 veces. Los fallos transitorios
(servidor caído, red) no marcan nada y se reintentan solos al siguiente tick.

## Errores

| Situación | Qué hace |
|---|---|
| Servidor web caído | Sale en silencio. La cola aguanta en disco. |
| Contrato irresoluble (sin strike, vencido) | `failedAt` + motivo. No se reintenta. |
| Robinhood da error transitorio | No marca nada. Reintenta al siguiente tick. |
| Ya está en el watchlist del bróker | Marca `synced` sin volver a añadir. |
| Más de 10 pendientes | Empuja 10, deja el resto, lo registra. |

## UI

`WatchlistCard` añade dos cosas pequeñas: **hora del último push** y los **fallidos con su
motivo**, con un "vuelve a marcar ⭐" que los reencola con el contrato completo.

## Tests

En `lib/watchlist.test.ts` (funciones puras, como el resto):

- `removeFromOutbox` con fila legado de solo-ticker.
- `removeFromOutbox` sin arrastrar strikes hermanos del mismo ticker.
- `pendingOutbox` excluyendo los fallidos.
- `markOutboxFailed` no pisa los ya sincronizados.
- Rechazo al encolar sin strike con granularidad `contracts`.

## Cadencia

Cada 15 min, lunes a viernes 9:00–17:30 ET. Cubre la franja en que se miran ideas sin
dejar 96 ejecuciones diarias en vacío. Es una línea de cron si luego se quiere 24/7.

## Fuera de alcance

- Sincronizar para estudiantes (imposible sin OAuth propio, ver arriba).
- Borrar del watchlist del bróker.
- Colocar órdenes. Tito nunca coloca una orden.
- Estrategias de varias patas: Robinhood no las acepta por API.
