import { ApifyClient } from 'apify-client';
import { readFileSync, writeFileSync, existsSync, watchFile } from 'fs';
import { createServer } from 'http';

// ============================================
// Configuration
// ============================================
const CONFIG_FILE = process.env.CONFIG_FILE || './config.json';
const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// Default config
const defaultConfig = {
  webhookUrl: '',
  handles: [],
  pollIntervalMinutes: 15,
};

let config = { ...defaultConfig };
let pollTimeout = null;
let client = null;

// ============================================
// Config management
// ============================================
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = readFileSync(CONFIG_FILE, 'utf-8');
      const loaded = JSON.parse(data);
      config = { ...defaultConfig, ...loaded };
      console.log(`[Config] Loaded: ${config.handles.length} handles, ${config.pollIntervalMinutes}min interval`);
    } else {
      saveConfig(config);
      console.log('[Config] Created default config file');
    }
  } catch (err) {
    console.error('[Config] Error loading:', err.message);
  }
  return config;
}

function saveConfig(newConfig) {
  try {
    config = { ...defaultConfig, ...newConfig };
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('[Config] Saved');
    return true;
  } catch (err) {
    console.error('[Config] Error saving:', err.message);
    return false;
  }
}

// ============================================
// State management (tracks last seen tweets)
// ============================================
const STATE_FILE = process.env.STATE_FILE || './state.json';

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[State] Error loading:', err.message);
  }
  return { lastSeenIds: {}, lastPoll: null };
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[State] Error saving:', err.message);
  }
}

// ============================================
// Apify Tweet Scraper
// ============================================
async function fetchLatestTweets(handles, maxItemsPerHandle = 10) {
  if (!handles || handles.length === 0) {
    return [];
  }
  
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
async function sendToWebhook(tweet) {
  if (!config.webhookUrl) {
    console.log('[Webhook] No webhook URL configured');
    return false;
  }

  const payload = {
    event: 'new_tweet',
    timestamp: new Date().toISOString(),
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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
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
  if (config.handles.length === 0) {
    console.log(`[${ts()}] No handles configured, skipping poll`);
    schedulePoll();
    return;
  }

  const state = loadState();
  
  try {
    const tweets = await fetchLatestTweets(config.handles);
    
    if (tweets.length === 0) {
      console.log(`[${ts()}] No tweets found`);
      schedulePoll();
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
      
      const lastSeenId = state.lastSeenIds[author];
      
      if (!lastSeenId) {
        // First time seeing this author
        console.log(`[${ts()}] First poll for @${author}, initializing state`);
        state.lastSeenIds[author] = authorTweets[0].id;
        continue;
      }

      // Find new tweets
      const newTweets = authorTweets.filter(t => t.id > lastSeenId);
      
      if (newTweets.length > 0) {
        console.log(`[${ts()}] Found ${newTweets.length} new tweet(s) from @${author}`);
        
        // Send oldest first
        newTweets.reverse();
        for (const tweet of newTweets) {
          await sendToWebhook(tweet);
          newCount++;
        }
        
        // Update last seen
        state.lastSeenIds[author] = authorTweets[0].id;
      }
    }

    if (newCount === 0) {
      console.log(`[${ts()}] No new tweets`);
    }

    state.lastPoll = new Date().toISOString();
    saveState(state);

  } catch (err) {
    console.error(`[${ts()}] Poll error:`, err.message);
  }

  schedulePoll();
}

function schedulePoll() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
  }
  
  const intervalMs = config.pollIntervalMinutes * 60 * 1000;
  console.log(`[${ts()}] Next poll in ${config.pollIntervalMinutes} minutes`);
  
  pollTimeout = setTimeout(poll, intervalMs);
}

function restartPolling() {
  console.log('[Polling] Restarting with new config...');
  if (pollTimeout) {
    clearTimeout(pollTimeout);
  }
  poll();
}

// ============================================
// HTTP API Server
// ============================================
function createApiServer() {
  const server = createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // Health check
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // Get config
    if (path === '/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    // Update config
    if (path === '/config' && req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const newConfig = JSON.parse(body);
          
          // Validate
          if (newConfig.webhookUrl !== undefined && typeof newConfig.webhookUrl !== 'string') {
            throw new Error('webhookUrl must be a string');
          }
          if (newConfig.handles !== undefined && !Array.isArray(newConfig.handles)) {
            throw new Error('handles must be an array');
          }
          if (newConfig.pollIntervalMinutes !== undefined) {
            const interval = parseInt(newConfig.pollIntervalMinutes);
            if (isNaN(interval) || interval < 1 || interval > 1440) {
              throw new Error('pollIntervalMinutes must be between 1 and 1440');
            }
            newConfig.pollIntervalMinutes = interval;
          }

          // Clean handles
          if (newConfig.handles) {
            newConfig.handles = newConfig.handles
              .map(h => h.replace(/^@/, '').trim().toLowerCase())
              .filter(Boolean);
          }

          saveConfig(newConfig);
          restartPolling();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, config }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Get state/status
    if (path === '/status' && req.method === 'GET') {
      const state = loadState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        config,
        state,
        nextPoll: pollTimeout ? 'scheduled' : 'not scheduled',
      }));
      return;
    }

    // Force poll now
    if (path === '/poll' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Poll triggered' }));
      
      // Run poll async
      if (pollTimeout) clearTimeout(pollTimeout);
      poll();
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
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
  console.log('  Tweet Watcher - Dashboard Edition');
  console.log('========================================');

  if (!APIFY_TOKEN) {
    console.error('ERROR: APIFY_TOKEN environment variable is required');
    process.exit(1);
  }

  // Initialize Apify client
  client = new ApifyClient({ token: APIFY_TOKEN });

  // Load config
  loadConfig();

  // Start API server
  const server = createApiServer();
  server.listen(PORT, () => {
    console.log(`[API] Server running on port ${PORT}`);
    console.log(`[API] Endpoints:`);
    console.log(`      GET  /health - Health check`);
    console.log(`      GET  /config - Get current config`);
    console.log(`      PUT  /config - Update config`);
    console.log(`      GET  /status - Get full status`);
    console.log(`      POST /poll   - Force poll now`);
    console.log('========================================\n');
  });

  // Start polling
  poll();
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n[Shutdown] SIGTERM received');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n[Shutdown] SIGINT received');
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
