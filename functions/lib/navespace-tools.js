import { z } from "zod";
import { SchemaType } from "@google/generative-ai";
import { normalize } from "./damage-matcher.js";

// Módulo compartido: la ÚNICA fuente de verdad de las herramientas de naveSpace-admin.
// Tanto el servidor MCP (index.js, protocolo MCP para clientes externos como Claude
// Desktop) como el backend del asistente embebido (ask-admin.js, function calling de
// Gemini para el widget del panel admin) importan esta misma lista — así el "qué puede
// hacer el asistente" está definido en un solo lugar, con un solo `handler` real por
// herramienta, sin dos implementaciones que puedan divergir.
//
// Alcance (actualizado a pedido del usuario, 2026-09-19): TODOS los endpoints que consume
// spacecraftSystem-frontend (flota, museo, teatro, y el ciclo de taller que orquesta este
// panel) están disponibles como tools, tanto de lectura como de escritura. Única excepción
// a propósito: aprobar un presupuesto de taller, porque esa acción cobra una tarjeta real
// contra BankIn — esa sigue siendo solo-UI (BudgetApprovalModal), nunca una tool de chat.
//
// IMPORTANTE — esto también aplica al servidor MCP (index.js): cualquier cliente MCP (p.ej.
// Claude Desktop) que se conecte puede llamar las mismas tools de escritura de acá. No hay
// gating a nivel de tool; la única capa de "pedí confirmación antes de romper algo" vive en
// el SYSTEM_PROMPT de ask-admin.js (ver ese archivo) — un cliente MCP que no tenga su propio
// mecanismo de confirmación por tool call queda sin esa red de seguridad. Si en algún momento
// se quiere separar "MCP de solo lectura" de "chat con escritura", este es el archivo a partir.
export const NAVESPACE_API_BASE =
  process.env.NAVESPACE_API_BASE || "https://spacecraftsystem.onrender.com/api";

// Fase 1 (extracción del taller a backend Python): detalle fino de reparación, presupuestos
// y stock de repuestos vive acá, no en Java.
export const TALLER_API_BASE =
  process.env.TALLER_API_BASE || "https://spacecraft-taller-backend.onrender.com/api";

// Ambos backends corren (o correrán) en el free tier de Render: si estuvieron inactivos, la
// primera llamada "despierta" el servicio y puede tardar hasta ~60s (cold start). Decisión
// del usuario: aceptar esa espera por ahora, sin keep-warm. Se le da margen de sobra al fetch.
export const FETCH_TIMEOUT_MS = 70_000;

/**
 * Llama a un endpoint de alguno de los dos backends de naveSpace y devuelve el JSON ya
 * parseado. Soporta GET/POST/PUT/PATCH/DELETE con body opcional. Tira un Error con mensaje
 * legible para humanos — cada handler de tool se lo come y lo traduce a un resultado de
 * error (MCP o Gemini, según quién lo esté usando), nunca deja que reviente el proceso que
 * la llama.
 */
async function callApi(
  base,
  path,
  { method = "GET", searchParams, body, coldStartLabel = "El backend" } = {}
) {
  const url = new URL(base + path);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    if (!res.ok) {
      // Java devuelve {"message": ...}, el backend de taller (FastAPI) devuelve {"detail": ...}
      // — se soporta cualquiera de los dos, igual que hace spacecraftApi.js en el frontend.
      const detail =
        data && typeof data === "object" ? data.message || data.detail : raw;
      throw new Error(
        `${coldStartLabel} respondió ${res.status}${detail ? `: ${detail}` : ""}`
      );
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `${coldStartLabel} (Render) no respondió a tiempo. Probablemente estaba "dormido" ` +
          `(cold start tras inactividad, hasta ~60s) o el servicio está caído. Probá de nuevo ` +
          `en unos segundos.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callNaveSpace(path, opts = {}) {
  return callApi(NAVESPACE_API_BASE, path, { ...opts, coldStartLabel: "naveSpace" });
}

export async function callTaller(path, opts = {}) {
  return callApi(TALLER_API_BASE, path, { ...opts, coldStartLabel: "El taller" });
}

// Normalización de daños para send_spacecraft_to_taller (bug real 2026-09-28): el
// backend Java deserializa `category` como enum por NOMBRE (PROPULSION, no la etiqueta
// "Propulsion") y exige el subtipo exacto — un 400 si el modelo manda la etiqueta o
// cambia mayúsculas/acentos. Se acepta clave o etiqueta, en cualquier caja y con o sin
// acentos, y se devuelve la forma exacta que el backend exige. Si no matchea, error con
// la lista REAL (para que el modelo la retransmita en vez de inventar una).
export async function normalizeDamage(categoryInput, subtypeInput) {
  const catalog = await callTaller("/catalog/damages");
  const cn = normalize(categoryInput);
  let foundKey = null;
  for (const [key, entry] of Object.entries(catalog || {})) {
    if (normalize(key) === cn || normalize(entry?.label) === cn) {
      foundKey = key;
      break;
    }
  }
  if (!foundKey) {
    return {
      error:
        `"${categoryInput}" no es una categoría válida. Válidas: ` +
        Object.entries(catalog || {})
          .map(([k, e]) => `${k} (${e?.label})`)
          .join(", "),
    };
  }
  const subtypes = catalog[foundKey]?.subtypes || [];
  const foundSub = subtypes.find((s) => normalize(s) === normalize(subtypeInput));
  if (!foundSub) {
    return {
      error:
        `"${subtypeInput}" no es un subtipo válido de ${foundKey}. Válidos: ` +
        subtypes.join(", "),
    };
  }
  return { category: foundKey, subtype: foundSub };
}

const emptyGeminiParams = { type: SchemaType.OBJECT, properties: {}, required: [] };

// Payload de nave compartido por create_spacecraft/update_spacecraft — mismo armado que hace
// SpacecraftForm.jsx antes de mandarlo a spacecraftApi.create()/update().
function buildSpacecraftPayload(input) {
  return {
    name: input.name,
    franchise: input.franchise,
    crewCapacity: input.crewCapacity ?? null,
    speed: input.speed ?? null,
    spacecraftType: input.spacecraftType || null,
    isArmed: Boolean(input.isArmed),
    isMuseum: Boolean(input.isMuseum),
    isTheater: Boolean(input.isTheater),
    museumCapacity: input.isMuseum && input.museumCapacity != null ? input.museumCapacity : null,
    ticketPrice: input.ticketPrice ?? null,
  };
}

const spacecraftZodFields = {
  name: z.string().min(1).describe("Spacecraft name"),
  franchise: z.string().min(1).describe("Franchise (e.g. Star Wars)"),
  crewCapacity: z.coerce.number().int().nonnegative().optional().describe("Crew capacity"),
  speed: z.coerce.number().nonnegative().optional().describe("Speed"),
  spacecraftType: z.string().optional().describe("Spacecraft type (e.g. Freighter)"),
  isArmed: z.boolean().optional().describe("Is it armed?"),
  isMuseum: z.boolean().optional().describe("Is it a museum?"),
  isTheater: z.boolean().optional().describe("Is it a theater?"),
  museumCapacity: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Museum capacity (required and over 0 if isMuseum is true)"),
  ticketPrice: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Ticket price in euros (backend defaults to 25.00 euros if omitted)"),
};

const spacecraftGeminiProperties = {
  name: { type: SchemaType.STRING, description: "Spacecraft name" },
  franchise: { type: SchemaType.STRING, description: "Franchise (e.g. Star Wars)" },
  crewCapacity: { type: SchemaType.NUMBER, description: "Crew capacity" },
  speed: { type: SchemaType.NUMBER, description: "Speed" },
  spacecraftType: { type: SchemaType.STRING, description: "Spacecraft type (e.g. Freighter)" },
  isArmed: { type: SchemaType.BOOLEAN, description: "Is it armed?" },
  isMuseum: { type: SchemaType.BOOLEAN, description: "Is it a museum?" },
  isTheater: { type: SchemaType.BOOLEAN, description: "Is it a theater?" },
  museumCapacity: {
    type: SchemaType.NUMBER,
    description: "Museum capacity (required and over 0 if isMuseum is true)",
  },
  ticketPrice: {
    type: SchemaType.NUMBER,
    description: "Ticket price in euros (backend defaults to 25.00 euros if omitted)",
  },
};

const theaterEventZodFields = {
  eventType: z.enum(["MUSICA", "ARTES", "LIBRE"]).describe("Show type"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD").describe("Start date"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD").describe("End date"),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Formato esperado: HH:MM").describe("Show time"),
};

const theaterEventGeminiProperties = {
  eventType: {
    type: SchemaType.STRING,
    format: "enum",
    enum: ["MUSICA", "ARTES", "LIBRE"],
    description: "Show type",
  },
  startDate: { type: SchemaType.STRING, description: "Start date, YYYY-MM-DD format" },
  endDate: { type: SchemaType.STRING, description: "End date, YYYY-MM-DD format" },
  time: { type: SchemaType.STRING, description: "Show time, HH:MM format" },
};

export const NAVESPACE_TOOLS = [
  // ============================== LECTURA — Flota ==============================
  {
    name: "list_spacecrafts",
    title: "List fleet",
    description:
      "Lists all fleet spacecraft with name, status (OPERATIVA/EN_TALLER) and " +
      "enabled venues (museum, theater, none).",
    zodShape: {},
    geminiParameters: emptyGeminiParams,
    async handler() {
      return callNaveSpace("/spacecrafts");
    },
  },
  {
    name: "get_spacecraft",
    title: "Spacecraft detail",
    description: "Full detail for one spacecraft by ID (all fields).",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}`);
    },
  },
  {
    name: "list_venues",
    title: "List venues",
    description:
      "Lists enabled fleet venues (museums and/or theaters). The type param " +
      "is optional; without a filter it returns all.",
    zodShape: {
      type: z.string().optional().describe("Optional venue type filter"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { type: { type: SchemaType.STRING, description: "Optional venue type filter" } },
      required: [],
    },
    async handler({ type } = {}) {
      return callNaveSpace("/spacecrafts/venues", { searchParams: { type } });
    },
  },
  // ============================== ESCRITURA — Flota ==============================
  {
    name: "create_spacecraft",
    title: "Register new spacecraft",
    description:
      "Registers a new spacecraft in the fleet. No warning attached — can run " +
      "directly, without asking for prior confirmation.",
    zodShape: spacecraftZodFields,
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: spacecraftGeminiProperties,
      required: ["name", "franchise"],
    },
    async handler(input) {
      return callNaveSpace("/spacecrafts", { method: "POST", body: buildSpacecraftPayload(input) });
    },
  },
  {
    name: "update_spacecraft",
    title: "Edit spacecraft",
    description:
      "Edits an existing spacecraft (replaces all its editable fields). A " +
      "spacecraft in EN_TALLER cannot be edited — the backend rejects it. No warning " +
      "attached — can run directly.",
    zodShape: { spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID to edit"), ...spacecraftZodFields },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID to edit" }, ...spacecraftGeminiProperties },
      required: ["spacecraftId", "name", "franchise"],
    },
    async handler({ spacecraftId, ...input }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}`, {
        method: "PUT",
        body: buildSpacecraftPayload(input),
      });
    },
  },
  {
    name: "delete_spacecraft",
    title: "Delete spacecraft",
    description:
      "Deletes a spacecraft from the fleet PERMANENTLY. Destructive and irreversible: " +
      "ALWAYS explain to the user what will be deleted and ask for explicit " +
      "confirmation in chat before calling this tool; only run it on a later " +
      "turn if the user clearly confirms.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID to delete"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID to delete" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      await callNaveSpace(`/spacecrafts/${spacecraftId}`, { method: "DELETE" });
      return { success: true, spacecraftId };
    },
  },
  // ============================== LECTURA — Dashboard / entradas ==============================
  {
    name: "get_fleet_overview",
    title: "Fleet overview",
    description:
      "General naveSpace dashboard: revenue (museum/theater/total), TODAY " +
      "occupancy (museum and theater), spacecraft count by status, and top 5 " +
      "spacecraft by revenue.",
    zodShape: {},
    geminiParameters: emptyGeminiParams,
    async handler() {
      return callNaveSpace("/dashboard/overview");
    },
  },
  {
    name: "get_spacecraft_dashboard",
    title: "Single spacecraft dashboard",
    description:
      "Same KPIs as the general overview (revenue, today occupancy) scoped to one " +
      "spacecraft, plus a summary of its workshop visit history.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" },
      },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/dashboard/spacecrafts/${spacecraftId}`);
    },
  },
  {
    name: "list_active_tickets",
    title: "Active tickets",
    description:
      "Detail of active museum and theater tickets: buyer, visit/show " +
      "date and time, quantity and cost. Without spacecraftId returns the whole fleet.",
    zodShape: {
      spacecraftId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by single spacecraft (optional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: {
          type: SchemaType.INTEGER,
          description: "Filter by single spacecraft (optional)",
        },
      },
      required: [],
    },
    async handler({ spacecraftId } = {}) {
      return callNaveSpace("/dashboard/tickets", { searchParams: { spacecraftId } });
    },
  },
  // ============================== LECTURA — Museo ==============================
  {
    name: "get_museum_schedule",
    title: "Configured museum schedule",
    description:
      "Saved museum hours for one spacecraft (day by day, open/close). Unlike " +
      "get_museum_availability: this is the stored config, not booked capacity.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace("/museum-schedules", { searchParams: { spacecraftId } });
    },
  },
  {
    name: "get_museum_availability",
    title: "Museum availability",
    description:
      "Booked slots vs. capacity per time slot, for one museum spacecraft on one " +
      "given date.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD")
        .describe("Date to check, YYYY-MM-DD format"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" },
        date: {
          type: SchemaType.STRING,
          description: "Date to check, YYYY-MM-DD format",
        },
      },
      required: ["spacecraftId", "date"],
    },
    async handler({ spacecraftId, date }) {
      return callNaveSpace(`/museum/${spacecraftId}/availability`, {
        searchParams: { date },
      });
    },
  },
  // ============================== ESCRITURA — Museo ==============================
  {
    name: "save_museum_schedule_day",
    title: "Set museum hours for one day",
    description:
      "Sets museum open and close time for one spacecraft on one given day (within " +
      "the today + 7 days window). No warning attached — can run directly.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD").describe("Day to configure"),
      openTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Formato esperado: HH:MM").describe("Opening time"),
      closeTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Formato esperado: HH:MM").describe("Closing time"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" },
        date: { type: SchemaType.STRING, description: "Day to configure, YYYY-MM-DD format" },
        openTime: { type: SchemaType.STRING, description: "Opening time, HH:MM format" },
        closeTime: { type: SchemaType.STRING, description: "Closing time, HH:MM format" },
      },
      required: ["spacecraftId", "date", "openTime", "closeTime"],
    },
    async handler({ spacecraftId, date, openTime, closeTime }) {
      return callNaveSpace("/museum-schedules", {
        method: "POST",
        body: { spacecraftId, date, openTime, closeTime },
      });
    },
  },
  // ============================== LECTURA — Teatro ==============================
  {
    name: "list_theater_events",
    title: "Theater shows",
    description:
      "Lists scheduled theater shows (category, date range, spacecraft). " +
      "Without spacecraftId returns the whole fleet.",
    zodShape: {
      spacecraftId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by single spacecraft (optional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: {
          type: SchemaType.INTEGER,
          description: "Filter by single spacecraft (optional)",
        },
      },
      required: [],
    },
    async handler({ spacecraftId } = {}) {
      return callNaveSpace("/theater-events", { searchParams: { spacecraftId } });
    },
  },
  {
    name: "get_theater_event_sales",
    title: "Sales for one theater show",
    description:
      "Sales summary for one show: seats sold, active ticket count " +
      "and breakdown by show date.",
    zodShape: {
      eventId: z.coerce.number().int().positive().describe("Theater show ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        eventId: { type: SchemaType.INTEGER, description: "Theater show ID" },
      },
      required: ["eventId"],
    },
    async handler({ eventId }) {
      return callNaveSpace(`/theater-events/${eventId}/sales`);
    },
  },
  // ============================== ESCRITURA — Teatro ==============================
  {
    name: "create_theater_event",
    title: "Create theater show",
    description:
      "Creates a new theater show for one spacecraft (repeats every day of the range at " +
      "the same time, fixed 100 seats). Fails if it overlaps another show on the " +
      "same spacecraft. No warning attached — can run directly.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
      ...theaterEventZodFields,
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" },
        ...theaterEventGeminiProperties,
      },
      required: ["spacecraftId", "eventType", "startDate", "endDate", "time"],
    },
    async handler({ spacecraftId, eventType, startDate, endDate, time }) {
      return callNaveSpace("/theater-events", {
        method: "POST",
        body: { spacecraftId, eventType, startDate, endDate, time },
      });
    },
  },
  {
    name: "update_theater_event",
    title: "Edit theater show",
    description:
      "Edits an existing theater show (replaces type, dates and time). No " +
      "warning attached — can run directly.",
    zodShape: {
      eventId: z.coerce.number().int().positive().describe("Theater show ID to edit"),
      spacecraftId: z.coerce.number().int().positive().describe("ID of spacecraft owning the show"),
      ...theaterEventZodFields,
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        eventId: { type: SchemaType.INTEGER, description: "Theater show ID to edit" },
        spacecraftId: { type: SchemaType.INTEGER, description: "ID of spacecraft owning the show" },
        ...theaterEventGeminiProperties,
      },
      required: ["eventId", "spacecraftId", "eventType", "startDate", "endDate", "time"],
    },
    async handler({ eventId, spacecraftId, eventType, startDate, endDate, time }) {
      return callNaveSpace(`/theater-events/${eventId}`, {
        method: "PUT",
        body: { spacecraftId, eventType, startDate, endDate, time },
      });
    },
  },
  {
    name: "delete_theater_event",
    title: "Delete theater show",
    description:
      "Deletes a theater show PERMANENTLY. Destructive: ALWAYS explain " +
      "to the user which show will be deleted and ask for explicit confirmation " +
      "in chat before calling this tool; only run it on a later turn if the " +
      "user clearly confirms (same rule as the panel, which also asks 'Sí, " +
      "borrar' before deleting).",
    zodShape: {
      eventId: z.coerce.number().int().positive().describe("Theater show ID to delete"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { eventId: { type: SchemaType.INTEGER, description: "Theater show ID to delete" } },
      required: ["eventId"],
    },
    async handler({ eventId }) {
      await callNaveSpace(`/theater-events/${eventId}`, { method: "DELETE" });
      return { success: true, eventId };
    },
  },
  // ============================== LECTURA — Taller (lado Java: envío) ==============================
  {
    name: "get_repair_history",
    title: "Repair history (summary)",
    description:
      "Workshop visit history for one spacecraft (send dates, reported damages) — " +
      "aggregate summary living in Java. For fine detail of one given repair " +
      "(sub-statuses, budgets, parts) use get_active_repair/get_repairs_for_spacecraft " +
      "/get_repair_detail, which query the workshop backend (Python).",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" },
      },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs`);
    },
  },
  {
    name: "get_repair_impact",
    title: "Impact of sending a spacecraft to the workshop",
    description:
      "Preview of what would happen if this spacecraft is sent to the workshop NOW: how many " +
      "active tickets would be cancelled and how many museum/theater schedules " +
      "would close. Must call this tool and show the result to the user BEFORE " +
      "calling send_spacecraft_to_taller, as part of asking for confirmation.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs/impact`);
    },
  },
  // ============================== ESCRITURA — Taller (lado Java: envío / retiro) ==============================
  {
    name: "send_spacecraft_to_taller",
    title: "Send spacecraft to workshop",
    description:
      "Sends a spacecraft to the workshop with the chosen damages. Cancels that " +
      "spacecraft's active tickets and closes its schedules/shows — ACTION WITH REAL IMPACT, " +
      "not only destructive on the spacecraft but on already sold tickets. Mandatory flow: 1) first call " +
      "get_damage_catalog for valid categories/subtypes and get_repair_impact " +
      "to know how many tickets/schedules would be affected, 2) clearly explain the " +
      "impact to the user and ask for explicit confirmation in chat, 3) only on a later " +
      "turn, if the user confirms, call this tool. " +
      "Category accepts key or label in any case/accents (e.g. Propulsion, PROPULSION) " +
      "and subtype likewise — the server normalizes them to the exact backend form, " +
      "so pass through what the user said instead of refusing near-matches.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID to send"),
      damages: z
        .array(
          z.object({
            category: z.string().min(1).describe("Damage category (catalog key)"),
            subtype: z.string().min(1).describe("Damage subtype within the category"),
          })
        )
        .min(1)
        .describe("One or more reported damages"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID to send" },
        damages: {
          type: SchemaType.ARRAY,
          description: "One or more reported damages",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              category: { type: SchemaType.STRING, description: "Damage category (catalog key)" },
              subtype: { type: SchemaType.STRING, description: "Damage subtype within the category" },
            },
            required: ["category", "subtype"],
          },
        },
      },
      required: ["spacecraftId", "damages"],
    },
    async handler({ spacecraftId, damages }) {
      // Todo o nada: si un daño no normaliza, no se envía ninguno (el error trae la
      // lista real para que el modelo la muestre en vez de inventar).
      const normalized = [];
      for (const d of damages || []) {
        const n = await normalizeDamage(d?.category, d?.subtype);
        if (n.error) return { error: n.error };
        normalized.push({ category: n.category, subtype: n.subtype });
      }
      if (!normalized.length) return { error: "Indicá al menos un daño (categoría y subtipo)." };
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs`, {
        method: "POST",
        body: { damages: normalized },
      });
    },
  },
  {
    name: "confirm_ship_operational",
    title: "Mark spacecraft as collected from workshop (OPERATIONAL)",
    description:
      "The fleet owner confirms the spacecraft was collected from the workshop: marks it " +
      "OPERATIVA again in naveSpace. Idempotent. Normally called AFTER " +
      "receive_ship_from_taller (which closes the workshop side). No warning " +
      "attached — can run directly.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs/current/receive`, { method: "POST" });
    },
  },
  // ============================== LECTURA — Taller (lado Python: catálogo/estado/presupuestos) ==============================
  {
    name: "get_damage_catalog",
    title: "Damage catalog",
    description:
      "Valid damage categories and subtypes to report when sending a spacecraft to the workshop. " +
      "Check this before building the damages of send_spacecraft_to_taller.",
    zodShape: {},
    geminiParameters: emptyGeminiParams,
    async handler() {
      return callTaller("/catalog/damages");
    },
  },
  {
    name: "get_repairs_for_spacecraft",
    title: "Full repair history (detail)",
    description:
      "Full repair history for one spacecraft in the workshop backend, including the " +
      "active one if underway: sub-statuses, dates, linked budgets.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callTaller("/repairs", { searchParams: { spacecraftId } });
    },
  },
  {
    name: "get_active_repair",
    title: "Active repair for one spacecraft",
    description:
      "Currently open repair for one spacecraft (status other than ENTREGADA), with its " +
      "repairId — needed to check/reject budgets or collect the spacecraft. If the " +
      "spacecraft has no open repair, returns null.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("Spacecraft ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "Spacecraft ID" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      try {
        return await callTaller("/repairs/active", { searchParams: { spacecraftId } });
      } catch (err) {
        if (err.message.includes(" 404")) return null;
        throw err;
      }
    },
  },
  {
    name: "get_repair_detail",
    title: "Repair detail",
    description: "Full detail for one repair by ID (status, damages, dates).",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "Repair ID" } },
      required: ["repairId"],
    },
    async handler({ repairId }) {
      return callTaller(`/repairs/${repairId}`);
    },
  },
  {
    name: "get_budgets",
    title: "Budgets for one repair",
    description:
      "Lists budgets built by the workshop for one repair, with their parts " +
      "lines and status (PENDIENTE/APROBADO/RECHAZADO). Excludes the approve " +
      "action (that charges BankIn and is panel-only).",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "Repair ID" } },
      required: ["repairId"],
    },
    async handler({ repairId }) {
      return callTaller(`/repairs/${repairId}/budgets`);
    },
  },
  // ============================== ESCRITURA — Taller (lado Python: dueño de flota) ==============================
  {
    name: "reject_budget",
    title: "Reject workshop budget",
    description:
      "Rejects a pending budget; the workshop is then free to build a new one. Charges " +
      "nothing (unlike approving, which is out of scope for this assistant). " +
      "No warning attached — can run directly, without asking for prior " +
      "confirmation (same rule as the panel 'Rechazar' button, which asks no double confirmation).",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
      budgetId: z.coerce.number().int().positive().describe("ID of budget to reject"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        repairId: { type: SchemaType.INTEGER, description: "Repair ID" },
        budgetId: { type: SchemaType.INTEGER, description: "ID of budget to reject" },
      },
      required: ["repairId", "budgetId"],
    },
    async handler({ repairId, budgetId }) {
      return callTaller(`/repairs/${repairId}/budgets/${budgetId}/reject`, { method: "POST" });
    },
  },
  {
    name: "receive_ship_from_taller",
    title: "Close workshop side (repair to DELIVERED)",
    description:
      "Closes the workshop side of one repair (moves to ENTREGADA). Idempotent. Called " +
      "BEFORE confirm_ship_operational (the naveSpace side). No warning " +
      "attached — can run directly.",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "Repair ID" } },
      required: ["repairId"],
    },
    async handler({ repairId }) {
      return callTaller(`/repairs/${repairId}/receive`, { method: "POST" });
    },
  },
  // NOTA: no existe (a propósito) una tool "approve_budget". Aprobar cobra una tarjeta real
  // contra BankIn (requiere cardId) — esa acción queda excluida del chat/MCP por decisión del
  // usuario y solo está disponible desde BudgetApprovalModal.jsx en el panel.
];

export function findTool(name) {
  return NAVESPACE_TOOLS.find((t) => t.name === name);
}
