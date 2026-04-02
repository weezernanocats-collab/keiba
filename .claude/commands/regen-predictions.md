---
description: 指定日の未発走レースの予想を再生成する
---

# 予想再生成

指定された日付（デフォルト: 今日）の未発走レースの予想を安全に再生成します。

## 手順

1. まず対象日の結果確定済みレース（prediction_resultsが存在するrace_id）を確認する
2. 結果確定済みレースの一覧をユーザーに提示する
3. 未発走レースのみを対象に `gen-predictions-optimized.ts --date [日付] --regen` を実行する

## 実行コマンド

```bash
cd /Users/naoto_kimura/kaihatsu/keiba
npx tsx -r tsconfig-paths/register scripts/gen-predictions-optimized.ts --date $ARGUMENTS --regen
```

## 注意事項

- `--regen` は必ず `--date` と併用すること
- 結果確定済みレースはFK制約でエラーになるため、事前に除外確認する
- 引数がない場合は今日の日付を使用する
