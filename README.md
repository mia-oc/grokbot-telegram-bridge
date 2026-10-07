# grokbot-telegram-bridge

Open-source **Telegram ↔ Grok Bot** bridge: a local webhook listener, on-disk spool, and stdio [MCP](https://modelcontextprotocol.io/) server so Grok Bot can drain Telegram messages and reply.

## What this is / what it is not

**Is**

- A small Node.js service that receives Telegram Bot API webhooks on `127.0.0.1:8787`
- An atomic on-disk **spool** of inbound updates (`spool/<update_id>.json`)
- A **stdio MCP** server exposing Telegram helpers (`tg_send_message`, `tg_list_spool`, …) that Grok Bot can call as a custom MCP
- Designed to be drained by a **Grok Bot cron routine** (~1 minute latency while waking hours), not by a webhook-into-Grok path

**Is not**

- Native Telegram support inside Grok Bot (there is none)
- A hosted SaaS or always-on cloud bot framework
- Instant push: expect roughly **~1 minute drain latency** depending on your routine schedule
- A replacement for BotFather, Telegram clients, or Grok Bot itself

Architecture in one line: **Telegram → HTTPS relay → local listener → spool → Grok Bot MCP routine → `tg_send_message`**.

**UX note:** Telegram “typing…” alone is *not* progress (OpenClaw can stream tool actions; this bridge cannot). The listener therefore sends an immediate **“Queued for Grok Bot…”** receipt when a new update is spooled, then keeps typing warm until the spool item is acknowledged.

## Prerequisites

- **Node.js 18+** (20+ recommended)
- A Telegram bot from [@BotFather](https://t.me/BotFather) (API token)
- Your numeric Telegram **chat id** (allowlisted)
- **Grok Bot desktop** (to register the stdio MCP and create a cron routine)
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
| `ALLOWED_CHAT_ID` | Your numeric chat id (listener typing keepalive respects this) |

`example.env.example` shows placeholder env keys only:

```bash
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=
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

## Create a Grok Bot **cron** routine (not a webhook routine)

Create a **scheduled / cron** routine in Grok Bot (waking hours are enough), roughly **every ~1 minute**, that:

1. Calls `tg_list_spool`
2. If empty → **stay silent** (no user-visible chatter)
3. If pending → read each update, draft a reply, call `tg_send_message` to the allowlisted chat
4. Calls `tg_ack_spool` with each handled `update_id`

Do **not** wire this as a “webhook routine” that tries to receive Telegram POSTs inside Grok Bot. The local listener + spool is the ingress; the routine only drains.

Suggested prompt sketch for the routine:

> Every run: call `tg_list_spool`. If `count` is 0, do nothing and produce no user-facing message. Otherwise, for each pending item, reply helpfully via `tg_send_message` to that chat_id (only if it matches the allowlisted chat), then `tg_ack_spool` for that `update_id`. Never print tokens or secrets.

## Security

- **Never commit** `token`, `webhook-secret`, `ALLOWED_CHAT_ID`, `allowed-chat-id`, `.env`, `spool/`, or logs
- File mode **0600** for secrets; spool dirs preferably `0700`
- **Allowlist** your chat id; do not run an open relay for the world
- Rotate the BotFather token if it was pasted into chat, committed, or leaked
- Listener binds **127.0.0.1 only**; expose it only through a deliberate HTTPS relay
- Validate Telegram’s `X-Telegram-Bot-Api-Secret-Token` (built-in) — keep `webhook-secret` long and random
- Do not log tokens, secrets, or full public relay URLs in shared issue trackers

## Dogfood checklist

- [ ] `npm install` succeeds on Node 18+
- [ ] `npm run setup-secrets` then fill `token` + `ALLOWED_CHAT_ID` (0600)
- [ ] `npm run supervise` (or `npm run listener`) — `GET /healthz` returns **200**
- [ ] HTTPS relay (prefer smee.io) forwards to `http://127.0.0.1:8787/telegram-webhook`
- [ ] `tg_set_webhook` / `setWebhook` with `secret_token`; `tg_webhook_info` shows the URL
- [ ] Send yourself a Telegram message → file appears under `spool/`
- [ ] MCP registered in Grok Bot (`node` + absolute `mcp-server.mjs`)
- [ ] Cron routine drains spool, replies with `tg_send_message`, acks with `tg_ack_spool`
- [ ] Empty spool runs stay silent
- [ ] Confirm `.gitignore` excludes secrets; no secrets under version control

## Layout

```
grokbot-telegram-bridge/
  listener.mjs          # HTTP webhook + spool writer
  mcp-server.mjs        # stdio MCP tools
  supervisor.sh         # simple process keeper
  package.json
  scripts/setup-secrets.sh
  example.env.example
  LICENSE               # MIT
  README.md
```

Runtime data (gitignored): `token`, `webhook-secret`, `ALLOWED_CHAT_ID`, `spool/`, `listener.pid`, `*.log`.

## License

MIT — see [LICENSE](./LICENSE).
