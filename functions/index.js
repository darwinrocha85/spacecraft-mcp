import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { NAVESPACE_TOOLS } from "./lib/navespace-tools.js";
import { TALLER_TOOLS } from "./lib/taller-tools.js";

// Servidor MCP de naveSpace — expone datos y ACCIONES EN VIVO sobre la flota (naveSpace +
// el taller que el panel admin orquesta) como herramientas MCP, para cualquier cliente MCP
// (Claude Desktop/Code, u otro) y como base de los asistentes embebidos (ask-admin.js y
// ask-taller.js, que reusan los mismos catálogos sin pasar por HTTP/MCP — este archivo es
// la interfaz MCP "pública", los ask-* son consumidores directos en el mismo proceso).
//
// Vive en su proyecto Firebase propio (`spacecraft-mcp`), separado de los frontends: el
// panel admin y la app del taller son clientes HTTP delgados (sus widgets llaman a askAdmin
// y askTaller por URL directa). Una sola copia de cada lib — la duplicación
// admin/taller anterior (mismo ai-provider, chat-utils, damage-matcher en dos repos, y 6
// tools de lectura copiadas en vez de reusadas) muere acá: taller-tools.js reusa por
// referencia las tools de lectura de navespace-tools.js (mismo backend/endpoint).
//
// Alcance: TODOS los endpoints que consumen los frontends, lectura y escritura, salvo
// aprobar un presupuesto de taller (cobra una tarjeta real contra BankIn — queda fuera a
// propósito, solo disponible desde el panel admin).
//
// IMPORTANTE sobre confirmación: acá, a nivel de tool MCP, no hay ningún gating — cualquier
// cliente conectado puede llamar directo a delete_spacecraft, send_spacecraft_to_taller, etc.
// La única capa que pide confirmación antes de ejecutar acciones destructivas/con impacto
// vive en los SYSTEM_PROMPT de ask-admin.js / ask-taller.js, no acá. Un cliente MCP que
// llegue por otro lado (Claude Desktop, por ejemplo) depende de su propio mecanismo de
// confirmación de tool calls — las `description` de cada tool ya avisan cuáles requieren
// confirmación humana antes de llamarse.
//
// Decisión de diseño: stateless. El SDK oficial de MCP soporta explícitamente un modo sin
// sesión para Streamable HTTP (sessionIdGenerator: undefined) — cada invocación crea su
// propio McpServer + transport efímeros y los descarta al terminar. Encaja con serverless
// y evita sumar Firestore u otra base solo para sostener sesiones MCP.

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err) {
  console.error("spacecraft-mcp tool error:", err);
  return {
    content: [{ type: "text", text: `Error consultando naveSpace: ${err.message}` }],
    isError: true,
  };
}

// TALLER_TOOLS reusa por referencia varias tools de NAVESPACE_TOOLS (mismo objeto, ver
// taller-tools.js) — se deduplica por `name` para no registrar la misma tool dos veces en
// un mismo McpServer.
const ALL_TOOLS = [...NAVESPACE_TOOLS];
const navespaceNames = new Set(NAVESPACE_TOOLS.map((t) => t.name));
for (const tool of TALLER_TOOLS) {
  if (!navespaceNames.has(tool.name)) ALL_TOOLS.push(tool);
}

function buildServer() {
  const server = new McpServer(
    { name: "spacecraft-mcp", version: "0.1.0" },
    {
      instructions:
        "Herramientas de lectura Y ESCRITURA sobre datos en vivo de naveSpace-admin y del " +
        "taller de reparación (flota, museo, teatro, ciclo de taller completo incluyendo " +
        "stock de repuestos y presupuestos). No incluye aprobar un presupuesto de taller " +
        "(cobra una tarjeta real contra BankIn, queda fuera a propósito). Antes de llamar a " +
        "una tool cuya description indique que requiere confirmación (acciones destructivas " +
        "o con impacto real: borrar una nave, borrar una función de teatro, enviar una nave " +
        "al taller), mostrale al usuario qué va a pasar y pedile confirmación explícita " +
        "antes de ejecutarla — no lo asumas. Los backends corren en Render free tier: la " +
        "primera llamada tras un rato de inactividad puede tardar hasta ~60s (cold start) " +
        "antes de responder.",
    }
  );

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.zodShape },
      async (args) => {
        try {
          return textResult(await tool.handler(args));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  return server;
}

const corsHandler = cors({ origin: true });

// Endpoint único, stateless: cada POST arma su propio McpServer + StreamableHTTPServerTransport
// (sessionIdGenerator: undefined = sin sesión) y los cierra al terminar la request. GET/DELETE
// no tienen sentido sin sesión, así que responden 405 siguiendo el ejemplo oficial del SDK
// para modo stateless.
export const mcp = onRequest(
  { region: "us-central1", cors: true, maxInstances: 5, timeoutSeconds: 90 },
  async (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed. Este servidor MCP es stateless: usá POST.",
          },
          id: null,
        });
        return;
      }

      let server;
      let transport;
      try {
        server = buildServer();
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        // req.body ya viene parseado por Firebase Functions (Express) cuando el
        // Content-Type es application/json — se lo pasamos directo al transport para que
        // no intente releer el stream de la request.
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("spacecraft-mcp request error:", err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });
  }
);

export { askAdmin } from "./ask-admin.js";
export { askTaller } from "./ask-taller.js";
