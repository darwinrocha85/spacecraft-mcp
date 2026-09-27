import { z } from "zod";
import { SchemaType } from "@google/generative-ai";
import { callTaller, findTool as findNavespaceTool } from "./navespace-tools.js";
import { matchDamageDescription } from "./damage-matcher.js";

// Catálogo de tools para el asistente del TALLER (staff del taller de reparación, no el dueño
// de la flota — ese es navespace-tools.js). Construido leyendo directo el código real de
// spacecraft-taller-frontend (repairApi.js, BudgetForm.jsx, PartsStockPanel.jsx, RepairCard.jsx,
// constants/repairStatus.js) para que cada payload matchee exactamente lo que ya manda esa UI.
//
// Reusa (no duplica) las tools de lectura de navespace-tools.js que le sirven igual al staff
// del taller, porque son el MISMO backend/endpoint — evita una segunda definición que se
// pueda desalinear con la primera.
const REUSED_TOOL_NAMES = [
  "list_spacecrafts", // para ubicar el spacecraftId de una nave por nombre
  "get_damage_catalog",
  "get_repairs_for_spacecraft",
  "get_active_repair",
  "get_repair_detail",
  "get_budgets",
];
const reusedTools = REUSED_TOOL_NAMES.map((name) => {
  const tool = findNavespaceTool(name);
  if (!tool) {
    throw new Error(`taller-tools.js: no se encontró la tool reusada "${name}" en navespace-tools.js`);
  }
  return tool;
});

// Único manual "avance" disponible (mismo mapeo que NEXT_MANUAL_STATUS en
// src/constants/repairStatus.js del frontend de taller) — ESPERANDO_APROBACION_PRESUPUESTO y
// ENTREGADA no son transiciones manuales de este endpoint (la primera la dispara crear un
// presupuesto, la segunda el flujo del dueño de la flota vía receive_ship_from_taller).
const MANUAL_ADVANCE_TARGETS = ["EN_REVISION", "EN_TRABAJO", "LISTA_PARA_SALIR"];
const REPAIR_STATUSES = [
  "ENVIADA",
  "RECIBIDA",
  "EN_REVISION",
  "EN_TRABAJO",
  "ESPERANDO_APROBACION_PRESUPUESTO",
  "LISTA_PARA_SALIR",
  "ENTREGADA",
];

// Extraído como función standalone (no solo el handler de la tool) para poder reusarlo desde
// draft_budget_from_damage_description sin pasar por una vuelta de function-calling del
// modelo — es una llamada directa en el mismo proceso, igual de válida que la de la tool.
async function listSparePartsHandler({ activeOnly = true } = {}) {
  return callTaller("/parts", { searchParams: { active: activeOnly } });
}

const newTallerTools = [
  {
    name: "get_shop_repairs",
    title: "Shop repairs",
    description:
      "Lists shop repairs, optionally filtered by status. Without " +
      "status returns all (active and historic).",
    zodShape: {
      status: z.enum(REPAIR_STATUSES).optional().describe("Filter by status (optional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        status: { type: SchemaType.STRING, format: "enum", enum: REPAIR_STATUSES, description: "Filter by status (optional)" },
      },
      required: [],
    },
    async handler({ status } = {}) {
      return callTaller("/repairs", { searchParams: { status } });
    },
  },
  {
    name: "confirm_repair_receipt",
    title: "Confirm ship receipt",
    description:
      "Shop confirms physical receipt of a newly sent ship (moves ENVIADA to " +
      "RECIBIDA). No warning, can run directly.",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { repairId: { type: SchemaType.INTEGER, description: "Repair ID" } },
      required: ["repairId"],
    },
    async handler({ repairId }) {
      return callTaller(`/repairs/${repairId}/confirm-receipt`, { method: "POST" });
    },
  },
  {
    name: "advance_repair_status",
    title: "Advance repair status",
    description:
      "Manually advances a repair one step: RECIBIDA to EN_REVISION, " +
      "EN_REVISION to EN_TRABAJO, or EN_TRABAJO to LISTA_PARA_SALIR (backend enforces " +
      "the single allowed step from the current status; if unsure of current status, " +
      "check get_repair_detail first). No warning, can run directly.",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
      status: z.enum(MANUAL_ADVANCE_TARGETS).describe("Target status"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        repairId: { type: SchemaType.INTEGER, description: "Repair ID" },
        status: { type: SchemaType.STRING, format: "enum", enum: MANUAL_ADVANCE_TARGETS, description: "Target status" },
      },
      required: ["repairId", "status"],
    },
    async handler({ repairId, status }) {
      return callTaller(`/repairs/${repairId}/status`, { method: "PATCH", body: { status } });
    },
  },
  {
    name: "list_spare_parts",
    title: "Spare parts stock",
    description:
      "Lists shop spare parts (name, price, informative stock, active/inactive). " +
      "Check this before building a budget (create_budget) for valid " +
      "sparePartIds and prices.",
    zodShape: {
      activeOnly: z.boolean().optional().describe("true = active parts only (default). false = include deactivated."),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        activeOnly: { type: SchemaType.BOOLEAN, description: "true = active parts only (default). false = include deactivated." },
      },
      required: [],
    },
    async handler({ activeOnly = true } = {}) {
      return listSparePartsHandler({ activeOnly });
    },
  },
  {
    name: "create_spare_part",
    title: "Add spare part to stock",
    description:
      "Adds a new spare part to shop stock. No warning, " +
      "can run directly.",
    zodShape: {
      name: z.string().min(1).describe("Part name"),
      price: z.coerce.number().nonnegative().describe("Unit price in euros"),
      stockQuantity: z.coerce.number().int().nonnegative().optional().describe("Stock quantity (informative, optional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING, description: "Part name" },
        price: { type: SchemaType.NUMBER, description: "Unit price in euros" },
        stockQuantity: { type: SchemaType.NUMBER, description: "Stock quantity (informative, optional)" },
      },
      required: ["name", "price"],
    },
    async handler({ name, price, stockQuantity }) {
      return callTaller("/parts", {
        method: "POST",
        body: { name, price, stockQuantity: stockQuantity ?? null },
      });
    },
  },
  {
    name: "update_spare_part",
    title: "Edit spare part",
    description:
      "Edits selected fields of an existing part (name, price, stock, or " +
      "reactivate with active true). Send only fields to change. No " +
      "warning, can run directly.",
    zodShape: {
      partId: z.coerce.number().int().positive().describe("Part ID"),
      name: z.string().min(1).optional().describe("New name (optional)"),
      price: z.coerce.number().nonnegative().optional().describe("New price in euros (optional)"),
      stockQuantity: z.coerce.number().int().nonnegative().optional().describe("New stock (optional)"),
      active: z.boolean().optional().describe("true to reactivate a deactivated part (optional)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        partId: { type: SchemaType.INTEGER, description: "Part ID" },
        name: { type: SchemaType.STRING, description: "New name (optional)" },
        price: { type: SchemaType.NUMBER, description: "New price in euros (optional)" },
        stockQuantity: { type: SchemaType.NUMBER, description: "New stock (optional)" },
        active: { type: SchemaType.BOOLEAN, description: "true to reactivate a deactivated part (optional)" },
      },
      required: ["partId"],
    },
    async handler({ partId, ...changes }) {
      const body = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) body[key] = value;
      }
      return callTaller(`/parts/${partId}`, { method: "PATCH", body });
    },
  },
  {
    name: "deactivate_spare_part",
    title: "Deactivate spare part",
    description:
      "Deactivates a part (soft-delete, reversible with update_spare_part and active=true). " +
      "No warning, can run directly, same as the stock panel button.",
    zodShape: {
      partId: z.coerce.number().int().positive().describe("ID of part to deactivate"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: { partId: { type: SchemaType.INTEGER, description: "ID of part to deactivate" } },
      required: ["partId"],
    },
    async handler({ partId }) {
      return callTaller(`/parts/${partId}`, { method: "DELETE" });
    },
  },
  {
    name: "create_budget",
    title: "Create repair budget",
    description:
      "Creates a budget for a repair from parts and quantities (total " +
      "is price times quantity per line, no labor field in this " +
      "demo). Check list_spare_parts first for valid " +
      "sparePartIds and prices. On creation the repair moves to ESPERANDO_APROBACION_PRESUPUESTO " +
      "pending fleet owner approval or rejection from the admin panel. No warning here, " +
      "can run directly.",
    zodShape: {
      repairId: z.coerce.number().int().positive().describe("Repair ID"),
      items: z
        .array(
          z.object({
            sparePartId: z.coerce.number().int().positive().describe("Part ID (from list_spare_parts)"),
            quantity: z.coerce.number().int().positive().describe("Quantity of that part"),
          })
        )
        .min(1)
        .describe("One or more part lines"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        repairId: { type: SchemaType.INTEGER, description: "Repair ID" },
        items: {
          type: SchemaType.ARRAY,
          description: "One or more part lines",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              sparePartId: { type: SchemaType.INTEGER, description: "Part ID (from list_spare_parts)" },
              quantity: { type: SchemaType.INTEGER, description: "Quantity of that part" },
            },
            required: ["sparePartId", "quantity"],
          },
        },
      },
      required: ["repairId", "items"],
    },
    async handler({ repairId, items }) {
      return callTaller(`/repairs/${repairId}/budgets`, { method: "POST", body: { items } });
    },
  },
  {
    // Fase 1 del asistente de taller (ver claude/phase_1.md, proyecto "taller"): borrador de
    // presupuesto desde texto libre. Matching "con criterio" — exacto/fuzzy por texto contra
    // el catálogo de daños y el stock de repuestos (damage-matcher.js, sin llamar a ningún
    // proveedor de IA para eso) y SOLO lo que queda ambiguo se deja para que el modelo lo
    // resuelva con su propio criterio dentro de este mismo turno de function-calling (no hay
    // una segunda llamada a un LLM: el "escalar a LLM" es simplemente que el modelo que ya
    // está corriendo esta conversación recibe los candidatos y decide).
    //
    // `structuredType` (leído por ai-provider.js, ver runToolCall) hace que el resultado de
    // esta tool también viaje aparte como `structured` en la respuesta de runAssistant(), para
    // que el frontend (TallerAssistantWidget.jsx) pueda pintar una tarjeta de borrador en vez
    // de depender de que el modelo transcriba los números en texto plano.
    name: "draft_budget_from_damage_description",
    title: "Draft budget from free-text damage",
    structuredType: "budget_draft",
    description:
      "Builds a DRAFT budget from one or more free-text damage descriptions (as shop staff " +
      "would write them, without exact catalog categories), matching each against the damage " +
      "catalog and parts stock with text rules (exact/fuzzy), no extra AI call. Confident " +
      "matches come back as ready lines (part, price, quantity 1). Low-confidence ones come " +
      "back in unresolved with top damage and part candidates for you to judge (never invent " +
      "a sparePartId outside the candidates or list_spare_parts). This is ONLY a draft, it " +
      "creates nothing, do not confuse with create_budget. Show the user the full draft " +
      "(resolved lines plus lines needing judgment, with the resolved total) and ask for " +
      "explicit confirmation of which part to use per unresolved line, and only if confirmed " +
      "offer to call create_budget with the real repairId; unlike other actions here, confirm " +
      "this one first because text matches may be wrong.",
    zodShape: {
      descriptions: z
        .array(z.string().min(1).max(300))
        .min(1)
        .max(10)
        .describe("One or more free-text damage descriptions (max 10 per call)"),
    },
    geminiParameters: {
      type: SchemaType.OBJECT,
      properties: {
        descriptions: {
          type: SchemaType.ARRAY,
          description: "One or more free-text damage descriptions (max 10 per call)",
          items: { type: SchemaType.STRING },
        },
      },
      required: ["descriptions"],
    },
    async handler({ descriptions }) {
      const [damageCatalog, spareParts] = await Promise.all([
        findNavespaceTool("get_damage_catalog").handler(),
        listSparePartsHandler({ activeOnly: true }),
      ]);

      const lines = [];
      const unresolved = [];
      for (const description of descriptions) {
        const match = matchDamageDescription(description, damageCatalog, spareParts);
        if (match.sparePart) {
          const quantity = 1;
          lines.push({
            description,
            damage: match.damage, // puede ser null: cerrar la línea solo depende del repuesto
            sparePartId: match.sparePart.id,
            sparePartName: match.sparePart.name,
            unitPrice: match.sparePart.price,
            quantity,
            subtotal: Number((match.sparePart.price * quantity).toFixed(2)),
            matchMethod: match.sparePart.method,
          });
        } else {
          unresolved.push({
            description,
            damageGuess: match.damage,
            damageCandidates: match.damageCandidates || [],
            partCandidates: match.partCandidates || [],
          });
        }
      }

      const totalAmount = Number(lines.reduce((sum, l) => sum + l.subtotal, 0).toFixed(2));
      return {
        isDraft: true,
        currency: "EUR",
        lines,
        unresolved,
        totalAmount,
        // Métrica de Fase 1.3 ("% de casos resuelto sin tocar el LLM"): cuántas de las
        // descripciones pedidas cerraron por matching de texto vs cuántas necesitan que el
        // modelo (ya corriendo esta conversación) las resuelva con su propio criterio.
        resolvedWithoutLlm: lines.length,
        needsModelJudgment: unresolved.length,
      };
    },
  },
];

export const TALLER_TOOLS = [...reusedTools, ...newTallerTools];

export function findTallerTool(name) {
  return TALLER_TOOLS.find((t) => t.name === name);
}
