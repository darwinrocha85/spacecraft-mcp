import { z } from "zod";
import { SchemaType } from "@google/generative-ai";

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
  name: z.string().min(1).describe("Nombre de la nave"),
  franchise: z.string().min(1).describe("Franquicia (ej. Star Wars)"),
  crewCapacity: z.coerce.number().int().nonnegative().optional().describe("Capacidad de tripulación"),
  speed: z.coerce.number().nonnegative().optional().describe("Velocidad"),
  spacecraftType: z.string().optional().describe("Tipo de nave (ej. Carguero)"),
  isArmed: z.boolean().optional().describe("¿Está armada?"),
  isMuseum: z.boolean().optional().describe("¿Es museo?"),
  isTheater: z.boolean().optional().describe("¿Es teatro?"),
  museumCapacity: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Capacidad del museo (obligatoria y > 0 si isMuseum es true)"),
  ticketPrice: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Precio de entrada en euros (si se omite, el backend usa 25.00 € por defecto)"),
};

const spacecraftGeminiProperties = {
  name: { type: SchemaType.STRING, description: "Nombre de la nave" },
  franchise: { type: SchemaType.STRING, description: "Franquicia (ej. Star Wars)" },
  crewCapacity: { type: SchemaType.NUMBER, description: "Capacidad de tripulación" },
  speed: { type: SchemaType.NUMBER, description: "Velocidad" },
  spacecraftType: { type: SchemaType.STRING, description: "Tipo de nave (ej. Carguero)" },
  isArmed: { type: SchemaType.BOOLEAN, description: "¿Está armada?" },
  isMuseum: { type: SchemaType.BOOLEAN, description: "¿Es museo?" },
  isTheater: { type: SchemaType.BOOLEAN, description: "¿Es teatro?" },
  museumCapacity: {
    type: SchemaType.NUMBER,
    description: "Capacidad del museo (obligatoria y > 0 si isMuseum es true)",
  },
  ticketPrice: {
    type: SchemaType.NUMBER,
    description: "Precio de entrada en euros (si se omite, el backend usa 25.00 € por defecto)",
  },
};

const theaterEventZodFields = {
  eventType: z.enum(["MUSICA", "ARTES", "LIBRE"]).describe("Tipo de función"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD").describe("Fecha de inicio"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD").describe("Fecha de fin"),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Formato esperado: HH:MM").describe("Hora de la función"),
};

const theaterEventGeminiProperties = {
  eventType: {
    type: SchemaType.STRING,
    format: "enum",
    enum: ["MUSICA", "ARTES", "LIBRE"],
    description: "Tipo de función",
  },
  startDate: { type: SchemaType.STRING, description: "Fecha de inicio, formato YYYY-MM-DD" },
  endDate: { type: SchemaType.STRING, description: "Fecha de fin, formato YYYY-MM-DD" },
  time: { type: SchemaType.STRING, description: "Hora de la función, formato HH:MM" },
};

export const NAVESPACE_TOOLS = [
  // ============================== LECTURA — Flota ==============================
  {
    name: "list_spacecrafts",
    title: "Listar flota",
    description:
      "Lista todas las naves de la flota con su nombre, estado (OPERATIVA/EN_TALLER) y " +
      "qué recintos tiene habilitados (museo, teatro, ninguno).",
    zodShape: {},
    geminiParameters: emptyGeminiParams,
    async handler() {
      return callNaveSpace("/spacecrafts");
    },
  },
  {
    name: "get_spacecraft",
    title: "Detalle de una nave",
    description: "Detalle completo de una nave puntual por su ID (todos sus campos).",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}`);
    },
  },
  {
    name: "list_venues",
    title: "Listar recintos",
    description:
      "Lista los recintos habilitados de la flota (museos y/o teatros). El parámetro type " +
      "es opcional; sin filtro trae todos.",
    zodShape: {
      type: z.string().optional().describe("Filtro opcional de tipo de recinto"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { type: { type: SchemaType.STRING, description: "Filtro opcional de tipo de recinto" } },
      required: [],
    },
    async handler({ type } = {}) {
      return callNaveSpace("/spacecrafts/venues", { searchParams: { type } });
    },
  },
  // ============================== ESCRITURA — Flota ==============================
  {
    name: "create_spacecraft",
    title: "Registrar nueva nave",
    description:
      "Da de alta una nueva nave en la flota. Sin advertencia asociada — se puede ejecutar " +
      "directo, sin pedir confirmación previa.",
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
    title: "Editar una nave",
    description:
      "Edita los datos de una nave existente (reemplaza todos sus campos editables). No se " +
      "puede editar una nave que está EN_TALLER — el backend lo rechaza. Sin advertencia " +
      "asociada — se puede ejecutar directo.",
    zodShape: { spacecraftId: z.coerce.number().int().positive().describe("ID de la nave a editar"), ...spacecraftZodFields },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave a editar" }, ...spacecraftGeminiProperties },
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
    title: "Eliminar una nave",
    description:
      "Elimina una nave de la flota de forma PERMANENTE. Acción destructiva e irreversible: " +
      "SIEMPRE hay que explicarle al usuario qué se va a borrar y pedirle confirmación " +
      "explícita en el chat antes de llamar a esta tool; solo ejecutarla en un turno " +
      "posterior si el usuario confirma con claridad.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave a eliminar"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave a eliminar" } },
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
    title: "Resumen general de la flota",
    description:
      "Dashboard general de naveSpace: ingresos (museo/teatro/total), ocupación de HOY " +
      "(museo y teatro), conteo de naves por estado, y el top 5 de naves por ingresos.",
    zodShape: {},
    geminiParameters: emptyGeminiParams,
    async handler() {
      return callNaveSpace("/dashboard/overview");
    },
  },
  {
    name: "get_spacecraft_dashboard",
    title: "Dashboard de una nave puntual",
    description:
      "Mismos KPIs que el resumen general (ingresos, ocupación de hoy) acotados a una " +
      "nave, más un resumen de su historial de visitas al taller.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" },
      },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/dashboard/spacecrafts/${spacecraftId}`);
    },
  },
  {
    name: "list_active_tickets",
    title: "Entradas activas",
    description:
      "Detalle de entradas activas de museo y teatro: comprador, fecha/hora de la visita " +
      "o función, cantidad y costo. Sin spacecraftId trae las de toda la flota.",
    zodShape: {
      spacecraftId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filtrar por una nave puntual (opcional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: {
          type: SchemaType.INTEGER,
          description: "Filtrar por una nave puntual (opcional)",
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
    title: "Horario configurado del museo",
    description:
      "Horario de museo ya guardado para una nave (día por día, apertura/cierre). Distinto " +
      "de get_museum_availability: esto es la configuración cargada, no los cupos ocupados.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace("/museum-schedules", { searchParams: { spacecraftId } });
    },
  },
  {
    name: "get_museum_availability",
    title: "Disponibilidad de museo",
    description:
      "Cupos reservados vs. capacidad por franja horaria, para una nave-museo en una " +
      "fecha puntual.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD")
        .describe("Fecha a consultar, formato YYYY-MM-DD"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" },
        date: {
          type: SchemaType.STRING,
          description: "Fecha a consultar, formato YYYY-MM-DD",
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
    title: "Cargar horario de museo para un día",
    description:
      "Define apertura y cierre del museo de una nave para un día puntual (dentro de la " +
      "ventana de hoy + 7 días). Sin advertencia asociada — se puede ejecutar directo.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD").describe("Día a configurar"),
      openTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Formato esperado: HH:MM").describe("Hora de apertura"),
      closeTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Formato esperado: HH:MM").describe("Hora de cierre"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" },
        date: { type: SchemaType.STRING, description: "Día a configurar, formato YYYY-MM-DD" },
        openTime: { type: SchemaType.STRING, description: "Hora de apertura, formato HH:MM" },
        closeTime: { type: SchemaType.STRING, description: "Hora de cierre, formato HH:MM" },
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
    title: "Funciones de teatro",
    description:
      "Lista las funciones de teatro programadas (categoría, rango de fechas, nave). " +
      "Sin spacecraftId trae las de toda la flota.",
    zodShape: {
      spacecraftId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filtrar por una nave puntual (opcional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: {
          type: SchemaType.INTEGER,
          description: "Filtrar por una nave puntual (opcional)",
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
    title: "Ventas de una función de teatro",
    description:
      "Resumen de ventas de una función puntual: asientos vendidos, cantidad de entradas " +
      "activas y desglose por fecha de función.",
    zodShape: {
      eventId: z.coerce.number().int().positive().describe("ID de la función de teatro"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        eventId: { type: SchemaType.INTEGER, description: "ID de la función de teatro" },
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
    title: "Crear función de teatro",
    description:
      "Crea una función de teatro nueva para una nave (se repite todos los días del rango a " +
      "la misma hora, 100 asientos fijos). Falla si choca en horario con otra función de la " +
      "misma nave. Sin advertencia asociada — se puede ejecutar directo.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
      ...theaterEventZodFields,
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" },
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
    title: "Editar función de teatro",
    description:
      "Edita una función de teatro existente (reemplaza tipo, fechas y hora). Sin " +
      "advertencia asociada — se puede ejecutar directo.",
    zodShape: {
      eventId: z.coerce.number().int().positive().describe("ID de la función a editar"),
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave dueña de la función"),
      ...theaterEventZodFields,
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        eventId: { type: SchemaType.INTEGER, description: "ID de la función a editar" },
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave dueña de la función" },
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
    title: "Eliminar función de teatro",
    description:
      "Elimina una función de teatro de forma PERMANENTE. Acción destructiva: SIEMPRE hay " +
      "que explicarle al usuario qué función se va a borrar y pedirle confirmación explícita " +
      "en el chat antes de llamar a esta tool; solo ejecutarla en un turno posterior si el " +
      "usuario confirma con claridad (mismo criterio que usa el panel, que también pide 'Sí, " +
      "borrar' antes de eliminar).",
    zodShape: {
      eventId: z.coerce.number().int().positive().describe("ID de la función a eliminar"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { eventId: { type: SchemaType.INTEGER, description: "ID de la función a eliminar" } },
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
    title: "Historial de reparaciones (resumen)",
    description:
      "Historial de visitas al taller de una nave (fechas de envío, daños reportados) — " +
      "resumen agregado que vive en Java. Para el detalle fino de una reparación puntual " +
      "(sub-estados, presupuestos, repuestos) usar get_active_repair/get_repairs_for_spacecraft " +
      "/get_repair_detail, que consultan el backend de taller (Python).",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" },
      },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs`);
    },
  },
  {
    name: "get_repair_impact",
    title: "Impacto de enviar una nave al taller",
    description:
      "Vista previa de lo que pasaría si se envía esta nave al taller AHORA: cuántas " +
      "entradas activas se cancelarían y cuántos horarios de museo/funciones de teatro se " +
      "cerrarían. Hay que llamar a esta tool y mostrarle el resultado al usuario ANTES de " +
      "llamar a send_spacecraft_to_taller, como parte de pedirle confirmación.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs/impact`);
    },
  },
  // ============================== ESCRITURA — Taller (lado Java: envío / retiro) ==============================
  {
    name: "send_spacecraft_to_taller",
    title: "Enviar una nave al taller",
    description:
      "Envía una nave al taller con los daños elegidos. Cancela las entradas activas de esa " +
      "nave y cierra sus horarios/funciones — ACCIÓN CON IMPACTO REAL, no solo destructiva " +
      "sobre la nave sino sobre ventas ya hechas. Flujo obligatorio: 1) llamar primero a " +
      "get_damage_catalog para conocer las categorías/subtipos válidos y a get_repair_impact " +
      "para saber cuántas entradas/horarios se verían afectados, 2) explicarle claramente el " +
      "impacto al usuario y pedir confirmación explícita en el chat, 3) recién en un turno " +
      "posterior, si el usuario confirma, llamar a esta tool.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave a enviar"),
      damages: z
        .array(
          z.object({
            category: z.string().min(1).describe("Categoría de daño (clave del catálogo)"),
            subtype: z.string().min(1).describe("Subtipo de daño dentro de la categoría"),
          })
        )
        .min(1)
        .describe("Uno o más daños reportados"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave a enviar" },
        damages: {
          type: SchemaType.ARRAY,
          description: "Uno o más daños reportados",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              category: { type: SchemaType.STRING, description: "Categoría de daño (clave del catálogo)" },
              subtype: { type: SchemaType.STRING, description: "Subtipo de daño dentro de la categoría" },
            },
            required: ["category", "subtype"],
          },
        },
      },
      required: ["spacecraftId", "damages"],
    },
    async handler({ spacecraftId, damages }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs`, {
        method: "POST",
        body: { damages },
      });
    },
  },
  {
    name: "confirm_ship_operational",
    title: "Marcar nave como retirada del taller (OPERATIVA)",
    description:
      "El dueño de la flota confirma que retiró la nave del taller: vuelve a marcarla " +
      "OPERATIVA en naveSpace. Idempotente. Normalmente se llama DESPUÉS de " +
      "receive_ship_from_taller (que cierra el lado del taller). Sin advertencia asociada — " +
      "se puede ejecutar directo.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callNaveSpace(`/spacecrafts/${spacecraftId}/repairs/current/receive`, { method: "POST" });
    },
  },
  // ============================== LECTURA — Taller (lado Python: catálogo/estado/presupuestos) ==============================
  {
    name: "get_damage_catalog",
    title: "Catálogo de daños",
    description:
      "Categorías y subtipos de daño válidos para reportar al enviar una nave al taller. " +
      "Consultar esto antes de armar los `damages` de send_spacecraft_to_taller.",
    zodShape: {},
    geminiParameters: emptyGeminiParams,
    async handler() {
      return callTaller("/catalog/damages");
    },
  },
  {
    name: "get_repairs_for_spacecraft",
    title: "Historial completo de reparaciones (detalle)",
    description:
      "Historial completo de reparaciones de una nave en el backend de taller, incluida la " +
      "activa si está en curso: sub-estados, fechas, presupuestos asociados.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" } },
      required: ["spacecraftId"],
    },
    async handler({ spacecraftId }) {
      return callTaller("/repairs", { searchParams: { spacecraftId } });
    },
  },
  {
    name: "get_active_repair",
    title: "Reparación activa de una nave",
    description:
      "Reparación actualmente abierta de una nave (estado distinto de ENTREGADA), con su " +
      "repairId — necesario para consultar/rechazar presupuestos o recibir la nave. Si la " +
      "nave no tiene ninguna reparación abierta, devuelve null.",
    zodShape: {
      spacecraftId: z.coerce.number().int().positive().describe("ID de la nave"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { spacecraftId: { type: SchemaType.INTEGER, description: "ID de la nave" } },
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
    title: "Detalle de una reparación",
    description: "Detalle completo de una reparación puntual por su ID (estado, daños, fechas).",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("ID de la reparación"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "ID de la reparación" } },
      required: ["repairId"],
    },
    async handler({ repairId }) {
      return callTaller(`/repairs/${repairId}`);
    },
  },
  {
    name: "get_budgets",
    title: "Presupuestos de una reparación",
    description:
      "Lista los presupuestos armados por el taller para una reparación, con sus líneas de " +
      "repuestos y estado (PENDIENTE/APROBADO/RECHAZADO). No incluye la acción de aprobar " +
      "(eso cobra a BankIn y solo se hace desde el panel).",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("ID de la reparación"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "ID de la reparación" } },
      required: ["repairId"],
    },
    async handler({ repairId }) {
      return callTaller(`/repairs/${repairId}/budgets`);
    },
  },
  // ============================== ESCRITURA — Taller (lado Python: dueño de flota) ==============================
  {
    name: "reject_budget",
    title: "Rechazar un presupuesto de taller",
    description:
      "Rechaza un presupuesto pendiente; el taller queda libre para armar uno nuevo. No " +
      "cobra nada (a diferencia de aprobar, que está fuera de alcance de este asistente). " +
      "Sin advertencia asociada — se puede ejecutar directo, sin pedir confirmación previa " +
      "(mismo criterio que el botón 'Rechazar' del panel, que no pide doble confirmación).",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("ID de la reparación"),
      budgetId: z.coerce.number().int().positive().describe("ID del presupuesto a rechazar"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        repairId: { type: SchemaType.INTEGER, description: "ID de la reparación" },
        budgetId: { type: SchemaType.INTEGER, description: "ID del presupuesto a rechazar" },
      },
      required: ["repairId", "budgetId"],
    },
    async handler({ repairId, budgetId }) {
      return callTaller(`/repairs/${repairId}/budgets/${budgetId}/reject`, { method: "POST" });
    },
  },
  {
    name: "receive_ship_from_taller",
    title: "Cerrar el lado del taller (reparación → ENTREGADA)",
    description:
      "Cierra el lado del taller de una reparación (pasa a ENTREGADA). Idempotente. Se llama " +
      "ANTES de confirm_ship_operational (que es el lado de naveSpace). Sin advertencia " +
      "asociada — se puede ejecutar directo.",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("ID de la reparación"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "ID de la reparación" } },
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
