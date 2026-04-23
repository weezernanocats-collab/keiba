#!/usr/bin/env bash
#
# オッズ監視デーモン（paddock-watcher.sh から起動される軽量プロセス）
#
# 10秒間隔で時刻をチェックし:
#   - 発走30分前〜5分前: 5分おきにオッズスナップショット記録（通知なし）
#   - 発走3分前: 朝一 vs 直前を比較し、30%以上急落があればSlack通知
#
# 使い方（単独実行も可能）:
#   bash scripts/odds-watcher.sh
#   bash scripts/odds-watcher.sh --threshold 25
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ODDS_SCRIPT="npx tsx ${SCRIPT_DIR}/odds-snapshot.ts"
BET_CHECKER="npx tsx ${SCRIPT_DIR}/bet-checker.ts"
TODAY=$(date +%Y-%m-%d)
WORK_DIR="/tmp/paddock_watcher"
LOG_FILE="${WORK_DIR}/transcript_$(date +%Y%m%d).log"

# 設定
ODDS_DROP_THRESHOLD="${1:-30}"
if [ "$1" = "--threshold" ] && [ -n "$2" ]; then
  ODDS_DROP_THRESHOLD="$2"
fi
CHECK_INTERVAL=10  # 秒

mkdir -p "$WORK_DIR"

# 済みチェック用ファイル
ODDS_COLLECT_DONE="${WORK_DIR}/odds_watcher_collect_${TODAY}.txt"
ODDS_ALERT_DONE="${WORK_DIR}/odds_watcher_alert_${TODAY}.txt"
touch "$ODDS_COLLECT_DONE" "$ODDS_ALERT_DONE"

is_done() { grep -qF "$1" "$2" 2>/dev/null || false; }
mark_done() { echo "$1" >> "$2"; }

# レース一覧取得（race_id付き）
RACE_LIST_FILE="${WORK_DIR}/race_list.txt"
if [ ! -s "$RACE_LIST_FILE" ]; then
  cd "$PROJECT_DIR"
  node --env-file=.env.local -e "
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_DATABASE_URL.replace('libsql://', 'https://'), authToken: process.env.TURSO_AUTH_TOKEN });
(async () => {
  const r = await db.execute(\"SELECT id, time, racecourse_name, race_number, name FROM races WHERE date = '${TODAY}' AND time IS NOT NULL ORDER BY time\");
  r.rows.forEach(row => console.log(row.time + '\t' + row.racecourse_name + '\t' + row.race_number + '\t' + row.name + '\t' + row.id));
})();
" 2>/dev/null | grep -E '^[0-9]{2}:[0-9]{2}' > "$RACE_LIST_FILE"
fi

RACE_COUNT=$(wc -l < "$RACE_LIST_FILE" | tr -d ' ')
echo "[odds-watcher] 開始 $(date '+%H:%M:%S') | レース: ${RACE_COUNT}件 | 閾値: ${ODDS_DROP_THRESHOLD}% | 間隔: ${CHECK_INTERVAL}秒"

cd "$PROJECT_DIR"

while true; do
  NOW_EPOCH=$(date +%s)

  # === 5分おきスナップショット記録（発走30分前〜5分前）===
  for offset in 5 10 15 20 25 30; do
    TARGET_EPOCH=$((NOW_EPOCH + offset * 60))
    TARGET_HHMM=$(date -r "$TARGET_EPOCH" '+%H:%M' 2>/dev/null || date -d "@$TARGET_EPOCH" '+%H:%M' 2>/dev/null)
    COLLECT_KEY="${TARGET_HHMM}_${offset}"

    RACES=$(grep "^${TARGET_HHMM}	" "$RACE_LIST_FILE" 2>/dev/null || true)

    if [ -n "$RACES" ] && ! is_done "$COLLECT_KEY" "$ODDS_COLLECT_DONE"; then
      mark_done "$COLLECT_KEY" "$ODDS_COLLECT_DONE"
      echo "$RACES" | while IFS=$'\t' read -r _time venue rnum rname race_id; do
        if [ -n "$race_id" ]; then
          $ODDS_SCRIPT --date "$TODAY" --race "$race_id" --snapshot --label "T-${offset}min" > /dev/null 2>&1
        fi
      done
      echo "[odds-watcher] $(date '+%H:%M:%S') 記録: ${TARGET_HHMM}発走 -${offset}分"
    fi
  done

  # === 3分前: 急落チェック + 通知 ===
  ALERT_EPOCH=$((NOW_EPOCH + 3 * 60))
  ALERT_HHMM=$(date -r "$ALERT_EPOCH" '+%H:%M' 2>/dev/null || date -d "@$ALERT_EPOCH" '+%H:%M' 2>/dev/null)

  ALERT_RACES=$(grep "^${ALERT_HHMM}	" "$RACE_LIST_FILE" 2>/dev/null || true)

  if [ -n "$ALERT_RACES" ] && ! is_done "$ALERT_HHMM" "$ODDS_ALERT_DONE"; then
    mark_done "$ALERT_HHMM" "$ODDS_ALERT_DONE"

    echo "[odds-watcher] $(date '+%H:%M:%S') 急落チェック: ${ALERT_HHMM}発走"

    echo "$ALERT_RACES" | while IFS=$'\t' read -r _time venue rnum rname race_id; do
      if [ -n "$race_id" ]; then
        COMPARE_OUT=$($ODDS_SCRIPT --date "$TODAY" --race "$race_id" --compare --threshold "$ODDS_DROP_THRESHOLD" 2>&1)
        DROPS_JSON=$(echo "$COMPARE_OUT" | grep '__DROPS_JSON__' | sed 's/.*__DROPS_JSON__//' | sed 's/__END_JSON__.*//')

        if [ -n "$DROPS_JSON" ] && [ "$DROPS_JSON" != "[]" ]; then
          echo "[odds-watcher] 🔥 ${venue}${rnum}R ${rname}: 急落検知!"
          echo "$COMPARE_OUT" | grep -E '^\s+\S' | head -5
          echo "  [$(date '+%H:%M:%S')] オッズ急落: ${venue}${rnum}R ${DROPS_JSON}" >> "$LOG_FILE"

          DROP_MSG=$(echo "$COMPARE_OUT" | grep -E '^\s+\S.*→' | head -3 | tr '\n' '\n')
          bash "${SCRIPT_DIR}/slack-notify.sh" "📊 オッズ急落検知 ${venue}${rnum}R ${rname}\n${DROP_MSG}"
        else
          echo "[odds-watcher] ✓ ${venue}${rnum}R: 急落なし"
        fi
      fi
    done

    # 馬券セット条件チェック（同じタイミングで実行）
    BET_OUT=$($BET_CHECKER --date "$TODAY" 2>&1)
    NOTIFY_JSON=$(echo "$BET_OUT" | grep '__NOTIFY_JSON__' | sed 's/.*__NOTIFY_JSON__//' | sed 's/__END_JSON__.*//')

    if [ -n "$NOTIFY_JSON" ]; then
      NOTIFY_MSG=$(echo "$BET_OUT" | grep -v '__NOTIFY_JSON__' | grep -v '===' | grep -v '^$' | head -10 | tr '\n' '\n')
      bash "${SCRIPT_DIR}/slack-notify.sh" "🎯 馬券セット条件クリア!\n${NOTIFY_MSG}"
      echo "[odds-watcher] $(date '+%H:%M:%S') 馬券セット条件クリア"
    fi
  fi

  # 17:00以降は終了
  HOUR=$(date +%H)
  if [ "$HOUR" -ge 17 ]; then
    echo "[odds-watcher] 終了 $(date '+%H:%M:%S')"
    break
  fi

  sleep "$CHECK_INTERVAL"
done
