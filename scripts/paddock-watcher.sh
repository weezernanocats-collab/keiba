#!/bin/bash
#
# パドック解説リアルタイム監視 + 予想再生成パイプライン
#
# 使い方:
#   bash scripts/paddock-watcher.sh <YouTube_URL>
#
# 動作:
#   1. ライブ配信音声を60秒チャンクで継続取得
#   2. Whisper(tiny)で即時文字起こし
#   3. パドック推奨馬の発表を検知
#   4. 該当レースの予想を再生成
#   5. 全テキストをログに保存
#

set -euo pipefail

YOUTUBE_URL="${1:-}"
if [ -z "$YOUTUBE_URL" ]; then
  echo "Usage: bash scripts/paddock-watcher.sh <YouTube_URL>"
  exit 1
fi

CHUNK_SECONDS=60
WHISPER_MODEL=tiny
WORK_DIR="/tmp/paddock_watcher"
LOG_FILE="${WORK_DIR}/transcript_$(date +%Y%m%d).log"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REGEN_SCRIPT="npx tsx ${SCRIPT_DIR}/gen-predictions-optimized.ts"

mkdir -p "$WORK_DIR"

echo "=== パドック解説監視開始 $(date '+%H:%M:%S') ==="
echo "YouTube: $YOUTUBE_URL"
echo "チャンク: ${CHUNK_SECONDS}秒, モデル: $WHISPER_MODEL"
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

# 直近で再生成済みのレースを記録（重複防止）
declare -A REGEN_DONE

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
  TRANSCRIPT=$(whisper "$AUDIO_FILE" --model "$WHISPER_MODEL" --language ja --output_format txt --output_dir "$WORK_DIR" 2>/dev/null)
  TEXT_FILE="${AUDIO_FILE%.wav}.txt"
  if [ -f "${WORK_DIR}/chunk_${CHUNK_NUM}.txt" ]; then
    TEXT_FILE="${WORK_DIR}/chunk_${CHUNK_NUM}.txt"
  fi

  TRANSCRIPT_TEXT=""
  if [ -f "$TEXT_FILE" ]; then
    TRANSCRIPT_TEXT=$(cat "$TEXT_FILE")
  fi

  # ログに記録
  echo "[$TIMESTAMP] --- chunk $CHUNK_NUM ---" >> "$LOG_FILE"
  echo "$TRANSCRIPT_TEXT" >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"

  # 画面表示（コンパクト）
  PREVIEW=$(echo "$TRANSCRIPT_TEXT" | head -3 | tr '\n' ' ' | cut -c1-120)
  echo "[$TIMESTAMP] #${CHUNK_NUM}: ${PREVIEW}..."

  # パドック推奨馬の検知
  # キーワード: "推奨馬" "推奨場" "以上で" "パドックでの評価"
  if echo "$TRANSCRIPT_TEXT" | grep -qiE "推奨|以上で.*お願い|パドックでの"; then
    echo "  >>> パドック推奨馬を検知!"

    # レース番号を特定（"○R" or "○レース"）
    # 直近のテキストからレース番号を抽出
    RACE_NUM=$(echo "$TRANSCRIPT_TEXT" | grep -oE '[0-9]+レース|[0-9]+R' | tail -1 | grep -oE '[0-9]+')

    # 競馬場を特定
    VENUE=""
    if echo "$TRANSCRIPT_TEXT" | grep -qi "中山\|なかやま\|仲間"; then
      VENUE="中山"
    elif echo "$TRANSCRIPT_TEXT" | grep -qi "阪神\|半信\|はんしん"; then
      VENUE="阪神"
    fi

    # 推奨馬番号を抽出
    PICKS=$(echo "$TRANSCRIPT_TEXT" | grep -oE '[0-9]+番' | sort -u | tr '\n' ',' | sed 's/,$//')

    echo "  >>> 競馬場: ${VENUE:-不明}, レース: ${RACE_NUM:-不明}R, 推奨馬番: ${PICKS:-不明}"
    echo "  [$(date '+%H:%M:%S')] 推奨検知: ${VENUE:-?} ${RACE_NUM:-?}R 推奨=${PICKS}" >> "$LOG_FILE"

    # 予想再生成（重複防止）
    REGEN_KEY="${VENUE}_${RACE_NUM}"
    if [ -n "$VENUE" ] && [ -n "$RACE_NUM" ] && [ -z "${REGEN_DONE[$REGEN_KEY]:-}" ]; then
      echo "  >>> 予想再生成開始: ${VENUE} ${RACE_NUM}R ($(date '+%H:%M:%S'))"
      # バックグラウンドで再生成（メインループをブロックしない）
      (
        cd "$PROJECT_DIR"
        $REGEN_SCRIPT --date "$(date +%Y-%m-%d)" --race "${VENUE}${RACE_NUM}" --regen 2>&1 | tail -3
        echo "  >>> 予想再生成完了: ${VENUE} ${RACE_NUM}R ($(date '+%H:%M:%S'))"
      ) &
      REGEN_DONE[$REGEN_KEY]=1
    fi
  fi

  # 一時ファイル削除
  rm -f "$AUDIO_FILE" "$TEXT_FILE"

  # 17:00以降は終了
  HOUR=$(date +%H)
  if [ "$HOUR" -ge 17 ]; then
    echo ""
    echo "=== 監視終了 $(date '+%H:%M:%S') ==="
    echo "ログ: $LOG_FILE"
    break
  fi
done
