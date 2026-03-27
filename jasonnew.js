const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

// === CONTROL VARIABLES ===
const ENABLE_TEXT_TASKS = false;
const ENABLE_FILE_TASKS = false;
// =============================

// Load replies from replies.json
let replies = [];
try {
  const repliesPath = path.join(__dirname, 'replies.json');
  if (fs.existsSync(repliesPath)) {
    const data = fs.readFileSync(repliesPath, 'utf-8').trim();
    if (data) {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        replies = parsed;
      }
    }
  }
} catch (err) {
  console.error('Failed to load replies.json:', err.message);
}

// Twitter client
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEYj,
  appSecret: process.env.TWITTER_API_SECRETj,
  accessToken: process.env.TWITTER_ACCESS_TOKENj,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRETj,
});

const ZEALY_URL = 'https://api-v1.zealy.io/communities/worldx/questboard/v2?filters=locked&filters=available&filters=inCooldown&filters=inReview&filters=completed';
const QUEST_URL = 'https://api-v1.zealy.io/communities/worldx/quests/v2';
const CLAIM_URL = 'https://api-v1.zealy.io/communities/worldx/quests/v2';
const FILE_PATH = path.join(__dirname, 'asta.json');
const MY_USERNAME = 'Obinnainnit';
const IS_X_AUTH_CONFIGURED = true; // ← change to false if X auth is not working
const ZEALY_COOKIE = 'access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJiMzA1NmU0NC02YWM3LTRjODctOTgyZi0wODkwMjllZGYxNDYiLCJhY2NvdW50VHlwZSI6ImVtYWlsIiwiZW1haWwiOiJpZ3dlZW1la2EyM0BnbWFpbC5jb20iLCJsYXN0RW1haWxDaGVjayI6MTc3MzUyMDczMTI0MSwiaWF0IjoxNzczNTIwNzMxLCJleHAiOjE3NzYxMTI3MzF9.lPUyc78IY36jyUjFApqsQkmEl2KajYhE_gtykrGUKAc; user_metadata=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJiMzA1NmU0NC02YWM3LTRjODctOTgyZi0wODkwMjllZGYxNDYiLCJpYXQiOjE3NzM1MjA3MzEsImV4cCI6MTc3NjExMjczMX0.0iSEwoeMyilvSboy5m1sEqpRIdcbfc8kWCZkpOQ5DSs';

const RETRYABLE_ERROR_MSG = 'Invalid number of tasks';
const CONDITION_NOT_MET_MSG = 'condition not met';

const questState = new Map(); // questId → { postUrls: { taskId: tweetUrl } }

async function loadKnownIds() {
  if (fs.existsSync(FILE_PATH)) {
    const content = fs.readFileSync(FILE_PATH, 'utf-8');
    return JSON.parse(content);
  }
  return [];
}

function saveKnownIds(ids) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(ids, null, 2));
}

async function fetchCurrentQuestIds() {
  try {
    const res = await axios.get(ZEALY_URL, {
      headers: {
        'authority': 'api-v1.zealy.io',
        'accept': 'application/json',
        'cookie': ZEALY_COOKIE,
        'user-agent': 'Mozilla/5.0',
        'origin': 'https://zealy.io'
      }
    });
    const categories = res.data;
    const currentIds = [];
    for (const category of categories) {
      const quests = category.quests || [];
      for (const quest of quests) {
        currentIds.push(quest.id);
      }
    }
    return currentIds;
  } catch (err) {
    console.error('Fetch quest IDs error:', err.message, err.response?.data);
    return [];
  }
}

async function getTweetAndTaskInfo(questId) {
  try {
    const res = await axios.get(`${QUEST_URL}/${questId}`, {
      headers: {
        'authority': 'api-v1.zealy.io',
        'accept': 'application/json',
        'cookie': ZEALY_COOKIE,
        'user-agent': 'Mozilla/5.0',
        'origin': 'https://zealy.io'
      }
    });
    const tasks = res.data?.tasks || [];
    const taskResults = [];
    for (const task of tasks) {
      const taskId = task.id;
      const taskType = task.type || 'unknown';
      if (taskType === 'tweetReact') {
        if (task?.metadata?.tweetId && task.settings?.actions) {
          const tweetId = String(task.metadata.tweetId);
          const requiresReply = task.settings.actions.includes('reply');
          taskResults.push({ tweetId, taskId, type: taskType, requiresReply, actions: task.settings.actions });
        }
      } else if (taskType === 'tweet') {
        taskResults.push({ taskId, type: taskType, defaultTweet: task.settings?.defaultTweet || '' });
      } else if (['proveYourHumanity', 'twitterBlue', 'visitLink'].includes(taskType)) {
        taskResults.push({ taskId, type: taskType });
      } else if (taskType === 'text') {
        taskResults.push({ taskId, type: taskType, autoValidated: task.settings?.autoValidated ?? false });
      } else if (taskType === 'file') {
        taskResults.push({ taskId, type: taskType, autoValidated: task.settings?.autoValidated ?? false });
      }
    }
    return taskResults;
  } catch (err) {
    console.error(`Failed to fetch quest ${questId}:`, err.message);
    return [];
  }
}

async function postTweet(content) {
  if (!content) return null;
  try {
    const response = await twitterClient.v2.tweet({ text: content });
    const restId = response.data.id;
    if (restId) {
      const tweetUrl = `https://x.com/${MY_USERNAME}/status/${restId}`;
      console.log(`Tweet posted: "${content}" → ${tweetUrl}`);
      return { restId, tweetUrl };
    }
    return null;
  } catch (error) {
    console.error('Error posting tweet:', error.message);
    return null;
  }
}

async function replyToTweet(originalTweetId, username) {
  if (!replies.length) {
    console.warn('No replies loaded. Skipping reply.');
    return null;
  }
  const message = replies[currentReplyIndex];
  currentReplyIndex = (currentReplyIndex + 1) % replies.length;
  try {
    const response = await twitterClient.v2.tweet({
      text: message,
      reply: { in_reply_to_tweet_id: originalTweetId },
    });
    const restId = response.data.id;
    if (restId) {
      const tweetUrl = `https://x.com/${username}/status/${restId}`;
      console.log(`Reply posted: restId=${restId}`);
      return { restId, tweetUrl };
    }
    return null;
  } catch (error) {
    console.error('Error replying:', error.message);
    return null;
  }
}

async function submitZealyClaim(questId, taskResults) {
  const url = `${CLAIM_URL}/${questId}/claim`;
  const payload = {
    taskValues: taskResults.map(task => {
      const obj = { taskId: task.taskId, type: task.type };
      if (task.tweetUrl) obj.tweetUrl = task.tweetUrl;
      if (task.value) obj.value = task.value;
      if (task.fileUrls) obj.fileUrls = task.fileUrls;
      return obj;
    })
  };

  const headers = {
    'authority': 'api-v1.zealy.io',
    'accept': '*/*',
    'content-type': 'application/json',
    'cookie': ZEALY_COOKIE,
    'origin': 'https://zealy.io',
    'referer': 'https://zealy.io/',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'x-zealy-subdomain': 'propclub'
  };

  try {
    const response = await axios.post(url, payload, { headers });
    console.log(`✅ Claim SUCCESS for quest ${questId}`);
    return { success: true, shouldRetry: false };
  } catch (error) {
    const errMsg = error.response?.data?.message || error.message;
    console.error(`Claim failed for ${questId}:`, errMsg);
    if (errMsg.includes(RETRYABLE_ERROR_MSG)) return { success: false, shouldRetry: true };
    if (errMsg.toLowerCase().includes(CONDITION_NOT_MET_MSG)) return { success: false, shouldRetry: false, permanent: true };
    return { success: false, shouldRetry: false };
  }
}

async function processQuests() {
  let knownIds = await loadKnownIds();

  console.log("Starting strict sequential quest processor (no overlapping, no delays)...");

  while (true) {
    const currentIds = await fetchCurrentQuestIds();
    const newIds = currentIds.filter(id => !knownIds.includes(id));

    if (newIds.length === 0) continue;

    console.log(`Found ${newIds.length} new quests`);

    const processedIds = [];

    for (const questId of newIds) {
      console.log(`\n=== Processing quest ${questId} ===`);

      let retryCount = 0;
      const maxRetries = 5;
      let shouldRetry = true;
      const state = questState.get(questId) || { postUrls: {} };

      while (shouldRetry && retryCount < maxRetries) {
        retryCount++;
        console.log(`Attempt ${retryCount}/${maxRetries}`);

        const taskResults = await getTweetAndTaskInfo(questId);
        const claimTasks = [];

        for (const task of taskResults) {
          const { taskId, type } = task;

          if (type === 'tweetReact') {
            const { tweetId, requiresReply } = task;
            let finalTweetUrl = state.postUrls[taskId] || '';

            if (!requiresReply) {
              claimTasks.push({ taskId, type, tweetUrl: finalTweetUrl });
              continue;
            }

            if (!IS_X_AUTH_CONFIGURED) {
              console.log(`Skipping reply-required task ${taskId} — X auth disabled`);
              continue;
            }

            const replyResult = await replyToTweet(tweetId, MY_USERNAME);
            if (replyResult) {
              finalTweetUrl = replyResult.tweetUrl;
              state.postUrls[taskId] = finalTweetUrl;
              questState.set(questId, state);
              claimTasks.push({ taskId, type, tweetUrl: finalTweetUrl });
            } else {
              console.log(`Reply failed for tweetId ${tweetId} — skipping`);
              continue;
            }
          } else if (type === 'tweet') {
            let finalTweetUrl = state.postUrls[taskId] || '';
            let content = task.defaultTweet?.trim();

            if (!finalTweetUrl) {
              if (!content) {
                if (!replies.length) {
                  console.warn(`No content for tweet task ${taskId} — skipping`);
                  continue;
                }
                content = replies[currentReplyIndex];
                currentReplyIndex = (currentReplyIndex + 1) % replies.length;
              }
              const postResult = await postTweet(content);
              if (postResult) {
                finalTweetUrl = postResult.tweetUrl;
                state.postUrls[taskId] = finalTweetUrl;
                questState.set(questId, state);
              } else {
                continue;
              }
            }
            claimTasks.push({ taskId, type, tweetUrl: finalTweetUrl });
          } else if (['visitLink', 'proveYourHumanity', 'twitterBlue'].includes(type)) {
            claimTasks.push({ taskId, type });
          } else if (type === 'text' && ENABLE_TEXT_TASKS) {
            claimTasks.push({ taskId, type, value: "yes" });
          } else if (type === 'file' && ENABLE_FILE_TASKS) {
            const randomUrl = fileUrlList[Math.floor(Math.random() * fileUrlList.length)] || "";
            claimTasks.push({ taskId, type, fileUrls: [randomUrl] });
          }
        }

        const result = await submitZealyClaim(questId, claimTasks);

        if (result.success || result.permanent) {
          console.log(`Claim SUCCESS for ${questId}`);
          processedIds.push(questId);
          shouldRetry = false;
          questState.delete(questId);
        } else if (result.shouldRetry) {
          console.log(`Retrying ${questId} immediately`);
          continue;
        } else {
          console.log(`Permanent fail for ${questId}`);
          processedIds.push(questId);
          shouldRetry = false;
          questState.delete(questId);
        }
      }

      saveKnownIds([...new Set([...knownIds, ...processedIds])]);
    }
  }
}

console.log("Starting quest processor...");
processQuests();
