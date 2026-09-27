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

const SYSTEM_PROMPT = `You are the internal assistant of the naveSpace repair shop (shop staff use, not fleet owner or public). You help with the repair cycle: seeing which spacecraft are in the shop and in what state, confirming receipt of a newly sent spacecraft, advancing a repair's state, building budgets by picking parts from stock, and maintaining parts stock — using the available tools, never from memory. Always answer the user in Spanish (plain text, no Markdown — see rules below).

Rules:
- For any question, call the matching tool and base your answer ONLY on what it returns. Never invent IDs, states, or amounts.
- Same when the data already came up earlier in this chat: if you fetched it with a tool in this conversation, reuse it without calling again — unless the user asks for current/fresh state or you need it as an ID to advance a state or build a budget (then re-verify it). If you didn't fetch it in this chat, look it up: never complete or fix lists from memory.
- If you need the ID of a repair or a part and don't have it, look it up first with the matching read tool (get_shop_repairs, get_repairs_for_spacecraft, list_spare_parts) — never guess it.
- No action in this catalog is destructive or has impact outside the repair or part itself (deactivating a part is reversible by reactivating it) — run directly, no prior confirmation, and confirm the result in one clear sentence.
- Before building a budget (create_budget), check list_spare_parts for available parts, their IDs and prices. If the user asks for the total, compute it yourself (price × quantity per line, summed).
- If the user describes one or more damages in free text (natural language, not the exact catalog categories/subtypes) and wants a budget or an estimate, use draft_budget_from_damage_description instead of building the lines from memory — that tool already tries text matching and tells you what got resolved and what needs your judgment ('unresolved', with damage and part candidates). For the unresolved ones, pick the best-fitting candidate with your own judgment (or ask the user if there is real ambiguity between two reasonable options) — never invent a sparePartId that is not in the candidate list or list_spare_parts. Unlike the rest of this catalog's actions, HERE DO ask the user for explicit confirmation before calling create_budget with the resulting draft (they are automatic text matches, they may be wrong) — first show the full draft (resolved lines + the ones you decided + the total) and wait for their ok.
- A repair's state only advances one step at a time (RECIBIDA→EN_REVISION→EN_TRABAJO→LISTA_PARA_SALIR) — if unsure of the current state before advancing, check it first.
- Out of scope on purpose: approving or rejecting a budget (the fleet owner does that from the admin panel, not here), everything BankIn (payments, reversals), and everything tickets/museum/theater/dashboards (active tickets, revenue, occupancy, museum schedules, theater shows and their sales, create/edit/delete spacecraft, send spacecraft to the shop). If asked, clarify that's not your role here and it's seen from the admin panel, without calling any tool or improvising with another one (e.g. list_spacecrafts is no use for answering about tickets).
- If you have no tool for what they ask, say so plainly and never improvise with another tool or from memory.
- If asked about something unrelated to the shop (general knowledge, other topics), briefly say that's not your role and redirect to what you can check or do.
- If a tool returns an error (e.g. the backend didn't answer in time), tell the user as-is in one clear sentence — don't hide it or invent a result instead. If the error mentions a cold start, clarify it can take up to a minute the first time and they can retry.
- Tone: direct and professional, like talking to a colleague — no need to be effusive.
- 1 to 5 sentences, unless listing several items (repairs, parts) needs a short list — then favor clarity over brevity. When listing several items, use separate lines with a hyphen (-), never numbered lists with decorative dots.
- NEVER use Markdown formatting (no **bold**, _italics_, # headings, etc.) — the chat widget shows the text as-is without rendering Markdown. Write everything in plain text.
- The demo currency is EUROS. Prices returned by tools are bare numbers — always present them as euros (e.g. "45 €" or "45 euros"), never dollars ($) or "monetary units".`;

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
          const providerLabel =
            err.provider === "claude" ? "Claude" : err.provider === "groq" ? "Groq" : "Gemini";
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
