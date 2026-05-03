#!/usr/bin/env bash
# 開催日自動起動スクリプト
#
# 毎朝cronで実行。当日レースがあればslack-bet-runnerを起動する。
# 最終レース30分後に自動停止。
#
# cron設定:
#   0 9 * * * cd ~/kaihatsu/keiba && bash scripts/race-day-launcher.sh >> /tmp/race-day-launcher.log 2>&1
#
# 手動テスト:
#   bash scripts/race-day-launcher.sh --check   # レース有無だけ確認
#   bash scripts/race-day-launcher.sh            # 実行

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

LOG_PREFIX="[launcher $(date '+%Y-%m-%d %H:%M')]"
PIDFILE="/tmp/slack-bet-runner.pid"

# .env.local読み込み
if [ -f "$PROJECT_DIR/.env.local" ]; then
  export TURSO_DATABASE_URL=$(grep '^TURSO_DATABASE_URL=' "$PROJECT_DIR/.env.local" | cut -d= -f2 | tr -d '"')
  export TURSO_AUTH_TOKEN=$(grep '^TURSO_AUTH_TOKEN=' "$PROJECT_DIR/.env.local" | cut -d= -f2 | tr -d '"')
  export SLACK_BOT_TOKEN=$(grep '^SLACK_BOT_TOKEN=' "$PROJECT_DIR/.env.local" | cut -d= -f2 | tr -d '"')
  export SLACK_CHANNEL_ID=$(grep '^SLACK_CHANNEL_ID=' "$PROJECT_DIR/.env.local" | cut -d= -f2 | tr -d '"')
fi

TODAY=$(date '+%Y-%m-%d')

# 当日のレース数をDBから取得
RACE_COUNT=$(npx tsx -e "
const { readFileSync, existsSync } = require('fs');
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)=\"?([^\"]*)\"?\$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
(async () => {
  const r = await db.execute({ sql: 'SELECT COUNT(*) as cnt FROM races WHERE date = ?', args: ['$TODAY'] });
  console.log(r.rows[0].cnt);
  db.close();
})();
" 2>/dev/null | tail -1)

echo "$LOG_PREFIX 当日レース数: $RACE_COUNT"

if [ "$RACE_COUNT" = "0" ] || [ -z "$RACE_COUNT" ]; then
  echo "$LOG_PREFIX 本日はレースなし。起動しません。"
  exit 0
fi

# --check モード: レース有無だけ確認して終了
if [ "$1" = "--check" ]; then
  echo "$LOG_PREFIX レースあり ($RACE_COUNT R)。--check モードなので起動しません。"
  exit 0
fi

# 既に起動中なら何もしない
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if ps -p "$OLD_PID" > /dev/null 2>&1; then
    echo "$LOG_PREFIX 既に起動中 (PID: $OLD_PID)。スキップ。"
    exit 0
  else
    rm -f "$PIDFILE"
  fi
fi

# 最終レース時刻を取得（HH:MM形式）
LAST_RACE_TIME=$(npx tsx -e "
const { readFileSync, existsSync } = require('fs');
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)=\"?([^\"]*)\"?\$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
(async () => {
  const r = await db.execute({ sql: 'SELECT MAX(time) as t FROM races WHERE date = ?', args: ['$TODAY'] });
  console.log(r.rows[0].t || '16:30');
  db.close();
})();
" 2>/dev/null | tail -1)

echo "$LOG_PREFIX 最終レース: ${LAST_RACE_TIME}"

# 停止時刻を計算（最終レース + 30分）
STOP_HOUR=$(echo "$LAST_RACE_TIME" | cut -d: -f1)
STOP_MIN=$(echo "$LAST_RACE_TIME" | cut -d: -f2)
STOP_MIN=$((STOP_MIN + 30))
if [ "$STOP_MIN" -ge 60 ]; then
  STOP_HOUR=$((STOP_HOUR + 1))
  STOP_MIN=$((STOP_MIN - 60))
fi
STOP_TIME=$(printf "%02d:%02d" "$STOP_HOUR" "$STOP_MIN")

echo "$LOG_PREFIX 自動停止予定: ${STOP_TIME}"

# Slack通知
if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_CHANNEL_ID" ]; then
  bash "$SCRIPT_DIR/slack-notify.sh" "🤖 開催日検知: ${TODAY} (${RACE_COUNT}R) — 自動投票Botを起動します。最終レース ${LAST_RACE_TIME}、${STOP_TIME}に停止予定。"
fi

# slack-bet-runner をバックグラウンド起動
echo "$LOG_PREFIX slack-bet-runner 起動中..."
nohup npx tsx scripts/slack-bet-runner.ts >> /tmp/slack-bet-runner.log 2>&1 &
RUNNER_PID=$!
echo "$RUNNER_PID" > "$PIDFILE"
echo "$LOG_PREFIX 起動完了 (PID: $RUNNER_PID)"

# 停止用のatジョブをスケジュール（atがなければsleepで代替）
CURRENT_EPOCH=$(date +%s)
STOP_EPOCH=$(date -j -f "%Y-%m-%d %H:%M" "${TODAY} ${STOP_TIME}" +%s 2>/dev/null)

if [ -n "$STOP_EPOCH" ] && [ "$STOP_EPOCH" -gt "$CURRENT_EPOCH" ]; then
  SLEEP_SECS=$((STOP_EPOCH - CURRENT_EPOCH))
  echo "$LOG_PREFIX ${SLEEP_SECS}秒後に自動停止 (${STOP_TIME})"

  # バックグラウンドで停止タイマー
  (
    sleep "$SLEEP_SECS"
    if [ -f "$PIDFILE" ]; then
      PID=$(cat "$PIDFILE")
      if ps -p "$PID" > /dev/null 2>&1; then
        kill "$PID" 2>/dev/null
        rm -f "$PIDFILE"
        echo "[launcher $(date '+%Y-%m-%d %H:%M')] 自動停止完了 (PID: $PID)"
        if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_CHANNEL_ID" ]; then
          bash "$SCRIPT_DIR/slack-notify.sh" "🤖 自動投票Bot停止しました (最終レース終了)"
        fi
      fi
    fi
  ) &
  echo "$LOG_PREFIX 停止タイマーセット (PID: $!)"
else
  echo "$LOG_PREFIX ⚠ 停止時刻が過去のため、タイマーはセットしません"
fi

echo "$LOG_PREFIX 完了"
