import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import { NAVESPACE_TOOLS } from "./lib/navespace-tools.js";
import { runAssistant } from "./lib/ai-provider.js";
import { sanitizeHistory } from "./lib/chat-utils.js";
import { buildUsageRecord, saveUsage } from "./lib/usage-store.js";
import { routeTools } from "./lib/harness-router.js";
import {
  isHarnessActive,
  lookupL1,
  learnL1,
  estimateTokensAvoided,
  formatCachedAnswer,
} from "./lib/harness-cache.js";

// Backend del asistente embebido en el panel admin (widget del front, ver
// AdminAssistantWidget.jsx). A diferencia del agente del portfolio (que solo conoce texto
// estático sobre el propio portfolio), este habla con datos EN VIVO de naveSpace usando
// function calling contra las mismas NAVESPACE_TOOLS que expone el servidor MCP (index.js)
// — mismo catálogo de herramientas, dos formas de llegar a él: protocolo MCP para clientes
// externos, y esta llamada directa en el mismo proceso para el widget (sin pasar por
// HTTP/MCP, así no se paga un segundo cold start ni una segunda vuelta de red).
//
// Alcance (actualizado 2026-09-19, a pedido del usuario): TODOS los endpoints que consume
// spacecraftSystem-frontend, lectura y escritura, salvo aprobar un presupuesto de taller
// (eso cobra una tarjeta real contra BankIn — queda fuera del chat a propósito, solo UI).
// La red de seguridad para las acciones de escritura con impacto real (borrar algo, enviar
// una nave al taller) vive ACÁ, en este SYSTEM_PROMPT: el modelo tiene que mostrar el
// impacto y pedir confirmación explícita en el chat antes de ejecutar, nunca en el mismo
// turno en que detecta la intención. Ver la sección "Acciones que modifican datos" abajo.
//
// Fase 11.1 (mismo día): el motor de function-calling (armar el request al proveedor de IA,
// correr el loop de tool-calling, normalizar errores de cuota) se movió a
// lib/ai-provider.js, compartido con ask-taller.js. Este archivo solo define QUÉ tools se
// exponen y QUÉ se le dice al modelo — soporta Gemini o Claude según la variable de entorno
// AI_PROVIDER (default "gemini"; ver lib/ai-provider.js para el resto de las variables).

const SYSTEM_PROMPT = `You are the internal assistant of the naveSpace admin panel (fleet owner/staff use, not public). You answer questions about the LIVE state of the operation and can also run data-changing actions (create/edit/delete spacecraft, load museum schedules, create/edit/delete theater shows, send a spacecraft to the shop, mark it operational on pickup, reject a budget) — using the available tools, never from memory or on your own. Always answer the user in Spanish (plain text, no Markdown — see rules below).

READ rules:
- For any question about operational data (revenue, occupancy, spacecraft, tickets, shows, repairs, budgets), call the matching tool and base your answer ONLY on what it returns. Never invent numbers, IDs, or fill gaps with guesses — if you need the ID of a spacecraft/show/repair/budget and don't have it, look it up first with the matching read tool (by name or context).
- Same when the data already came up earlier in this chat: if you fetched it with a tool in this conversation, reuse it without calling again — unless the user asks for current/fresh state, it is availability, sales or balances (they change fast), or you need it as an ID for a write action (then re-verify it with the tool before running). Never complete or fix lists from memory: if you didn't fetch it in this chat, look it up.

Rules for DATA-CHANGING actions (create, edit, delete, send to shop, etc.):
- Before running an action, check whether it is one WITH WARNING (list below). If not, run it directly and confirm the result in one clear sentence — no need to ask permission to create/edit a spacecraft, load a schedule, create/edit a theater show, mark a spacecraft as picked up from the shop, reject a budget, or close the shop side of a repair.
- Actions WITH WARNING (always need the user's explicit confirmation in chat before running): delete a spacecraft, delete a theater show, send a spacecraft to the shop. For these:
  1. First gather what you need (to send to shop: call get_damage_catalog and get_repair_impact; for a delete, you already have the name/ID of what will be deleted). If the user names a damage you don't see listed, re-call get_damage_catalog before saying it doesn't exist — never declare a damage invalid from memory, catalogs beat recall.
  2. Explain to the user, in one clear sentence, what will happen (e.g. "this will cancel 3 active tickets and close 2 museum slots" or "this will permanently delete spacecraft X") and ask them to confirm.
  3. End your answer there, WITHOUT calling the tool that runs the action — wait for the user's next message.
  4. Only in a later turn, if the user confirms clearly ("sí", "dale", "confirmo", "adelante" or equivalent), call the tool that runs the action. If the user says no, changes topic, or doesn't confirm clearly, run NOTHING.
- Never chain "read the impact" + "run the action" in the same turn for warning actions, even though you technically can make several tool calls in a row — the confirmation must come from a new user message, never assumed by you.
- Out of scope on purpose, always: approving a shop budget (that charges a real card via BankIn, needs the card number), and everything about parts stock and internal shop work (view/create/edit/deactivate parts, build budgets or drafts from damage descriptions, confirm receipts or advance repair states). If asked, clarify that action happens in the panel (the budget modal has the "Aprobar y cobrar" button) or in the shop chat, not in this chat, and that you can help with what IS in your catalog (view or reject the budget if needed).
- If you have no tool for what they ask (e.g. parts stock), say so plainly and never improvise with another tool or from memory.
- If a tool returns an error (e.g. the backend didn't answer in time, or rejects the operation by a business rule like editing a spacecraft that is in the shop), tell the user as-is in one clear sentence — don't hide it or invent a result instead. If the error mentions a cold start, clarify it can take up to a minute the first time and they can retry.
- If asked about something unrelated to the naveSpace operation (general knowledge, other topics), briefly say that's not your role and redirect to what you can check or do.
- Tone: direct and professional, like talking to a colleague — no need to be effusive.
- 1 to 5 sentences, unless listing several items (spacecraft, shows, tickets) or explaining an impact before confirming needs a short list — then favor clarity over brevity. When listing several items, use separate lines with a hyphen (-), never numbered lists with decorative dots.
- NEVER use Markdown formatting (no **bold**, _italics_, # headings, etc.) — the chat widget shows the text as-is without rendering Markdown, so the symbols would appear literally on screen. Write everything in plain text.
- The demo currency is EUROS. Amounts returned by tools are bare numbers — always present them as euros (e.g. "620 €" or "620 euros"), never dollars ($) or "monetary units".`;

// Máximo de turnos previos que se reenvían al modelo: acota el costo por request en una
// charla larga.
const MAX_HISTORY_TURNS = 6;

// Tope de vueltas de function-calling por pregunta — red de seguridad ante un loop
// inesperado del modelo (pedir la misma tool una y otra vez); en la práctica casi ninguna
// pregunta necesita más de 1-2 llamadas. Bajado de 4 a 3 (2026-09-21): con la regla de
// reutilizar datos ya traídos en la charla, 3 vueltas sobran y cada vuelta ahorrada evita
// reenviar system + catálogo + resultados de nuevo.
const MAX_FUNCTION_CALL_ROUNDS = 3;

const corsHandler = cors({ origin: true });

// No confía en lo que mande el cliente (endpoint público, cors:true, sin auth — mismo
// criterio que el resto del demo): valida forma, longitud y alternancia estricta
// user/assistant server-side (sanitizeHistory, en lib/chat-utils.js).
export const askAdmin = onRequest(
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
        // Harness Fase 2b (solo con HARNESS_PHASE=post-harness): L1 exacto antes del
        // LLM. Hit = se ejecuta la tool directo (dato fresco), 0 tokens de modelo.
        if (isHarnessActive()) {
          const hit = await lookupL1({ endpoint: "askAdmin", question });
          if (hit) {
            const cachedTool = NAVESPACE_TOOLS.find((t) => t.name === hit.tool);
            if (cachedTool) {
              try {
                const data = await cachedTool.handler(hit.args || {});
                const tokensAvoided = estimateTokensAvoided({
                  systemPrompt: SYSTEM_PROMPT,
                  fullTools: NAVESPACE_TOOLS,
                });
                const cachedResult = {
                  answer: formatCachedAnswer(hit.tool, data),
                  provider: "harness-cache",
                  model: "l1-exact",
                  cacheHit: true,
                  cacheLevel: hit.level,
                  toolCalls: [{ name: hit.tool, ok: true, args: hit.args || {} }],
                };
                const hitRecord = buildUsageRecord({
                  endpoint: "askAdmin",
                  result: cachedResult,
                  latencyMs: Date.now() - startedAt,
                  questionLength: question.length,
                  historyTurns: history.length,
                  harness: {
                    family: hit.family,
                    fullToolCount: NAVESPACE_TOOLS.length,
                    subsetToolCount: 1,
                    cacheHit: true,
                    cacheLevel: hit.level,
                    tokensAvoided,
                  },
                });
                console.log(JSON.stringify({ event: "ask_admin_usage", ...hitRecord }));
                await saveUsage(hitRecord);
                res.json(cachedResult);
                return;
              } catch {
                // Si la tool del hit falla, se sigue al LLM como un miss normal.
              }
            }
          }
        }

        // Harness Fase 2 (solo con HARNESS_PHASE=post-harness): el modelo ve solo el
        // subset de su familia en vez del catálogo completo. En pre-harness va todo.
        const route = isHarnessActive()
          ? routeTools({ endpoint: "askAdmin", question, allTools: NAVESPACE_TOOLS })
          : { family: "full", matched: [], tools: NAVESPACE_TOOLS };
        const result = await runAssistant({
          systemPrompt: SYSTEM_PROMPT,
          tools: route.tools,
          history,
          question,
          maxRounds: MAX_FUNCTION_CALL_ROUNDS,
          temperature: 0.2,
          maxOutputTokens: 800,
        });
        result.harness = {
          active: isHarnessActive(),
          family: route.family,
          fullToolCount: NAVESPACE_TOOLS.length,
          subsetToolCount: route.tools.length,
        };
        // Aprender L1: el turno usó UNA sola tool de lectura con éxito → ese mapeo
        // pregunta→{tool,args} vale para la próxima (learnL1 filtra lo no-cacheable).
        if (result.harness.active && !result.mock && result.toolCalls?.length === 1 && result.toolCalls[0].ok) {
          await learnL1({
            endpoint: "askAdmin",
            question,
            tool: result.toolCalls[0].name,
            args: result.toolCalls[0].args,
            family: route.family,
          });
        }
        const record = buildUsageRecord({
          endpoint: "askAdmin",
          result,
          latencyMs: Date.now() - startedAt,
          questionLength: question.length,
          historyTurns: history.length,
          harness: result.harness.active
            ? {
                family: route.family,
                fullToolCount: NAVESPACE_TOOLS.length,
                subsetToolCount: route.tools.length,
                cacheHit: false,
              }
            : undefined,
        });
        console.log(JSON.stringify({ event: "ask_admin_usage", ...record }));
        await saveUsage(record);
        res.json(result);
      } catch (err) {
        console.error("ask-admin error", err);

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
