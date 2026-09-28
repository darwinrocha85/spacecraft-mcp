# spacecraft-mcp

Servidor MCP + asistentes con IA del ecosistema naveSpace: un solo proyecto de Cloud
Functions que expone las herramientas una sola vez y las sirve a los chats del panel admin
y del taller — y a cualquier cliente MCP externo (Claude Desktop, Code...).

## Qué expone
| Endpoint | Qué es |
|---|---|
| `mcp` | Servidor MCP stateless (StreamableHTTP, sin sesión), **solo lectura**: 20 tools. La escritura se filtra por denylist (`WRITE_TOOL_NAMES`, 17 fuera). |
| `askAdmin` | Chat del panel admin: opera la flota en vivo (28 tools), pide confirmación antes de impacto real. |
| `askTaller` | Chat del taller: ciclo de reparación y presupuestos (15 tools, sin destructivas). |

Los frontends ([admin](https://github.com/darwinrocha85/spacecraftSystem-frontend),
[taller](https://github.com/darwinrocha85/spacecraft-taller-frontend)) son clientes delgados:
llaman por URL directa, sin `functions/` propia.

## Stack
Cloud Functions for Firebase 2.ª gen (Node 20, ESM), `@modelcontextprotocol/sdk`,
Groq/Gemini/Claude según `AI_PROVIDER` (default prod `gemini-3.8-flash` vía `GEMINI_MODEL`),
Firestore (`ai_usage`: un documento por request con modelo, tokens y latencia, etiquetado
pre/post-harness vía `HARNESS_PHASE`).

## Cómo correr en local
```powershell
cd functions
npm.cmd install
Copy-Item .env.example .env   # completar claves reales
npm.cmd run serve             # solo Functions :5001
```
Para persistir uso en local (Firestore `:8085`, requiere Java 21+):
```powershell
firebase.cmd emulators:start --only functions,firestore
```
Sin emulador de Firestore, el uso va solo al log. Para apuntar a backends locales en vez de
Render, crear `functions/.env.local` con `NAVESPACE_API_BASE=http://localhost:8080/api` y
`TALLER_API_BASE=http://localhost:8001/api` (nunca se deploya).

## Deploy
```powershell
firebase.cmd deploy --only functions   # proyecto spacecraft-mcp (Blaze)
```

## Repos relacionados
Orquestador: [spacecraftSystem](https://github.com/darwinrocha85/spacecraftSystem).
Taller: [spacecraft-taller-backend](https://github.com/darwinrocha85/spacecraft-taller-backend).
