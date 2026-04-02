---
description: 指定日のレースデータをnetkeibaからインポートする
---

# レースデータインポート

指定日のレースデータをnetkeibaからスクレイピングしてインポートします。

## 注意事項

- netkeibaのレート制限: 約2,600リクエストで12時間以上のIP BAN
- rateLimitMs: 最低1200ms間隔を守る
- 大量取得時はチャンク分割する

## 実行

```bash
cd /Users/naoto_kimura/kaihatsu/keiba
npx tsx -r tsconfig-paths/register scripts/prefetch-upcoming.ts $ARGUMENTS
```
