#!/usr/bin/env node
/**
 * Optional smoke test: POST a wake payload using grokbot-wake-url/secret.
 * Never prints URL or secret contents.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wakeUrl = fs.existsSync(path.join(ROOT, "grokbot-wake-url"))
  ? fs.readFileSync(path.join(ROOT, "grokbot-wake-url"), "utf8").trim()
  : "";
const wakeSecret = fs.existsSync(path.join(ROOT, "grokbot-wake-secret"))
  ? fs.readFileSync(path.join(ROOT, "grokbot-wake-secret"), "utf8").trim()
  : "";

if (!wakeUrl || !wakeSecret) {
  console.error("wake test skipped: missing grokbot-wake-url/secret");
  process.exit(2);
}

const headers = { "Content-Type": "application/json" };
const customHeader = (process.env.GROKBOT_WAKE_HEADER || "").trim();
if (customHeader) {
  const colon = customHeader.indexOf(":");
  if (colon > 0) {
    headers[customHeader.slice(0, colon).trim()] = customHeader.slice(colon + 1).trim();
  }
} else {
  headers["Authorization"] = `Bearer ${wakeSecret}`;
  headers["X-Webhook-Secret"] = wakeSecret;
}

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 10_000);
try {
  const res = await fetch(wakeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "telegram-bridge",
      update_id: "wake-test",
      chat_id: 0,
    }),
    signal: ac.signal,
  });
  console.error(`wake test status=${res.status}`);
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  const msg = err && err.name === "AbortError" ? "timeout" : err?.message || "unknown";
  console.error(`wake test error: ${msg}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
