import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Persistencia de uso de IA para comparar pre/post-harness (ver HARNESS_PHASE en .env).
// Un documento por request en la colección `ai_usage`: proveedor, modelo, tokens
// normalizados (Gemini y Claude traen formas distintas), latencia y métricas del borrador
// de presupuesto si hubo. Sin PII: de la pregunta solo se guarda la longitud.
//
// Diseñado para no romper nunca el chat: si Firestore no está disponible (emulador sin
// Firestore levantado, proyecto sin base creada), escribe solo el log y sigue. En el
// emulador de Functions SIN emulador de Firestore se salta la escritura a propósito para
// no contaminar prod con pruebas locales — para persistir en local, levantar con
// `firebase emulators:start --only functions,firestore`.

const COLLECTION = "ai_usage";

function db() {
  if (getApps().length === 0) initializeApp();
  return getFirestore();
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input =
    usage.input_tokens ?? usage.promptTokenCount ?? usage.prompt_token_count ?? usage.prompt_tokens;
  const output =
    usage.output_tokens ?? usage.candidatesTokenCount ?? usage.candidates_token_count ?? usage.completion_tokens;
  const total =
    usage.total_tokens ?? usage.totalTokenCount ?? usage.total_token_count;
  const cached =
    usage.cache_read_input_tokens ?? usage.cachedContentTokenCount ?? undefined;
  const out = {};
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (total !== undefined) out.total = total;
  if (cached !== undefined) out.cached = cached;
  return Object.keys(out).length ? out : undefined;
}

export function buildUsageRecord({ endpoint, result, latencyMs, questionLength, historyTurns, harness }) {
  const draft =
    result?.structured?.type === "budget_draft" ? result.structured.payload : null;
  const usage = normalizeUsage(result?.usage);
  // Harness (Fase 2/2b): solo se incluyen los campos definidos — Firestore rechaza
  // fields `undefined` (misma lección que budgetDraft).
  const harnessFields =
    harness && (harness.family || harness.cacheHit)
      ? {
          harness: {
            ...(harness.family ? { family: harness.family } : {}),
            ...(harness.fullToolCount !== undefined ? { fullToolCount: harness.fullToolCount } : {}),
            ...(harness.subsetToolCount !== undefined ? { subsetToolCount: harness.subsetToolCount } : {}),
            ...(harness.cacheHit !== undefined ? { cacheHit: harness.cacheHit } : {}),
            ...(harness.cacheLevel ? { cacheLevel: harness.cacheLevel } : {}),
            ...(harness.tokensAvoided !== undefined ? { tokensAvoided: harness.tokensAvoided } : {}),
          },
        }
      : {};
  return {
    // ts se pisa con serverTimestamp al guardar (el ISO queda para el log).
    ts: new Date().toISOString(),
    harnessPhase: process.env.HARNESS_PHASE || "pre-harness",
    endpoint,
    provider: result?.provider,
    // `model` falta en modo mock y `usage` en hits L1 (0 tokens): Firestore rechaza
    // fields `undefined`, así que van solo si definidos (misma lección que budgetDraft).
    ...(result?.model !== undefined ? { model: result.model } : {}),
    mock: Boolean(result?.mock),
    ...(usage !== undefined ? { usage } : {}),
    ...(result?.usage !== undefined ? { usageRaw: result.usage } : {}),
    latencyMs,
    questionLength,
    historyTurns,
    ...harnessFields,
    // budgetDraft solo cuando hubo borrador: Firestore rechaza fields `undefined` y
    // sin esto NINGÚN documento de askAdmin se persistía (visto en logs de prod).
    ...(draft
      ? {
          budgetDraft: {
            resolvedWithoutLlm: draft.resolvedWithoutLlm,
            needsModelJudgment: draft.needsModelJudgment,
          },
        }
      : {}),
  };
}

export async function saveUsage(record) {
  // Salta Firestore en emulador sin Firestore: evita mezclar pruebas locales con prod.
  if (process.env.FUNCTIONS_EMULATOR === "true" && !process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(JSON.stringify({ event: "usage_skipped_no_firestore_emulator", ...record }));
    return;
  }
  try {
    await db()
      .collection(COLLECTION)
      .add({ ...record, ts: FieldValue.serverTimestamp() });
  } catch (err) {
    // Nunca romper el chat por el almacenamiento: log y seguir.
    console.warn("usage-store: no se pudo guardar en Firestore, solo log.", err?.message);
    console.log(JSON.stringify({ event: "usage_unpersisted", ...record }));
  }
}
