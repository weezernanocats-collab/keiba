#!/usr/bin/env bash
# Slack通知ヘルパー
# 使い方: bash scripts/slack-notify.sh "メッセージ"
#
# 環境変数: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID (.env.local から読み込み)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(dirname "$SCRIPT_DIR")/.env.local"

# .env.localから読み込み
if [ -f "$ENV_FILE" ]; then
  SLACK_BOT_TOKEN=$(grep '^SLACK_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2)
  SLACK_CHANNEL_ID=$(grep '^SLACK_CHANNEL_ID=' "$ENV_FILE" | cut -d= -f2)
fi

if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_CHANNEL_ID" ]; then
  exit 0  # 設定なしなら静かに終了
fi

MESSAGE="${1:-}"
if [ -z "$MESSAGE" ]; then
  exit 0
fi

curl -s -X POST 'https://slack.com/api/chat.postMessage' \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d "$(printf '{"channel":"%s","text":"%s"}' "$SLACK_CHANNEL_ID" "$(echo "$MESSAGE" | sed 's/"/\\"/g')")" \
  > /dev/null 2>&1
