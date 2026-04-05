const express = require("express");
const axios = require("axios");
const cors = require("cors");
const pLimit = require("p-limit");

const app = express();
app.use(express.json());
app.use(cors({ origin: false })); // Block all cross-origin requests (API-only server)

// NETWORK SAFETY
axios.defaults.timeout = 10000; // 10s global timeout

// CONFIG
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN";
const WORKER_URL = process.env.WORKER_URL || "https://your-worker-url";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "YOUR_ADMIN_API_KEY";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// STABILITY SETTINGS
const CONCURRENCY = 20;
const RETRY_DELAY = 1000;
const UPDATE_EVERY = 25;

// GLOBAL RATE SYNC
let globalPauseUntil = 0;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function checkRateLimit() {
  if (Date.now() < globalPauseUntil) {
    const sleepTime = globalPauseUntil - Date.now();
    console.log(`[SYNC] System-wide pause active. Waiting ${sleepTime}ms...`);
    await wait(sleepTime);
  }
}

// 🔔 NOTIFY BOT IN REAL-TIME
async function notifyBot(chat_id, message_id, text) {
  if (!chat_id || !message_id) return;
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id,
      message_id,
      text,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.error("Bot Notification Failed:", e.message);
  }
}

// Helper for Worker API
const workerApi = axios.create({
  baseURL: WORKER_URL,
  headers: { "X-API-Key": ADMIN_API_KEY }
});

const concurrencyLimiter = pLimit(CONCURRENCY); // Renamed to avoid shadowing fetchUsers 'limit' param

// 🔥 FETCH USERS
async function fetchUsers(page, pageSize = 1000) {
  try {
    const res = await workerApi.get(`/api/users?page=${page}&limit=${pageSize}&active_days=30`);
    return res.data;
  } catch (e) {
    console.error(`Fetch Users Failed (Page ${page}):`, e.message);
    return [];
  }
}

// 🔥 SAFE SEND WITH RETRY & 429 HANDLING
async function safeSend(chat_id, from_chat_id, message_id, attempt = 1) {
  await checkRateLimit();

  try {
    await axios.post(`${TELEGRAM_API}/copyMessage`, {
      chat_id,
      from_chat_id,
      message_id,
    });
    return { status: "success" };
  } catch (e) {
    const description = e.response?.data?.description || e.message;
    const isRateLimited = e.response?.status === 429;

    // Comprehensive "Dead User" detection
    const deadUserDescriptions = [
      "blocked",
      "chat not found",
      "can't initiate conversation",
      "user is deactivated"
    ];
    const isDeadUser = deadUserDescriptions.some(desc => description.toLowerCase().includes(desc));

    if (isRateLimited) {
      const waitTime = (e.response.data.parameters?.retry_after || 5) * 1000;
      globalPauseUntil = Date.now() + waitTime + 500;
      console.warn(`[429] Rate limit hit. Global pause for ${waitTime}ms.`);
      await wait(waitTime + 500);
      // Max 5 rate-limit retries to avoid infinite recursion
      if (attempt < 5) return safeSend(chat_id, from_chat_id, message_id, attempt + 1);
      return { status: "failed", error: "Rate limited too many times" };
    }

    if (isDeadUser) {
      workerApi.post("/api/users/block", { user_id: chat_id, reason: `Dead user: ${description}` }).catch(() => { });
      return { status: "failed", error: "Blocked/Dead User" };
    }

    if (attempt === 1) {
      await wait(RETRY_DELAY);
      return safeSend(chat_id, from_chat_id, message_id, 2);
    }

    return { status: "failed", error: description };
  }
}

// 🔥 PROCESS BATCH (Correct Chunked Updates with Flush Mutex)
async function processBatch(users, broadcastId, fromChatId, messageId) {
  let batchResults = [];
  let stats = { success: 0, failed: 0 };
  let isFlushing = false;

  const flush = async (force = false) => {
    if (isFlushing) return;
    if (!force && batchResults.length < UPDATE_EVERY) return;
    if (batchResults.length === 0) return;
    isFlushing = true;
    const toSend = [...batchResults];
    batchResults = [];
    try {
      await workerApi.patch("/api/broadcast-logs/update", {
        broadcast_id: broadcastId,
        updates: toSend
      });
    } catch (e) {
      console.error("Partial Sync Failed:", e.message);
    } finally {
      isFlushing = false;
    }
  };

  const tasks = users.map((user) =>
    concurrencyLimiter(async () => {
      const result = await safeSend(user.user_id, fromChatId, messageId);
      batchResults.push({ user_id: user.user_id, status: result.status, error: result.error });

      if (result.status === "success") stats.success++;
      else stats.failed++;

      await flush();
    })
  );

  await Promise.all(tasks);
  await flush(true); // Force-flush remaining results
  return stats;
}

// 🔥 BROADCAST ENDPOINT (With Pipelining + Concurrent Guard)
let isBroadcasting = false;

app.post("/broadcast", async (req, res) => {
  const apiKey = req.header("X-API-Key");
  if (!apiKey || apiKey !== ADMIN_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  if (isBroadcasting) {
    return res.status(429).json({ error: "A broadcast is already in progress. Wait for it to finish." });
  }

  // Validate required fields are integers
  const message_id = parseInt(req.body.message_id);
  const from_chat_id = parseInt(req.body.from_chat_id);
  const existingId = req.body.broadcast_id ? parseInt(req.body.broadcast_id) : null;
  const status_msg_id = req.body.status_msg_id ? parseInt(req.body.status_msg_id) : null;
  const admin_id = req.body.admin_id ? parseInt(req.body.admin_id) : null;

  if (!existingId && (isNaN(message_id) || isNaN(from_chat_id))) {
    return res.status(400).json({ error: "message_id and from_chat_id must be integers" });
  }

  isBroadcasting = true;
  try {
    let bId, bTotal;
    let startSuccess = 0;
    let startFailed = 0;
    let final_message_id = message_id;
    let final_from_chat_id = from_chat_id;

    if (existingId) {
        bId = existingId;
        const progress = await workerApi.get(`/api/broadcasts/${bId}/progress`);
        bTotal = parseInt(progress.data.total_users) || 0;
        startSuccess = parseInt(progress.data.sent_count) || 0;
        startFailed = parseInt(progress.data.failed_count) || 0;
        final_message_id = parseInt(progress.data.message_id);
        final_from_chat_id = parseInt(progress.data.from_chat_id);
        
        console.log(`🚀 [RESUME] ID:${bId} | Starting from S:${startSuccess} F:${startFailed}`);
    } else {
        // Fallback: create from_chat_id + message_id (legacy path)
        const campaign = await workerApi.post("/api/broadcasts", { message_id, from_chat_id, active_days: 30 });
        bId = campaign.data.broadcast_id;
        bTotal = campaign.data.total_users;
    }

    res.json({ status: "Processing", broadcast_id: bId, total_users: bTotal });
    console.log(`🚀 [ID:${bId}] Engine started for ${bTotal} users.`);

    let page = 1;
    let totalSuccess = startSuccess;
    let totalFailed = startFailed;
    
    let nextUsersPromise = fetchUsers(page);
    // 🟢 IMMEDIATE FEEDBACK
    // Send Current Progress as soon as it starts to avoid delay
    const initialPercent = Math.round(((totalSuccess + totalFailed) / bTotal) * 100) || 0;
    await notifyBot(admin_id, status_msg_id, 
        `🚀 **Broadcast [ID:${bId}] Initializing...**\n` +
        `🔄 Progress: \`${totalSuccess + totalFailed} / ${bTotal}\` (\`${initialPercent}%\`)\n` +
        `✅ Sent: \`${totalSuccess}\` | ❌ Failed: \`${totalFailed}\``
    );

    // Loop through users in batches
    while (true) {
      const users = await nextUsersPromise;
      if (!users || !users.length) break;

        page++;
        nextUsersPromise = fetchUsers(page);

        const result = await processBatch(users, bId, final_from_chat_id, final_message_id);
        totalSuccess += result.success;
        totalFailed += result.failed;

      // Periodic Bot Feedback (Every ~25-100 users)
      const progressPercent = Math.round(((totalSuccess + totalFailed) / bTotal) * 100);
      await notifyBot(admin_id, status_msg_id,
        `🚀 **Broadcast [ID:${bId}] In Progress**\n\n` +
        `🔄 Progress: \`${totalSuccess + totalFailed} / ${bTotal}\` (\`${progressPercent}%\`)\n` +
        `✅ Sent: \`${totalSuccess}\` | ❌ Failed: \`${totalFailed}\``
      );

      console.log(`📊 [ID:${bId}] Progress: ${totalSuccess + totalFailed}/${bTotal} (S:${totalSuccess} F:${totalFailed})`);
    }

    await workerApi.patch(`/api/broadcasts/${bId}/finish`);

    // Final Bot Summary
    await notifyBot(admin_id, status_msg_id,
      `🏁 **Broadcast [ID:${bId}] Completed!**\n\n` +
      `✅ Successfully Sent: \`${totalSuccess}\`\n` +
      `❌ Failures/Blocked: \`${totalFailed}\` (Handled)\n\n` +
      `📈 Total Audience: \`${bTotal}\``
    );
    console.log(`🏁 [ID:${bId}] Broadcast completed. S:${totalSuccess} F:${totalFailed}`);

  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error(`❌ [ID:${bId}] Critical Error during broadcast:`, errorMsg);

    // Safety Switch: Ensure the dashboard doesn't stay 'RUNNING' forever
    try {
      await workerApi.patch(`/api/broadcasts/${bId}/finish`);
      await notifyBot(admin_id, status_msg_id, `❌ **Broadcast Terminated with Error:**\n${errorMsg}`);
    } catch (e) { }

    res.status(500).json({ error: errorMsg });
  } finally {
    isBroadcasting = false; // Always release lock
  }
});

app.get("/progress/:id", async (req, res) => {
  try {
    const response = await workerApi.get(`/api/broadcasts/${req.params.id}/progress`);
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: "Stats unavailable" });
  }
});

// 🔥 SECURE MEDIA PROXY
const mediaCache = new Map();

app.get("/api/media/:file_id", async (req, res) => {
  const { file_id } = req.params;

  try {
    if (mediaCache.size > 1000) {
      console.log("Memory Guard: Clearing media cache.");
      mediaCache.clear();
    }

    let filePath = mediaCache.get(file_id);
    if (!filePath) {
      const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
      if (!data.ok) throw new Error("Not found");
      filePath = data.result.file_path;
      mediaCache.set(file_id, filePath);
    }

    const response = await axios({
      url: `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
      method: 'GET',
      responseType: 'stream',
      timeout: 60000 // Override global 10s for streaming large files
    });

    res.set("Content-Type", response.headers['content-type']);
    res.set("Cache-Control", "public, max-age=3600");
    response.data.pipe(res);
  } catch (e) {
    res.status(404).send("Error");
  }
});

app.get("/api/dashboard/stats", async (req, res) => {
  try {
    const [broadcasts, users] = await Promise.all([
      workerApi.get("/api/broadcasts"),
      workerApi.get("/api/users?limit=1")
    ]);
    res.json({
      broadcasts: broadcasts.data,
      total_users: parseInt(users.headers['x-total-count'] || '0', 10) // Parse as integer, headers are strings
    });
  } catch (e) {
    res.status(500).json({ error: "Dashboard down" });
  }
});

app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile(__dirname + "/public/index.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Engine is hot on port ${PORT}`));