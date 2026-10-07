# grokbot-telegram-bridge

Open-source **Telegram ↔ Grok Bot** bridge: a local webhook listener, on-disk spool, and stdio [MCP](https://modelcontextprotocol.io/) server so Grok Bot can drain Telegram messages and reply **immediately** when woken.

## What this is / what it is not

**Is**

- A small Node.js service that receives Telegram Bot API webhooks on `127.0.0.1:8787`
- An atomic on-disk **spool** of inbound updates (`spool/<update_id>.json`)
- A **stdio MCP** server exposing Telegram helpers (`tg_send_message`, `tg_list_spool`, …) that Grok Bot can call as a custom MCP
- Designed to **wake Grok Bot via a webhook routine** on each new Telegram message (NOT cron)

**Is not**

- Native Telegram support inside Grok Bot (there is none)
- A hosted SaaS or always-on cloud bot framework
- A cron-first design — **polling/cron drain was the wrong architecture**; use a webhook routine
- A replacement for BotFather, Telegram clients, or Grok Bot itself

Architecture in one line: **Telegram → HTTPS relay → local listener → spool → wake POST → Grok Bot webhook routine → MCP (`tg_list_spool` / `tg_send_message`)**.

**UX note (be blunt):** Telegram “typing…” alone is *not* progress (OpenClaw can stream tool actions; this bridge cannot). The listener therefore sends an immediate **“Queued for Grok Bot…”** receipt when a new update is spooled, then keeps typing warm until the spool item is acknowledged. Typing ≠ the agent working. Cron ≠ immediacy. Wake the agent.

## Prerequisites

- **Node.js 18+** (20+ recommended)
- A Telegram bot from [@BotFather](https://t.me/BotFather) (API token)
- Your numeric Telegram **chat id** (allowlisted)
- **Grok Bot desktop** (to register the stdio MCP and create a **webhook routine**)
- A public HTTPS front-door for Telegram webhooks (see [Public HTTPS](#public-https--prefer-smeeio))

## Install

```bash
git clone <this-repo-url> grokbot-telegram-bridge
cd grokbot-telegram-bridge
npm install
```

### Secrets (never commit)

Create secrets **outside the repo** or only in **gitignored** paths. Modes should be `0600`.

Helper (creates empty/`minted` files in the package directory — they are gitignored):

```bash
npm run setup-secrets
# or: bash scripts/setup-secrets.sh
```

Then edit:

| File | Purpose |
|------|---------|
| `token` | BotFather token (or set `TELEGRAM_BOT_TOKEN`) |
| `webhook-secret` | Random `secret_token` for `setWebhook` / `X-Telegram-Bot-Api-Secret-Token` |
| `ALLOWED_CHAT_ID` | Your numeric chat id (receipt, typing, and wake respect this) |
| `grokbot-wake-url` | Full HTTPS URL of the Grok Bot **webhook routine** |
| `grokbot-wake-secret` | Sender key / secret for that routine (Authorization Bearer + `X-Webhook-Secret`) |

`example.env.example` shows placeholder env keys only:

```bash
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=
# Optional override: GROKBOT_WAKE_HEADER="Header-Name: value"
```

**Do not** put real tokens in the repo, in README snippets, or in chat. If a token is ever pasted into chat, **revoke/rotate it in BotFather**.

## Run the listener

Bind address is hard-coded to loopback:

- `GET  http://127.0.0.1:8787/healthz` → `200 ok`
- `POST http://127.0.0.1:8787/telegram-webhook` → Telegram updates (requires secret header)

Foreground:

```bash
npm run listener
# or: node listener.mjs
```

Optional supervisor (restart-friendly, writes `listener.pid` / `listener.log`):

```bash
npm run supervise
# or: bash supervisor.sh
```

Confirm health:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz
# expect 200
```

## Public HTTPS — prefer smee.io

Telegram requires a public **HTTPS** webhook URL. Your listener stays on `127.0.0.1:8787`.

**Cloudflare Tunnel** often fails Telegram’s DNS/resolve checks for some setups. Prefer a relay such as **[smee.io](https://smee.io/)**:

1. Create a smee channel; note the public HTTPS URL.
2. Run the smee client locally, forwarding to `http://127.0.0.1:8787/telegram-webhook`.
3. Point Telegram’s webhook at the **smee (or other relay) public URL** that ultimately POSTs to `/telegram-webhook`.

Any stable HTTPS reverse proxy/tunnel that Telegram can resolve is fine; smee is the documented default recommendation here because Cloudflare tunnels frequently fail Telegram resolve.

Do **not** paste your public smee/relay URL into shared issue trackers or chat logs.

## setWebhook (and never mix with getUpdates)

With the listener running and the relay forwarding:

1. Ensure `webhook-secret` exists (`npm run setup-secrets`).
2. Call Telegram `setWebhook` with:
   - `url` = your public HTTPS webhook URL
   - `secret_token` = contents of `webhook-secret` (same value the listener checks on `X-Telegram-Bot-Api-Secret-Token`)

Via MCP (once registered):

- Tool: `tg_set_webhook`
- Arg: `public_url` = your public HTTPS URL

Or via curl (do **not** echo the token/secret into shell history logs you share):

```bash
# Illustrative only — load token/secret from files; do not paste into chat
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://YOUR_PUBLIC_HOST/telegram-webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\"}"
```

**Important:** While a webhook is active, **do not call `getUpdates`**. Telegram rejects long-polling when a webhook is set. Use `tg_get_updates` only for pre-webhook debugging. Inspect webhook state with `tg_webhook_info`.

## Register as a Grok Bot custom MCP (stdio)

In Grok Bot → custom MCP / Add MCP server (stdio):

| Field | Suggested value |
|-------|-----------------|
| Name | `grokbot-telegram-bridge` (or `telegram`) |
| Command | `node` |
| Args | `/ABS/PATH/TO/grokbot-telegram-bridge/mcp-server.mjs` |
| CWD (if offered) | `/ABS/PATH/TO/grokbot-telegram-bridge` |

Dogfood / box path example:

- Command: `node`
- Args: `/home/box/.local/telegram-mcp/mcp-server.mjs`

The MCP process reads `token` / `webhook-secret` / `spool/` relative to the script directory (or `TELEGRAM_BOT_TOKEN` from the environment). **Never** put the token in the MCP args.

### MCP tools

| Tool | Purpose |
|------|---------|
| `tg_get_me` | Bot identity |
| `tg_send_message` | `chat_id`, `text` |
| `tg_send_chat_action` | `chat_id`, `action` (default `typing`) |
| `tg_list_spool` | Pending inbound updates |
| `tg_ack_spool` | Archive `update_id` → `spool/done/` |
| `tg_webhook_info` | Telegram `getWebhookInfo` |
| `tg_get_updates` | Pre-webhook long-poll only |
| `tg_set_webhook` | Set webhook; reads `webhook-secret` |

## Wake Grok Bot with a **webhook routine** (primary path)

Cron/polling drain was the wrong design. Wire immediacy like this:

1. In Grok Bot, create a **webhook routine** (not a scheduled/cron routine).
2. Copy the routine’s **HTTPS URL** into `grokbot-wake-url` (mode `0600`).
3. Copy the routine’s **sender key / secret** into `grokbot-wake-secret` (mode `0600`).
4. Restart the listener (or supervisor) so it can read the new files.

On each **new** spool write (`created === true`), after Telegram already got `200 ok`, the listener asynchronously POSTs:

```json
{ "source": "telegram-bridge", "update_id": "...", "chat_id": 123 }
```

Auth headers (default): both `Authorization: Bearer <secret>` and `X-Webhook-Secret: <secret>`.  
Optional override: set env `GROKBOT_WAKE_HEADER` to `Name: value` to send that single header instead.

If either wake file is missing/empty: spool + Queued receipt + typing still run; wake is skipped with log line `wake skipped: missing grokbot-wake-url/secret`. Wake failures never fail the Telegram webhook response. Only allowlisted chats (`ALLOWED_CHAT_ID`) trigger a wake (same gate as the receipt).

### What the webhook routine should do

When woken, the routine should:

1. Call `tg_list_spool`
2. If empty → stay silent
3. If pending → read each update, reply via `tg_send_message` to the allowlisted chat
4. Call `tg_ack_spool` for each handled `update_id`

Suggested prompt sketch:

> On wake: call `tg_list_spool`. If `count` is 0, do nothing and produce no user-facing message. Otherwise, for each pending item, reply helpfully via `tg_send_message` to that chat_id (only if it matches the allowlisted chat), then `tg_ack_spool` for that `update_id`. Never print tokens or secrets. Do not wait for a cron tick — you were woken because a message arrived.

Optional smoke test (does not print secrets):

```bash
node scripts/send-wake-test.mjs
```

## Security

- **Never commit** `token`, `webhook-secret`, `grokbot-wake-url`, `grokbot-wake-secret`, `ALLOWED_CHAT_ID`, `allowed-chat-id`, `.env`, `spool/`, or logs
- File mode **0600** for secrets; spool dirs preferably `0700`
- **Allowlist** your chat id; do not run an open relay for the world
- Rotate the BotFather token if it was pasted into chat, committed, or leaked
- Listener binds **127.0.0.1 only**; expose it only through a deliberate HTTPS relay
- Validate Telegram’s `X-Telegram-Bot-Api-Secret-Token` (built-in) — keep `webhook-secret` long and random
- Do not log tokens, secrets, wake URLs, or full public relay URLs in shared issue trackers

## Dogfood checklist

- [ ] `npm install` succeeds on Node 18+
- [ ] `npm run setup-secrets` then fill `token` + `ALLOWED_CHAT_ID` (0600)
- [ ] Create Grok Bot **webhook routine**; paste URL + sender key into `grokbot-wake-url` / `grokbot-wake-secret` (0600)
- [ ] `npm run supervise` (or `npm run listener`) — `GET /healthz` returns **200**
- [ ] HTTPS relay (prefer smee.io) forwards to `http://127.0.0.1:8787/telegram-webhook`
- [ ] `tg_set_webhook` / `setWebhook` with `secret_token`; `tg_webhook_info` shows the URL
- [ ] Send yourself a Telegram message → file appears under `spool/` + Queued receipt + wake POST
- [ ] MCP registered in Grok Bot (`node` + absolute `mcp-server.mjs`)
- [ ] Webhook routine drains spool, replies with `tg_send_message`, acks with `tg_ack_spool`
- [ ] Empty spool runs stay silent
- [ ] Confirm `.gitignore` excludes secrets; no secrets under version control

## Layout

```
grokbot-telegram-bridge/
  listener.mjs          # HTTP webhook + spool writer + wake POST
  mcp-server.mjs        # stdio MCP tools
  supervisor.sh         # simple process keeper
  package.json
  scripts/setup-secrets.sh
  scripts/send-wake-test.mjs
  example.env.example
  LICENSE               # MIT
  README.md
```

Runtime data (gitignored): `token`, `webhook-secret`, `grokbot-wake-url`, `grokbot-wake-secret`, `ALLOWED_CHAT_ID`, `spool/`, `listener.pid`, `*.log`.

## License

MIT — see [LICENSE](./LICENSE).
