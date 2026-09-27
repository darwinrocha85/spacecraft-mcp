import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";

// Capa de abstracción para que un asistente de function-calling (ask-admin.js, ask-taller.js,
// y los que se sumen) pueda correr sobre Gemini, Claude o Groq cambiando UNA variable de
// entorno (AI_PROVIDER=gemini|claude|groq), sin duplicar el loop de tool-calling por proveedor.
//
// Decisión clave que simplifica todo esto: los `geminiParameters` que ya se escriben a mano
// para cada tool (en navespace-tools.js, taller-tools.js, etc.) SON JSON Schema válido tal
// cual — se confirmó inspeccionando el paquete @google/generative-ai instalado: SchemaType
// resuelve a strings en minúscula ("string", "object", "integer", ...), no a los enums en
// mayúscula que tiene la documentación vieja de Gemini. Eso significa que el mismo objeto
// sirve como `parameters` de Gemini y como `input_schema` de Claude sin conversión — un solo
// schema por tool, no tres.
//
// El `history` que reciben las funciones de acá es siempre neutral: [{role: "user"|
// "assistant", text}] (ver chat-utils.js). El tool-calling en sí (pedir una tool, mandarle el
// resultado) pasa solo DENTRO del turno actual — no se persiste como tool_use/functionCall en
// el historial entre preguntas, solo la respuesta final en texto. Por eso ambos proveedores
// pueden compartir la misma forma de historial sin perder nada.

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
// Haiku 4.5 es el modelo de Anthropic en el mismo escalón de precio/velocidad que Gemini
// Flash — el que tiene sentido para un asistente de function-calling de este tamaño.
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
// Provider principal desde 2026-09-27: Groq (Qwen 3.8 27B) con tool calling, endpoint
// OpenAI-compatible. Más cuota gratis que Gemini para este demo y más rápido que Haiku.
// (Antes fue Mistral: su API resultó paga sin trial útil — cuenta eliminada. Y el default
// anterior llama-3.3-70b-versatile Groq lo dio de baja — su catálogo rota seguido, por eso
// existe GROQ_MODEL para pisarlo sin tocar código.)
const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
const GROQ_API_BASE = process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1";

/**
 * Qué proveedor usar. AI_PROVIDER se lee una vez por invocación de la Cloud Function (no hay
 * caché entre requests en Cloud Functions Gen 2 salvo que la instancia se reuse, y aunque se
 * reuse esto es tan barato que da igual releerlo siempre).
 *
 * Valores: "gemini" | "claude" | "groq" (principal desde 2026-09-27).
 *
 * Ahorro de tokens (2026-09-21): el prefijo estático de cada request (system prompt + catálogo
 * de tools, idéntico en cada llamada) va marcado con breakpoints de prompt caching en Claude
 * (`cache_control`, ver runClaude) — cada follow-up paga ese prefijo como cache read en vez de
 * input completo. En Gemini el mismo prefijo estable queda cubierto por el caché implícito de
 * la API cuando el modelo lo soporta (este SDK no expone caché explícito, por eso ahí no hay
 * código extra: el orden estable de system+tools ya es lo que permite reusar).
 */
export function resolveProvider() {
  const raw = (process.env.AI_PROVIDER || "gemini").trim().toLowerCase();
  if (raw !== "gemini" && raw !== "claude" && raw !== "groq") {
    throw Object.assign(
      new Error(`AI_PROVIDER inválido: "${raw}". Los valores válidos son "gemini", "claude" o "groq".`),
      { isConfigError: true }
    );
  }
  return raw;
}

async function runToolCall(tools, name, args, sideChannel, toolCalls) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    if (toolCalls) toolCalls.push({ name, ok: false });
    return { error: `Herramienta desconocida: ${name}` };
  }
  try {
    const data = await tool.handler(args || {});
    // Side-channel (2026-09-26, Fase 1 del taller): una tool puede marcarse con
    // `structuredType` (ver draft_budget_from_damage_description en taller-tools.js) para que
    // su resultado, además de volver al modelo como siempre, quede disponible aparte en la
    // respuesta de runAssistant() — así el frontend puede pintar una tarjeta estructurada sin
    // depender de que el modelo transcriba los números en el texto. Si se llama más de una vez
    // en la misma conversación, se queda con la última (alcanza para el patrón de uso actual:
    // una tool estructurada por turno).
    if (sideChannel && tool.structuredType && !data?.error) {
      sideChannel.structured = { type: tool.structuredType, payload: data };
    }
    if (toolCalls) toolCalls.push({ name, ok: !data?.error, args: args || {} });
    return truncateToolResult(data);
  } catch (err) {
    if (toolCalls) toolCalls.push({ name, ok: false });
    return { error: err.message };
  }
}

// Poda de resultados (2026-09-21): las listas (naves, tickets, ventas) pueden ser largas y
// cada ronda del loop las reenvía íntegras al modelo. Se recorta a un tope con aviso — el
// modelo puede pedir el ítem puntual por ID/nombre con la herramienta de detalle si lo
// necesita, que sale más barato que reenviar la lista entera en cada vuelta.
const MAX_TOOL_RESULT_CHARS = 6000;

function truncateToolResult(data) {
  const text = JSON.stringify(data);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return data;
  return {
    truncated: true,
    note:
      "Resultado recortado a los primeros ~6000 caracteres para acotar costo. Si necesitás " +
      "un ítem puntual de la lista, pedilo por ID o nombre con la herramienta de detalle.",
    preview: text.slice(0, MAX_TOOL_RESULT_CHARS),
  };
}

async function runGemini({ apiKey, model, systemPrompt, tools, history, question, maxRounds, temperature, maxOutputTokens, sideChannel, toolCalls }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const toolsForGemini = [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.geminiParameters,
      })),
    },
  ];
  const generativeModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    tools: toolsForGemini,
  });
  // Nota de costo: system + tools van siempre en el mismo orden y con el mismo contenido,
  // así que el prefijo estático es reusable por el caché implícito de la API. Este SDK
  // (@google/generative-ai) no expone caché explícito — no hay nada más que hacer acá.

  // No usamos ChatSession/sendMessage() a propósito: el helper del SDK arma el turno de
  // respuesta de una function-call con `role: "function"`, rol que la API detrás de Gemini
  // ya no acepta (bug real encontrado y corregido en la Fase 10.1 — ver fase10-estado.md).
  // Armamos `contents` a mano y llamamos a generateContent() directo.
  const contents = [
    ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];

  let response;
  let rounds = 0;
  while (true) {
    const result = await generativeModel.generateContent({
      contents,
      generationConfig: { maxOutputTokens, temperature },
    });
    response = result.response;

    const calls = response.functionCalls();
    if (!calls || calls.length === 0 || rounds >= maxRounds) break;

    contents.push(response.candidates[0].content);

    const responseParts = [];
    for (const call of calls) {
      const data = await runToolCall(tools, call.name, call.args, sideChannel, toolCalls);
      // La API de Gemini exige que `response` sea un objeto (Struct): si la tool devolvió
      // un array o un primitivo (p. ej. una lista de repuestos), se envuelve en `result`.
      // Sin esto, cualquier tool que devuelva lista falla con 400 en la 2ª vuelta.
      const payload = data && typeof data === "object" && !Array.isArray(data) ? data : { result: data };
      responseParts.push({ functionResponse: { name: call.name, response: payload } });
    }
    contents.push({ role: "user", parts: responseParts });
    rounds++;
  }

  const text = (response.text() || "").trim();
  return {
    answer: text || "No pude obtener esa información ahora mismo.",
    model,
    usage: response.usageMetadata || undefined,
    toolCalls,
  };
}

async function runClaude({ apiKey, model, systemPrompt, tools, history, question, maxRounds, temperature, maxOutputTokens, sideChannel, toolCalls }) {
  const anthropic = new Anthropic({ apiKey });
  // Prompt caching: system + catálogo de tools son idénticos en cada request, así que van
  // con breakpoint de caché (máx 4 por request, acá usamos 2). Historial y pregunta quedan
  // fuera del caché porque cambian siempre. El `usage` se devuelve para poder verificar
  // cache hits en los logs (cache_read_input_tokens vs input_tokens).
  const claudeTools = tools.map((t, i) => {
    const tool = {
      name: t.name,
      description: t.description,
      input_schema: t.geminiParameters,
    };
    if (i === tools.length - 1) tool.cache_control = { type: "ephemeral" };
    return tool;
  });

  // Los roles neutrales ("user"/"assistant") ya coinciden con los de la Messages API de
  // Claude — a diferencia de Gemini, acá no hace falta mapear nada.
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: question },
  ];

  let response;
  let rounds = 0;
  while (true) {
    response = await anthropic.messages.create({
      model,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      max_tokens: maxOutputTokens,
      temperature,
      tools: claudeTools,
      messages,
    });

    if (response.stop_reason !== "tool_use" || rounds >= maxRounds) break;

    // El turno del modelo se reenvía tal cual vino (puede traer texto + uno o más bloques
    // tool_use) para que el modelo tenga su propio pedido en el historial de la vuelta
    // siguiente — mismo patrón que el `response.candidates[0].content` de Gemini.
    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const data = await runToolCall(tools, block.name, block.input, sideChannel, toolCalls);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(data),
      });
    }
    messages.push({ role: "user", content: toolResults });
    rounds++;
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return {
    answer: text || "No pude obtener esa información ahora mismo.",
    model,
    usage: response.usage || undefined,
    toolCalls,
  };
}

async function runGroq({ apiKey, model, systemPrompt, tools, history, question, maxRounds, temperature, maxOutputTokens, sideChannel, toolCalls }) {
  // Groq expone chat completions OpenAI-compatible con function calling: se usa fetch
  // directo (sin SDK nuevo) contra /chat/completions. Los `geminiParameters` son JSON
  // Schema válido y sirven tal cual como `parameters` de cada function.
  const groqTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.geminiParameters },
  }));

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: question },
  ];

  async function chat(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = data?.error?.message || res.statusText;
        const err = new Error(`Groq respondió ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  let data;
  let rounds = 0;
  while (true) {
    data = await chat({
      model,
      messages,
      tools: groqTools,
      tool_choice: "auto",
      temperature,
      max_tokens: maxOutputTokens,
    });
    // OJO: finish_reason vive en el CHOICE, no en el message (bug real 2026-09-28:
    // leerlo del message lo dejaba en undefined y el loop cortaba siempre en la
    // primera vuelta — Groq nunca ejecutaba tools). Además se confía en la presencia
    // de tool_calls por sobre el finish_reason (algunos modelos devuelven "stop" con
    // tool_calls igual).
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error("Groq devolvió una respuesta vacía.");
    // modelCalls (lo que pidió el modelo, se reenvía tal cual) vs toolCalls (acumulador
    // de tracking para L1/bench que llena runToolCall): TIENEN que ser arrays distintos.
    // Compartirlos causó dos bugs reales el 2026-09-28: iterar el mismo array que crece
    // (loop infinito + OOM) y serializar entradas de tracking sin `id` (400 de Groq).
    const modelCalls = msg.tool_calls || [];
    if (modelCalls.length === 0 || rounds >= maxRounds) break;

    messages.push({ role: "assistant", content: msg.content || "", tool_calls: modelCalls });
    for (const call of modelCalls) {
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      const result = await runToolCall(tools, call.function?.name, args, sideChannel, toolCalls);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    rounds++;
  }

  const finalMsg = data?.choices?.[0]?.message;
  const text = ((finalMsg?.content || "")).trim();
  return {
    answer: text || "No pude obtener esa información ahora mismo.",
    model,
    usage: data?.usage || undefined,
    toolCalls,
  };
}

/**
 * Clasifica un error del SDK del proveedor como "cuota agotada" (429) de forma normalizada,
 * para que el caller (ask-admin.js, ask-taller.js) responda con el mismo mensaje amigable sin
 * importar qué proveedor estaba activo.
 */
function classifyProviderError(err) {
  return (
    err?.status === 429 ||
    /\b429\b/.test(err?.message || "") ||
    /quota|resource_exhausted|too many requests|rate.?limit|overloaded/i.test(err?.message || "")
  );
}

/**
 * Punto de entrada único para ambos asistentes. Devuelve { answer, provider, mock? } o tira
 * un Error con `.isQuotaError` (bool) y `.provider` seteados, para que el caller decida el
 * status HTTP sin tener que conocer los detalles de cada SDK.
 */
export async function runAssistant({
  systemPrompt,
  tools,
  history,
  question,
  maxRounds = 4,
  temperature = 0.2,
  maxOutputTokens = 800,
}) {
  const provider = resolveProvider();
  // Side-channel de esta invocación (ver runToolCall): se llena en el sitio si alguna tool
  // corrida en este turno tiene `structuredType`, y se adjunta al resultado final acá abajo.
  // Vive solo durante esta llamada a runAssistant (no hay estado global entre requests).
  const sideChannel = {};
  // Harness (Fase 2b): lista de tools efectivamente corridas en este turno, para que el
  // caller pueda aprender mapeos L1 (un solo read → cacheable) sin re-ejecutar nada.
  const toolCalls = [];

  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return {
        mock: true,
        provider,
        toolCalls,
        answer:
          "[mock sin GROQ_API_KEY, AI_PROVIDER=groq] Configura GROQ_API_KEY en " +
          "esta Function para respuesta real. Pregunta recibida: " +
          question.slice(0, 120),
      };
    }
    const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    try {
      const result = await runGroq({ apiKey, model, systemPrompt, tools, history, question, maxRounds, temperature, maxOutputTokens, sideChannel, toolCalls });
      return { ...result, provider, structured: sideChannel.structured };
    } catch (err) {
      err.isQuotaError = classifyProviderError(err);
      err.provider = provider;
      throw err;
    }
  }

  if (provider === "claude") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        mock: true,
        provider,
        toolCalls,
        answer:
          "[mock sin ANTHROPIC_API_KEY, AI_PROVIDER=claude] Configura ANTHROPIC_API_KEY en " +
          "esta Function para respuesta real. Pregunta recibida: " +
          question.slice(0, 120),
      };
    }
    const model = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
    try {
      const result = await runClaude({ apiKey, model, systemPrompt, tools, history, question, maxRounds, temperature, maxOutputTokens, sideChannel, toolCalls });
      return { ...result, provider, structured: sideChannel.structured };
    } catch (err) {
      err.isQuotaError = classifyProviderError(err);
      err.provider = provider;
      throw err;
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      mock: true,
      provider,
      toolCalls,
      answer:
        "[mock sin GEMINI_API_KEY] Configura GEMINI_API_KEY en esta Function para " +
        "respuesta real con datos en vivo. Pregunta recibida: " +
        question.slice(0, 120),
    };
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  try {
    const result = await runGemini({ apiKey, model, systemPrompt, tools, history, question, maxRounds, temperature, maxOutputTokens, sideChannel, toolCalls });
    return { ...result, provider, structured: sideChannel.structured };
  } catch (err) {
    err.isQuotaError = classifyProviderError(err);
    err.provider = provider;
    throw err;
  }
}
