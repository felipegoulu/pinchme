#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3001;
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || 'openclaw';
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || 
  path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');

// ============================================
// OpenClaw Config Management
// ============================================
function getOpenClawConfig() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[OpenClaw Config] Error reading: ${err.message}`);
    return null;
  }
}

function saveOpenClawConfig(config) {
  try {
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error(`[OpenClaw Config] Error saving: ${err.message}`);
    return false;
  }
}

function restartOpenClawGateway() {
  return new Promise((resolve) => {
    exec(`${OPENCLAW_CMD} gateway restart`, (error, stdout, stderr) => {
      if (error) {
        console.error(`[OpenClaw] Restart error: ${error.message}`);
        resolve({ success: false, error: error.message });
      } else {
        console.log(`[OpenClaw] Gateway restarted`);
        resolve({ success: true });
      }
    });
  });
}

function getHeartbeatStatus() {
  return new Promise((resolve) => {
    exec(`${OPENCLAW_CMD} system heartbeat last --json 2>/dev/null || ${OPENCLAW_CMD} system heartbeat last`, (error, stdout, stderr) => {
      if (error) {
        resolve({ error: error.message });
      } else {
        try {
          // Try to parse as JSON first
          const parsed = JSON.parse(stdout);
          resolve(parsed);
        } catch {
          // Return raw output
          resolve({ raw: stdout.trim() });
        }
      }
    });
  });
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Store recent tweets to avoid duplicates
const recentTweets = new Set();

function sendToOpenClaw(tweet, handleConfig = {}) {
  const message = formatTweetMessage(tweet, handleConfig);
  const mode = handleConfig.mode || 'now';
  
  // Send to OpenClaw via CLI - uses system event to inject into main session
  const escapedMessage = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const cmd = `${OPENCLAW_CMD} system event --text "${escapedMessage}" --mode ${mode}`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`[OpenClaw] Error: ${error.message}`);
      // Fallback: write to file for OpenClaw to pick up
      const fs = require('fs');
      const logFile = process.env.TWEET_LOG || './tweets.log';
      fs.appendFileSync(logFile, `${new Date().toISOString()} | ${message}\n`);
      console.log(`[Fallback] Written to ${logFile}`);
      return;
    }
    console.log(`[OpenClaw] Sent: @${tweet.author} (mode: ${mode})`);
  });
}

function formatTweetMessage(tweet, handleConfig = {}) {
  let msg = '';
  
  // Add custom prompt/instructions if configured
  if (handleConfig.prompt) {
    msg += `INSTRUCCIÓN: ${handleConfig.prompt}\n\n`;
  }
  
  // Add channel instruction if configured
  if (handleConfig.channel) {
    msg += `CANAL: Respondé por ${handleConfig.channel}\n\n`;
  }
  
  msg += `🐦 New tweet from @${tweet.author}`;
  
  if (tweet.isReply) {
    msg += ` (reply to @${tweet.inReplyToUser})`;
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

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Webhook endpoint
  if (req.method === 'POST' && (req.url === '/' || req.url === '/webhook')) {
    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        
        console.log(`[${new Date().toISOString()}] Received webhook`);
        
        if (payload.event === 'new_tweet' && payload.tweet) {
          const tweet = payload.tweet;
          
          // Dedupe
          if (recentTweets.has(tweet.id)) {
            console.log(`[Skip] Duplicate tweet ${tweet.id}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, duplicate: true }));
            return;
          }
          
          recentTweets.add(tweet.id);
          
          // Keep only last 100 tweets in memory
          if (recentTweets.size > 100) {
            const first = recentTweets.values().next().value;
            recentTweets.delete(first);
          }
          
          console.log(`[Tweet] @${tweet.author}: ${tweet.text?.substring(0, 50)}...`);
          
          // Get handle config from payload
          const handleConfig = payload.handleConfig || {};
          
          // Send to OpenClaw
          sendToOpenClaw(tweet, handleConfig);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
      } catch (err) {
        console.error(`[Error] ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ============================================
  // OpenClaw Config Endpoints
  // ============================================
  
  // Get OpenClaw config
  if (req.method === 'GET' && req.url === '/openclaw/config') {
    const config = getOpenClawConfig();
    if (config) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read config' }));
    }
    return;
  }

  // Update OpenClaw config
  if (req.method === 'PUT' && req.url === '/openclaw/config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const newConfig = JSON.parse(body);
        if (saveOpenClawConfig(newConfig)) {
          // Auto-restart gateway after config change
          const restartResult = await restartOpenClawGateway();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, restarted: restartResult.success }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save config' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Patch OpenClaw config (partial update)
  if (req.method === 'PATCH' && req.url === '/openclaw/config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const patch = JSON.parse(body);
        const config = getOpenClawConfig();
        if (!config) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read config' }));
          return;
        }
        
        // Deep merge patch into config
        const merged = deepMerge(config, patch);
        
        if (saveOpenClawConfig(merged)) {
          const restartResult = await restartOpenClawGateway();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, restarted: restartResult.success }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save config' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Restart OpenClaw gateway
  if (req.method === 'POST' && req.url === '/openclaw/restart') {
    restartOpenClawGateway().then(result => {
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Get heartbeat status
  if (req.method === 'GET' && req.url === '/openclaw/heartbeat') {
    getHeartbeatStatus().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log('================================');
  console.log('  Tweet Webhook Receiver');
  console.log('================================');
  console.log(`Listening on port ${PORT}`);
  console.log(`OpenClaw cmd: ${OPENCLAW_CMD}`);
  console.log('================================\n');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
