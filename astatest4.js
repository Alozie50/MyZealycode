const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

// === NEW CONTROL VARIABLES ===
// Change these to true/false whenever you want
const ENABLE_TEXT_TASKS = false;  // Set false to skip all text tasks
const ENABLE_FILE_TASKS = false;  // Set false to skip all file tasks
// =============================

// Load replies from replies.json (safely)
let replies = [];
try {
  const repliesPath = path.join(__dirname, 'replies.json');
  if (fs.existsSync(repliesPath)) {
    const data = fs.readFileSync(repliesPath, 'utf-8').trim();
    if (data) {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        replies = parsed;
      } else {
        console.warn('replies.json is empty or not a valid array. Using empty replies.');
      }
    }
  } else {
    console.warn('replies.json not found. Using empty replies.');
  }
} catch (err) {
  console.error('Failed to load replies.json:', err.message);
}

// Twitter API v2 client setup using credentials from .env
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEYa,
  appSecret: process.env.TWITTER_API_SECRETa,
  accessToken: process.env.TWITTER_ACCESS_TOKENa,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRETa,
});

const ZEALY_URL = 'https://api-v1.zealy.io/communities/score11/questboard/v2?filters=locked&filters=available&filters=inCooldown&filters=inReview&filters=completed';
const QUEST_URL = 'https://api-v1.zealy.io/communities/score11/quests/v2';
const CLAIM_URL = 'https://api-v1.zealy.io/communities/score11/quests/v2';
const INTERVAL = 300;
const REQUEST_DELAY = 5;
const FILE_PATH = path.join(__dirname, 'asta.json');
const MY_USERNAME = 'alozie50684';
const IS_X_AUTH_CONFIGURED = false;
const ZEALY_COOKIE = 'access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIyNzA1NjI1My0wM2MwLTRkOWQtOTcxMS1hOWM3YzRmMmMwMWQiLCJhY2NvdW50VHlwZSI6ImVtYWlsIiwiZW1haWwiOiJmZWxpeG5tZW5pNTZAZ21haWwuY29tIiwibGFzdEVtYWlsQ2hlY2siOjE3Njc0MjM0MTc2OTUsImlhdCI6MTc2NzQyMzQxNywiZXhwIjoxNzcwMDE1NDE3fQ.MDs13VHnFZ7gbKPC52c2jDwi-v8xyALM4mhUKrmXVrw; user_metadata=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIyNzA1NjI1My0wM2MwLTRkOWQtOTcxMS1hOWM3YzRmMmMwMWQiLCJpYXQiOjE3Njc0MjM0MTcsImV4cCI6MTc3MDAxNTQxN30.TNJWnSJvhMeLn-ajKuowG485jCW-z_YkH9RJaB9kXS0';

const RETRYABLE_ERROR_MSG = 'Invalid number of tasks';
const CONDITION_NOT_MET_MSG = 'condition not met';

// Track reply/post URLs per taskId
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
    if (err.response?.status === 429) {
      console.error('429 Rate Limit Error fetching quest IDs:', err.message);
    } else {
      console.error('Fetch quest IDs error:', err.message, err.response?.data);
    }
    return [];
  }
}

async function getTweetAndTaskInfo(questId) {
  const url = `${QUEST_URL}/${questId}`;
  try {
    const res = await axios.get(url, {
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
        if (task && task.metadata?.tweetId && task.settings?.actions) {
          const tweetId = task.metadata.tweetId;
          const requiresReply = task.settings.actions.includes('reply');
          const actions = task.settings.actions;

          console.log(`Task found: tweetId=${tweetId}, taskId=${taskId}, type=${taskType}, requiresReply=${requiresReply}, actions=${actions.join(', ')}`);
          taskResults.push({ tweetId, taskId, type: taskType, requiresReply, actions });
        }
      } else if (taskType === 'tweet') {
        const defaultTweet = task.settings?.defaultTweet || '';
        console.log(`Tweet task found: taskId=${taskId}, defaultTweet="${defaultTweet}"`);
        taskResults.push({ taskId, type: taskType, defaultTweet });
      } else if (['proveYourHumanity', 'twitterBlue', 'visitLink'].includes(taskType)) {
        console.log(`Task found: taskId=${taskId}, type=${taskType}`);
        taskResults.push({ taskId, type: taskType });
      } else if (taskType === 'text') {
        console.log(`Text task found: taskId=${taskId}, autoValidated=${task.settings?.autoValidated}`);
        taskResults.push({ taskId, type: taskType, autoValidated: task.settings?.autoValidated ?? false });
      } else if (taskType === 'file') {
        console.log(`File task found: taskId=${taskId}, autoValidated=${task.settings?.autoValidated}`);
        taskResults.push({ taskId, type: taskType, autoValidated: task.settings?.autoValidated ?? false });
      }
    }

    return taskResults.length > 0 ? taskResults : [];
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`429 Rate Limit Error fetching quest ${questId}:`, err.message);
    } else {
      console.error(`Failed to fetch quest ${questId}:`, err.message, err.response?.data);
    }
    return [];
  }
}

async function postTweet(content) {
  if (!content) {
    console.warn('Empty tweet content. Skipping.');
    return null;
  }

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
    if (error.code === 429) {
      console.error('429 Rate Limit Error posting tweet:', error.message);
    } else {
      console.error('Error posting tweet:', error.message, error.data);
    }
    return null;
  }
}

async function replyToTweet(originalTweetId, username) {
  if (!replies.length) {
    console.warn('No replies loaded. Skipping reply.');
    return null;
  }
  const message = replies[Math.floor(Math.random() * replies.length)];

  try {
    const response = await twitterClient.v2.tweet({
      text: message,
      reply: { in_reply_to_tweet_id: originalTweetId },
    });

    const restId = response.data.id;
    if (restId) {
      const tweetUrl = `https://x.com/${username}/status/${restId}`;
      console.log(`Tweet reply submitted: restId=${restId}, tweetUrl=${tweetUrl}`);
      return { restId, tweetUrl };
    }
    return null;
  } catch (error) {
    if (error.code === 429) {
      console.error('429 Rate Limit Error sending tweet reply:', error.message);
    } else {
      console.error('Error sending tweet reply:', error.message, error.data);
    }
    return null;
  }
}

async function submitZealyClaim(questId, taskResults) {
  const url = `${CLAIM_URL}/${questId}/claim`;
  const payload = {
    taskValues: taskResults.map(task => {
      const obj = {
        taskId: task.taskId,
        type: task.type
      };

      if (task.type === 'tweetReact' && task.tweetUrl) {
        obj.tweetUrl = task.tweetUrl;
      } else if (task.type === 'tweet' && task.tweetUrl) {
        obj.tweetUrl = task.tweetUrl;
      } else if (task.type === 'text') {
        obj.value = "Done";
      } else if (task.type === 'file') {
        obj.fileUrls = task.fileUrls || [];
      }

      return obj;
    })
  };

  const headers = {
    'authority': 'api-v1.zealy.io',
    'accept': '*/*',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    'cookie': ZEALY_COOKIE,
    'origin': 'https://zealy.io',
    'referer': 'https://zealy.io/',
    'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'x-zealy-subdomain': 'score11'
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(url, payload, { headers });
      console.log(`Claim submitted for questId: ${questId}`);
      return { success: true, shouldRetry: false };
    } catch (error) {
      if (error.response?.status === 429) {
        console.error(`429 Rate Limit Error (attempt ${attempt}/3) submitting Zealy claim for questId: ${questId}:`, error.message);
        if (attempt === 3) {
          console.error(`Failed after 3 attempts for questId: ${questId}`);
          return { success: false, shouldRetry: false };
        }
        continue;
      } else {
        const errMsg = error.response?.data?.message || error.message;
        console.error(`Error submitting Zealy claim for questId: ${questId}:`, error.message, error.response?.data);

        if (errMsg.includes(RETRYABLE_ERROR_MSG)) {
          return { success: false, shouldRetry: true };
        }
        if (errMsg.toLowerCase().includes(CONDITION_NOT_MET_MSG)) {
          return { success: false, shouldRetry: false, permanent: true };
        }
        return { success: false, shouldRetry: false };
      }
    }
  }
  return { success: false, shouldRetry: false };
}

async function watchForNewQuests() {
  let knownIds = await loadKnownIds();

  // Load file URLs once
  let fileUrlList = [];
  if (!global.fileUrlsLoaded) {
    try {
      const filePath = path.join(__dirname, 'fileUrls.json');
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8').trim();
        if (data) {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed.length > 0) {
            fileUrlList = parsed;
            console.log(`Loaded ${fileUrlList.length} file URL(s) from fileUrls.json`);
          }
        }
      }
      global.fileUrlsLoaded = true;
      global.fileUrlList = fileUrlList;
    } catch (e) {
      console.error('Failed to load fileUrls.json:', e.message);
    }
  } else {
    fileUrlList = global.fileUrlList;
  }

  setInterval(async () => {
    const currentIds = await fetchCurrentQuestIds();
    const newIds = currentIds.filter(id => !knownIds.includes(id));

    if (newIds.length > 0) {
      const processedIds = [];

      for (const questId of newIds) {
        let shouldRetry = true;
        let retryCount = 0;
        const maxRetries = 5;

        const state = questState.get(questId) || { postUrls: {} };

        while (shouldRetry && retryCount < maxRetries) {
          retryCount++;
          console.log(`Attempt ${retryCount} for questId: ${questId}`);

          const taskResults = await getTweetAndTaskInfo(questId);
          if (taskResults.length === 0) {
            const result = await submitZealyClaim(questId, []);
            if (result.success || result.permanent) {
              processedIds.push(questId);
              shouldRetry = false;
              questState.delete(questId);
            } else if (result.shouldRetry) {
              await new Promise(r => setTimeout(r, 10));
            } else {
              processedIds.push(questId);
              shouldRetry = false;
              questState.delete(questId);
            }
            break;
          }

          const claimTasks = [];

          for (const task of taskResults) {
            const { taskId, type } = task;

            if (type === 'tweetReact') {
              const { tweetId, requiresReply } = task;
              let finalTweetUrl = state.postUrls[taskId] || '';

              if (!requiresReply) {
                claimTasks.push({ taskId, type, tweetUrl: finalTweetUrl });
              } else {
                if (!IS_X_AUTH_CONFIGURED) {
                  console.error(`X credentials not configured, skipping reply-required taskId: ${taskId}`);
                  continue;
                }

                if (!finalTweetUrl) {
                  const replyResult = await replyToTweet(tweetId, MY_USERNAME);
                  if (replyResult) {
                    finalTweetUrl = replyResult.tweetUrl;
                    state.postUrls[taskId] = finalTweetUrl;
                    questState.set(questId, state);
                  } else {
                    continue;
                  }
                }

                claimTasks.push({ taskId, type, tweetUrl: finalTweetUrl });
              }
            } else if (type === 'tweet') {
              let finalTweetUrl = state.postUrls[taskId] || '';
              let content = task.defaultTweet?.trim();

              if (!finalTweetUrl) {
                if (!content) {
                  if (replies.length === 0) {
                    console.warn(`No defaultTweet and no replies.json → skipping task ${taskId}`);
                    continue;
                  }
                  content = replies[Math.floor(Math.random() * replies.length)];
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
            } else if (type === 'text') {
              // === CONTROL FOR TEXT TASKS ===
              if (!ENABLE_TEXT_TASKS) {
                console.log(`Text task skipped (ENABLE_TEXT_TASKS = false): taskId=${taskId}`);
                continue;
              }
              claimTasks.push({ taskId, type, value: "yes" });
            } else if (type === 'file') {
              // === CONTROL FOR FILE TASKS ===
              if (!ENABLE_FILE_TASKS) {
                console.log(`File task skipped (ENABLE_FILE_TASKS = false): taskId=${taskId}`);
                continue;
              }
              const randomUrl = fileUrlList.length > 0
                ? fileUrlList[Math.floor(Math.random() * fileUrlList.length)]
                : "";
              claimTasks.push({ taskId, type, fileUrls: [randomUrl] });
            }

            await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
          }

          if (claimTasks.length > 0 || taskResults.length === 0) {
            const result = await submitZealyClaim(questId, claimTasks);

            if (result.success || result.permanent) {
              processedIds.push(questId);
              shouldRetry = false;
              questState.delete(questId);
            } else if (result.shouldRetry) {
              console.log(`Retrying quest ${questId} due to "${RETRYABLE_ERROR_MSG}"...`);
              await new Promise(resolve => setTimeout(resolve, 10));
            } else {
              processedIds.push(questId);
              shouldRetry = false;
              questState.delete(questId);
            }
          } else {
            processedIds.push(questId);
            shouldRetry = false;
            questState.delete(questId);
          }
        }

        if (retryCount >= maxRetries) {
          console.warn(`Max retries reached for questId: ${questId}`);
          processedIds.push(questId);
          questState.delete(questId);
        }
      }

      if (processedIds.length > 0) {
        knownIds = [...new Set([...knownIds, ...processedIds])];
        saveKnownIds(knownIds);
      }
    }
  }, INTERVAL );  // Note: INTERVAL is in seconds, setInterval expects ms
}

watchForNewQuests();
