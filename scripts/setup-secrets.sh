#!/usr/bin/env bash
# Mint local secret files with mode 0600. Does not print secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

umask 077

if [[ ! -f webhook-secret ]]; then
  # 32+ bytes hex; Telegram secret_token allows 1-256 chars [A-Za-z0-9_-]
  openssl rand -hex 32 > webhook-secret
  chmod 0600 webhook-secret
  echo "created webhook-secret (0600)"
else
  chmod 0600 webhook-secret
  echo "webhook-secret already present; ensured 0600"
fi

if [[ ! -f token ]]; then
  : > token
  chmod 0600 token
  echo "created empty token (0600) — paste BotFather token into this file"
else
  chmod 0600 token
  echo "token already present; ensured 0600"
fi

if [[ ! -f ALLOWED_CHAT_ID ]]; then
  if [[ -f allowed-chat-id ]]; then
    cp -f allowed-chat-id ALLOWED_CHAT_ID
    chmod 0600 ALLOWED_CHAT_ID
    echo "created ALLOWED_CHAT_ID from allowed-chat-id"
  else
    : > ALLOWED_CHAT_ID
    chmod 0600 ALLOWED_CHAT_ID
    echo "created empty ALLOWED_CHAT_ID (0600) — put your numeric chat id in this file"
  fi
else
  chmod 0600 ALLOWED_CHAT_ID
  echo "ALLOWED_CHAT_ID already present; ensured 0600"
fi

# Keep lowercase alias in sync if both empty/new is useful for humans
if [[ ! -f allowed-chat-id ]]; then
  cp -f ALLOWED_CHAT_ID allowed-chat-id
  chmod 0600 allowed-chat-id
fi

for f in grokbot-wake-url grokbot-wake-secret; do
  if [[ ! -f "$f" ]]; then
    : > "$f"
    chmod 0600 "$f"
    echo "created empty $f (0600) — paste Grok Bot webhook routine URL/secret"
  else
    chmod 0600 "$f"
    echo "$f already present; ensured 0600"
  fi
done

mkdir -p spool/done
chmod 0700 spool spool/done 2>/dev/null || true

echo "done. Fill token, ALLOWED_CHAT_ID, grokbot-wake-url, grokbot-wake-secret, then start the listener."
