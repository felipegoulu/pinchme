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
      handle TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'now',
      prompt TEXT DEFAULT '',
      channel TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
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
// Handle config management
// ============================================
async function getHandleConfig(handle) {
  const result = await pool.query(
    'SELECT * FROM handle_config WHERE handle = $1',
    [handle.toLowerCase()]
  );
  if (result.rows.length === 0) {
    return { handle: handle.toLowerCase(), mode: 'now', prompt: '', channel: '' };
  }
  return result.rows[0];
}

async function getAllHandleConfigs() {
  const result = await pool.query('SELECT * FROM handle_config ORDER BY handle');
  return result.rows;
}

async function setHandleConfig(handle, config) {
  await pool.query(`
    INSERT INTO handle_config (handle, mode, prompt, channel, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (handle) DO UPDATE SET
      mode = $2,
      prompt = $3,
      channel = $4,
      updated_at = NOW()
  `, [
    handle.toLowerCase(),
    config.mode || 'now',
    config.prompt || '',
    config.channel || ''
  ]);
}

async function deleteHandleConfig(handle) {
  await pool.query('DELETE FROM handle_config WHERE handle = $1', [handle.toLowerCase()]);
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
// Apify Tweet Scraper
// ============================================
async function fetchLatestTweets(handles, maxItemsPerHandle = 10) {
  if (!handles || handles.length === 0) return [];
  
  console.log(`[${ts()}] Fetching tweets from: ${handles.map(h => '@' + h).join(', ')}...`);
  
  const searchQuery = handles.map(h => `from:${h}`).join(' OR ');
  
  const input = {
    searchTerms: [searchQuery],
    sort: 'Latest',
    maxItems: maxItemsPerHandle * handles.length,
  };

  const run = await client.actor('apidojo/tweet-scraper').call(input, {
    waitSecs: 120,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[${ts()}] Fetched ${items.length} tweets`);
  
  return items;
}

// ============================================
// Webhook sender
// ============================================
async function sendToWebhook(config, tweet, handleConfig) {
  if (!config.webhookUrl) {
    console.log('[Webhook] No webhook URL configured');
    return false;
  }

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
    return true;
  } catch (err) {
    console.error(`[Webhook] Error:`, err.message);
    return false;
  }
}

// ============================================
// Polling logic
// ============================================
async function poll() {
  const config = await getConfig();
  
  if (config.handles.length === 0) {
    console.log(`[${ts()}] No handles configured, skipping poll`);
    schedulePoll(config.pollIntervalMinutes);
    return;
  }

  try {
    const tweets = await fetchLatestTweets(config.handles);
    
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

      // === Protected routes ===

      // Get config
      if (path === '/config' && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const config = await getConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      // Update config
      if (path === '/config' && req.method === 'PUT') {
        if (!await requireAuth(req, res)) return;
        
        const body = await parseBody(req);
        const currentConfig = await getConfig();
        
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
        newConfig.handles = newConfig.handles
          .map(h => h.replace(/^@/, '').trim().toLowerCase())
          .filter(Boolean);
        
        await saveConfig(newConfig);
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

      // Get all handle configs
      if (path === '/handle-config' && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const configs = await getAllHandleConfigs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configs));
        return;
      }

      // Get single handle config
      if (path.startsWith('/handle-config/') && req.method === 'GET') {
        if (!await requireAuth(req, res)) return;
        const handle = path.split('/')[2];
        if (!handle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Handle required' }));
          return;
        }
        const config = await getHandleConfig(handle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      // Create/update handle config
      if (path.startsWith('/handle-config/') && req.method === 'PUT') {
        if (!await requireAuth(req, res)) return;
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
        });
        
        const updated = await getHandleConfig(handle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: updated }));
        return;
      }

      // Delete handle config
      if (path.startsWith('/handle-config/') && req.method === 'DELETE') {
        if (!await requireAuth(req, res)) return;
        const handle = path.split('/')[2];
        if (!handle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Handle required' }));
          return;
        }
        await deleteHandleConfig(handle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
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
