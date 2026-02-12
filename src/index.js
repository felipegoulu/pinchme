import { ApifyClient } from 'apify-client';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ============================================
// Configuration (from environment variables)
// ============================================
const config = {
  // Apify
  apifyToken: process.env.APIFY_TOKEN,
  
  // Target accounts (comma-separated)
  twitterHandles: (process.env.TWITTER_HANDLES || process.env.TWITTER_HANDLE || 'elonmusk')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean),
  
  // Polling interval (in minutes)
  pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '5'),
  
  // Webhook URL to send new tweets
  webhookUrl: process.env.WEBHOOK_URL,
  
  // Optional: webhook secret for signature
  webhookSecret: process.env.WEBHOOK_SECRET,
  
  // State file path
  stateFile: process.env.STATE_FILE || './state.json',
};

// ============================================
// State management
// ============================================
function loadState() {
  try {
    if (existsSync(config.stateFile)) {
      const data = readFileSync(config.stateFile, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading state:', err.message);
  }
  return { lastSeenTweetId: null, lastSeenTimestamp: null };
}

function saveState(state) {
  try {
    writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state:', err.message);
  }
}

// ============================================
// Apify Tweet Scraper
// ============================================
async function fetchLatestTweets(client, handles, maxItemsPerHandle = 10) {
  const handleList = Array.isArray(handles) ? handles : [handles];
  console.log(`[${new Date().toISOString()}] Fetching latest tweets from: ${handleList.map(h => '@' + h).join(', ')}...`);
  
  // Build search query for multiple handles: (from:user1 OR from:user2 OR ...)
  const searchQuery = handleList.map(h => `from:${h}`).join(' OR ');
  
  const input = {
    searchTerms: [searchQuery],
    sort: 'Latest',
    maxItems: maxItemsPerHandle * handleList.length,
  };

  // Run the Tweet Scraper actor
  const run = await client.actor('apidojo/tweet-scraper').call(input, {
    waitSecs: 120,
  });

  // Fetch results from the dataset
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  
  console.log(`[${new Date().toISOString()}] Fetched ${items.length} tweets`);
  
  return items;
}

// ============================================
// Webhook sender
// ============================================
async function sendToWebhook(tweet) {
  if (!config.webhookUrl) {
    console.log('[Webhook] No webhook URL configured, skipping');
    return;
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
      // Reply context
      inReplyToId: tweet.inReplyToId,
      inReplyToUser: tweet.inReplyToUsername,
      // If replying, include the parent tweet info
      replyTo: tweet.isReply ? {
        id: tweet.inReplyToId,
        user: tweet.inReplyToUsername,
        text: tweet.inReplyToText || tweet.quotedTweet?.text,
      } : null,
      // If quoting, include the quoted tweet
      quotedTweet: tweet.isQuote && tweet.quotedTweet ? {
        id: tweet.quotedTweet.id,
        url: tweet.quotedTweet.url,
        text: tweet.quotedTweet.text,
        author: tweet.quotedTweet.author?.userName,
      } : null,
      // Conversation ID for threads
      conversationId: tweet.conversationId,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
  };

  // Add signature if secret is configured
  if (config.webhookSecret) {
    const crypto = await import('crypto');
    const signature = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    console.log(`[Webhook] Sent tweet ${tweet.id} to webhook`);
  } catch (err) {
    console.error(`[Webhook] Error sending to webhook:`, err.message);
  }
}

// ============================================
// Main polling loop
// ============================================
async function poll(client) {
  const state = loadState();
  const now = Date.now();
  const maxAgeMs = config.pollIntervalMinutes * 60 * 1000 * 2; // 2x interval as buffer
  
  try {
    const tweets = await fetchLatestTweets(client, config.twitterHandles);
    
    if (tweets.length === 0) {
      console.log(`[${new Date().toISOString()}] No tweets found`);
      return;
    }

    // Sort by ID descending (newest first)
    tweets.sort((a, b) => b.id.localeCompare(a.id));

    // First run: just save state, don't send anything
    if (!state.lastSeenTweetId) {
      console.log(`[${new Date().toISOString()}] First run - initializing state, not sending tweets`);
      state.lastSeenTweetId = tweets[0].id;
      state.lastSeenTimestamp = new Date().toISOString();
      saveState(state);
      return;
    }

    // Find new tweets (those newer than lastSeenTweetId AND within time window)
    const newTweets = [];
    for (const tweet of tweets) {
      if (tweet.id > state.lastSeenTweetId) {
        // Also check if tweet is recent enough (within 2x polling interval)
        const tweetTime = new Date(tweet.createdAt).getTime();
        if (now - tweetTime <= maxAgeMs) {
          newTweets.push(tweet);
        } else {
          console.log(`[Skip] Tweet ${tweet.id} too old (${tweet.createdAt})`);
        }
      }
    }

    if (newTweets.length === 0) {
      console.log(`[${new Date().toISOString()}] No new tweets`);
      // Still update state with newest ID
      state.lastSeenTweetId = tweets[0].id;
      state.lastSeenTimestamp = new Date().toISOString();
      saveState(state);
      return;
    }

    console.log(`[${new Date().toISOString()}] Found ${newTweets.length} new tweet(s)`);

    // Send new tweets to webhook (oldest first, to maintain chronological order)
    newTweets.reverse();
    for (const tweet of newTweets) {
      let context = '';
      if (tweet.isReply) {
        context = ` [Reply to @${tweet.inReplyToUsername}]`;
      } else if (tweet.isQuote) {
        context = ` [Quote of @${tweet.quotedTweet?.author?.userName}]`;
      } else if (tweet.isRetweet) {
        context = ` [Retweet]`;
      }
      const author = tweet.author?.userName || 'unknown';
      console.log(`[New Tweet] @${author}${context}: ${tweet.text?.substring(0, 100)}...`);
      await sendToWebhook(tweet);
    }

    // Update state with the newest tweet ID
    state.lastSeenTweetId = tweets[0].id;
    state.lastSeenTimestamp = new Date().toISOString();
    saveState(state);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error during poll:`, err.message);
    if (err.stack) console.error(err.stack);
  }
}

// ============================================
// Main entry point
// ============================================
async function main() {
  console.log('========================================');
  console.log('  Tweet Watcher - Multi-User Monitor');
  console.log('========================================');
  console.log(`Targets: ${config.twitterHandles.map(h => '@' + h).join(', ')}`);
  console.log(`Poll interval: ${config.pollIntervalMinutes} minutes`);
  console.log(`Webhook URL: ${config.webhookUrl ? '✓ configured' : '✗ not set'}`);
  console.log(`Webhook secret: ${config.webhookSecret ? '✓ configured' : '✗ not set'}`);
  console.log('========================================\n');

  // Validate required config
  if (!config.apifyToken) {
    console.error('ERROR: APIFY_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!config.webhookUrl) {
    console.warn('WARNING: No WEBHOOK_URL set, tweets will only be logged');
  }

  // Initialize Apify client
  const client = new ApifyClient({ token: config.apifyToken });

  // Initial poll
  await poll(client);

  // Set up recurring poll
  const intervalMs = config.pollIntervalMinutes * 60 * 1000;
  console.log(`\n[${new Date().toISOString()}] Next poll in ${config.pollIntervalMinutes} minutes...`);
  
  setInterval(async () => {
    await poll(client);
    console.log(`[${new Date().toISOString()}] Next poll in ${config.pollIntervalMinutes} minutes...`);
  }, intervalMs);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Received SIGTERM, exiting...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received SIGINT, exiting...');
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
