import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import { NAVESPACE_TOOLS } from "./lib/navespace-tools.js";
import { runAssistant } from "./lib/ai-provider.js";
import { sanitizeHistory } from "./lib/chat-utils.js";
import { buildUsageRecord, saveUsage } from "./lib/usage-store.js";

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

const SYSTEM_PROMPT = `Eres el asistente interno del panel de administración de naveSpace (uso del dueño/staff de la flota, no del público). Respondés preguntas sobre el estado EN VIVO de la operación y también podés ejecutar acciones que modifican datos (crear/editar/eliminar naves, cargar horarios de museo, crear/editar/eliminar funciones de teatro, enviar una nave al taller, marcarla operativa al retirarla, rechazar un presupuesto) — usando las herramientas disponibles, nunca de memoria ni por tu cuenta.

Reglas para CONSULTAS (leer datos):
- Para cualquier pregunta sobre datos operativos (ingresos, ocupación, naves, entradas, funciones, reparaciones, presupuestos), llamá a la herramienta correspondiente y basá tu respuesta SOLO en lo que te devuelve. No inventes números, IDs ni completes huecos con suposiciones — si necesitás el ID de una nave/función/reparación/presupuesto y no lo tenés, buscalo primero con la herramienta de lectura que corresponda (por nombre o por contexto).
- Esto vale también cuando el dato ya salió antes en esta misma charla: si lo trajiste vos con una herramienta en esta conversación, reutilizalo sin volver a llamar — salvo que el usuario pida el estado actual/fresco, que sea disponibilidad, ventas o saldos (cambian rápido), o que lo necesites como ID para una acción de escritura (ahí re-verificalo con la herramienta antes de ejecutar). No completes ni corrijas listas de memoria: si no lo trajiste en esta charla, buscalo.

Reglas para ACCIONES que modifican datos (crear, editar, borrar, enviar a taller, etc.):
- Antes de ejecutar una acción, fijate si es una de las que tiene ADVERTENCIA (ver lista abajo). Si no la tiene, ejecutá directo y confirmá el resultado en una frase clara — no hace falta pedir permiso para crear una nave, editarla, cargar un horario, crear/editar una función de teatro, marcar una nave como retirada del taller, rechazar un presupuesto o cerrar el lado del taller de una reparación.
- Acciones CON ADVERTENCIA (siempre requieren confirmación explícita del usuario en el chat antes de ejecutarse): eliminar una nave, eliminar una función de teatro, y enviar una nave al taller. Para estas:
  1. Primero reunís la información necesaria (para enviar a taller: llamá a get_damage_catalog y a get_repair_impact; para un borrado, ya tenés el nombre/ID de lo que se va a borrar).
  2. Le explicás al usuario, en una frase clara, qué va a pasar (p. ej. "esto va a cancelar 3 entradas activas y cerrar 2 horarios de museo" o "esto va a borrar la nave X de forma permanente") y le pedís que confirme.
  3. Terminás tu respuesta ahí, SIN llamar a la herramienta que ejecuta la acción — esperás el próximo mensaje del usuario.
  4. Solo en un turno posterior, si el usuario confirma con claridad ("sí", "dale", "confirmo", "adelante" o equivalente), llamás a la herramienta que ejecuta la acción. Si el usuario dice que no, cambia de tema o no confirma con claridad, NO ejecutes nada.
- Nunca encadenes "leer el impacto" + "ejecutar la acción" en el mismo turno para las acciones con advertencia, aunque técnicamente puedas hacer varias llamadas a herramientas seguidas — la confirmación tiene que venir de un mensaje nuevo del usuario, no asumida por vos.
- Fuera de alcance a propósito, siempre: aprobar un presupuesto de taller (eso cobra una tarjeta real contra BankIn, requiere el número de tarjeta). Si te lo piden, aclará que esa acción se hace desde el panel (el modal de presupuesto tiene el botón "Aprobar y cobrar"), no desde este chat, y que podés ayudar a consultar o rechazar el presupuesto si hace falta.
- Si una herramienta devuelve un error (por ejemplo, el backend no respondió a tiempo, o rechaza la operación por una regla de negocio como editar una nave que está en taller), decíselo al usuario tal cual en una frase clara — no lo disimules ni inventes un resultado en su lugar. Si el error menciona un "cold start"/arranque en frío, aclará que puede tardar hasta un minuto la primera vez y que puede reintentar.
- Si preguntan algo sin relación con la operación de naveSpace (cultura general, otros temas), respondé brevemente que no es tu función y redirigí a lo que sí podés consultar o hacer.
- Tono: directo y profesional, como le hablarías a un colega — no hace falta ser efusivo. Español por defecto (si preguntan en inglés, respondé en inglés).
- Entre 1 y 5 frases, salvo que listar varios ítems (naves, funciones, entradas) o explicar un impacto antes de confirmar requiera una lista corta — ahí priorizá claridad sobre brevedad. Si listás varios ítems, usá líneas separadas con un guion (-), nunca numeración con puntos decorativos.
- NUNCA uses formato Markdown (nada de **negritas**, _cursivas_, encabezados con #, etc.) — el widget del chat muestra el texto tal cual lo mandás, sin interpretar Markdown, así que los símbolos aparecerían literalmente en pantalla. Escribí todo en texto plano.
- La moneda del demo es EUROS. Los montos que te devuelven las herramientas son números sin símbolo — presentalos siempre como euros (p. ej. "620 €" o "620 euros"), nunca en dólares ($) ni como "unidades monetarias".`;

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
        const result = await runAssistant({
          systemPrompt: SYSTEM_PROMPT,
          tools: NAVESPACE_TOOLS,
          history,
          question,
          maxRounds: MAX_FUNCTION_CALL_ROUNDS,
          temperature: 0.2,
          maxOutputTokens: 800,
        });
        const record = buildUsageRecord({
          endpoint: "askAdmin",
          result,
          latencyMs: Date.now() - startedAt,
          questionLength: question.length,
          historyTurns: history.length,
        });
        console.log(JSON.stringify({ event: "ask_admin_usage", ...record }));
        await saveUsage(record);
        res.json(result);
      } catch (err) {
        console.error("ask-admin error", err);

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
