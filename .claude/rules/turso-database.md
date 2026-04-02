---
description: データベース接続・クエリに関するコード編集時に適用
globs: ["src/lib/database.ts", "src/lib/queries.ts", "src/**/*.ts"]
---

# Turso / データベースルール

## 接続プロトコル
- Turso接続は必ず `https://` を使用する
- `libsql://`（WebSocket）は障害リスクがあるため禁止

## クエリ実行
- `db.batch()` は使用禁止 — Turso障害時にハングする（2026-03-21障害の教訓）
- 代わりにsequential executeを使う

## クエリ性能
- 相関サブクエリ `WHERE x = (SELECT ...)` は本番データ量で爆発する — JOINまたはアプリ側で処理する
- JOINで行数が爆発しないか確認する（predictions × race_entries = 80,000+行になりうる）
- 変更したSQLは本番データで応答時間5秒以内を目安にテストする

## データリーケージ防止
- 予測に使う全クエリには `beforeDate` フィルタを適用すること
- レース日以降のデータが予測に混入しないようにする
