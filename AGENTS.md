# spacecraft-mcp — AGENTS.md

> Proyecto independiente. Abrir opencode con cwd en `spacecraft-mcp/`, nunca en `Projects/`.
> Stack: Cloud Functions for Firebase 2nd gen (Node 20, ESM) — servidor MCP stateless + backends de chat admin/taller con function-calling (Gemini/Claude según `AI_PROVIDER`).

## Qué vive acá
- `functions/index.js` → `mcp` (StreamableHTTP stateless, SOLO LECTURA: 20 tools; la
  escritura se filtra por denylist `WRITE_TOOL_NAMES`) + `askAdmin` y `askTaller`
  (catálogos completos, con confirmación en el SYSTEM_PROMPT).
- `functions/ask-admin.js` → `askAdmin` (alcance dueño de flota; aprobar presupuestos queda fuera a propósito).
- `functions/ask-taller.js` → `askTaller` (alcance staff de taller; sin acciones destructivas).
- `functions/lib/` es la ÚNICA copia: `navespace-tools`, `taller-tools` (reusa por referencia, no duplica), `ai-provider`, `chat-utils`, `damage-matcher`.

## Cómo correr
- `npm.cmd install` en `functions/`, `npm.cmd run serve` → emulador `:5001`.
- Para persistir uso en local: `firebase.cmd emulators:start --only functions,firestore`
  (Firestore en `:8085`; requiere Java). Con solo `functions`, el uso va solo al log.
- Los widgets apuntan al emulador en local: `http://localhost:5001/spacecraft-mcp/us-central1/askAdmin|askTaller`.
- Backends en Render free tier (cold start ~60s): admin `spacecraftsystem.onrender.com/api`, taller `spacecraft-taller-backend.onrender.com/api`.

## Uso de IA (comparar pre/post-harness)
- Cada request a `askAdmin`/`askTaller` guarda un documento en Firestore (`ai_usage`):
  `harnessPhase`, endpoint, provider, modelo, tokens normalizados (`usage.{input,output,total,cached}`),
  latencia, longitud de pregunta y métricas del borrador. Sin PII (no se guarda el texto).
- Requiere crear la base Firestore en el proyecto `spacecraft-mcp` (consola → Firestore →
  crear base de datos). Si no existe, el chat sigue funcionando y el uso queda solo en el log.
- Comparar en consola Firestore (o SDK): filtrar `ai_usage` por `harnessPhase ==
  pre-harness|post-harness` y promediar `usage.total`, `latencyMs` y tasa de
  `budgetDraft.resolvedWithoutLlm`. Cambiar la fase con `HARNESS_PHASE=post-harness` en `.env`.

## Deploy
- Crear antes el proyecto Firebase `spacecraft-mcp` (consola o `firebase projects:create`) y `firebase.cmd use spacecraft-mcp`.
- `firebase.cmd deploy --only functions`. Copiar las env vars (`AI_PROVIDER`, claves de Gemini/Claude) desde los proyectos anteriores — nunca commitear `.env`.

## No hacer
- No duplicar tools: las 6 de lectura del taller se reusan desde `navespace-tools.js` (si cambian ahí, cambian en todos lados).
- No exponer aprobar-presupuesto/cobros en ningún catálogo.
- No commitear `.env`, `node_modules/`, `.firebase/`.
