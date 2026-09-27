# Harness (local + web) — fases

> Provider principal: Groq (`AI_PROVIDER=groq`). La comparación pre/post sale
> de la colección `ai_usage` (`harnessPhase`, ver `functions/lib/usage-store.js`).
> Hay DOS harness (ver sección): local (emulador + backends `:8080`/`:8001`) y
> web (Firebase + Render + Firestore).

## Estado (2026-09-27, noche)

- HECHO harness v1 (código, sin números todavía):
  - Fase 2 router por familias (`functions/lib/harness-router.js`, Opción B):
    admin 28→4-12 tools, taller 15→4-7 por request; fallback full si no matchea.
    Desempate: "nave/naves/flota" genéricos no suman fleet si hay familia específica.
  - Fase 2b L1 exacto (`functions/lib/harness-cache.js`): pregunta→{tool,args}, la
    tool se re-ejecuta (dato fresco), 0 tokens LLM en hit. Seeds + aprendizaje de
    turnos de 1 sola tool; namespaces por endpoint; miss forzado
    (fresco/hoy/disponibilidad/ventas/saldos); mem + SQLite local (`node:sqlite`,
    sin deps) + Firestore `ai_cache` en prod. No invalida en escritura a propósito
    (cachea el mapeo, no los datos).
  - `runAssistant` reporta `toolCalls[]` (con args); `ai_usage.harness` lleva
    family/full/subset/cacheHit/cacheLevel/tokensAvoided; respuestas traen
    `harness{...}` + `toolCalls[]` para el bench.
  - Bench (`functions/bench/`: questions.json 7+7, bench.mjs → CSV + resumen +
    `--compare`, `npm run bench`); RTK solo para comprimir logs del bench.
  - Verificado sin cuota: router (12 preguntas), L1 (seed/learn/aislamiento/TTL),
    SQLite cross-process, pipeline completo en runtime con stub (hit L1 + miss con
    router + 400 + fallback). Caza: `usage`/`model` undefined rompían TODOS los
    docs de hits L1 y mocks en Firestore (misma clase que el bug de budgetDraft).
- Decisión previa vigente: Groq principal local+web, `gemini` fallback ante 429,
  RTK descartado para el backend, Ollama descartado.
- Medición prod 2026-09-27 (bench 14 preguntas fijas en orden, Groq qwen3.8-27b):
  PRE 56934 tokens (admin 35002, taller 21932) → POST 16344 (admin 10706, taller
  5638) = **71.3% ahorro**, 14/14 OK, hit-rate L1 0.43 (6 seeds; sube con ai_cache).
  p50 admin 1310→1136ms, taller 1010→1031ms. CSVs en functions/bench/results-*-prod-*
  (reservados para la sección harness del portfolio). Detalle: "lista las naves"
  post cayó a LLM (2294 tok, fleet) porque el hit L1 encontró el backend en cold
  start y el fallback funcionó como diseñado; 3 preguntas admin con cold start de
  Render (71s/22s/32s) inflan el avg pero no el p50.
- Bugs reales cazados 2026-09-28 (reporte: "enviar serenity al taller" devolvía
  "No pude obtener esa información"):
  1. `runGroq` leía `finish_reason` del message (vive en el choice) → undefined ≠
     "tool_calls" → el loop cortaba en la 1ª vuelta SIEMPRE. Desde que Groq es
     principal (2026-09-27), NINGUNA tool se ejecutó en prod: toda respuesta fue
     directa del modelo o fallback. Los números del bench (tokens) siguen valiendo;
     la calidad no. Fix: se confía en presencia de `tool_calls` + `maxRounds`.
  2. El tracking `toolCalls` compartía array con los `tool_calls` del modelo:
     iterar el array que crece = loop infinito + OOM, y serializar entradas de
     tracking sin `id` = 400 de Groq. Fix: `modelCalls` vs acumulador separados.
  3. Efecto colateral de (2): `result.toolCalls` de Groq siempre era `[]` → L1
     nunca aprendió en prod (el hit-rate 0,43 del bench fue solo seeds) y el bench
     contaba 0 tool-calls. Ahora acumula bien.
  Verificado con Groq real + stub: 3 tools (list→catalog→impact) y flujo de
  confirmación correcto. Deployado 2026-09-28 noche, pendiente re-test en prod
  cuando libere cuota (los probes saturaron los 7000 ITPM).
- Medición 2026-09-27 (logs prod): cada pregunta gasta ~5.000 input tokens;
  Groq gratis da 7.000 ITPM → 2 preguntas seguidas = 429. El harness no es
  opcional con estos límites: es lo que multiplica las consultas/día.
- Fix deployado 2026-09-27: `usage-store.js` ya no manda `budgetDraft: undefined`
  (Firestore rechazaba TODOS los docs de `ai_usage`; ahora sí se persisten).

## Dos harness: local vs web (decisión 2026-09-27)

Un solo diseño, dos instalaciones. El código del harness es el mismo
(router + L1 viven antes de `runAssistant`); cambia dónde guarda y qué niveles
usa:

| | Harness LOCAL | Harness WEB |
|---|---|---|
| Dónde corre | Emulador (`npm.cmd run serve`) | Firebase (`firebase deploy`) |
| Backends | Locales `:8080`/`:8001` (sin cold start) | Render (cold start ~60s) |
| Storage caché | SQLite o memoria (cero infra, se borra) | Firestore `ai_cache` (persiste, mide hit-rate) |
| Niveles | L1 exacto + L2 semántico (pruebas) | L1 exacto + matching por texto estilo `damage-matcher.js` (sin embeddings pagos) |
| Métricas | Log + `ai_usage` del emulador Firestore | `ai_usage` prod (`cacheHit`, `tokensAvoided`) |
| Para qué | Medir % de ahorro sin ruido | Ahorrar cuota real (20+ consultas/día) |

Lo que NO va en ninguno: RTK (Rust Token Killer) — comprime salida de
terminal para agentes de código, no system/tools/results del backend.
Lo equivalente en el backend es la poda de resultados (ya hecha, 6000 chars)
+ resumir tool-outputs (Fase 2c pendiente).

## Punto de partida (ya existe, fase pre-harness)

- `functions/lib/ai-provider.js`: providers `gemini`/`claude`/`groq`, loop de
  function-calling compartido, `MAX_FUNCTION_CALL_ROUNDS=3`,
  `MAX_HISTORY_TURNS=6`, poda a ~6000 chars por resultado, prompt caching en
  Claude. El prefijo estático (system + catálogo completo de tools) se reenvía
  íntegro en cada vuelta — ahí está el gasto a recortar.
- `functions/lib/usage-store.js`: un doc por request en `ai_usage` con
  `usage.{input,output,total,cached}`, `latencyMs`, `budgetDraft.*`.
  `HARNESS_PHASE=pre-harness` por default (`.env.example:20`).
- `functions/.env.local`: backends locales (`:8080` admin, `:8001` taller).
  Usarlos para el bench evita el ruido del cold start de Render (~60s).

## Fase 0 — Modelo local (DESCARTADA 2026-09-27: se usa Groq en nube, sin Ollama)

1. Instalar Ollama (Windows): https://ollama.com/download, luego
   `ollama pull <modelo>` y `ollama serve` (escucha en `:11434`).
2. Verificar: `ollama list` + `curl http://localhost:11434/api/tags`.

Opciones de modelo (16 GB RAM, ~6 GB libres → tope práctico 8B en Q4):

| Opción | Modelo | Peso aprox. | Por qué |
|---|---|---|---|
| A (recomendada) | `qwen2.5:7b-instruct-q4_K_M` | ~4.7 GB | Buen tool-calling + español, entra en RAM |
| B | `llama3.1:8b-instruct-q4_K_M` | ~4.9 GB | Alternativa si Qwen falla con alguna tool |
| C (ultra-light) | `llama3.2:3b-instruct-q4_K_M` | ~2 GB | Rápida pero sigue peor las tools; solo para humo |
| D | `mistral:7b-instruct-q4_K_M` | ~4.4 GB | Buena, español algo peor que Qwen |

Criterio: el bench de tokens vale igual con cualquiera; la calidad de
seguimiento de tools se compara entre A y B si hay tiempo.

## Fase 1 — Provider `groq` en `ai-provider.js` (HECHA 2026-09-27, smoke OK)

- Env: `AI_PROVIDER=groq`, `GROQ_API_KEY` (console.groq.com), `GROQ_MODEL`
  (default `qwen/qwen3.8-27b` — el `llama-3.3-70b-versatile` original Groq lo
  dio de baja; su catálogo rota, pisar por env sin tocar código).
- Implementado con fetch directo a `https://api.groq.com/openai/v1/chat/completions`
  (sin SDK nuevo), mismo loop de tools; `geminiParameters` sirven tal cual.
- Smoke test 2026-09-27 OK: `provider=groq`, respuesta correcta, `usage`
  normalizado (`prompt/completion/total_tokens`).
- `gemini` queda como fallback ante 429 (`isQuotaError` ya lo detecta).
- (La key vieja de Mistral se eliminó del archivo junto con la cuenta.)

## Fase 2 — Harness v1 = recortar el prefijo (opciones)

Idea: hoy cada request manda system completo + catálogo completo (20+ tools)
en cada vuelta. El harness manda solo lo necesario según intención.

- **Opción A (mínima):** filtro de tools por keywords, sin LLM. Ej. "stock" →
  solo tools de parts; "entrada" → solo tickets; si no matchea, catálogo
  completo (fallback seguro). + system prompt slim por endpoint.
- **Opción B (recomendada):** router determinístico (regex/keywords) →
  subset por familia (admin: flota/museo/teatro/envío; taller:
  reparación/stock/presupuesto) → el modelo solo ve 5-8 tools por request.
- **Opción C (full):** B + caché en proceso de catálogos + truncado adaptativo
  + extender el patrón `draft_budget_from_damage_description` (resolver sin
  LLM lo que se pueda por texto).

Se activa con `HARNESS_PHASE=post-harness`, sin tocar código entre corridas.

## Fase 2b — Caché de consultas estilo GPTCache (definición, sin código aún)

Idea: si la pregunta ya se resolvió antes, no llamar al modelo: se responde
desde la base de respuestas guardadas. Ej. "necesito todos los carros" /
"dame las naves" → ya se sabe que es `list_spacecrafts` sin args, se ejecuta
la tool directo o se devuelve el backend cacheado, 0 tokens de LLM.

Posición en el pipeline: `sanitizeHistory` → chequeo de alcance → **lookup en
caché** → (hit: responder + loguear) / (miss: router de Fase 2 → LLM → guardar
si califica).

Dos niveles:

- **L1 exacto/normalizado (determinístico, sin riesgo):** minusculas, sin
  acentos, espacios colapsados. "Dame las naves" = "dame  las NAVES". Solo
  mapea pregunta → `{ tool, args }`, la tool se ejecuta igual (dato fresco).
- **L2 semántico (paráfrasis):** embeddings + coseno ≥ umbral (a definir,
  ej. 0.92). "mostrame la flota" ≈ "lista las naves". Solo harness LOCAL;
  en WEB se usa matching por texto sin embeddings (patrón `damage-matcher.js`).

Reglas (para que no rompa nada):

- Namespaces separados `askAdmin` / `askTaller`: un hit de uno nunca sirve al
  otro (evita el leak entradas/stock del fix de alcance).
- Solo tools de **lectura** con args estables. Nunca se cachea el mapeo de una
  acción de escritura; y si el usuario pide "estado actual/fresco",
  disponibilidad o ventas, es miss forzado (ya lo dicen los SYSTEM_PROMPT).
- TTL por familia: flota/catálogos largo (minutos-horas), disponibilidad,
  ventas y saldos corto o sin caché (cambian rápido).
- Cualquier escritura válida invalida L1 de su familia.
- Privacidad: a diferencia de `ai_usage` (que solo guarda longitudes), este
  caché sí guarda texto de pregunta → **solo local**, nunca commitear ni
  llevar a prod sin revisión.

Opciones de storage (elegir una en su momento):

| Opción | Dónde | Pro / contra |
|---|---|---|
| A | LRU en memoria del proceso | Simple, cero infra; se pierde al reiniciar |
| B (recomendada local) | SQLite local | Harness LOCAL: persiste entre corridas, cero infra |
| C (recomendada web) | Firestore `ai_cache` | Harness WEB: reusa infra y mide hit-rate en prod |

Métricas nuevas para el bench (campos a sumar en `ai_usage`): `cacheHit`
(bool), `cacheLevel` (`L1`/`L2`/null) y `tokensAvoided` (estimado). El ahorro
real del harness = ahorro Fase 2 (prefijo) + hit-rate × costo medio por
pregunta.

## Fase 3 — Bench pre/post (estadísticas)

1. Set fijo de 12-15 preguntas (7 admin + 7 taller, incluyendo "naves con
   entradas" y "stock" del fix de alcance) contra el emulador con backends
   locales.
2. Script `npm run bench -- --phase=pre|post --repeat=3`: llama a
   `askAdmin`/`askTaller`, lee `ai_usage` (o el log si no hay Firestore
   local), saca CSV con tokens in/out/total, latencia, nº tool-calls,
   `resolvedWithoutLlm`.
3. Métrica: promedio y p50 por pregunta + total, % de ahorro post vs pre.

Requiere Firestore local para persistir (`firebase emulators:start --only
functions,firestore`); si no, el uso queda solo en log (ver AGENTS.md).

## Fase 4 — Publicar sección harness (después de los números)

- Agregar sección en README con: qué recorta cada harness, tabla pre/post
  (tokens, latencia, % ahorro), cómo reproducir
  (`AI_PROVIDER=groq` + `HARNESS_PHASE=post-harness` + `npm run bench`).
- Este archivo queda como índice; los números viven en el README o en
  `bench/results-*.csv` (no commitear `.env` ni resultados con PII — no hay:
  solo se guardan longitudes).

## Restricciones prod (el harness también sube a servidores)

El bench local es para medir, pero el objetivo es ahorrar cuota de Groq/Gemini
en web (ej. 20 consultas/día). Por eso:

- Provider-agnóstico: router + L1 viven **antes** de `runAssistant`, no dentro
  de cada provider → el mismo ahorro aplica a `groq`, `gemini` y `claude`.
- L1 exacto en prod sí. L2 semántico en prod solo si el embedding es barato;
  si no, L2 queda para pruebas locales y en prod se usa matching por texto
  como el que ya existe en `damage-matcher.js` (sin llamadas extra).
- Storage prod = Firestore `ai_cache` (misma infra que `ai_usage`); SQLite o
  memoria solo local.
- Sin dependencias nativas pesadas en Functions (cold start + tamaño de
  deploy): regex/keywords + Firestore bastan para router y L1.
- Con `cacheHit` + `tokensAvoided` en `ai_usage` el ahorro se traduce directo
  a cuota/tokens por día.

## No hacer

- No cambiar catálogos de tools para el bench (el ahorro debe venir del
  harness, no de quitar funcionalidad).
- No instalar RTK ni Ollama en este proyecto (no tocan el gasto del backend).
- No commitear `.env`, `node_modules/`, `.firebase/`.
