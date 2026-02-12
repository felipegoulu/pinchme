#!/usr/bin/env node

const http = require('http');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3001;
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || 'openclaw';

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
