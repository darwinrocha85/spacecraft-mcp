// Bench pre/post-harness (Fase 3).
//
// Uso:
//   1. Emulador con backends LOCALES (sin ruido de cold start de Render):
//        firebase emulators:start --only functions,firestore
//      (Firestore en :8085 si querés persistir ai_usage; si no, el uso queda en log.)
//   2. Corrida pre:  HARNESS_PHASE=pre-harness en functions/.env, reiniciar emulador,
//        npm run bench -- --phase=pre
//   3. Corrida post: HARNESS_PHASE=post-harness, reiniciar emulador,
//        npm run bench -- --phase=post --compare=bench/results-pre-<ts>.csv
//
// La fase vive en el SERVIDOR (.env + restart); --phase solo nombra el CSV de salida.
// --verbose imprime el ida y vuelta completo (ideal para `... 2>&1 | rtk`).
// --repeat=1 --delay-ms=8000 por default: Groq gratis da 7000 ITPM y cada pregunta
// pre-harness gasta ~5000 input tokens → ante un 429 espera 65s y reintenta una vez.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QUESTIONS = require("./questions.json");

const BASE = process.env.BENCH_BASE || "http://localhost:5001/spacecraft-mcp/us-central1";
// URLs de prod (una por función, las Cloud Run gen2 no son path-based):
//   $firebase functions:list  →  BENCH_ADMIN_URL=... BENCH_TALLER_URL=... npm run bench
function endpointUrl(endpoint) {
  if (endpoint === "askAdmin" && process.env.BENCH_ADMIN_URL) return process.env.BENCH_ADMIN_URL;
  if (endpoint === "askTaller" && process.env.BENCH_TALLER_URL) return process.env.BENCH_TALLER_URL;
  return `${BASE}/${endpoint}`;
}

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const PHASE = arg("phase", "pre");
const REPEAT = Number(arg("repeat", "1"));
const DELAY_MS = Number(arg("delay-ms", "8000"));
const COMPARE = arg("compare", null);
const VERBOSE = flag("verbose");
// --filter=admin|taller: corre solo la mitad (útil en prod con ITPM chico; el orden
// dentro de cada mitad es el mismo que en questions.json).
const FILTER = arg("filter", "all");
const QUEUE = QUESTIONS.filter(
  (q) => FILTER === "all" || (FILTER === "admin" && q.endpoint === "askAdmin") || (FILTER === "taller" && q.endpoint === "askTaller")
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normaliza usage de groq/gemini/claude (mismo criterio que usage-store.js).
function normUsage(u) {
  if (!u || typeof u !== "object") return { input: 0, output: 0, total: 0 };
  const input = u.prompt_tokens ?? u.promptTokenCount ?? u.prompt_token_count ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.candidatesTokenCount ?? u.candidates_token_count ?? u.output_tokens ?? 0;
  const total = u.total_tokens ?? u.totalTokenCount ?? u.total_token_count ?? input + output;
  return { input, output, total };
}

async function askOnce(endpoint, question) {
  const started = Date.now();
  const res = await fetch(endpointUrl(endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, latencyMs: Date.now() - started, body };
}

async function runQuestion(endpoint, question) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, latencyMs, body } = await askOnce(endpoint, question);
    if (status === 429 && attempt === 0) {
      console.error(`  429 en "${question}" — esperando 65s (cuota Groq)…`);
      await sleep(65_000);
      continue;
    }
    if (status !== 200) {
      return { endpoint, question, latencyMs, error: body?.error || `HTTP ${status}` };
    }
    const usage = normUsage(body.usage);
    const row = {
      endpoint,
      question,
      latencyMs,
      provider: body.provider ?? "",
      model: body.model ?? "",
      family: body.harness?.family ?? "",
      fullTools: body.harness?.fullToolCount ?? "",
      subsetTools: body.harness?.subsetToolCount ?? "",
      toolCalls: Array.isArray(body.toolCalls) ? body.toolCalls.length : "",
      cacheHit: body.cacheHit ? 1 : 0,
      cacheLevel: body.cacheLevel ?? "",
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.total,
      answerChars: (body.answer || "").length,
      error: "",
    };
    if (VERBOSE) {
      console.error(`Q [${endpoint}] ${question}\nA [${row.provider}/${row.model}${row.cacheHit ? `/${row.cacheLevel}` : ""}] ${(body.answer || "").slice(0, 300)}\n`);
    }
    return row;
  }
}

function toCsv(rows) {
  const cols = Object.keys(rows[0]);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const sum = (f) => ok.reduce((a, r) => a + Number(r[f] || 0), 0);
  const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  return {
    n: rows.length,
    ok: ok.length,
    errors: rows.length - ok.length,
    hitRate: ok.length ? (ok.filter((r) => r.cacheHit).length / ok.length).toFixed(2) : "0.00",
    totalTokens: sum("totalTokens"),
    avgLatencyMs: ok.length ? Math.round(sum("latencyMs") / ok.length) : 0,
    p50LatencyMs: p50,
  };
}

function loadCsv(path) {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const cols = lines[0].split(",").map((c) => c.replace(/^"|"$/g, ""));
  return lines.slice(1).map((l) => {
    // CSV simple del propio bench (las questions no tienen comas problemáticas escapadas
    // más allá de "" — parseo mínimo suficiente).
    const cells = l.match(/"(?:[^"]|"")*"|[^,]+/g) || [];
    const row = {};
    cols.forEach((c, i) => {
      row[c] = (cells[i] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"');
    });
    return row;
  });
}

const allRows = [];
for (let rep = 1; rep <= REPEAT; rep++) {
  console.error(`--- repeat ${rep}/${REPEAT} (${QUEUE.length} preguntas, filter=${FILTER}) ---`);
  for (const { endpoint, question } of QUEUE) {
    process.stdout.write(`  [${endpoint}] ${question} … `);
    const row = await runQuestion(endpoint, question);
    console.log(row.error ? `ERROR: ${row.error}` : `${row.totalTokens} tok / ${row.latencyMs}ms${row.cacheHit ? ` / ${row.cacheLevel}` : ""} / fam:${row.family || "-"}`);
    allRows.push({ rep, ...row });
    await sleep(DELAY_MS);
  }
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = `bench/results-${PHASE}-${ts}.csv`;
writeFileSync(outPath, toCsv(allRows));
console.error(`\nCSV: ${outPath}`);

const s = summarize(allRows);
console.log(`\nRESUMEN ${PHASE}: n=${s.n} ok=${s.ok} errores=${s.errors} hitRate=${s.hitRate} totalTokens=${s.totalTokens} avgLat=${s.avgLatencyMs}ms p50Lat=${s.p50LatencyMs}ms`);

if (COMPARE) {
  const pre = loadCsv(COMPARE);
  const preSum = summarize(pre);
  const pct = (a, b) => (b ? (((b - a) / b) * 100).toFixed(1) : "0.0");
  console.log(
    `\nVS ${COMPARE}: tokens ${s.totalTokens} vs ${preSum.totalTokens} (${pct(s.totalTokens, preSum.totalTokens)}% ahorro) · ` +
      `avgLat ${s.avgLatencyMs}ms vs ${preSum.avgLatencyMs}ms · hitRate post=${s.hitRate}`
  );
}
