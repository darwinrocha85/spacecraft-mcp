import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { NAVESPACE_TOOLS } from "./lib/navespace-tools.js";
import { TALLER_TOOLS } from "./lib/taller-tools.js";

// Servidor MCP de naveSpace — SOLO LECTURA para clientes externos (Claude Desktop/Code u
// otro). Las tools de escritura (crear/borrar/enviar a taller/cobros) NO se exponen acá:
// solo viven en ask-admin.js y ask-taller.js, donde el SYSTEM_PROMPT pide confirmación
// antes de ejecutar. Un cliente MCP directo no tiene esa red de seguridad, así que el
// catálogo público se filtra por denylist: si algún día se agrega una tool de escritura
// nueva, hay que sumarla a WRITE_TOOL_NAMES o quedará expuesta.
//
// Vive en su proyecto Firebase propio (`spacecraft-mcp`), separado de los frontends: el
// panel admin y la app del taller son clientes HTTP delgados (sus widgets llaman a askAdmin
// y askTaller por URL directa). Una sola copia de cada lib — la duplicación
// admin/taller anterior (mismo ai-provider, chat-utils, damage-matcher en dos repos, y 6
// tools de lectura copiadas en vez de reusadas) muere acá: taller-tools.js reusa por
// referencia las tools de lectura de navespace-tools.js (mismo backend/endpoint).
//
// Alcance del MCP público: solo lectura (ver WRITE_TOOL_NAMES). La escritura vive solo en
// los chats embebidos, donde el SYSTEM_PROMPT pide confirmación antes de ejecutar —
// precisamente porque un cliente MCP directo no tiene esa red de seguridad. Aprobar un
// presupuesto de taller (cobra tarjeta real contra BankIn) no existe en ningún catálogo,
// solo en el panel admin.
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
    content: [{ type: "text", text: `Error querying naveSpace: ${err.message}` }],
    isError: true,
  };
}

// Denylist de escritura para el MCP público (ver comentario arriba). Los ask-* usan los
// catálogos completos sin filtrar.
const WRITE_TOOL_NAMES = new Set([
  // naveSpace (admin)
  "create_spacecraft",
  "update_spacecraft",
  "delete_spacecraft",
  "save_museum_schedule_day",
  "create_theater_event",
  "update_theater_event",
  "delete_theater_event",
  "send_spacecraft_to_taller",
  "confirm_ship_operational",
  "reject_budget",
  "receive_ship_from_taller",
  // taller
  "confirm_repair_receipt",
  "advance_repair_status",
  "create_spare_part",
  "update_spare_part",
  "deactivate_spare_part",
  "create_budget",
]);

// TALLER_TOOLS reusa por referencia varias tools de NAVESPACE_TOOLS (mismo objeto, ver
// taller-tools.js) — se deduplica por `name` para no registrar la misma tool dos veces en
// un mismo McpServer.
const ALL_TOOLS = [...NAVESPACE_TOOLS];
const navespaceNames = new Set(NAVESPACE_TOOLS.map((t) => t.name));
for (const tool of TALLER_TOOLS) {
  if (!navespaceNames.has(tool.name)) ALL_TOOLS.push(tool);
}

// Catálogo público = todo menos escritura. Exportado para testear el filtro sin levantar
// el servidor (node: importar index.js y revisar PUBLIC_TOOLS).
export const PUBLIC_TOOLS = ALL_TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.name));

function buildServer() {
  const server = new McpServer(
    { name: "spacecraft-mcp", version: "0.2.0" },
    {
      instructions:
        "READ-ONLY tools over live naveSpace-admin and repair shop data " +
        "(fleet, museum, theater, repairs, spare parts stock and " +
        "budgets). No writes here: create, edit, delete or send to shop " +
        "only exist in the embedded chats (which ask for confirmation before running). " +
        "Backends run on Render free tier: first call after idle " +
        "may take up to about 60s (cold start) before responding.",
    }
  );

  for (const tool of PUBLIC_TOOLS) {
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
            message: "Method not allowed. This MCP server is stateless: use POST.",
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
