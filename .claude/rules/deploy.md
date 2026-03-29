---
description: デプロイ・本番環境に関する作業時に適用
globs: ["vercel.json", "src/app/api/**/*.ts", "next.config.ts"]
---

# デプロイチェックリスト

## クエリ変更時
- 本番データでのクエリ性能テスト（目安: 5秒以内）
- 相関サブクエリの回避
- JOINでの行数爆発チェック

## デプロイ手順
- 複数ファイル変更時は1-2ファイルずつ段階的にデプロイ
- デプロイ後に `/api/races?date=今日` と `/api/predictions/{raceId}` で200確認
- 「影響ゼロ」は禁句 — 影響範囲を具体的に列挙する

## トークン更新時
- Vercelプロジェクト（keiba）+ GitHub Secrets + .env.local を全て同時に更新する
