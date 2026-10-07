#!/usr/bin/env node
/**
 * Telegram webhook listener — binds 127.0.0.1:8787 only.
 * POST /telegram-webhook  ·  GET /healthz
 * Never logs token, webhook secret, wake secret/url, or public URL.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SPOOL = path.join(ROOT, "spool");
const DONE = path.join(SPOOL, "done");
const SECRET_PATH = path.join(ROOT, "webhook-secret");
const TOKEN_PATH = path.join(ROOT, "token");
const ALLOWED_CHAT_PATH = path.join(ROOT, "ALLOWED_CHAT_ID");
const WAKE_URL_PATH = path.join(ROOT, "grokbot-wake-url");
const WAKE_SECRET_PATH = path.join(ROOT, "grokbot-wake-secret");
const HOST = "127.0.0.1";
const PORT = 8787;
const BODY_LIMIT = 1_048_576; // ~1 MiB
const TYPING_INTERVAL_MS = 4_000;
const TYPING_MAX_MS = 120_000;
const WAKE_TIMEOUT_MS = 10_000;

/**
 * OpenClaw-style progress draft initial headline (streaming.mode=progress).
 * Keep the wake line for inbound; agent edits should then mirror exact
 * Grok in-app commentary (e.g. "Running a few commands") via tg_progress.
 */
const PROGRESS_DRAFT_INITIAL = "● waking Grok Bot";

function readTrimmedFileSync(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still compare equal-length buffers to reduce timing leak on length.
    crypto.timingSafeEqual(ba.length ? ba : Buffer.alloc(1), ba.length ? ba : Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function loadWebhookSecret() {
  const secret = readTrimmedFileSync(SECRET_PATH);
  if (!secret) {
    console.error("listener: webhook-secret file missing or empty; refusing to start");
    process.exit(1);
  }
  return secret;
}

function loadBotToken() {
  const fromEnv = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  return readTrimmedFileSync(TOKEN_PATH);
}

function loadAllowedChatId() {
  const raw = readTrimmedFileSync(ALLOWED_CHAT_PATH);
  return raw || null;
}

function chatAllowed(chatId) {
  const allowed = loadAllowedChatId();
  if (allowed === null) return true;
  return String(chatId) === allowed;
}

async function ensureDirs() {
  await fsp.mkdir(SPOOL, { recursive: true });
  await fsp.mkdir(DONE, { recursive: true });
}

/** Atomically write spool/<update_id>.json. Idempotent if file already exists. */
async function writeSpoolAtomic(updateId, bodyBuf) {
  const dest = path.join(SPOOL, `${updateId}.json`);
  try {
    await fsp.access(dest, fs.constants.F_OK);
    return { path: dest, created: false };
  } catch {
    // does not exist
  }
  const tmp = path.join(SPOOL, `.${updateId}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, bodyBuf, { mode: 0o600 });
  try {
    await fsp.rename(tmp, dest);
    return { path: dest, created: true };
  } catch (err) {
    // Race: another writer won — treat as idempotent success if dest exists.
    await fsp.unlink(tmp).catch(() => {});
    try {
      await fsp.access(dest, fs.constants.F_OK);
      return { path: dest, created: false };
    } catch {
      throw err;
    }
  }
}

async function sendChatAction(token, chatId, action = "typing") {
  if (!token) return;
  try {
    const url = `https://api.telegram.org/bot${token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // best-effort; never log token
  }
}

/**
 * sendMessage; returns message_id on success, null otherwise.
 * Never logs token.
 */
async function sendTextMessage(token, chatId, text) {
  if (!token || chatId == null || !text) return null;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok && data.result && data.result.message_id != null) {
      return data.result.message_id;
    }
    return null;
  } catch {
    // best-effort; never log token
    return null;
  }
}

/**
 * OpenClaw-style progress draft: ONE status message on new inbound.
 * Persists { chat_id, progress_message_id } to spool/<update_id>.meta.json (0600).
 * On idempotent redelivery (created===false), do not send another draft.
 * Returns progress_message_id or null.
 */
async function startProgressDraft(chatId, updateId, created) {
  if (!created) return null;
  if (!chatAllowed(chatId)) return null;
  const token = loadBotToken();
  if (!token) return null;

  const messageId = await sendTextMessage(token, chatId, PROGRESS_DRAFT_INITIAL);
  if (messageId == null) {
    console.error("listener: progress draft send failed");
    return null;
  }

  const metaPath = path.join(SPOOL, `${updateId}.meta.json`);
  const meta = {
    chat_id: chatId,
    progress_message_id: messageId,
  };
  try {
    const tmp = path.join(SPOOL, `.${updateId}.meta.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(meta) + "\n", { mode: 0o600 });
    await fsp.rename(tmp, metaPath);
  } catch (err) {
    console.error(
      `listener: progress meta write failed: ${err && err.message ? err.message : "unknown"}`,
    );
  }
  return messageId;
}

/**
 * POST a wake to Grok Bot webhook-routine after a NEW spool write.
 * Never logs URL or secret. Failures are log-only; never affect Telegram 200.
 */
async function wakeGrokBot({ updateId, chatId, progressMessageId }) {
  if (!chatAllowed(chatId)) return;

  const wakeUrl = readTrimmedFileSync(WAKE_URL_PATH);
  const wakeSecret = readTrimmedFileSync(WAKE_SECRET_PATH);
  if (!wakeUrl || !wakeSecret) {
    console.error("listener: wake skipped: missing grokbot-wake-url/secret");
    return;
  }

  const headers = { "Content-Type": "application/json" };
  const customHeader = (process.env.GROKBOT_WAKE_HEADER || "").trim();
  if (customHeader) {
    const colon = customHeader.indexOf(":");
    if (colon > 0) {
      const name = customHeader.slice(0, colon).trim();
      const value = customHeader.slice(colon + 1).trim();
      if (name && value) headers[name] = value;
    }
  } else {
    headers["Authorization"] = `Bearer ${wakeSecret}`;
    headers["X-Webhook-Secret"] = wakeSecret;
  }

  const payload = {
    source: "telegram-bridge",
    update_id: String(updateId),
    chat_id: chatId,
  };
  if (progressMessageId != null) {
    payload.progress_message_id = progressMessageId;
  }
  const body = JSON.stringify(payload);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WAKE_TIMEOUT_MS);
  try {
    const res = await fetch(wakeUrl, {
      method: "POST",
      headers,
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(`listener: wake POST failed status=${res.status}`);
    } else {
      console.error(`listener: wake POST ok status=${res.status}`);
    }
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "timeout"
        : err && err.message
          ? err.message
          : "unknown";
    console.error(`listener: wake POST error: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * While spool file exists (and under 2 min), send typing every 4s.
 * Optional/secondary: progress draft text is the primary signal of life.
 * Only for message updates; respects ALLOWED_CHAT_ID when present.
 */
function startTypingKeepalive(spoolPath, chatId) {
  const token = loadBotToken();
  if (!token || chatId == null) return;
  if (!chatAllowed(chatId)) return;

  const started = Date.now();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (Date.now() - started >= TYPING_MAX_MS) {
      stopped = true;
      return;
    }
    try {
      await fsp.access(spoolPath, fs.constants.F_OK);
    } catch {
      stopped = true;
      return;
    }
    await sendChatAction(token, chatId, "typing");
  };

  void tick();
  const timer = setInterval(() => {
    void tick().then(() => {
      if (stopped) clearInterval(timer);
    });
  }, TYPING_INTERVAL_MS);
  timer.unref?.();
}

function readBodyLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

const webhookSecret = loadWebhookSecret();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      send(res, 200, "ok");
      return;
    }

    if (req.method === "POST" && url.pathname === "/telegram-webhook") {
      const headerSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (!timingSafeEqualStr(typeof headerSecret === "string" ? headerSecret : "", webhookSecret)) {
        send(res, 401, "unauthorized");
        return;
      }

      let bodyBuf;
      try {
        bodyBuf = await readBodyLimited(req, BODY_LIMIT);
      } catch (err) {
        if (err && err.code === "BODY_TOO_LARGE") {
          send(res, 413, "payload too large");
          return;
        }
        send(res, 400, "bad request");
        return;
      }

      let update;
      try {
        update = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        send(res, 400, "invalid json");
        return;
      }

      const updateId = update?.update_id;
      if (updateId == null || (typeof updateId !== "number" && typeof updateId !== "string")) {
        send(res, 400, "missing update_id");
        return;
      }

      const { path: spoolPath, created } = await writeSpoolAtomic(String(updateId), bodyBuf);
      send(res, 200, "ok");

      const msg = update.message || update.edited_message;
      const chatId = msg && msg.chat && msg.chat.id != null ? msg.chat.id : null;
      let progressMessageId = null;
      if (chatId != null) {
        // Await draft so wake POST can include progress_message_id.
        progressMessageId = await startProgressDraft(chatId, String(updateId), created);
        startTypingKeepalive(spoolPath, chatId);
      }
      if (created) {
        void wakeGrokBot({
          updateId,
          chatId,
          progressMessageId,
        });
      }
      return;
    }

    send(res, 404, "not found");
  } catch (err) {
    console.error("listener: request error", err && err.message ? err.message : "unknown");
    if (!res.headersSent) send(res, 500, "error");
  }
});

await ensureDirs();
server.listen(PORT, HOST, () => {
  console.error(`listener: listening on ${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
