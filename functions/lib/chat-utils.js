// Utilidades compartidas por los backends de los asistentes de chat (ask-admin.js,
// ask-taller.js, y los que se sumen). Separado de ai-provider.js porque esto no tiene nada
// que ver con qué proveedor de IA se use — es sanitización de lo que manda el cliente.

/**
 * Sanea el historial que manda el cliente a una forma neutral [{role: "user"|"assistant",
 * text}], sin nada específico de Gemini ni de Claude — cada runner de proveedor (ver
 * ai-provider.js) lo adapta a su propio formato de mensajes.
 *
 * No confía en lo que mande el cliente (endpoint público, cors:true, sin auth — mismo
 * criterio que el resto del demo): valida forma, longitud y alternancia estricta
 * user/assistant server-side.
 */
export function sanitizeHistory(historyRaw, maxTurns) {
  if (!Array.isArray(historyRaw)) return [];

  const cleaned = [];
  let expectedRole = "user";
  for (const item of historyRaw) {
    if (!item || typeof item.text !== "string") continue;
    const text = item.text.trim().slice(0, 500);
    if (!text) continue;
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    if (role !== expectedRole) continue;
    cleaned.push({ role, text });
    expectedRole = role === "user" ? "assistant" : "user";
  }

  // Si terminó esperando un turno "assistant" es porque el último elemento que se aceptó fue
  // un "user" sin respuesta todavía — eso no debería pasar en un historial bien armado, pero
  // por las dudas se descarta ese user colgado para no romper la alternancia.
  if (expectedRole === "assistant" && cleaned.length) cleaned.pop();

  return cleaned.slice(-maxTurns * 2);
}
