#!/usr/bin/env bash
#
# パドック解説リアルタイ��文字起こし + 発走7分前に予想一括再生成
#
# 使い方:
#   bash scripts/paddock-watcher.sh <YouTube_URL>
#
# 動作:
#   1. ライブ配信音声を60秒チャンクで継続取得・文字起こし
#   2. 発走7分���になったレースを検知
#   3. 当日の未発走レースをまとめて予想再生成
#   4. 全テキストをログに保存
#

set -eo pipefail

YOUTUBE_URL="${1:-}"
if [ -z "$YOUTUBE_URL" ]; then
  echo "Usage: bash scripts/paddock-watcher.sh <YouTube_URL>"
  exit 1
fi

CHUNK_SECONDS=60
WHISPER_MODEL=tiny
WORK_DIR="/tmp/paddock_watcher"
LOG_FILE="${WORK_DIR}/transcript_$(date +%Y%m%d).log"
JSONL_FILE="${WORK_DIR}/chunks_$(date +%Y%m%d).jsonl"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REGEN_SCRIPT="npx tsx ${SCRIPT_DIR}/gen-predictions-optimized.ts"
RESULT_SCRIPT="npx tsx ${SCRIPT_DIR}/fetch-yesterday-results.ts"
ODDS_SCRIPT="npx tsx ${SCRIPT_DIR}/odds-snapshot.ts"
TODAY=$(date +%Y-%m-%d)

# 再生成タイミング: 発走の何分前か
REGEN_MINUTES_BEFORE=7
# オッズ急落閾値（%）— odds-watcher.sh に渡す
ODDS_DROP_THRESHOLD=30

mkdir -p "$WORK_DIR"

echo "=== パドック解説監視開始 $(date '+%H:%M:%S') ==="
echo "YouTube: $YOUTUBE_URL"
echo "チャンク: ${CHUNK_SECONDS}秒, モデル: $WHISPER_MODEL"
echo "再生成: 発走${REGEN_MINUTES_BEFORE}分前に自動実行"
echo "ログ: $LOG_FILE"
echo ""

# ストリームURLを取得（5分ごとに更新）
get_stream_url() {
  yt-dlp -f 91 -g "$YOUTUBE_URL" 2>/dev/null
}

STREAM_URL=$(get_stream_url)
URL_REFRESH_AT=$(($(date +%s) + 300))

if [ -z "$STREAM_URL" ]; then
  echo "ERROR: ストリームURL取得失敗"
  exit 1
fi

# 再生成済みタイムスタンプ管理（ファイルベース）
REGEN_DONE_FILE="${WORK_DIR}/regen_done_${TODAY}.txt"
touch "$REGEN_DONE_FILE"

is_regen_done() { grep -qF "$1" "$REGEN_DONE_FILE" 2>/dev/null || false; }
mark_regen_done() { echo "$1" >> "$REGEN_DONE_FILE"; }

# レース発走時刻+競馬場+レース番号+race_idリスト取得
RACE_LIST_FILE="${WORK_DIR}/race_list.txt"
cd "$PROJECT_DIR"
node --env-file=.env.local -e "
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_DATABASE_URL.replace('libsql://', 'https://'), authToken: process.env.TURSO_AUTH_TOKEN });
(async () => {
  const r = await db.execute(\"SELECT id, time, racecourse_name, race_number, name FROM races WHERE date = '${TODAY}' AND time IS NOT NULL ORDER BY time\");
  r.rows.forEach(row => console.log(row.time + '\t' + row.racecourse_name + '\t' + row.race_number + '\t' + row.name + '\t' + row.id));
})();
" 2>/dev/null | grep -E '^[0-9]{2}:[0-9]{2}' > "$RACE_LIST_FILE"

# 旧形式の時刻のみファイルも作成（互換用）
RACE_TIMES_FILE="${WORK_DIR}/race_times.txt"
cut -f1 "$RACE_LIST_FILE" | sort -u > "$RACE_TIMES_FILE"

RACE_COUNT=$(wc -l < "$RACE_LIST_FILE" | tr -d ' ')
echo "本日のレース: ${RACE_COUNT}件"
head -5 "$RACE_LIST_FILE"
echo "..."
echo ""

# 朝一しょーさん予想通知（メール+LINE） + スナップショット保存（7分前差分検知の基準）
echo "=== 朝一しょーさん予想通知 ==="
npx tsx "${SCRIPT_DIR}/mail-notify.ts" --date "$TODAY" 2>&1 | tail -3
npx tsx "${SCRIPT_DIR}/line-notify.ts" --date "$TODAY" 2>&1 | tail -3
echo ""

# 朝一オッズスナップショット保存（急落検知のベースライン）
echo "=== 朝一オッズスナップショット ==="
(cd "$PROJECT_DIR" && $ODDS_SCRIPT --date "$TODAY" --snapshot 2>&1 | tail -3)
echo ""

# オッズ監視デーモン起動（独立プロセス: 10秒間隔で急落検知）
echo "=== オッズ監視デーモン起動 ==="
bash "${SCRIPT_DIR}/odds-watcher.sh" --threshold "$ODDS_DROP_THRESHOLD" &
ODDS_WATCHER_PID=$!
echo "PID: $ODDS_WATCHER_PID"
echo ""

# 発走7分前チェック: 現在時刻から7分後の発走レースがあれば再生成
check_and_regen() {
  local now_epoch=$(date +%s)
  local trigger_time=$((now_epoch + REGEN_MINUTES_BEFORE * 60))
  local trigger_hhmm=$(date -r "$trigger_time" '+%H:%M' 2>/dev/null || date -d "@$trigger_time" '+%H:%M' 2>/dev/null)

  # trigger_hhmmと一致する発走レースを取得
  local races_at_time
  races_at_time=$(grep "^${trigger_hhmm}	" "$RACE_LIST_FILE" 2>/dev/null || true)

  if [ -n "$races_at_time" ] && ! is_regen_done "$trigger_hhmm"; then
    echo ""
    echo "  *** 発走${REGEN_MINUTES_BEFORE}分前: ${trigger_hhmm}発走のレースを検知 ***"
    echo "  [$(date '+%H:%M:%S')] 再生成トリガー: ${trigger_hhmm}発走" >> "$LOG_FILE"

    mark_regen_done "$trigger_hhmm"

    # 完走済みレース結果を取得 → 馬場バイアス計算用データを確保
    (
      cd "$PROJECT_DIR"
      echo "  [$(date '+%H:%M:%S')] 結果取得開始 (発走済みレース)"
      $RESULT_SCRIPT "$TODAY" --results-only 2>&1 | tail -3
      echo "  [$(date '+%H:%M:%S')] 結果取得完了"
    )

    # 該当レースのみ再生成 + Slack通知
    (
      cd "$PROJECT_DIR"
      RACE_NAMES=""
      echo "$races_at_time" | while IFS=$'\t' read -r _time venue rnum rname; do
        RACE_KEY="${venue}${rnum}"
        echo "  *** 再生成: ${venue} ${rnum}R ${rname} ($(date '+%H:%M:%S')) ***"
        $REGEN_SCRIPT --date "$TODAY" --race "$RACE_KEY" --regen 2>&1 | tail -2
        RACE_NAMES="${RACE_NAMES}${venue}${rnum}R ${rname}\n"
      done

      # しょーさん予想メール通知（朝一と比較して変更があるレースのみ送信）
      # + しょーさん候補があるレースのみSlack通知
      SHOSHAN_RACES=""
      echo "$races_at_time" | while IFS=$'\t' read -r _t v r n; do
        MAIL_OUT=$(npx tsx "${SCRIPT_DIR}/mail-notify.ts" --date "$TODAY" --race "${v}${r}" --diff 2>&1 | tail -1)
        echo "  $MAIL_OUT"
        if echo "$MAIL_OUT" | grep -q "送信"; then
          SHOSHAN_RACES="${SHOSHAN_RACES}${v}${r}R ${n}\n"
        fi
      done
      if [ -n "$SHOSHAN_RACES" ]; then
        bash "${SCRIPT_DIR}/slack-notify.sh" "🐴 しょーさん予想更新 (${trigger_hhmm}発走前)\n${SHOSHAN_RACES}メール通知済み"
      fi

      echo "  *** 再生成完了 ($(date '+%H:%M:%S')) ***"
    ) &
  fi
}


# メインループ
CHUNK_NUM=0
while true; do
  CHUNK_NUM=$((CHUNK_NUM + 1))
  TIMESTAMP=$(date '+%H:%M:%S')
  AUDIO_FILE="${WORK_DIR}/chunk_${CHUNK_NUM}.wav"

  # ストリームURL更新（5分ごと）
  NOW_EPOCH=$(date +%s)
  if [ "$NOW_EPOCH" -ge "$URL_REFRESH_AT" ]; then
    NEW_URL=$(get_stream_url)
    if [ -n "$NEW_URL" ]; then
      STREAM_URL="$NEW_URL"
      URL_REFRESH_AT=$((NOW_EPOCH + 300))
    fi
  fi

  # 発走7分前チェック
  check_and_regen

  # 音声取得
  ffmpeg -i "$STREAM_URL" -t "$CHUNK_SECONDS" -vn -acodec pcm_s16le -ar 16000 -ac 1 "$AUDIO_FILE" 2>/dev/null

  if [ ! -f "$AUDIO_FILE" ]; then
    echo "[$TIMESTAMP] 音声取得失敗、5秒後にリトライ"
    sleep 5
    STREAM_URL=$(get_stream_url)
    URL_REFRESH_AT=$(($(date +%s) + 300))
    continue
  fi

  # Whisper文字起こし
  whisper "$AUDIO_FILE" --model "$WHISPER_MODEL" --language ja --output_format txt --output_dir "$WORK_DIR" 2>/dev/null
  TEXT_FILE="${WORK_DIR}/chunk_${CHUNK_NUM}.txt"

  TRANSCRIPT_TEXT=""
  if [ -f "$TEXT_FILE" ]; then
    TRANSCRIPT_TEXT=$(cat "$TEXT_FILE")
  fi

  # ログに記録
  echo "[$TIMESTAMP] --- chunk $CHUNK_NUM ---" >> "$LOG_FILE"
  echo "$TRANSCRIPT_TEXT" >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"

  # JSON Lines形式でも保存（再生成スクリプトから参照）
  if [ -n "$TRANSCRIPT_TEXT" ]; then
    ESCAPED_TEXT=$(echo "$TRANSCRIPT_TEXT" | tr '\n' ' ' | sed 's/"/\\"/g')
    echo "{\"time\":\"$TIMESTAMP\",\"text\":\"$ESCAPED_TEXT\"}" >> "$JSONL_FILE"
  fi

  # 画面表示（コンパクト）
  PREVIEW=$(echo "$TRANSCRIPT_TEXT" | head -3 | tr '\n' ' ' | cut -c1-120)
  echo "[$TIMESTAMP] #${CHUNK_NUM}: ${PREVIEW}..."

  # 一時ファイル削除
  rm -f "$AUDIO_FILE" "$TEXT_FILE"

  # 17:00以降は終了
  HOUR=$(date +%H)
  if [ "$HOUR" -ge 17 ]; then
    echo ""
    # odds-watcher を停止
    if [ -n "$ODDS_WATCHER_PID" ]; then
      kill "$ODDS_WATCHER_PID" 2>/dev/null || true
      echo "odds-watcher 停止 (PID: $ODDS_WATCHER_PID)"
    fi
    echo "=== 監視終了 $(date '+%H:%M:%S') ==="
    echo "ログ: $LOG_FILE"
    break
  fi
done
