import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 3002;
const API_URL = process.env.API_URL || "https://elon-watcher-production.up.railway.app";

// Helper to call the backend API
async function apiCall(method, path, body = null) {
  const url = `${API_URL}${path}`;
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  return res.json();
}

// Create MCP server
function createServer() {
  const server = new McpServer({
    name: "pinchme",
    version: "1.0.0",
  });

  // Tool: List handles
  server.tool(
    "list_handles",
    "List all Twitter/X handles being monitored",
    {},
    async () => {
      try {
        const config = await apiCall("GET", "/config");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              handles: config.handles || [],
              count: (config.handles || []).length,
              pollIntervalMinutes: config.pollIntervalMinutes,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Add handle
  server.tool(
    "add_handle",
    "Add a Twitter/X handle to monitor",
    { handle: { type: "string", description: "Twitter/X username (without @)" } },
    async ({ handle }) => {
      try {
        const config = await apiCall("GET", "/config");
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        if (config.handles.includes(cleanHandle)) {
          return { content: [{ type: "text", text: `@${cleanHandle} is already being monitored` }] };
        }
        config.handles.push(cleanHandle);
        await apiCall("PUT", "/config", config);
        return { content: [{ type: "text", text: `Added @${cleanHandle}. Now tracking ${config.handles.length} accounts.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Remove handle
  server.tool(
    "remove_handle",
    "Remove a Twitter/X handle from monitoring",
    { handle: { type: "string", description: "Twitter/X username to remove" } },
    async ({ handle }) => {
      try {
        const config = await apiCall("GET", "/config");
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        if (!config.handles.includes(cleanHandle)) {
          return { content: [{ type: "text", text: `@${cleanHandle} is not being monitored` }] };
        }
        config.handles = config.handles.filter((h) => h !== cleanHandle);
        await apiCall("PUT", "/config", config);
        return { content: [{ type: "text", text: `Removed @${cleanHandle}. Now tracking ${config.handles.length} accounts.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Poll now
  server.tool(
    "poll_now",
    "Trigger an immediate poll for new tweets",
    {},
    async () => {
      try {
        await apiCall("POST", "/poll");
        return { content: [{ type: "text", text: "Poll triggered. New tweets will be sent shortly." }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Get recent tweets
  server.tool(
    "get_recent_tweets",
    "Get recently captured tweets",
    { limit: { type: "number", description: "Number of tweets (default: 10)" } },
    async ({ limit = 10 }) => {
      try {
        const data = await apiCall("GET", `/sent-tweets?limit=${Math.min(limit, 50)}`);
        if (data.length === 0) {
          return { content: [{ type: "text", text: "No recent tweets found" }] };
        }
        const summary = data.map((t) => ({
          handle: `@${t.handle}`,
          text: t.tweet_text?.substring(0, 100) + (t.tweet_text?.length > 100 ? "..." : ""),
          status: t.status,
          time: t.created_at,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Get status
  server.tool(
    "get_status",
    "Get current monitoring status",
    {},
    async () => {
      try {
        const [config, status] = await Promise.all([
          apiCall("GET", "/config"),
          apiCall("GET", "/status"),
        ]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              handles: config.handles?.length || 0,
              pollIntervalMinutes: config.pollIntervalMinutes,
              webhookConfigured: !!config.webhookUrl,
              lastPoll: status.state?.lastPoll || null,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  return server;
}

// Express app
const app = express();
app.use(cors());
app.use(express.json());

// Store transports
const transports = {};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "pinchme-mcp" });
});

// Root info
app.get("/", (req, res) => {
  res.json({
    name: "PinchMe MCP Server",
    version: "1.0.0",
    endpoints: { sse: "/sse", health: "/health" },
    tools: ["list_handles", "add_handle", "remove_handle", "poll_now", "get_recent_tweets", "get_status"],
  });
});

// SSE endpoint
app.get("/sse", async (req, res) => {
  console.log("[SSE] New connection");
  
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;
  
  const server = createServer();
  
  res.on("close", () => {
    console.log(`[SSE] Connection closed: ${sessionId}`);
    delete transports[sessionId];
  });
  
  await server.connect(transport);
  console.log(`[SSE] Connected: ${sessionId}`);
});

// Messages endpoint
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`[MSG] Received for session: ${sessionId}`);
  
  const transport = transports[sessionId];
  if (!transport) {
    console.log(`[MSG] Session not found: ${sessionId}`);
    res.status(404).json({ error: "Session not found" });
    return;
  }
  
  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error(`[MSG] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log("================================");
  console.log("  PinchMe MCP Server");
  console.log("================================");
  console.log(`Port: ${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log(`SSE: http://localhost:${PORT}/sse`);
  console.log("================================");
});
