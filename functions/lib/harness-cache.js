// Harness Fase 2b — caché L1 exacto/normalizado (determinístico, sin riesgo).
//
// Qué cachea: el MAPEO pregunta → { tool, args }, NO los datos. En un hit la tool
// se ejecuta igual contra el backend (dato siempre fresco), lo que se evita es la
// llamada al LLM (0 tokens de modelo). Por eso una escritura válida NO necesita
// invalidar nada: el mapeo "stock" → list_spare_parts sigue valiendo después de
// crear un repuesto, porque los datos se releen en cada hit.
//
// Reglas (de harness-phases.md):
// - Namespaces separados askAdmin/askTaller (la key incluye el endpoint).
// - Solo tools de lectura con args estables (TOOL_TTL_MS). Lo demás nunca se aprende.
// - Miss forzado si piden estado fresco/actual, disponibilidad, ventas o saldos.
// - Seeds: puñado de preguntas frecuentes cableadas; el resto se aprende solo cuando
//   un turno usa UNA sola tool de lectura (el caller lo verifica con result.toolCalls).
//
// Storage, dos instalaciones (mismo código):
// - LOCAL (emulador): memoria LRU + SQLite en functions/.harness-cache.sqlite vía
//   node:sqlite (built-in de Node 22+, cero deps nativas; en prod con Node 20 el
//   import falla y se ignora en silencio).
// - PROD: memoria LRU + Firestore `ai_cache` (misma infra que ai_usage).
// Nunca rompe el chat: todo el I/O va en try/catch y ante cualquier error es miss.

import { normalize } from "./damage-matcher.js";

const MEM_CAP = 200;
const mem = new Map(); // key -> { tool, args, family, expiresAt }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Solo estas tools aprenden mapeos (lectura, args estables). El valor es el TTL del
// mapeo. Lo que cambia rápido (disponibilidad, ventas, saldos, estados) NO está acá:
// siempre es miss y va al LLM.
const TOOL_TTL_MS = {
  list_spacecrafts: 4 * HOUR,
  list_venues: 4 * HOUR,
  get_damage_catalog: 12 * HOUR,
  list_spare_parts: 1 * HOUR,
  get_spacecraft: 15 * MINUTE,
  get_museum_schedule: 15 * MINUTE,
  list_theater_events: 15 * MINUTE,
  get_shop_repairs: 5 * MINUTE,
  get_repairs_for_spacecraft: 5 * MINUTE,
  get_repair_history: 5 * MINUTE,
  get_repair_detail: 5 * MINUTE,
  get_budgets: 5 * MINUTE,
  get_fleet_overview: 1 * MINUTE, // resumen general: cambia con cada venta, TTL mínimo
};

// Miss forzado: piden dato fresco o de algo que cambia rápido.
const FORCED_MISS_RE = /\b(fresc|actual|ahora|hoy|disponib|vent|vend|sald|recaud|cambi)/;

// Seeds por endpoint (pregunta ya normalizada → mapeo). Cubren las preguntas del bench
// y las más repetidas del demo.
function seed(endpoint, question, tool, args = {}, family = "seed") {
  return { key: cacheKey(endpoint, question), tool, args, family, seed: true };
}
function seedsFor(endpoint) {
  if (endpoint === "askTaller") {
    return [
      seed(endpoint, "lista las naves", "list_spacecrafts", {}, "fleet"),
      seed(endpoint, "dame las naves", "list_spacecrafts", {}, "fleet"),
      seed(endpoint, "stock", "list_spare_parts", { activeOnly: true }, "stock"),
      seed(endpoint, "lista de repuestos", "list_spare_parts", { activeOnly: true }, "stock"),
      seed(endpoint, "que repuestos hay", "list_spare_parts", { activeOnly: true }, "stock"),
      seed(endpoint, "reparaciones en taller", "get_shop_repairs", {}, "shop_state"),
      seed(endpoint, "naves en taller", "get_shop_repairs", {}, "shop_state"),
    ];
  }
  return [
    seed(endpoint, "lista las naves", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "dame las naves", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "mostrame la flota", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "muestrame la flota", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "lista la flota", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "necesito todos los carros", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "todas las naves", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "que naves hay", "list_spacecrafts", {}, "fleet"),
    seed(endpoint, "resumen general", "get_fleet_overview", {}, "dashboard"),
    seed(endpoint, "catalogo de danos", "get_damage_catalog", {}, "shop"),
  ];
}

export function isHarnessActive() {
  return (process.env.HARNESS_PHASE || "pre-harness").trim() === "post-harness";
}

export function normalizeQuestion(question) {
  return normalize(question).replace(/\s+/g, " ").trim().slice(0, 500);
}

export function cacheKey(endpoint, question) {
  return `${endpoint} :: ${normalizeQuestion(question)}`;
}

export function isForcedMiss(question) {
  return FORCED_MISS_RE.test(normalizeQuestion(question));
}

function memGet(key) {
  const entry = mem.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    mem.delete(key);
    return null;
  }
  // LRU: reinsertar al final.
  mem.delete(key);
  mem.set(key, entry);
  return entry;
}

function memSet(key, { tool, args, family, ttlMs }) {
  if (mem.size >= MEM_CAP) {
    const oldest = mem.keys().next().value;
    mem.delete(oldest);
  }
  mem.set(key, { tool, args, family, expiresAt: Date.now() + ttlMs });
}

// ---------- SQLite local (solo emulador / HARNESS_SQLITE_PATH) ----------

let sqliteDb = null;
let sqliteTried = false;

function sqlitePath() {
  if (process.env.HARNESS_SQLITE_PATH) return process.env.HARNESS_SQLITE_PATH;
  // Solo fuera de prod: en Cloud Functions nunca hay .harness-cache (ni node:sqlite en Node 20).
  if (process.env.FUNCTIONS_EMULATOR === "true" || !process.env.FUNCTIONS_EMULATOR) {
    try {
      const url = new URL("../.harness-cache.sqlite", import.meta.url);
      return url.pathname.replace(/^\/(?=[A-Za-z]:\/)/, "");
    } catch {
      return null;
    }
  }
  return null;
}

async function sqlite() {
  if (sqliteTried) return sqliteDb;
  sqliteTried = true;
  const path = sqlitePath();
  if (!path) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    sqliteDb = new DatabaseSync(path);
    sqliteDb.exec(
      "CREATE TABLE IF NOT EXISTS harness_l1 " +
        "(key TEXT PRIMARY KEY, endpoint TEXT, tool TEXT, args TEXT, family TEXT, expires_at INTEGER)"
    );
    return sqliteDb;
  } catch {
    sqliteDb = null;
    return null;
  }
}

async function sqliteGet(key) {
  try {
    const db = await sqlite();
    if (!db) return null;
    const row = db.prepare("SELECT tool, args, family, expires_at FROM harness_l1 WHERE key = ?").get(key);
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      db.prepare("DELETE FROM harness_l1 WHERE key = ?").run(key);
      return null;
    }
    return { tool: row.tool, args: JSON.parse(row.args), family: row.family };
  } catch {
    return null;
  }
}

async function sqliteSet(key, { endpoint, tool, args, family, ttlMs }) {
  try {
    const db = await sqlite();
    if (!db) return;
    db.prepare(
      "INSERT OR REPLACE INTO harness_l1 (key, endpoint, tool, args, family, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(key, endpoint, tool, JSON.stringify(args), family, Date.now() + ttlMs);
  } catch {
    // Nunca romper el chat por el caché.
  }
}

// ---------- Firestore prod (colección ai_cache) ----------

function firestoreGuarded() {
  // Misma regla que usage-store: en emulador sin Firestore, no tocar nada.
  if (process.env.FUNCTIONS_EMULATOR === "true" && !process.env.FIRESTORE_EMULATOR_HOST) return false;
  return true;
}

function docIdFor(key) {
  return Buffer.from(key, "utf8").toString("base64url");
}

async function firestoreGet(key) {
  if (!firestoreGuarded()) return null;
  try {
    const { getApps, initializeApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    if (getApps().length === 0) initializeApp();
    const snap = await getFirestore().collection("ai_cache").doc(docIdFor(key)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data || !data.tool || Date.now() > (data.expiresAt ?? 0)) return null;
    return { tool: data.tool, args: data.args ?? {}, family: data.family ?? "learned" };
  } catch {
    return null;
  }
}

async function firestoreSet(key, { endpoint, tool, args, family, ttlMs }) {
  if (!firestoreGuarded()) return;
  try {
    const { getApps, initializeApp } = await import("firebase-admin/app");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
    if (getApps().length === 0) initializeApp();
    await getFirestore()
      .collection("ai_cache")
      .doc(docIdFor(key))
      .set({
        endpoint,
        questionNorm: key,
        tool,
        args,
        family,
        hits: FieldValue.increment(1),
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Date.now() + ttlMs,
      });
  } catch {
    // Nunca romper el chat por el caché.
  }
}

/**
 * Lookup L1. Devuelve null (miss) o { tool, args, family, level }.
 * level: L1-seed | L1-mem | L1-sqlite | L1-firestore (para métricas en ai_usage).
 */
export async function lookupL1({ endpoint, question }) {
  const key = cacheKey(endpoint, question);
  if (!key.split("::")[1].trim()) return null;

  const seedHit = seedsFor(endpoint).find((s) => s.key === key);
  if (seedHit && !isForcedMiss(question)) {
    return { tool: seedHit.tool, args: seedHit.args, family: seedHit.family, level: "L1-seed", key };
  }
  if (isForcedMiss(question)) return null;

  const fromMem = memGet(key);
  if (fromMem) return { ...fromMem, level: "L1-mem", key };

  const fromSqlite = await sqliteGet(key);
  if (fromSqlite) {
    const ttlMs = TOOL_TTL_MS[fromSqlite.tool] ?? 5 * MINUTE;
    memSet(key, { ...fromSqlite, ttlMs });
    return { ...fromSqlite, level: "L1-sqlite", key };
  }

  const fromFirestore = await firestoreGet(key);
  if (fromFirestore) {
    const ttlMs = TOOL_TTL_MS[fromFirestore.tool] ?? 5 * MINUTE;
    memSet(key, { ...fromFirestore, ttlMs });
    return { ...fromFirestore, level: "L1-firestore", key };
  }

  return null;
}

/**
 * Aprende un mapeo después de un turno que usó UNA sola tool de lectura.
 * Devuelve true si se guardó. Nunca tira.
 */
export async function learnL1({ endpoint, question, tool, args, family }) {
  try {
    const ttlMs = TOOL_TTL_MS[tool];
    if (!ttlMs) return false; // no aprendible (escritura o dato volátil)
    if (isForcedMiss(question)) return false;
    const stable = args && typeof args === "object" && JSON.stringify(args).length < 500 ? args : null;
    if (!stable) return false;
    const key = cacheKey(endpoint, question);
    memSet(key, { tool, args: stable, family, ttlMs });
    await sqliteSet(key, { endpoint, tool, args: stable, family, ttlMs });
    await firestoreSet(key, { endpoint, tool, args: stable, family, ttlMs });
    return true;
  } catch {
    return false;
  }
}

/** Estimación de tokens evitados en un hit: prefijo completo que NO se mandó al LLM. */
export function estimateTokensAvoided({ systemPrompt, fullTools }) {
  try {
    const paramsLen = JSON.stringify(
      fullTools.map((t) => ({ n: t.name, d: t.description, p: t.geminiParameters }))
    ).length;
    return Math.round(((systemPrompt || "").length + paramsLen) / 4);
  } catch {
    return 0;
  }
}

// Respuesta en español plano (sin Markdown, como exige el widget) para un hit L1.
// La tool ya se ejecutó: esto solo verbaliza el dato fresco.
export function formatCachedAnswer(toolName, data) {
  try {
    if (Array.isArray(data)) {
      const names = data
        .map((d) => d?.name ?? d?.title ?? d?.id)
        .filter(Boolean)
        .slice(0, 20);
      const extra = data.length > names.length ? ` (y ${data.length - names.length} más)` : "";
      if (toolName === "list_spare_parts") {
        const lines = data.slice(0, 20).map((p) => `- ${p.name}: ${p.price} euros`);
        return `Hay ${data.length} repuestos en stock:\n${lines.join("\n")}${extra}`;
      }
      if (toolName === "get_shop_repairs") {
        return `Hay ${data.length} reparaciones en el taller${names.length ? ": " + names.join(", ") : ""}${extra}`;
      }
      return `Hay ${data.length} naves en la flota: ${names.join(", ")}${extra}`;
    }
    if (data && typeof data === "object") {
      const text = JSON.stringify(data);
      if (text.length <= 1200) return `Según los datos actuales: ${text}`;
      return `Dato actual recuperado (${text.length} caracteres, se muestra el inicio): ${text.slice(0, 1200)}`;
    }
    return `Dato actual: ${String(data)}`;
  } catch {
    return "Dato actual recuperado, pero no se pudo formatear. Probá de nuevo.";
  }
}
