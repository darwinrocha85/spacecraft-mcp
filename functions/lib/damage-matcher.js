// Matching "con criterio" para el borrador de presupuesto del taller (Fase 1 del asistente
// `askTaller`, ver claude/phase_1.md del proyecto "taller"). Puro y sin dependencias externas
// a propósito (nada de Levenshtein/fuzzy de npm) — barato y fácil de auditar/testear.
//
// Estrategia en dos pasos, en ese orden (más barato primero):
//   1. Exacto: el texto libre contiene (o es contenido por) la etiqueta del candidato
//      (subtipo de daño o nombre de repuesto), normalizada (sin acentos, minúsculas).
//   2. Fuzzy: similitud por trigramas de caracteres con coeficiente de contención (qué
//      fracción de los trigramas de la etiqueta aparece en el texto largo) — funciona mejor
//      que Dice simétrico cuando el texto libre es mucho más largo que la etiqueta corta.
//      Si supera `threshold`, se toma el mejor candidato.
// Si ni exacto ni fuzzy encuentran un repuesto con confianza suficiente, no se inventa nada
// acá: se devuelven los mejores candidatos (aunque estén debajo del umbral) para que quien
// llama (el modelo, dentro del mismo turno de function-calling) decida con criterio propio —
// esa es la única vez que "se escala a LLM", sin una segunda llamada a ningún proveedor.
//
// Hallazgo de diseño (ver Fase 1.1 de phase_1.md): clasificar el TIPO de daño (subtipo) no
// implica saber qué REPUESTO usar — no existe una tabla que los vincule. Por eso lo que decide
// si un caso "cierra sin LLM" es si se encontró un repuesto con confianza, no si se clasificó
// el daño (eso lo decide el llamador, ver taller-tools.js).

const DEFAULT_THRESHOLD = 0.42;

function normalize(text) {
  return (text || "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(text) {
  const padded = `  ${text} `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

// Coeficiente de contención: qué fracción de los trigramas del candidato (normalmente corto)
// aparece en el texto libre (normalmente largo). A propósito NO es el Dice simétrico
// (2*compartidos/(size_a+size_b)) porque ese castiga la diferencia de longitud entre una
// frase larga y una etiqueta de 1-3 palabras, aunque la etiqueta esté completamente presente.
function similarity(description, label) {
  const nd = normalize(description);
  const nl = normalize(label);
  if (!nd || !nl) return 0;
  if (nd === nl) return 1;
  const gd = trigrams(nd);
  const gl = trigrams(nl);
  if (gl.size === 0) return 0;
  let shared = 0;
  for (const g of gl) if (gd.has(g)) shared++;
  return shared / gl.size;
}

function isExactMatch(description, label) {
  const nd = normalize(description);
  const nl = normalize(label);
  if (!nd || !nl) return false;
  return nd.includes(nl) || nl.includes(nd);
}

function bestMatch(description, candidates, threshold) {
  let best = null;
  for (const item of candidates) {
    if (isExactMatch(description, item.label)) {
      if (!best || best.method !== "exact") best = { item, score: 1, method: "exact" };
      continue;
    }
    if (best?.method === "exact") continue;
    const score = similarity(description, item.label);
    if (score >= threshold && (!best || score > best.score)) {
      best = { item, score: Number(score.toFixed(3)), method: "fuzzy" };
    }
  }
  return best;
}

function topCandidates(description, candidates, n) {
  return candidates
    .map((item) => ({ ...item, score: Number(similarity(description, item.label).toFixed(3)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/**
 * @param {string} description texto libre del daño reportado.
 * @param {Record<string, {label: string, subtypes: string[]}>} damageCatalog forma de
 *   GET /catalog/damages tal cual la devuelve el backend de taller.
 * @param {Array<{id: number, name: string, price: number, active?: boolean}>} spareParts
 * @param {number} [threshold] umbral de confianza fuzzy (0-1), default 0.42.
 * @returns {{
 *   damage: {category:string, subtype:string, method:string, score:number}|null,
 *   damageCandidates?: Array<{category:string, subtype:string, score:number}>,
 *   sparePart: {id:number, name:string, price:number, method:string, score:number}|null,
 *   partCandidates?: Array<{id:number, name:string, price:number, score:number}>,
 * }}
 */
function matchDamageDescription(description, damageCatalog, spareParts, threshold = DEFAULT_THRESHOLD) {
  const damageCandidates = [];
  for (const [category, entry] of Object.entries(damageCatalog || {})) {
    for (const subtype of entry.subtypes || []) {
      damageCandidates.push({ category, subtype, label: subtype });
    }
  }
  const partCandidates = (spareParts || [])
    .filter((p) => p.active !== false)
    .map((p) => ({ id: p.id, name: p.name, price: p.price, label: p.name }));

  const damageMatch = bestMatch(description, damageCandidates, threshold);
  const partMatch = bestMatch(description, partCandidates, threshold);

  const result = {
    damage: damageMatch
      ? { category: damageMatch.item.category, subtype: damageMatch.item.subtype, method: damageMatch.method, score: damageMatch.score }
      : null,
    sparePart: partMatch
      ? { id: partMatch.item.id, name: partMatch.item.name, price: partMatch.item.price, method: partMatch.method, score: partMatch.score }
      : null,
  };
  if (!result.damage) result.damageCandidates = topCandidates(description, damageCandidates, 3);
  if (!result.sparePart) result.partCandidates = topCandidates(description, partCandidates, 3);
  return result;
}

export { normalize, similarity, matchDamageDescription, DEFAULT_THRESHOLD };
