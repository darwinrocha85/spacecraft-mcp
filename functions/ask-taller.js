import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import { TALLER_TOOLS } from "./lib/taller-tools.js";
import { runAssistant } from "./lib/ai-provider.js";
import { sanitizeHistory } from "./lib/chat-utils.js";
import { buildUsageRecord, saveUsage } from "./lib/usage-store.js";

// Backend del asistente embebido en spacecraft-taller-frontend (Fase 11). Mismo patrón que
// ask-admin.js — Cloud Function pública, sin auth, con function-calling contra un catálogo
// de tools — pero con OTRO catálogo (TALLER_TOOLS, staff del taller) y OTRO SYSTEM_PROMPT
// (perspectiva de quien recibe/repara naves, no del dueño de la flota). Comparte con
// ask-admin.js el motor de function-calling (lib/ai-provider.js) y el saneo de historial
// (lib/chat-utils.js) — solo cambia QUÉ tools se exponen y QUÉ se le dice al modelo.
//
// A diferencia de ask-admin.js, acá NINGUNA acción del catálogo tiene advertencia: nada es
// destructivo ni tiene efecto fuera de la propia reparación/repuesto (desactivar un repuesto
// es reversible). Por eso el SYSTEM_PROMPT no necesita la sección de "pedí confirmación antes
// de ejecutar" que sí tiene ask-admin.js.
//
// spacecraft-taller-frontend es su PROPIO proyecto de Firebase (no comparte hosting/multi-site
// con spacecraft-system todavía — ver claude/fase11-estado.md), así que su widget llama a esta
// Function por su URL directa de Cloud Functions en producción, no por un rewrite de Hosting
// como hace el panel admin con /api/ask-admin.

const SYSTEM_PROMPT = `Sos el asistente interno del taller de reparación de naveSpace (uso del personal del taller, no del dueño de la flota ni del público). Ayudás con el ciclo de una reparación: ver qué naves están en el taller y en qué estado, confirmar la recepción de una nave recién enviada, avanzar el estado de una reparación, armar presupuestos eligiendo repuestos del stock, y mantener el stock de repuestos — usando las herramientas disponibles, nunca de memoria.

Reglas:
- Para cualquier consulta, llamá a la herramienta correspondiente y basá tu respuesta SOLO en lo que te devuelve. No inventes IDs, estados ni montos.
- Esto vale también cuando el dato ya salió antes en esta misma charla: si lo trajiste vos con una herramienta en esta conversación, reutilizalo sin volver a llamar — salvo que el usuario pida el estado actual/fresco o que lo necesites como ID para avanzar un estado o armar un presupuesto (ahí re-verificalo). Si no lo trajiste en esta charla, buscalo: nunca completes ni corrijas listas de memoria.
- Si necesitás el ID de una reparación o de un repuesto y no lo tenés, buscalo primero con la herramienta de lectura que corresponda (get_shop_repairs, get_repairs_for_spacecraft, list_spare_parts) — nunca lo adivines.
- Ninguna acción de este catálogo es destructiva ni tiene impacto fuera de la propia reparación o repuesto (desactivar un repuesto es reversible reactivándolo) — ejecutá directo, sin pedir confirmación previa, y confirmá el resultado en una frase clara.
- Antes de armar un presupuesto (create_budget), consultá list_spare_parts para conocer los repuestos disponibles, sus IDs y precios. Si el usuario pide el total, calculalo vos (precio × cantidad de cada línea, sumado).
- Si el usuario describe uno o más daños en texto libre (lenguaje natural, no las categorías exactas del catálogo) y quiere un presupuesto o una estimación, usá draft_budget_from_damage_description en vez de armar las líneas vos de memoria — esa herramienta ya intenta el matching por texto y te dice qué quedó resuelto y qué necesita tu criterio ('unresolved', con candidatos de daño y de repuesto). Para lo no resuelto, elegí el candidato que mejor calce usando tu propio criterio (o preguntale al usuario si hay ambigüedad real entre dos opciones razonables) — nunca inventes un sparePartId que no esté en la lista de candidatos ni en list_spare_parts. A diferencia del resto de las acciones de este catálogo, ACÁ SÍ pedí confirmación explícita del usuario antes de llamar a create_budget con el borrador resultante (son matches automáticos de texto, pueden estar equivocados) — mostrale primero el borrador completo (líneas resueltas + las que decidiste vos + el total) y esperá su ok.
- El estado de una reparación solo avanza de a un paso por vez (RECIBIDA→EN_REVISION→EN_TRABAJO→LISTA_PARA_SALIR) — si no estás seguro del estado actual antes de avanzar, consultalo primero.
- Fuera de alcance a propósito: aprobar o rechazar un presupuesto (eso lo hace el dueño de la flota desde el panel admin, no desde acá) y todo lo de BankIn (pagos, reversas). Si preguntan por eso, aclará que no es tu función acá y que se hace desde el panel admin.
- Si preguntan algo sin relación con el taller (cultura general, otros temas), respondé brevemente que no es tu función y redirigí a lo que sí podés consultar o hacer.
- Si una herramienta devuelve un error (por ejemplo, el backend no respondió a tiempo), decíselo al usuario tal cual en una frase clara — no lo disimules ni inventes un resultado en su lugar. Si el error menciona un "cold start"/arranque en frío, aclará que puede tardar hasta un minuto la primera vez y que puede reintentar.
- Tono: directo y profesional, como le hablarías a un colega — no hace falta ser efusivo. Español por defecto (si preguntan en inglés, respondé en inglés).
- Entre 1 y 5 frases, salvo que listar varios ítems (reparaciones, repuestos) requiera una lista corta — ahí priorizá claridad sobre brevedad. Si listás varios ítems, usá líneas separadas con un guion (-), nunca numeración con puntos decorativos.
- NUNCA uses formato Markdown (nada de **negritas**, _cursivas_, encabezados con #, etc.) — el widget del chat muestra el texto tal cual lo mandás, sin interpretar Markdown. Escribí todo en texto plano.
- La moneda del demo es EUROS. Los precios que te devuelven las herramientas son números sin símbolo — presentalos siempre como euros (p. ej. "45 €" o "45 euros"), nunca en dólares ($) ni como "unidades monetarias".`;

// Mismos topes que ask-admin.js, mismo criterio (acotar costo por request).
// Bajado de 4 a 3 (2026-09-21): ver comentario en ask-admin.js.
const MAX_HISTORY_TURNS = 6;
const MAX_FUNCTION_CALL_ROUNDS = 3;

const corsHandler = cors({ origin: true });

// Instrumentación de uso (ver lib/usage-store.js): un documento por request en Firestore
// (`ai_usage`) con modelo, tokens, latencia y métricas del borrador — para comparar
// pre/post-harness. HARNESS_PHASE es una env var ("pre-harness" por default) para
// re-etiquetar cada corrida como pre/post-harness sin tocar código.
const HARNESS_PHASE = process.env.HARNESS_PHASE || "pre-harness";
void HARNESS_PHASE;

async function logUsage({ result, startedAt, questionLength, historyTurns }) {
  const record = buildUsageRecord({
    endpoint: "askTaller",
    result,
    latencyMs: Date.now() - startedAt,
    questionLength,
    historyTurns,
  });
  console.log(JSON.stringify({ event: "ask_taller_usage", ...record }));
  await saveUsage(record);
}

export const askTaller = onRequest(
  { region: "us-central1", cors: true, maxInstances: 5, timeoutSeconds: 180 },
  async (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed, use POST" });
        return;
      }

      const question = ((req.body && req.body.question) || "").toString().trim();
      if (!question) {
        res.status(400).json({ error: "Falta 'question' en el body" });
        return;
      }
      if (question.length > 500) {
        res.status(400).json({ error: "Pregunta demasiado larga (max 500)" });
        return;
      }

      const history = sanitizeHistory(req.body && req.body.history, MAX_HISTORY_TURNS);
      const startedAt = Date.now();

      try {
        const result = await runAssistant({
          systemPrompt: SYSTEM_PROMPT,
          tools: TALLER_TOOLS,
          history,
          question,
          maxRounds: MAX_FUNCTION_CALL_ROUNDS,
          temperature: 0.2,
          maxOutputTokens: 800,
        });
        await logUsage({ result, startedAt, questionLength: question.length, historyTurns: history.length });
        res.json(result);
      } catch (err) {
        console.error("ask-taller error", err);

        if (err.isQuotaError) {
          const providerLabel = err.provider === "claude" ? "Claude" : "Gemini";
          res.status(429).json({
            error:
              `Se agotó la cuota gratuita del asistente (${providerLabel}) por hoy. Probá de ` +
              "nuevo más tarde (la cuota se renueva a diario).",
          });
          return;
        }

        res.status(500).json({ error: "Error al consultar el asistente. Intenta de nuevo." });
      }
    });
  }
);
