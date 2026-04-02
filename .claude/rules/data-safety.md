---
description: データ削除・変更を伴うコード編集時に適用
globs: ["src/**/*.ts", "scripts/**/*.ts"]
---

# データ保全ルール

## DELETE文
- DELETE文には必ずWHERE句でrace_id、date、horse_id等の条件を指定すること
- 条件なしの `DELETE FROM テーブル` は禁止
- 大量削除の前にSELECT COUNTで影響範囲を確認し、ユーザーに提示すること

## 使用禁止スクリプト・関数
- `scripts/regen-predictions.ts` → 代わりに `gen-predictions-optimized.ts --date --regen` を使う
- `bulk-importer.ts` の `clearAllData()` / `clearExisting=true` → 明示的な許可なく使わない
- `scripts/repair-roi.ts` → 日付範囲指定なしでの実行禁止

## 予想再生成
- `--regen` は必ず `--date` と併用する
- 結果確定済み（prediction_resultsが存在する）レースは再生成対象から除外する
