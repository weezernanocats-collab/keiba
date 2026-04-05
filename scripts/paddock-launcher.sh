#!/usr/bin/env bash
#
# Slack DMからYouTube URLを受信してpaddock-watcherを起動
#
# 使い方:
#   bash scripts/paddock-launcher.sh
#
# SlackのDMにYouTube URLを送るとwatcherが自動起動。
# 新しいURLが送られたら古いwatcherを停止して再起動。
# 17時に自動終了。
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_DIR}/.env.local"

# .env.localから読み込み
SLACK_BOT_TOKEN=$(grep '^SLACK_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2)
SLACK_CHANNEL_ID=$(grep '^SLACK_CHANNEL_ID=' "$ENV_FILE" | cut -d= -f2)

if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_CHANNEL_ID" ]; then
  echo "ERROR: SLACK_BOT_TOKEN / SLACK_CHANNEL_ID が .env.local にありません"
  exit 1
fi

POLL_INTERVAL=30  # 30秒ごとにチェック
WATCHER_PID=""
CURRENT_URL=""
LAST_TS=""

echo "=== パドックランチャー起動 $(date '+%H:%M:%S') ==="
echo "Slack DMを監視中... YouTube URLを送ってください"
echo ""

# Slack通知
notify() {
  bash "${SCRIPT_DIR}/slack-notify.sh" "$1"
}

# watcher停止
stop_watcher() {
  if [ -n "$WATCHER_PID" ]; then
    kill "$WATCHER_PID" 2>/dev/null
    wait "$WATCHER_PID" 2>/dev/null
    echo "[$(date '+%H:%M:%S')] watcher停止 (PID: $WATCHER_PID)"
    WATCHER_PID=""
  fi
}

# watcher起動
start_watcher() {
  local url="$1"
  stop_watcher
  echo "[$(date '+%H:%M:%S')] watcher起動: $url"
  cd "$PROJECT_DIR"
  bash scripts/paddock-watcher.sh "$url" > /tmp/paddock_watcher/watcher.log 2>&1 &
  WATCHER_PID=$!
  CURRENT_URL="$url"
  echo "[$(date '+%H:%M:%S')] PID: $WATCHER_PID"
  notify "🐴 パドック監視開始\n${url}"
}

# メインループ
while true; do
  # 17時以降は終了
  HOUR=$(date +%H)
  if [ "$HOUR" -ge 17 ]; then
    stop_watcher
    notify "🐴 パドック監視終了（17時）"
    echo "[$(date '+%H:%M:%S')] 17時 - 終了"
    break
  fi

  # Slack DMから最新メッセージを取得
  RESPONSE=$(curl -s "https://slack.com/api/conversations.history?channel=${SLACK_CHANNEL_ID}&limit=10" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H 'Content-Type: application/json; charset=utf-8' 2>/dev/null)

  # YouTube URLを探す（最新のもの）
  URL_INFO=$(echo "$RESPONSE" | python3 -c "
import json, sys, re
try:
    d = json.load(sys.stdin)
    for m in d.get('messages', []):
        # bot自身のメッセージはスキップ
        if m.get('bot_id'):
            continue
        text = m.get('text', '')
        # YouTube URLを検出
        match = re.search(r'(https?://(?:www\.)?youtube\.com/live/[^\s>|]+|https?://youtu\.be/[^\s>|]+)', text)
        if match:
            url = match.group(1).split('|')[0].split('>')[0]
            print(f'{m.get(\"ts\", \"\")}\t{url}')
            break
except:
    pass
" 2>/dev/null)

  if [ -n "$URL_INFO" ]; then
    MSG_TS=$(echo "$URL_INFO" | cut -f1)
    NEW_URL=$(echo "$URL_INFO" | cut -f2)

    # 新しいURLが来たら起動/再起動
    if [ "$MSG_TS" != "$LAST_TS" ] && [ -n "$NEW_URL" ]; then
      LAST_TS="$MSG_TS"
      if [ "$NEW_URL" != "$CURRENT_URL" ]; then
        echo "[$(date '+%H:%M:%S')] 新しいURL検出: $NEW_URL"
        start_watcher "$NEW_URL"
      fi
    fi
  fi

  # watcherが死んでいたら再起動
  if [ -n "$WATCHER_PID" ] && ! kill -0 "$WATCHER_PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] watcher停止検知、再起動..."
    start_watcher "$CURRENT_URL"
  fi

  sleep "$POLL_INTERVAL"
done
