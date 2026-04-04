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
    const isBlocked = description.toLowerCase().includes("blocked");

    if (isRateLimited) {
      const waitTime = (e.response.data.parameters?.retry_after || 5) * 1000;
      globalPauseUntil = Date.now() + waitTime + 500;
      console.warn(`[429] Rate limit hit. Global pause for ${waitTime}ms.`);
      await wait(waitTime + 500);
      // Max 5 rate-limit retries to avoid infinite recursion
      if (attempt < 5) return safeSend(chat_id, from_chat_id, message_id, attempt + 1);
      return { status: "failed", error: "Rate limited too many times" };
    }

    if (isBlocked) {
      workerApi.post("/api/users/block", { user_id: chat_id, reason: "Blocked during broadcast" }).catch(() => {});
      return { status: "failed", error: "Blocked by user" };
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

  if (!existingId && (isNaN(message_id) || isNaN(from_chat_id))) {
    return res.status(400).json({ error: "message_id and from_chat_id must be integers" });
  }
  
  isBroadcasting = true;
  try {
    let bId, bTotal;
    if (existingId) {
        bId = existingId;
        const progress = await workerApi.get(`/api/broadcasts/${bId}/progress`);
        bTotal = parseInt(progress.data.total_users) || 0;
    } else {
        // Fallback: create from_chat_id + message_id (legacy path)
        const campaign = await workerApi.post("/api/broadcasts", { message_id, from_chat_id, active_days: 30 });
        bId = campaign.data.broadcast_id;
        bTotal = campaign.data.total_users;
    }

    res.json({ status: "Processing", broadcast_id: bId, total_users: bTotal });
    console.log(`🚀 [ID:${bId}] Engine started for ${bTotal} users.`);

    let page = 1;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    let nextUsersPromise = fetchUsers(page);

    while (true) {
        const users = await nextUsersPromise;
        if (!users || !users.length) break;

        page++;
        nextUsersPromise = fetchUsers(page);

        const result = await processBatch(users, bId, from_chat_id || existingId, message_id);
        totalSuccess += result.success;
        totalFailed += result.failed;

        console.log(`📊 [ID:${bId}] Progress: ${totalSuccess + totalFailed}/${bTotal} (S:${totalSuccess} F:${totalFailed})`);
    }

    await workerApi.patch(`/api/broadcasts/${bId}/finish`);
    console.log(`🏁 [ID:${bId}] Broadcast completed. S:${totalSuccess} F:${totalFailed}`);

  } catch (err) {
    console.error("Engine Crash:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
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