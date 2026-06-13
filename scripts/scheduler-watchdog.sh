#!/bin/zsh
# ipat-race-scheduler の死活監視
# 5分おきに launchd から起動される
# - レース日のみ動く (heartbeat ファイルが当日存在するか)
# - 異常検知: プロセス不在 / heartbeat 古い / 投票間際で未処理
# - 異常時: Slack通知 + kickstart (1日最大3回まで)

set -u
cd /Users/naoto_kimura/kaihatsu/keiba

DATE=$(date +%Y-%m-%d)
LOG_DIR="${HOME}/Library/Logs/keiba"
HEARTBEAT_FILE="${LOG_DIR}/scheduler-heartbeat-${DATE}.json"
RESTART_COUNT_FILE="${LOG_DIR}/watchdog-restart-count-${DATE}.txt"
WATCHDOG_LOG="${LOG_DIR}/watchdog.log"
JOB_LABEL="com.naoto.keiba.ipat-auto-bet"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$WATCHDOG_LOG"; }

# .env.local から SLACK 設定を取得
if [[ -f .env.local ]]; then
  export $(grep -E '^(SLACK_BOT_TOKEN|SLACK_CHANNEL_ID)=' .env.local | xargs)
fi

slack_notify() {
  local msg="$1"
  if [[ -z "${SLACK_BOT_TOKEN:-}" || -z "${SLACK_CHANNEL_ID:-}" ]]; then
    log "Slack 設定なし: $msg"
    return
  fi
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H 'Content-Type: application/json; charset=utf-8' \
    -d "$(jq -n --arg ch "$SLACK_CHANNEL_ID" --arg text "$msg" '{channel:$ch, text:$text}')" \
    > /dev/null
}

# heartbeat が無い = 当日schedulerが起動していない or レースなし
if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  # 9時起動直後は heartbeat 書き込み前なので 9:00-9:10 は猶予
  HOUR=$(date +%H); MIN=$(date +%M)
  if [[ "$HOUR" == "09" && "$MIN" -lt 10 ]]; then
    log "9:00直後の猶予期間、heartbeat 未生成は許容"
    exit 0
  fi
  # プロセスが居なければ レースなし日と判断して終了
  if ! pgrep -f "ipat-race-scheduler.ts" > /dev/null; then
    exit 0
  fi
  log "プロセスは居るが heartbeat 未生成 (起動直後 or 異常)"
  exit 0
fi

# heartbeat ファイル解析
NOW_EPOCH=$(date +%s)
LAST_POLL=$(jq -r '.last_poll' "$HEARTBEAT_FILE" 2>/dev/null)
# ISO 8601 → epoch (macOS の date 互換)
LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_POLL%.*}" "+%s" 2>/dev/null || echo 0)
ELAPSED=$((NOW_EPOCH - LAST_EPOCH))

# scheduler が正常終了済みなら異常扱いしない
FINISHED=$(jq -r '.finished // false' "$HEARTBEAT_FILE" 2>/dev/null)
if [[ "$FINISHED" == "true" ]]; then
  exit 0
fi

# 異常判定
ANOMALY=""

# 1. プロセス不在
if ! pgrep -f "ipat-race-scheduler.ts" > /dev/null; then
  ANOMALY="プロセス不在"
fi

# 2. heartbeat が180秒以上古い (polling間隔30秒の6倍)
if [[ -z "$ANOMALY" && "$ELAPSED" -gt 180 ]]; then
  ANOMALY="heartbeat停滞 (${ELAPSED}秒前が最終)"
fi

# 3. 投票時刻近接で未処理 (minsTo <= 10 かつ status が pending/baselined)
if [[ -z "$ANOMALY" ]]; then
  IMMINENT=$(jq -r '[.races[] | select((.status=="pending" or .status=="baselined") and .minsTo <= 10 and .minsTo > 1)] | length' "$HEARTBEAT_FILE" 2>/dev/null)
  if [[ "$IMMINENT" -gt 0 && "$ELAPSED" -gt 90 ]]; then
    DETAIL=$(jq -r '[.races[] | select((.status=="pending" or .status=="baselined") and .minsTo <= 10 and .minsTo > 1) | "\(.label)(minsTo=\(.minsTo),status=\(.status))"] | join(", ")' "$HEARTBEAT_FILE")
    ANOMALY="投票時刻近接で未処理: ${DETAIL} (heartbeat ${ELAPSED}秒前)"
  fi
fi

if [[ -z "$ANOMALY" ]]; then
  exit 0
fi

log "異常検知: $ANOMALY"

# 再起動回数チェック
RESTART_COUNT=0
if [[ -f "$RESTART_COUNT_FILE" ]]; then
  RESTART_COUNT=$(cat "$RESTART_COUNT_FILE")
fi

NOTIFIED_FILE="${LOG_DIR}/watchdog-notified-${DATE}.flag"

if [[ "$RESTART_COUNT" -ge 3 ]]; then
  # 上限到達Slack通知は1日1回のみ (連射防止)
  if [[ ! -f "$NOTIFIED_FILE" ]]; then
    slack_notify "🚨 *scheduler watchdog* ${DATE} ${ANOMALY} — 再起動上限(3回)到達、手動確認お願いします"
    touch "$NOTIFIED_FILE"
  fi
  log "再起動上限到達、通知済み (silent exit)"
  exit 1
fi

# kickstart
log "launchctl kickstart 実行 (試行 $((RESTART_COUNT + 1))/3)"
UID_=$(id -u)
launchctl kickstart -k "gui/${UID_}/${JOB_LABEL}" >> "$WATCHDOG_LOG" 2>&1
RESTART_COUNT=$((RESTART_COUNT + 1))
echo "$RESTART_COUNT" > "$RESTART_COUNT_FILE"

slack_notify "🔄 *scheduler watchdog* ${DATE} ${ANOMALY} — 自動kickstart 実行 (${RESTART_COUNT}/3)"
