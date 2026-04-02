---
description: スクレイピング関連のコード編集時に適用
globs: ["src/lib/scraper.ts", "scripts/import-*.ts", "scripts/scrape-*.ts"]
---

# netkeiba スクレイピングルール

- 約2,600リクエストでIP BAN（12時間以上アクセス不可）になる
- `rateLimitMs`（最低1200ms）を必ず守る
- 大量取得時はチャンク分割する
- 同時リクエスト数は3以下に抑える
