// Harness Fase 2 — router determinístico (Opción B, por familias).
//
// Vive ANTES de runAssistant (provider-agnóstico: el mismo ahorro aplica a groq,
// gemini y claude) y solo filtra QUÉ tools ve el modelo por request. Si no matchea
// nada, o la unión de familias matcheadas es demasiado grande, devuelve el catálogo
// completo (fallback seguro — nunca se quita funcionalidad, solo se recorta el prefijo).
//
// Reglas:
// - Keywords/regex en español, sobre texto normalizado (sin acentos, minúsculas).
// - Las familias que necesitan resolver un ID por nombre incluyen list_spacecrafts.
// - Las tools de escritura de la familia se incluyen cuando la intención lo pide
//   (crear/editar/borrar): si el router las filtrara, el modelo no podría ejecutarlas.

import { normalize } from "./damage-matcher.js";

// Familias admin (NAVESPACCE_TOOLS, 28 tools). Cada familia lista sus tools por nombre.
const ADMIN_FAMILIES = {
  fleet: {
    keywords: [
      "flota", "nave", "naves", "spacecraft", "carro", "carros", "venue", "fragata",
      "carguero", "crucero", "armada", "operativa", "en taller",
    ],
    tools: [
      "list_spacecrafts", "get_spacecraft", "list_venues",
      "create_spacecraft", "update_spacecraft", "delete_spacecraft",
    ],
  },
  dashboard: {
    keywords: [
      "recaudacion", "ingreso", "revenue", "ocupacion", "ocupación", "ticket",
      "entrada", "venta", "balance", "resumen", "panel", "kpi", "top", "hoy",
      "cuanto", "cuánto",
    ],
    tools: ["get_fleet_overview", "get_spacecraft_dashboard", "list_active_tickets", "list_spacecrafts"],
  },
  museum: {
    keywords: [
      "museo", "horario", "apertura", "cierre", "disponibilidad", "slot",
      "franja", "capacidad", "visita", "museum",
    ],
    tools: [
      "get_museum_schedule", "get_museum_availability", "save_museum_schedule_day",
      "list_spacecrafts", "list_venues",
    ],
  },
  theater: {
    keywords: [
      "teatro", "funcion", "función", "show", "espectaculo", "espectáculo",
      "evento", "obra", "concierto", "musica", "música", "artes", "butaca",
      "theater",
    ],
    tools: [
      "list_theater_events", "get_theater_event_sales",
      "create_theater_event", "update_theater_event", "delete_theater_event",
      "list_spacecrafts",
    ],
  },
  shop: {
    keywords: [
      "taller", "reparacion", "reparación", "dano", "daño", "presupuesto",
      "enviar", "recoger", "retirar", "operativa", "operativo", "historial",
      "impacto", "rechazar", "danado", "dañado", "roto", "averi",
    ],
    tools: [
      "get_repair_history", "get_repair_impact", "send_spacecraft_to_taller",
      "confirm_ship_operational", "get_damage_catalog", "get_repairs_for_spacecraft",
      "get_active_repair", "get_repair_detail", "get_budgets",
      "reject_budget", "receive_ship_from_taller", "list_spacecrafts",
    ],
  },
};

// Familias taller (TALLER_TOOLS, 15 tools).
const TALLER_FAMILIES = {
  shop_state: {
    keywords: [
      "taller", "reparacion", "reparación", "estado", "recibida", "revision",
      "revisión", "trabajo", "lista", "entregada", "enviada", "historial",
    ],
    tools: [
      "get_shop_repairs", "get_active_repair", "get_repair_detail",
      "get_repairs_for_spacecraft", "list_spacecrafts",
    ],
  },
  stock: {
    keywords: [
      "stock", "repuesto", "parte", "inventario", "precio", "almacen",
      "almacén", "pieza", "parts",
    ],
    tools: [
      "list_spare_parts", "create_spare_part", "update_spare_part",
      "deactivate_spare_part",
    ],
  },
  budget: {
    keywords: [
      "presupuesto", "cotizar", "cotizacion", "cotización", "borrador",
      "estimar", "estimacion", "estimación", "total", "cuanto cuesta",
      "cuánto cuesta", "dano", "daño",
    ],
    tools: [
      "create_budget", "draft_budget_from_damage_description",
      "list_spare_parts", "get_damage_catalog",
      "get_repairs_for_spacecraft", "get_active_repair", "get_budgets",
    ],
  },
  receipt: {
    keywords: [
      "confirmar", "recibir", "recibo", "recepcion", "recepción", "avanzar",
      "cambiar estado", "pasar a",
    ],
    tools: [
      "confirm_repair_receipt", "advance_repair_status",
      "get_repair_detail", "get_shop_repairs",
    ],
  },
};

// Tope de la unión: si las familias matcheadas suman más tools que esto, se devuelve
// el catálogo completo (una pregunta ambigua no debería pagar un subset gigante que
// casi no ahorra y sí arriesga dejar afuera la tool correcta).
const MAX_SUBSET_TOOLS = 12;

// "nave/naves/flota/..." aparecen en casi cualquier pregunta admin pero no dicen nada
// de la intención: si OTRA familia más específica también matcheó y fleet solo entró
// por estos sustantivos genéricos, fleet se cae (ej. "naves con entradas" → dashboard,
// "mandar la nave al taller" → shop). Sin esto, fleet+shop sumarían 17 tools y todo
// caería al fallback full.
const GENERIC_FLEET_NOUNS = ["nave", "naves", "spacecraft", "flota", "carro", "carros"];

function matchFamilies(question, families) {
  const norm = ` ${normalize(question)} `;
  const matched = [];
  for (const [family, def] of Object.entries(families)) {
    if (def.keywords.some((kw) => norm.includes(normalize(kw)))) {
      matched.push(family);
    }
  }
  // Desempate admin: fleet por sustantivos genéricos no suma si hay familia específica.
  if (families === ADMIN_FAMILIES && matched.includes("fleet") && matched.length > 1) {
    const fleetHits = ADMIN_FAMILIES.fleet.keywords.filter((kw) => norm.includes(normalize(kw)));
    const onlyGeneric = fleetHits.every((kw) => GENERIC_FLEET_NOUNS.includes(normalize(kw)));
    if (onlyGeneric) matched.splice(matched.indexOf("fleet"), 1);
  }
  return matched;
}

function buildSubset(allTools, families, matched) {
  const names = new Set();
  for (const family of matched) {
    for (const name of families[family].tools) names.add(name);
  }
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const subset = [...names].map((n) => byName.get(n)).filter(Boolean);
  return { names: [...names], subset };
}

/**
 * Enruta una pregunta al subset de tools de su familia.
 * @returns {{ family: string, matched: string[], toolNames: string[], tools: Array }}
 *   family es "full" cuando se devuelve el catálogo completo.
 */
export function routeTools({ endpoint, question, allTools }) {
  const families = endpoint === "askTaller" ? TALLER_FAMILIES : ADMIN_FAMILIES;
  const matched = matchFamilies(question, families);
  if (matched.length === 0) {
    return {
      family: "full",
      matched,
      toolNames: allTools.map((t) => t.name),
      tools: allTools,
    };
  }
  const { names, subset } = buildSubset(allTools, families, matched);
  if (subset.length > MAX_SUBSET_TOOLS || subset.length === 0) {
    return {
      family: "full",
      matched,
      toolNames: allTools.map((t) => t.name),
      tools: allTools,
    };
  }
  return {
    family: matched.length === 1 ? matched[0] : matched.join("+"),
    matched,
    toolNames: subset.map((t) => t.name),
    tools: subset,
  };
}

export const HARNESS_ROUTER_DEBUG = { ADMIN_FAMILIES, TALLER_FAMILIES, MAX_SUBSET_TOOLS };
