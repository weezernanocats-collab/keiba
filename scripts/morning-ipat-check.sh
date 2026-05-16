#!/bin/bash
# 朝の IPAT 動作チェック (scheduler 自動起動前のセルフテスト)
#
# 動作:
#   1. test-ipat-flow.ts で 東京1R を対象に login + race nav + bet set + show list を実行
#   2. 購入確定はしない (テスト用、IPAT session 終了でbetはクリア)
#   3. 結果を Slack 通知 (成功/失敗)
#
# 失敗時は scheduler 起動を取りやめるべきだが、自動キャンセル機構はないため
# ユーザーが Slack 通知を見て手動対応 (plistを停止 or 手動投票準備)
set -u

cd /Users/naoto_kimura/kaihatsu/keiba

LOG_DIR="$HOME/Library/Logs/keiba"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/morning-ipat-check.log"
TS=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TS] === morning-ipat-check 起動 ===" >> "$LOG_FILE"

# テスト対象: 朝なので 5/17 1R (or 当日の早いレース)
# 当日の最初のレースを指す venue/race は変動するので、デフォルトは東京1R
# (場合により本番に影響しない安全な値だが、当日開催してなければ failure になる)
VENUE="${1:-東京}"
RACE="${2:-1}"

OUTPUT=$(/opt/homebrew/bin/npx tsx scripts/test-ipat-flow.ts \
  --venue "$VENUE" --race "$RACE" --horse 1 --box 1,3,5,7 --headless 2>&1)
EXIT_CODE=$?

echo "$OUTPUT" >> "$LOG_FILE"
echo "[$TS] === exit code: $EXIT_CODE ===" >> "$LOG_FILE"

if [ $EXIT_CODE -eq 0 ]; then
  MSG="✅ *朝の IPAT 動作チェック成功* ($(date '+%H:%M'))
$VENUE $RACE R で login → 会場/レース選択 → 単勝+ワイドbox セット → 投票一覧表示 完走
9:00 scheduler 起動を信頼してOK"
else
  MSG="❌ *朝の IPAT 動作チェック失敗* ($(date '+%H:%M'))
$VENUE $RACE R テストでエラー
ログ: $LOG_FILE
推奨: scheduler 自動起動を停止し手動投票準備
\`launchctl bootout gui/\$(id -u) ~/Library/LaunchAgents/com.naoto.keiba.ipat-auto-bet.plist\`"
fi

bash scripts/slack-notify.sh "$MSG" >> "$LOG_FILE" 2>&1
echo "[$TS] === Slack通知送信完了 ===" >> "$LOG_FILE"
exit $EXIT_CODE
