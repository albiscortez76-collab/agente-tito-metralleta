# Watchlist ⭐ → broker: sincronización real con Robinhood y lista para el resto

**Fecha:** 2026-07-24
**Estado:** aprobado, en implementación

## El problema

En `/ideas` marcas una idea con ⭐ y se guarda en Tito. Ahí se acaba. La pregunta del
usuario fue: *"si marco una empresa con la estrella, ¿puedes añadirla a mi Robinhood?
Y como esto va para los estudiantes, ¿que sincronice con el broker que cada uno use?"*

## Lo que se investigó antes de diseñar

Tres hechos cambiaron el diseño. Se verificaron, no se asumieron.

**1. SnapTrade no tiene watchlist.** Se descartó como capa multi-broker. Su índice
legible por máquina (`docs.snaptrade.com/llms.txt`) expone Authentication, Connections,
Account Information y Trading. No hay ningún endpoint de watchlist, lista o símbolos
guardados. Además su integración con Robinhood es **solo lectura**: no coloca órdenes.
Montar OAuth + cuentas de usuario + un proveedor de pago habría dejado la estrella sin
nada que llamar.

**2. El MCP de Robinhood sí escribe watchlists — con una salvedad.** El endpoint oficial
es `https://agent.robinhood.com/mcp/trading` (OAuth, sin contraseñas). La documentación
propia de Robinhood confirma que un agente tiene acceso de **lectura** a "todos los
detalles de tus watchlists y scans"; las herramientas `get_watchlists` / `add_to_watchlist`
(escritura) vienen de reportes de terceros, no del doc oficial.

> **Riesgo declarado.** El primer paso de implementación es conectar el MCP y listar sus
> herramientas reales. Si `add_to_watchlist` no existe, Robinhood baja a broker de tipo
> `link` — un cambio de una línea en el registro, por eso el registro existe.

Agentic Trading está en beta **solo con acciones**, así que la granularidad de hoy es el
subyacente (`WULF`), no el contrato (`$20C 15-ene-2027`).

**3. Los deep links de broker: la mitad no funcionan.** Se probó cada URL con `curl`
(código HTTP + si la página realmente renderiza el ticker):

| Broker | URL | Resultado |
|---|---|---|
| Robinhood | `robinhood.com/stocks/{T}` | ✅ 200, página real |
| Schwab / thinkorswim | `schwab.com/research/stocks/quotes/summary/{T}` | ✅ 200 y renderiza el ticker |
| Fidelity | `digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol={T}` | ✅ 200 |
| Tastytrade | `my.tastytrade.com/app.html#/trade/{T}` | ⚠️ 200, pero es el shell de una SPA con ruta en hash — no verificable por HTTP |
| Webull | `webull.com/quote/{exchange}-{t}` | ❌ exige prefijo de bolsa (`nasdaq-wulf` 200, `nyse-wulf` 404) y el feed de Tito no trae la bolsa |
| Interactive Brokers | `interactivebrokers.com/en/index.php?f=2222&symbol={T}` | ❌ 200 pero es una página genérica, no enruta por símbolo |

Webull e IBKR **no reciben deep link**: reciben copiar-al-portapapeles. Es la degradación
honesta — el proyecto ya sigue la regla de que la UI diga la verdad en vez de fingir.

## Diseño

### 1. El watchlist se muda a `localStorage`

Hoy vive en `data/watchlist.json`, un archivo único en el servidor. En un despliegue
compartido con estudiantes eso significa **un solo watchlist para toda la clase**, y el
saldo de cuenta y el sizing de cada uno aterrizando en el servidor.

Se muda a `tito.watchlist` en el navegador, siguiendo la regla que el perfil de riesgo ya
sigue (*"el saldo nunca llega al servidor"*). Por estudiante, privado, sin autenticación.

- **Contrapartida aceptada:** no hay sincronía entre dispositivos y limpiar el navegador lo borra.
- **Migración:** si existe `data/watchlist.json` (tu máquina), se importa una vez y se marca como migrado.

### 2. El registro de brokers gana `kind`

`BrokerAdapter` crece con `kind: "mcp" | "link" | "copy" | "none"` junto al `granularity`
que ya tiene. Añadir un broker sigue siendo una entrada en el array.

```ts
interface BrokerAdapter {
  id: string;
  name: string;
  kind: SyncKind;
  granularity: BrokerGranularity;
  quoteUrl?: (ticker: string) => string;  // solo kind "link"
  caveat?: string;
}
```

### 3. Robinhood: la vía real

La app web **no puede** ejecutar el OAuth del MCP — ese flujo vive en Claude Code. Así que
"Conectar Robinhood" en la UI es un traspaso guiado, no un login en página:

```
claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading
```

…y luego `/mcp` → autenticar. La tarjeta muestra el comando con botón de copiar.

Al marcar ⭐ con Robinhood elegido, la app hace POST **solo del ticker** a un buzón de
salida en el servidor (`data/outbox.json`). Ni strike, ni sizing, ni saldo: nada sensible
sale del navegador. El buzón existe únicamente como puente navegador → agente. Le pides
"sincroniza" en el chat, el agente lo vacía con `add_to_watchlist` y marca las entradas.

### 4. El resto: lista, enlace y copiar

Cada broker `link` produce un "abrir en \<broker\>" por ticker. Los `copy` producen la
lista de tickers separada por comas al portapapeles. Un toque, sin OAuth, sin proveedor.

### 5. Operar es un no-objetivo explícito

La app nunca coloca una orden, y la UI lo dice con todas las letras. El estudiante que
quiera operar configura su propio Claude; el panel de conexión le explica cómo.

### 6. Pruebas

`watchlist.test.ts` se extiende sobre la superficie pura: búsquedas en el registro,
`payloadFor` por `kind`, deduplicado del buzón y las plantillas de URL. El almacenamiento
y las llamadas MCP quedan fuera de la capa pura, como ya hace todo `lib/`.

## Límites declarados

- Robinhood sincroniza el **subyacente**, no el contrato, hasta que habilite opciones.
- La escritura en watchlist depende de que `add_to_watchlist` exista de verdad (ver riesgo arriba).
- El watchlist no cruza dispositivos.
- Webull e IBKR son copiar-y-pegar, no enlace.
