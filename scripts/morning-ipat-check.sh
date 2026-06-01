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

# 当日レース有無チェック (平日=レースなしなら何もせず終了、Slack通知も出さない)
TODAY=$(date '+%Y-%m-%d')
RACE_COUNT=$(/opt/homebrew/bin/node --env-file=.env.local -e "
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_DATABASE_URL.replace('libsql://', 'https://'), authToken: process.env.TURSO_AUTH_TOKEN });
(async () => {
  const r = await db.execute(\"SELECT COUNT(*) AS n FROM races WHERE date = '$TODAY'\");
  console.log(r.rows[0].n);
  db.close();
})();
" 2>/dev/null)

if [ "${RACE_COUNT:-0}" -eq 0 ]; then
  echo "[$TS] 当日($TODAY)のレースなし → セルフテスト skip, Slack通知なし" >> "$LOG_FILE"
  exit 0
fi

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
