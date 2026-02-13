import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 3002;
const API_URL = process.env.API_URL || "https://elon-watcher-production.up.railway.app";

// Helper to call the backend API with user's API key
async function apiCall(method, path, apiKey, body = null) {
  const url = `${API_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  const options = { method, headers };
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
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" }
      },
      required: ["api_key"]
    },
    async (params, context) => {
      console.log("[list_handles] Params:", JSON.stringify(params));
      console.log("[list_handles] Context keys:", Object.keys(context || {}));
      const api_key = params?.api_key;
      if (!api_key) {
        return { content: [{ type: "text", text: `Error: api_key is required. Params: ${JSON.stringify(params)}, Context keys: ${Object.keys(context || {})}` }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", api_key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
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
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" },
        handle: { type: "string", description: "Twitter/X username (without @)" },
      },
      required: ["api_key", "handle"]
    },
    async ({ api_key, handle }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", api_key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        if (config.handles.includes(cleanHandle)) {
          return { content: [{ type: "text", text: `@${cleanHandle} is already being monitored` }] };
        }
        config.handles.push(cleanHandle);
        await apiCall("PUT", "/config", api_key, config);
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
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" },
        handle: { type: "string", description: "Twitter/X username to remove" },
      },
      required: ["api_key", "handle"]
    },
    async ({ api_key, handle }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", api_key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        if (!config.handles.includes(cleanHandle)) {
          return { content: [{ type: "text", text: `@${cleanHandle} is not being monitored` }] };
        }
        config.handles = config.handles.filter((h) => h !== cleanHandle);
        await apiCall("PUT", "/config", api_key, config);
        return { content: [{ type: "text", text: `Removed @${cleanHandle}. Now tracking ${config.handles.length} accounts.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Configure handle
  server.tool(
    "configure_handle",
    "Configure alert settings for a specific handle",
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" },
        handle: { type: "string", description: "Twitter/X username" },
        mode: { type: "string", description: "Alert mode: 'now' (immediate) or 'next-heartbeat' (batched)" },
        prompt: { type: "string", description: "Custom prompt/instructions for this handle's alerts" },
        channel: { type: "string", description: "Channel to send alerts to (e.g., 'telegram', 'discord')" },
      },
      required: ["api_key", "handle"]
    },
    async ({ api_key, handle, mode, prompt, channel }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        const body = {};
        if (mode) body.mode = mode;
        if (prompt !== undefined) body.prompt = prompt;
        if (channel !== undefined) body.channel = channel;
        
        const result = await apiCall("PUT", `/handle-config/${cleanHandle}`, api_key, body);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Configured @${cleanHandle}: ${JSON.stringify(result.config)}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Get handle config
  server.tool(
    "get_handle_config",
    "Get alert configuration for a specific handle",
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" },
        handle: { type: "string", description: "Twitter/X username" },
      },
      required: ["api_key", "handle"]
    },
    async ({ api_key, handle }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        const config = await apiCall("GET", `/handle-config/${cleanHandle}`, api_key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  // Tool: Poll now
  server.tool(
    "poll_now",
    "Trigger an immediate poll for new tweets",
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" }
      },
      required: ["api_key"]
    },
    async ({ api_key }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      try {
        const result = await apiCall("POST", "/poll", api_key);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
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
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" },
        limit: { type: "number", description: "Number of tweets (default: 10)" },
      },
      required: ["api_key"]
    },
    async ({ api_key, limit = 10 }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      try {
        const data = await apiCall("GET", `/sent-tweets?limit=${Math.min(limit, 50)}`, api_key);
        if (data.error) {
          return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
        }
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
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" }
      },
      required: ["api_key"]
    },
    async ({ api_key }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      try {
        const [config, status] = await Promise.all([
          apiCall("GET", "/config", api_key),
          apiCall("GET", "/status", api_key),
        ]);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
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

  // Tool: Set poll interval
  server.tool(
    "set_poll_interval",
    "Change how often to check for new tweets",
    {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your PinchMe API key (pk_...)" },
        minutes: { type: "number", description: "Poll interval in minutes (1-60)" },
      },
      required: ["api_key", "minutes"]
    },
    async ({ api_key, minutes }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      if (!minutes || minutes < 1 || minutes > 60) {
        return { content: [{ type: "text", text: "Error: minutes must be between 1 and 60" }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", api_key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        config.pollIntervalMinutes = minutes;
        await apiCall("PUT", "/config", api_key, config);
        return { content: [{ type: "text", text: `Poll interval set to ${minutes} minutes.` }] };
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
    tools: [
      "list_handles",
      "add_handle",
      "remove_handle",
      "configure_handle",
      "get_handle_config",
      "poll_now",
      "get_recent_tweets",
      "get_status",
      "set_poll_interval",
    ],
    note: "All tools require api_key parameter. Get your API key from the PinchMe dashboard.",
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
  
  await transport.handlePostMessage(req, res);
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
