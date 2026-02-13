import { ApifyClient } from 'apify-client';
import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import pg from 'pg';

const { Pool } = pg;

// ============================================
// Configuration
// ============================================
const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// Default auth (can be overridden in DB)
const DEFAULT_USERNAME = 'felipegoulu';
const DEFAULT_PASSWORD = process.env.AUTH_PASSWORD || 'changeme';

let pool = null;
let pollTimeout = null;
let client = null;

// Debug state for monitoring
const debugState = {
  version: '2.1.0', // Added handle validation
  startedAt: new Date().toISOString(),
  lastPollAttempt: null,
  lastPollSuccess: null,
  lastPollError: null,
  lastPollTweets: 0,
  totalPolls: 0,
};

// ============================================
// Database setup
// ============================================
async function initDb() {
  pool = new Pool({ connectionString: DATABASE_URL });
  
  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      webhook_url TEXT DEFAULT '',
      handles TEXT[] DEFAULT '{}',
      poll_interval_minutes INTEGER DEFAULT 15,
      CHECK (id = 1)
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      handle TEXT PRIMARY KEY,
      last_seen_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS handle_config (
      handle TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'felipegoulu',
      mode TEXT DEFAULT 'now',
      prompt TEXT DEFAULT '',
      channel TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (handle, user_id)
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      api_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT DEFAULT 'default',
      mcp_activated BOOLEAN DEFAULT FALSE,
      mcp_activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // Add mcp_activated column if it doesn't exist (migration for existing DBs)
  await pool.query(`
    ALTER TABLE api_keys 
    ADD COLUMN IF NOT EXISTS mcp_activated BOOLEAN DEFAULT FALSE
  `).catch(() => {});
  await pool.query(`
    ALTER TABLE api_keys 
    ADD COLUMN IF NOT EXISTS mcp_activated_at TIMESTAMPTZ
  `).catch(() => {});
  
  // Migration: handle_config might have been created without user_id
  // Drop and recreate if needed (safe because it's config, not data)
  try {
    await pool.query(`SELECT user_id FROM handle_config LIMIT 1`);
  } catch (e) {
    console.log('[DB] Recreating handle_config with user_id column...');
    await pool.query(`DROP TABLE IF EXISTS handle_config`);
    await pool.query(`
      CREATE TABLE handle_config (
        handle TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'felipegoulu',
        mode TEXT DEFAULT 'now',
        prompt TEXT DEFAULT '',
        channel TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (handle, user_id)
      )
    `);
  }
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_config (
      user_id TEXT PRIMARY KEY,
      webhook_url TEXT DEFAULT '',
      handles TEXT[] DEFAULT '{}',
      poll_interval_minutes INTEGER DEFAULT 15,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_tweets (
      id SERIAL PRIMARY KEY,
      tweet_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      tweet_text TEXT,
      tweet_url TEXT,
      formatted_message TEXT,
      handle_config JSONB,
      status TEXT DEFAULT 'sent',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // Insert default config if not exists
  await pool.query(`
    INSERT INTO config (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
  
  // Insert default user if not exists
  const passwordHash = hashPassword(DEFAULT_PASSWORD);
  await pool.query(`
    INSERT INTO users (username, password_hash) VALUES ($1, $2)
    ON CONFLICT (username) DO NOTHING
  `, [DEFAULT_USERNAME, passwordHash]);
  
  console.log('[DB] Initialized');
}

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

// ============================================
// Twitter Handle Validation
// ============================================
function isValidHandleFormat(handle) {
  // Twitter handles: 1-15 chars, alphanumeric + underscore
  return /^[a-zA-Z0-9_]{1,15}$/.test(handle);
}

async function verifyTwitterHandle(handle) {
  // Quick check via Twitter's intent API (no auth needed, fast)
  const https = require('https');
  
  return new Promise((resolve) => {
    const url = `https://twitter.com/intent/user?screen_name=${handle}`;
    
    const req = https.get(url, { timeout: 5000 }, (res) => {
      // 200 = exists, 404 = not found, 302 = redirect (usually exists)
      if (res.statusCode === 200 || res.statusCode === 302) {
        resolve({ valid: true, reason: 'exists' });
      } else if (res.statusCode === 404) {
        resolve({ valid: false, reason: 'not_found' });
      } else {
        // Other status - assume valid to avoid false negatives
        resolve({ valid: true, reason: `status_${res.statusCode}` });
      }
    });
    
    req.on('error', (err) => {
      console.error(`[Verify] Error checking @${handle}: ${err.message}`);
      // On error, assume valid to avoid blocking
      resolve({ valid: true, reason: 'error_skipped' });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: true, reason: 'timeout_skipped' });
    });
  });
}

async function validateHandles(handles) {
  const results = [];
  const invalid = [];
  
  for (const handle of handles) {
    // First check format
    if (!isValidHandleFormat(handle)) {
      invalid.push({ handle, reason: 'invalid_format' });
      continue;
    }
    
    // Then verify exists (with Apify)
    const verification = await verifyTwitterHandle(handle);
    if (!verification.valid) {
      invalid.push({ handle, reason: verification.reason });
    } else {
      results.push(handle);
    }
  }
  
  return { valid: results, invalid };
}

// ============================================
// Config management
// ============================================
async function getConfig() {
  const result = await pool.query('SELECT * FROM config WHERE id = 1');
  const row = result.rows[0];
  return {
    webhookUrl: row.webhook_url || '',
    handles: row.handles || [],
    pollIntervalMinutes: row.poll_interval_minutes || 15,
  };
}

async function saveConfig(config) {
  await pool.query(`
    UPDATE config SET
      webhook_url = $1,
      handles = $2,
      poll_interval_minutes = $3
    WHERE id = 1
  `, [
    config.webhookUrl || '',
    config.handles || [],
    config.pollIntervalMinutes || 15,
  ]);
  console.log('[Config] Saved');
}

// ============================================
// State management
// ============================================
async function getLastSeenId(handle) {
  const result = await pool.query(
    'SELECT last_seen_id FROM state WHERE handle = $1',
    [handle.toLowerCase()]
  );
  return result.rows[0]?.last_seen_id || null;
}

async function setLastSeenId(handle, tweetId) {
  await pool.query(`
    INSERT INTO state (handle, last_seen_id, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (handle) DO UPDATE SET
      last_seen_id = $2,
      updated_at = NOW()
  `, [handle.toLowerCase(), tweetId]);
}

async function getState() {
  const result = await pool.query('SELECT * FROM state');
  const lastSeenIds = {};
  for (const row of result.rows) {
    lastSeenIds[row.handle] = row.last_seen_id;
  }
  return { lastSeenIds };
}

// ============================================
// Handle config management (multi-tenant)
// ============================================
async function getHandleConfig(handle, userId = 'felipegoulu') {
  const result = await pool.query(
    'SELECT * FROM handle_config WHERE handle = $1 AND user_id = $2',
    [handle.toLowerCase(), userId]
  );
  if (result.rows.length === 0) {
    return { handle: handle.toLowerCase(), user_id: userId, mode: 'now', prompt: '', channel: '' };
  }
  return result.rows[0];
}

async function getAllHandleConfigs(userId = 'felipegoulu') {
  const result = await pool.query(
    'SELECT * FROM handle_config WHERE user_id = $1 ORDER BY handle',
    [userId]
  );
  return result.rows;
}

async function setHandleConfig(handle, config, userId = 'felipegoulu') {
  await pool.query(`
    INSERT INTO handle_config (handle, user_id, mode, prompt, channel, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (handle, user_id) DO UPDATE SET
      mode = $3,
      prompt = $4,
      channel = $5,
      updated_at = NOW()
  `, [
    handle.toLowerCase(),
    userId,
    config.mode || 'now',
    config.prompt || '',
    config.channel || ''
  ]);
}

async function deleteHandleConfig(handle, userId = 'felipegoulu') {
  await pool.query(
    'DELETE FROM handle_config WHERE handle = $1 AND user_id = $2',
    [handle.toLowerCase(), userId]
  );
}

// ============================================
// Auth management
// ============================================
async function validateCredentials(username, password) {
  const result = await pool.query(
    'SELECT password_hash FROM users WHERE username = $1',
    [username]
  );
  if (result.rows.length === 0) return false;
  return result.rows[0].password_hash === hashPassword(password);
}

async function createSession(username) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  
  await pool.query(`
    INSERT INTO sessions (token, username, expires_at)
    VALUES ($1, $2, $3)
  `, [token, username, expiresAt]);
  
  return token;
}

async function validateSession(token) {
  const result = await pool.query(`
    SELECT username FROM sessions
    WHERE token = $1 AND expires_at > NOW()
  `, [token]);
  
  return result.rows[0]?.username || null;
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function cleanupExpiredSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
}

// ============================================
// API Key management
// ============================================
async function generateApiKey(userId, name = 'default') {
  const apiKey = 'pk_' + randomBytes(24).toString('hex');
  await pool.query(`
    INSERT INTO api_keys (api_key, user_id, name)
    VALUES ($1, $2, $3)
  `, [apiKey, userId, name]);
  return apiKey;
}

async function validateApiKey(apiKey) {
  if (!apiKey) return null;
  const result = await pool.query(
    'SELECT user_id FROM api_keys WHERE api_key = $1',
    [apiKey]
  );
  return result.rows[0]?.user_id || null;
}

async function listApiKeys(userId) {
  const result = await pool.query(
    'SELECT api_key, name, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows;
}

async function deleteApiKey(apiKey, userId) {
  await pool.query(
    'DELETE FROM api_keys WHERE api_key = $1 AND user_id = $2',
    [apiKey, userId]
  );
}

// ============================================
// User config management (multi-tenant)
// ============================================
async function getUserConfig(userId) {
  // First try user-specific config
  let result = await pool.query('SELECT * FROM user_config WHERE user_id = $1', [userId]);
  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      webhookUrl: row.webhook_url || '',
      handles: row.handles || [],
      pollIntervalMinutes: row.poll_interval_minutes || 15,
    };
  }
  // Fallback to global config for existing users
  result = await pool.query('SELECT * FROM config WHERE id = 1');
  const row = result.rows[0];
  return {
    webhookUrl: row?.webhook_url || '',
    handles: row?.handles || [],
    pollIntervalMinutes: row?.poll_interval_minutes || 15,
  };
}

async function saveUserConfig(userId, config) {
  await pool.query(`
    INSERT INTO user_config (user_id, webhook_url, handles, poll_interval_minutes, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      webhook_url = $2,
      handles = $3,
      poll_interval_minutes = $4,
      updated_at = NOW()
  `, [
    userId,
    config.webhookUrl || '',
    config.handles || [],
    config.pollIntervalMinutes || 15,
  ]);
  console.log(`[Config] Saved for user ${userId}`);
}

// ============================================
// Apify Tweet Scraper (Unlimited - for monitoring)
// ============================================
async function fetchLatestTweets(handles, maxItemsPerHandle = 3) {
  if (!handles || handles.length === 0) return [];
  
  console.log(`[${ts()}] Fetching tweets from: ${handles.map(h => '@' + h).join(', ')}...`);
  
  // Get today's date for the since filter (YYYY-MM-DD)
  const today = new Date().toISOString().split('T')[0];
  
  // Build query with date filter and exclude retweets
  // Each handle gets: from:handle since:YYYY-MM-DD -filter:retweets
  const searchQuery = handles.map(h => `from:${h}`).join(' OR ');
  const fullQuery = `(${searchQuery}) since:${today} -filter:retweets`;
  
  const input = {
    searchTerms: [fullQuery],
    sort: 'Latest',
    maxItems: maxItemsPerHandle * handles.length,
  };

  console.log(`[${ts()}] Query: ${fullQuery}`);
  console.log(`[${ts()}] Max items: ${input.maxItems}`);

  // Using twitter-scraper-lite (Unlimited) - no minimum, event-based pricing
  const run = await client.actor('apidojo/twitter-scraper-lite').call(input, {
    waitSecs: 120,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[${ts()}] Fetched ${items.length} tweets`);
  
  return items;
}

// ============================================
// Webhook sender
// ============================================

// Format message the same way the webhook server does
function formatMessageForOpenClaw(tweet, handleConfig) {
  let msg = '';
  
  if (handleConfig?.prompt) {
    msg += `INSTRUCCIÓN: ${handleConfig.prompt}\n\n`;
  }
  
  if (handleConfig?.channel) {
    msg += `CANAL: Respondé por ${handleConfig.channel}\n\n`;
  }
  
  const author = tweet.author?.userName || 'unknown';
  msg += `🐦 New tweet from @${author}`;
  
  if (tweet.isReply) {
    msg += ` (reply to @${tweet.inReplyToUsername})`;
  } else if (tweet.isQuote) {
    msg += ` (quote)`;
  } else if (tweet.isRetweet) {
    msg += ` (retweet)`;
  }
  
  msg += `:\n\n${tweet.text}`;
  
  if (tweet.url) {
    msg += `\n\n${tweet.url}`;
  }
  
  return msg;
}

// Log sent tweet to database
async function logSentTweet(tweet, handleConfig, formattedMessage, status = 'sent') {
  try {
    await pool.query(`
      INSERT INTO sent_tweets (tweet_id, handle, tweet_text, tweet_url, formatted_message, handle_config, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      tweet.id,
      tweet.author?.userName || 'unknown',
      tweet.text,
      tweet.url,
      formattedMessage,
      JSON.stringify(handleConfig || {}),
      status
    ]);
  } catch (err) {
    console.error('[DB] Failed to log sent tweet:', err.message);
  }
}

// Get recent sent tweets
async function getSentTweets(limit = 50) {
  const result = await pool.query(
    'SELECT * FROM sent_tweets ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

async function sendToWebhook(config, tweet, handleConfig) {
  if (!config.webhookUrl) {
    console.log('[Webhook] No webhook URL configured');
    return false;
  }

  // Format the message that OpenClaw will see
  const formattedMessage = formatMessageForOpenClaw(tweet, handleConfig);

  const payload = {
    event: 'new_tweet',
    timestamp: new Date().toISOString(),
    handleConfig: {
      mode: handleConfig?.mode || 'now',
      prompt: handleConfig?.prompt || '',
      channel: handleConfig?.channel || '',
    },
    tweet: {
      id: tweet.id,
      url: tweet.url,
      text: tweet.text,
      createdAt: tweet.createdAt,
      author: tweet.author?.userName || 'unknown',
      authorName: tweet.author?.name,
      replyCount: tweet.replyCount,
      retweetCount: tweet.retweetCount,
      likeCount: tweet.likeCount,
      quoteCount: tweet.quoteCount,
      isRetweet: tweet.isRetweet,
      isQuote: tweet.isQuote,
      isReply: tweet.isReply,
      inReplyToId: tweet.inReplyToId,
      inReplyToUser: tweet.inReplyToUsername,
      conversationId: tweet.conversationId,
      quotedTweet: tweet.isQuote && tweet.quotedTweet ? {
        id: tweet.quotedTweet.id,
        url: tweet.quotedTweet.url,
        text: tweet.quotedTweet.text,
        author: tweet.quotedTweet.author?.userName,
      } : null,
    },
  };

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`[Webhook] Sent tweet ${tweet.id}`);
    
    // Log to database
    await logSentTweet(tweet, handleConfig, formattedMessage, 'sent');
    
    return true;
  } catch (err) {
    console.error(`[Webhook] Error:`, err.message);
    
    // Log failed attempt
    await logSentTweet(tweet, handleConfig, formattedMessage, 'failed');
    
    return false;
  }
}

// ============================================
// Polling logic
// ============================================
async function poll() {
  debugState.lastPollAttempt = new Date().toISOString();
  debugState.totalPolls++;
  
  const config = await getConfig();
  
  if (config.handles.length === 0) {
    console.log(`[${ts()}] No handles configured, skipping poll`);
    schedulePoll(config.pollIntervalMinutes);
    return;
  }

  try {
    const tweets = await fetchLatestTweets(config.handles);
    debugState.lastPollTweets = tweets.length;
    debugState.lastPollSuccess = new Date().toISOString();
    debugState.lastPollError = null;
    
    if (tweets.length === 0) {
      console.log(`[${ts()}] No tweets found`);
      schedulePoll(config.pollIntervalMinutes);
      return;
    }

    // Group by author
    const byAuthor = {};
    for (const tweet of tweets) {
      const author = tweet.author?.userName?.toLowerCase();
      if (!author) continue;
      if (!byAuthor[author]) byAuthor[author] = [];
      byAuthor[author].push(tweet);
    }

    // Process each author
    let newCount = 0;
    for (const [author, authorTweets] of Object.entries(byAuthor)) {
      authorTweets.sort((a, b) => b.id.localeCompare(a.id)); // newest first
      
      const lastSeenId = await getLastSeenId(author);
      
      if (!lastSeenId) {
        console.log(`[${ts()}] First poll for @${author}, initializing state`);
        await setLastSeenId(author, authorTweets[0].id);
        continue;
      }

      // Find new tweets
      const newTweets = authorTweets.filter(t => t.id > lastSeenId);
      
      if (newTweets.length > 0) {
        console.log(`[${ts()}] Found ${newTweets.length} new tweet(s) from @${author}`);
        
        // Get handle-specific config
        const handleConfig = await getHandleConfig(author);
        
        // Send oldest first
        newTweets.reverse();
        for (const tweet of newTweets) {
          await sendToWebhook(config, tweet, handleConfig);
          newCount++;
        }
        
        // Update last seen
        await setLastSeenId(author, authorTweets[0].id);
      }
    }

    if (newCount === 0) {
      console.log(`[${ts()}] No new tweets`);
    }

  } catch (err) {
    debugState.lastPollError = err.message;
    console.error(`[${ts()}] Poll error:`, err.message);
  }

  schedulePoll(config.pollIntervalMinutes);
}

function schedulePoll(intervalMinutes) {
  if (pollTimeout) clearTimeout(pollTimeout);
  
  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`[${ts()}] Next poll in ${intervalMinutes} minutes`);
  
  pollTimeout = setTimeout(poll, intervalMs);
}

function restartPolling() {
  console.log('[Polling] Restarting...');
  if (pollTimeout) clearTimeout(pollTimeout);
  poll();
}

// ============================================
// HTTP helpers
// ============================================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function requireAuth(req, res) {
  // Check for user API key (pk_...)
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && apiKeyHeader.startsWith('pk_')) {
    const userId = await validateApiKey(apiKeyHeader);
    if (userId) {
      return userId;
    }
  }
  
  // Check for legacy MCP_API_KEY (service account)
  const MCP_API_KEY = process.env.MCP_API_KEY;
  if (apiKeyHeader && MCP_API_KEY && apiKeyHeader === MCP_API_KEY) {
    return 'felipegoulu'; // Legacy service account defaults to felipegoulu
  }
  
  // Check for JWT token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  
  const token = authHeader.slice(7);
  const username = await validateSession(token);
  
  if (!username) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  
  return username;
}

// ============================================
// HTTP API Server
// ============================================
function createApiServer() {
  const server = createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    try {
      // Health check (public)
      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      // Debug endpoint (public - for troubleshooting)
      if (path === '/debug' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(debugState, null, 2));
        return;
      }

      // Validate handle endpoint
      if (path === '/validate-handle' && req.method === 'POST') {
        if (!await requireAuth(req, res)) return;
        const { handle } = await parseBody(req);
        
        if (!handle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'handle is required' }));
          return;
        }
        
        const cleanHandle = handle.replace(/^@/, '').trim().toLowerCase();
        
        if (!isValidHandleFormat(cleanHandle)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            handle: cleanHandle,
            valid: false,
            reason: 'invalid_format',
            hint: 'Handle must be 1-15 characters, alphanumeric or underscore'
          }));
          return;
        }
        
        const result = await verifyTwitterHandle(cleanHandle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          handle: cleanHandle,
          valid: result.valid,
          reason: result.reason
        }));
        return;
      }

      // Login
      if (path === '/auth/login' && req.method === 'POST') {
        const { username, password } = await parseBody(req);
        
        if (await validateCredentials(username, password)) {
          const token = await createSession(username);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, token, username }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
        return;
      }

      // Check auth status
      if (path === '/auth/me' && req.method === 'GET') {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const username = await validateSession(authHeader.slice(7));
          if (username) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ authenticated: true, username }));
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: false }));
        return;
      }

      // Logout
      if (path === '/auth/logout' && req.method === 'POST') {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          await deleteSession(authHeader.slice(7));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Change password
      if (path === '/auth/password' && req.method === 'PUT') {
        const username = await requireAuth(req, res);
        if (!username) return;
        
        const { currentPassword, newPassword } = await parseBody(req);
        
        if (!currentPassword || !newPassword) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Current and new password required' }));
          return;
        }
        
        if (newPassword.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Password must be at least 4 characters' }));
          return;
        }
        
        // Verify current password
        if (!await validateCredentials(username, currentPassword)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Current password is incorrect' }));
          return;
        }
        
        // Update password
        const newHash = hashPassword(newPassword);
        await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [newHash, username]);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // === API Key management ===

      // List API keys
      if (path === '/api-keys' && req.method === 'GET') {
        const username = await requireAuth(req, res);
        if (!username) return;
        const keys = await listApiKeys(username);
        // Mask the keys for security (show first 8 chars only)
        const maskedKeys = keys.map(k => ({
          ...k,
          api_key: k.api_key.substring(0, 11) + '...' + k.api_key.slice(-4),
          api_key_full: k.api_key, // Include full key for copying
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(maskedKeys));
        return;
      }

      // Generate new API key
      if (path === '/api-keys' && req.method === 'POST') {
        const username = await requireAuth(req, res);
        if (!username) return;
        const { name } = await parseBody(req);
        const apiKey = await generateApiKey(username, name || 'default');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, api_key: apiKey, name: name || 'default' }));
        return;
      }

      // Delete API key
      if (path.startsWith('/api-keys/') && req.method === 'DELETE') {
        const username = await requireAuth(req, res);
        if (!username) return;
        const apiKey = decodeURIComponent(path.split('/')[2]);
        await deleteApiKey(apiKey, username);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // === MCP Activation (persists auth across server restarts) ===

      // Mark API key as MCP-activated
      if (path === '/mcp/activate' && req.method === 'POST') {
        const apiKeyHeader = req.headers['x-api-key'];
        if (!apiKeyHeader) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'X-API-Key header required' }));
          return;
        }
        const userId = await validateApiKey(apiKeyHeader);
        if (!userId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid API key' }));
          return;
        }
        await pool.query(
          'UPDATE api_keys SET mcp_activated = TRUE, mcp_activated_at = NOW() WHERE api_key = $1',
          [apiKeyHeader]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'API key activated for MCP' }));
        return;
      }

      // Get all MCP-activated API keys (for MCP server startup)
      // This endpoint is intentionally public so MCP server can call it on boot
      if (path === '/mcp/activated-keys' && req.method === 'GET') {
        const result = await pool.query(
          'SELECT api_key FROM api_keys WHERE mcp_activated = TRUE'
        );
        const keys = result.rows.map(r => r.api_key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys }));
        return;
      }

      // === Protected routes ===

      // Get config
      if (path === '/config' && req.method === 'GET') {
        const userId = await requireAuth(req, res);
        if (!userId) return;
        const config = await getUserConfig(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      // Update config
      if (path === '/config' && req.method === 'PUT') {
        const userId = await requireAuth(req, res);
        if (!userId) return;
        
        const body = await parseBody(req);
        const currentConfig = await getUserConfig(userId);
        
        const newConfig = {
          webhookUrl: body.webhookUrl ?? currentConfig.webhookUrl,
          handles: body.handles ?? currentConfig.handles,
          pollIntervalMinutes: body.pollIntervalMinutes ?? currentConfig.pollIntervalMinutes,
        };
        
        // Validate
        if (typeof newConfig.webhookUrl !== 'string') {
          throw new Error('webhookUrl must be a string');
        }
        if (!Array.isArray(newConfig.handles)) {
          throw new Error('handles must be an array');
        }
        
        const interval = parseInt(newConfig.pollIntervalMinutes);
        if (isNaN(interval) || interval < 1 || interval > 1440) {
          throw new Error('pollIntervalMinutes must be between 1 and 1440');
        }
        newConfig.pollIntervalMinutes = interval;
        
        // Clean handles
        const cleanedHandles = newConfig.handles
          .map(h => h.replace(/^@/, '').trim().toLowerCase())
          .filter(Boolean);
        
        // Validate handles exist on Twitter
        const { valid, invalid } = await validateHandles(cleanedHandles);
        
        if (invalid.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'Some handles are invalid',
            invalid: invalid,
            hint: 'Remove invalid handles and try again'
          }));
          return;
        }
        
        newConfig.handles = valid;
        
        await saveUserConfig(userId, newConfig);
        restartPolling();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: newConfig }));
        return;
      }

      // Get status
      if (path === '/status' && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const config = await getConfig();
        const state = await getState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          config,
          state,
          nextPoll: pollTimeout ? 'scheduled' : 'not scheduled',
        }));
        return;
      }

      // Force poll
      if (path === '/poll' && req.method === 'POST') {
        if (!await requireAuth(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Poll triggered' }));
        restartPolling();
        return;
      }

      // Get sent tweets log
      if (path === '/sent-tweets' && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const tweets = await getSentTweets(Math.min(limit, 200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tweets));
        return;
      }

      // Get all handle configs
      if (path === '/handle-config' && req.method === 'GET') {
        const userId = await requireAuth(req, res);
        if (!userId) return;
        const configs = await getAllHandleConfigs(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configs));
        return;
      }

      // Get single handle config
      if (path.startsWith('/handle-config/') && req.method === 'GET') {
        const userId = await requireAuth(req, res);
        if (!userId) return;
        const handle = path.split('/')[2];
        if (!handle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Handle required' }));
          return;
        }
        const config = await getHandleConfig(handle, userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      // Create/update handle config
      if (path.startsWith('/handle-config/') && req.method === 'PUT') {
        const userId = await requireAuth(req, res);
        if (!userId) return;
        const handle = path.split('/')[2];
        if (!handle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Handle required' }));
          return;
        }
        const body = await parseBody(req);
        
        // Validate mode
        if (body.mode && !['now', 'next-heartbeat'].includes(body.mode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Mode must be "now" or "next-heartbeat"' }));
          return;
        }
        
        await setHandleConfig(handle, {
          mode: body.mode,
          prompt: body.prompt,
          channel: body.channel,
        }, userId);
        
        const updated = await getHandleConfig(handle, userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: updated }));
        return;
      }

      // Delete handle config
      if (path.startsWith('/handle-config/') && req.method === 'DELETE') {
        const userId = await requireAuth(req, res);
        if (!userId) return;
        const handle = path.split('/')[2];
        if (!handle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Handle required' }));
          return;
        }
        await deleteHandleConfig(handle, userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // ============================================
      // OpenClaw Proxy Endpoints (forwards to webhook server)
      // ============================================
      
      // Proxy: Get OpenClaw config
      if (path === '/openclaw/config' && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const config = await getConfig();
        if (!config.webhookUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No webhook URL configured' }));
          return;
        }
        try {
          const webhookBase = config.webhookUrl.trim().replace(/\/$/, '');
          const proxyRes = await fetch(`${webhookBase}/openclaw/config`);
          const data = await proxyRes.json();
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reach webhook server: ' + err.message }));
        }
        return;
      }

      // Proxy: Update OpenClaw config
      if (path === '/openclaw/config' && (req.method === 'PUT' || req.method === 'PATCH')) {
        if (!await requireAuth(req, res)) return;
        const config = await getConfig();
        if (!config.webhookUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No webhook URL configured' }));
          return;
        }
        try {
          const body = await parseBody(req);
          const webhookBase = config.webhookUrl.trim().replace(/\/$/, '');
          const proxyRes = await fetch(`${webhookBase}/openclaw/config`, {
            method: req.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await proxyRes.json();
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reach webhook server: ' + err.message }));
        }
        return;
      }

      // Proxy: Restart OpenClaw gateway
      if (path === '/openclaw/restart' && req.method === 'POST') {
        if (!await requireAuth(req, res)) return;
        const config = await getConfig();
        if (!config.webhookUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No webhook URL configured' }));
          return;
        }
        try {
          const webhookBase = config.webhookUrl.trim().replace(/\/$/, '');
          const proxyRes = await fetch(`${webhookBase}/openclaw/restart`, { method: 'POST' });
          const data = await proxyRes.json();
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reach webhook server: ' + err.message }));
        }
        return;
      }

      // Proxy: Get OpenClaw heartbeat status
      if (path === '/openclaw/heartbeat' && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const config = await getConfig();
        if (!config.webhookUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No webhook URL configured' }));
          return;
        }
        try {
          const webhookBase = config.webhookUrl.trim().replace(/\/$/, '');
          const proxyRes = await fetch(`${webhookBase}/openclaw/heartbeat`);
          const data = await proxyRes.json();
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reach webhook server: ' + err.message }));
        }
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      
    } catch (err) {
      console.error('[API] Error:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return server;
}

// ============================================
// Utils
// ============================================
function ts() {
  return new Date().toISOString();
}

// ============================================
// Main
// ============================================
async function main() {
  console.log('========================================');
  console.log('  Tweet Watcher - PostgreSQL Edition');
  console.log('========================================');

  if (!APIFY_TOKEN) {
    console.error('ERROR: APIFY_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  // Initialize database
  await initDb();
  
  // Cleanup expired sessions periodically
  setInterval(cleanupExpiredSessions, 60 * 60 * 1000); // every hour

  // Initialize Apify client
  client = new ApifyClient({ token: APIFY_TOKEN });

  // Start API server
  const server = createApiServer();
  server.listen(PORT, () => {
    console.log(`[API] Server running on port ${PORT}`);
    console.log('========================================\n');
  });

  // Start polling
  poll();
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n[Shutdown] SIGTERM received');
  if (pool) await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n[Shutdown] SIGINT received');
  if (pool) await pool.end();
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
