#!/usr/bin/env node
/**
 * Telegram stdio MCP server for Grok Bot.
 * Token from ./token or TELEGRAM_BOT_TOKEN. Never logs secrets.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SPOOL = path.join(ROOT, "spool");
const DONE = path.join(SPOOL, "done");
const TOKEN_PATH = path.join(ROOT, "token");
const SECRET_PATH = path.join(ROOT, "webhook-secret");

function readTrimmedFileSync(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function loadBotToken() {
  const fromEnv = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const fromFile = readTrimmedFileSync(TOKEN_PATH);
  if (!fromFile) {
    throw new Error("Bot token missing: set TELEGRAM_BOT_TOKEN or write token file");
  }
  return fromFile;
}

function loadWebhookSecret() {
  const secret = readTrimmedFileSync(SECRET_PATH);
  if (!secret) {
    throw new Error("webhook-secret file missing or empty");
  }
  return secret;
}

function textResult(obj, isError = false) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function ensureDirs() {
  await fsp.mkdir(SPOOL, { recursive: true });
  await fsp.mkdir(DONE, { recursive: true });
}

async function telegramApi(method, body) {
  const token = loadBotToken();
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, description: `HTTP ${res.status} non-JSON response` };
  }
  return data;
}

async function telegramGet(method, query = {}) {
  const token = loadBotToken();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const q = qs.toString();
  const url = `https://api.telegram.org/bot${token}/${method}${q ? `?${q}` : ""}`;
  const res = await fetch(url);
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, description: `HTTP ${res.status} non-JSON response` };
  }
  return data;
}

/** Read spool/<update_id>.meta.json for progress_message_id (if present). */
async function readProgressMeta(updateId) {
  const metaPath = path.join(SPOOL, `${updateId}.meta.json`);
  try {
    const raw = await fsp.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    if (meta && meta.progress_message_id != null) {
      return meta.progress_message_id;
    }
  } catch {
    // missing or unreadable meta is fine
  }
  return null;
}

const server = new McpServer({
  name: "grokbot-telegram-bridge",
  version: "1.1.0",
});

server.registerTool(
  "tg_get_me",
  {
    title: "Telegram getMe",
    description: "Call Telegram Bot API getMe. Returns bot identity (never includes the token).",
  },
  async () => {
    try {
      const data = await telegramGet("getMe");
      if (!data.ok) return textResult(data, true);
      return textResult(data.result);
    } catch (err) {
      return textResult({ error: err?.message || "getMe failed" }, true);
    }
  }
);

server.registerTool(
  "tg_send_message",
  {
    title: "Telegram sendMessage",
    description: "Send a text message to a Telegram chat.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe("Telegram chat id"),
      text: z.string().min(1).describe("Message text"),
    },
  },
  async ({ chat_id, text }) => {
    try {
      const data = await telegramApi("sendMessage", { chat_id, text });
      if (!data.ok) return textResult(data, true);
      return textResult({ ok: true, message_id: data.result?.message_id, chat_id: data.result?.chat?.id });
    } catch (err) {
      return textResult({ error: err?.message || "sendMessage failed" }, true);
    }
  }
);

server.registerTool(
  "tg_edit_message",
  {
    title: "Telegram editMessageText",
    description:
      "Edit an existing Telegram message (OpenClaw-style progress draft updates). Never logs the bot token.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe("Telegram chat id"),
      message_id: z.union([z.string(), z.number()]).describe("Message id to edit"),
      text: z.string().min(1).describe("New message text"),
    },
  },
  async ({ chat_id, message_id, text }) => {
    try {
      const data = await telegramApi("editMessageText", {
        chat_id,
        message_id: Number(message_id),
        text,
      });
      if (!data.ok) return textResult(data, true);
      return textResult({
        ok: true,
        message_id: data.result?.message_id ?? Number(message_id),
        chat_id: data.result?.chat?.id ?? chat_id,
      });
    } catch (err) {
      return textResult({ error: err?.message || "editMessageText failed" }, true);
    }
  }
);

server.registerTool(
  "tg_delete_message",
  {
    title: "Telegram deleteMessage",
    description:
      "Delete a Telegram message (e.g. clear the progress draft before sending the final answer). Never logs the bot token.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe("Telegram chat id"),
      message_id: z.union([z.string(), z.number()]).describe("Message id to delete"),
    },
  },
  async ({ chat_id, message_id }) => {
    try {
      const data = await telegramApi("deleteMessage", {
        chat_id,
        message_id: Number(message_id),
      });
      if (!data.ok) return textResult(data, true);
      return textResult({ ok: true, chat_id, message_id: Number(message_id) });
    } catch (err) {
      return textResult({ error: err?.message || "deleteMessage failed" }, true);
    }
  }
);

server.registerTool(
  "tg_progress",
  {
    title: "Update progress draft",
    description:
      "Alias of tg_edit_message — edit the OpenClaw-style progress draft with a status/commentary line. Never logs the bot token.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe("Telegram chat id"),
      message_id: z.union([z.string(), z.number()]).describe("Progress draft message id"),
      text: z.string().min(1).describe("Progress / status text"),
    },
  },
  async ({ chat_id, message_id, text }) => {
    try {
      const data = await telegramApi("editMessageText", {
        chat_id,
        message_id: Number(message_id),
        text,
      });
      if (!data.ok) return textResult(data, true);
      return textResult({
        ok: true,
        message_id: data.result?.message_id ?? Number(message_id),
        chat_id: data.result?.chat?.id ?? chat_id,
      });
    } catch (err) {
      return textResult({ error: err?.message || "tg_progress failed" }, true);
    }
  }
);

server.registerTool(
  "tg_send_chat_action",
  {
    title: "Telegram sendChatAction",
    description: "Send a chat action (default: typing) to indicate the bot is working.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe("Telegram chat id"),
      action: z
        .string()
        .default("typing")
        .describe("Chat action, e.g. typing, upload_photo, record_voice"),
    },
  },
  async ({ chat_id, action }) => {
    try {
      const data = await telegramApi("sendChatAction", {
        chat_id,
        action: action || "typing",
      });
      if (!data.ok) return textResult(data, true);
      return textResult({ ok: true, action: action || "typing" });
    } catch (err) {
      return textResult({ error: err?.message || "sendChatAction failed" }, true);
    }
  }
);

server.registerTool(
  "tg_list_spool",
  {
    title: "List spool",
    description:
      "List pending inbound Telegram updates in the local spool directory. Preview includes progress_message_id from .meta.json when present.",
  },
  async () => {
    try {
      await ensureDirs();
      const names = await fsp.readdir(SPOOL);
      const pending = [];
      for (const name of names) {
        // Skip meta sidecars and temp files; only list update JSON.
        if (!name.endsWith(".json") || name.startsWith(".") || name.endsWith(".meta.json")) {
          continue;
        }
        const full = path.join(SPOOL, name);
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isFile()) continue;
        const updateId = String(name.replace(/\.json$/, ""));
        let preview = null;
        try {
          const raw = await fsp.readFile(full, "utf8");
          const update = JSON.parse(raw);
          const msg = update.message || update.edited_message;
          const progressMessageId = await readProgressMeta(updateId);
          preview = {
            update_id: update.update_id,
            chat_id: msg?.chat?.id ?? null,
            from: msg?.from?.username || msg?.from?.id || null,
            text: typeof msg?.text === "string" ? msg.text.slice(0, 200) : null,
            date: msg?.date ?? null,
          };
          if (progressMessageId != null) {
            preview.progress_message_id = progressMessageId;
          }
        } catch {
          preview = { file: name, parse_error: true };
        }
        pending.push({
          file: name,
          update_id: updateId,
          bytes: st.size,
          mtime_ms: st.mtimeMs,
          preview,
        });
      }
      pending.sort((a, b) => a.mtime_ms - b.mtime_ms);
      return textResult({ count: pending.length, pending });
    } catch (err) {
      return textResult({ error: err?.message || "list spool failed" }, true);
    }
  }
);

server.registerTool(
  "tg_ack_spool",
  {
    title: "Ack spool item",
    description:
      "Acknowledge (archive) a spooled update by moving it to spool/done/. Also moves .meta.json sidecar if present.",
    inputSchema: {
      update_id: z.union([z.string(), z.number()]).describe("Telegram update_id to acknowledge"),
    },
  },
  async ({ update_id }) => {
    try {
      await ensureDirs();
      const id = String(update_id);
      const src = path.join(SPOOL, `${id}.json`);
      const dest = path.join(DONE, `${id}.json`);
      try {
        await fsp.access(src, fs.constants.F_OK);
      } catch {
        return textResult({ error: `spool item not found: ${id}` }, true);
      }
      try {
        await fsp.rename(src, dest);
      } catch {
        // Cross-device or dest exists — copy then unlink.
        await fsp.copyFile(src, dest);
        await fsp.unlink(src);
      }
      // Archive progress meta sidecar alongside the update (best-effort).
      const metaSrc = path.join(SPOOL, `${id}.meta.json`);
      const metaDest = path.join(DONE, `${id}.meta.json`);
      try {
        await fsp.access(metaSrc, fs.constants.F_OK);
        try {
          await fsp.rename(metaSrc, metaDest);
        } catch {
          await fsp.copyFile(metaSrc, metaDest);
          await fsp.unlink(metaSrc);
        }
      } catch {
        // no meta — fine
      }
      return textResult({ ok: true, update_id: id, archived: dest });
    } catch (err) {
      return textResult({ error: err?.message || "ack spool failed" }, true);
    }
  }
);

server.registerTool(
  "tg_webhook_info",
  {
    title: "Telegram getWebhookInfo",
    description: "Return Telegram getWebhookInfo (URL may be present; secret is never returned by Telegram).",
  },
  async () => {
    try {
      const data = await telegramGet("getWebhookInfo");
      if (!data.ok) return textResult(data, true);
      return textResult(data.result);
    } catch (err) {
      return textResult({ error: err?.message || "getWebhookInfo failed" }, true);
    }
  }
);

server.registerTool(
  "tg_get_updates",
  {
    title: "Telegram getUpdates",
    description:
      "Call getUpdates (long-poll). Only use before a webhook is active — Telegram rejects getUpdates while a webhook is set.",
    inputSchema: {
      offset: z.number().optional().describe("Optional update offset"),
      limit: z.number().int().min(1).max(100).optional().describe("Max updates to return"),
      timeout: z.number().int().min(0).max(50).optional().describe("Long-poll timeout seconds"),
    },
  },
  async ({ offset, limit, timeout }) => {
    try {
      const body = {};
      if (offset !== undefined) body.offset = offset;
      if (limit !== undefined) body.limit = limit;
      if (timeout !== undefined) body.timeout = timeout;
      const data = await telegramApi("getUpdates", body);
      if (!data.ok) return textResult(data, true);
      return textResult({ ok: true, updates: data.result || [] });
    } catch (err) {
      return textResult({ error: err?.message || "getUpdates failed" }, true);
    }
  }
);

server.registerTool(
  "tg_set_webhook",
  {
    title: "Telegram setWebhook",
    description:
      "Set the Telegram webhook to public_url. Reads secret_token from the local webhook-secret file (never logs it).",
    inputSchema: {
      public_url: z
        .string()
        .url()
        .describe("Public HTTPS URL ending at /telegram-webhook (or your relay target)"),
    },
  },
  async ({ public_url }) => {
    try {
      const secret_token = loadWebhookSecret();
      const data = await telegramApi("setWebhook", {
        url: public_url,
        secret_token,
        allowed_updates: ["message", "edited_message"],
        drop_pending_updates: false,
      });
      if (!data.ok) return textResult(data, true);
      return textResult({ ok: true, url_set: true, description: data.description || "Webhook was set" });
    } catch (err) {
      return textResult({ error: err?.message || "setWebhook failed" }, true);
    }
  }
);

await ensureDirs();
const transport = new StdioServerTransport();
await server.connect(transport);
