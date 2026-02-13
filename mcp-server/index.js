import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { z } from "zod";

const PORT = process.env.PORT || 3002;
const API_URL = process.env.API_URL || "https://elon-watcher-production.up.railway.app";

// Store authenticated sessions: sessionId -> { userId, apiKey }
const sessions = {};

// Global cache of validated API keys (persists across sessions)
const validatedApiKeys = new Set();

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

// Validate API key against backend (with caching)
async function validateApiKey(apiKey) {
  // Check cache first
  if (validatedApiKeys.has(apiKey)) {
    return true;
  }
  try {
    const result = await apiCall("GET", "/config", apiKey);
    if (!result.error) {
      validatedApiKeys.add(apiKey); // Cache valid key
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Get API key for session (from param, session store, or last used)
let lastUsedApiKey = null;

function getApiKey(sessionId, paramApiKey) {
  // 1. Use param if provided
  if (paramApiKey) {
    lastUsedApiKey = paramApiKey; // Remember for future calls
    return paramApiKey;
  }
  // 2. Use session-stored key
  if (sessions[sessionId]?.apiKey) {
    return sessions[sessionId].apiKey;
  }
  // 3. Use last successfully used key (persists across sessions)
  if (lastUsedApiKey && validatedApiKeys.has(lastUsedApiKey)) {
    return lastUsedApiKey;
  }
  return null;
}

// Create MCP server with session context
function createServer(sessionId) {
  const server = new McpServer({
    name: "pinchme",
    version: "1.0.0",
  });

  // Tool: Authenticate
  server.tool(
    "authenticate",
    "Authenticate with your PinchMe API key. Call this once per session, then other tools won't need the api_key.",
    { api_key: z.string().describe("Your PinchMe API key (pk_...)") },
    async ({ api_key }) => {
      if (!api_key) {
        return { content: [{ type: "text", text: "Error: api_key is required" }], isError: true };
      }
      
      const valid = await validateApiKey(api_key);
      if (!valid) {
        return { content: [{ type: "text", text: "Error: Invalid API key" }], isError: true };
      }
      
      // Store in session AND globally
      sessions[sessionId] = { apiKey: api_key, authenticatedAt: new Date().toISOString() };
      lastUsedApiKey = api_key;
      validatedApiKeys.add(api_key);
      
      return { content: [{ type: "text", text: "✓ Authenticated! You can now use other tools without api_key (persists across sessions)." }] };
    }
  );

  // Tool: List handles
  server.tool(
    "list_handles",
    "List all Twitter/X handles being monitored",
    { api_key: z.string().optional().describe("API key (optional if authenticated)") },
    async ({ api_key }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first, or pass api_key." }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", key);
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
      handle: z.string().describe("Twitter/X username (without @)"),
      api_key: z.string().optional().describe("API key (optional if authenticated)"),
    },
    async ({ api_key, handle }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        if (config.handles.includes(cleanHandle)) {
          return { content: [{ type: "text", text: `@${cleanHandle} is already being monitored` }] };
        }
        config.handles.push(cleanHandle);
        await apiCall("PUT", "/config", key, config);
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
      handle: z.string().describe("Twitter/X username to remove"),
      api_key: z.string().optional().describe("API key (optional if authenticated)"),
    },
    async ({ api_key, handle }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        if (!config.handles.includes(cleanHandle)) {
          return { content: [{ type: "text", text: `@${cleanHandle} is not being monitored` }] };
        }
        config.handles = config.handles.filter((h) => h !== cleanHandle);
        await apiCall("PUT", "/config", key, config);
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
      handle: z.string().describe("Twitter/X username"),
      mode: z.string().optional().describe("Alert mode: 'now' (immediate) or 'next-heartbeat' (batched)"),
      prompt: z.string().optional().describe("Custom prompt/instructions for this handle's alerts"),
      channel: z.string().optional().describe("Channel to send alerts to (e.g., 'telegram', 'discord')"),
      api_key: z.string().optional().describe("API key (optional if authenticated)"),
    },
    async ({ api_key, handle, mode, prompt, channel }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
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
        
        const result = await apiCall("PUT", `/handle-config/${cleanHandle}`, key, body);
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
      handle: z.string().describe("Twitter/X username"),
      api_key: z.string().optional().describe("API key (optional if authenticated)"),
    },
    async ({ api_key, handle }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      if (!handle) {
        return { content: [{ type: "text", text: "Error: handle is required" }], isError: true };
      }
      try {
        const cleanHandle = handle.replace(/^@/, "").toLowerCase().trim();
        const config = await apiCall("GET", `/handle-config/${cleanHandle}`, key);
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
    { api_key: z.string().optional().describe("API key (optional if authenticated)") },
    async ({ api_key }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      try {
        const result = await apiCall("POST", "/poll", key);
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
      limit: z.number().optional().describe("Number of tweets (default: 10)"),
      api_key: z.string().optional().describe("API key (optional if authenticated)"),
    },
    async ({ api_key, limit = 10 }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      try {
        const data = await apiCall("GET", `/sent-tweets?limit=${Math.min(limit, 50)}`, key);
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
    { api_key: z.string().optional().describe("API key (optional if authenticated)") },
    async ({ api_key }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      try {
        const [config, status] = await Promise.all([
          apiCall("GET", "/config", key),
          apiCall("GET", "/status", key),
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
      minutes: z.number().describe("Poll interval in minutes (1-60)"),
      api_key: z.string().optional().describe("API key (optional if authenticated)"),
    },
    async ({ api_key, minutes }) => {
      const key = getApiKey(sessionId, api_key);
      if (!key) {
        return { content: [{ type: "text", text: "Error: Not authenticated. Call authenticate(api_key) first." }], isError: true };
      }
      if (!minutes || minutes < 1 || minutes > 60) {
        return { content: [{ type: "text", text: "Error: minutes must be between 1 and 60" }], isError: true };
      }
      try {
        const config = await apiCall("GET", "/config", key);
        if (config.error) {
          return { content: [{ type: "text", text: `Error: ${config.error}` }], isError: true };
        }
        config.pollIntervalMinutes = minutes;
        await apiCall("PUT", "/config", key, config);
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
  res.json({ status: "ok", service: "pinchme-mcp", activeSessions: Object.keys(sessions).length });
});

// Root info
app.get("/", (req, res) => {
  res.json({
    name: "PinchMe MCP Server",
    version: "1.1.0",
    endpoints: { sse: "/sse", health: "/health" },
    tools: [
      "authenticate ← call first with api_key",
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
    note: "Call authenticate(api_key) once per session, then other tools work without api_key.",
  });
});

// SSE endpoint
app.get("/sse", async (req, res) => {
  console.log("[SSE] New connection");
  
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;
  
  const server = createServer(sessionId);
  
  res.on("close", () => {
    console.log(`[SSE] Connection closed: ${sessionId}`);
    delete transports[sessionId];
    delete sessions[sessionId]; // Clean up auth session
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
  console.log("  PinchMe MCP Server v1.1.0");
  console.log("================================");
  console.log(`Port: ${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log(`SSE: http://localhost:${PORT}/sse`);
  console.log("================================");
});
