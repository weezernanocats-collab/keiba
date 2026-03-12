# Phase 2 改修ログ (2026-03-12 ~ 2026-03-13)

## 概要

ラップタイム基盤の構築、MLモデル55特徴量化、システム全体のバグ修正を実施。

---

## A1: ラップタイムバックフィル

### 新規スクリプト
- `scripts/fetch-lap-times.ts`: netkeiba race/result.html からラップタイムをスクレイプ
  - `--limit N`: 最大N件処理
  - `--resume`: progress.jsonから中断再開
  - バッチ20件ずつUPDATE、100件ごとprogress保存
  - 429/400エラーで自動停止 (rate limit ~2,600 requests)

- `scripts/recalc-pace-types.ts`: 累積タイム混入を修正しpace_typeを再計算
  - `extractActualLapTimes()`: distance/200で期待ラップ数を算出し、9.0-15.0範囲フィルタ
  - ペース分類: 前半平均 vs 後半平均の差 (threshold 0.3s)
    - diff > 0.3 → ハイ (前半速い)
    - diff < -0.3 → スロー (後半速い)
    - else → ミドル

### DBスキーマ
- `races.lap_times_json`: JSON配列 (例: [12.1, 11.5, 12.0, ...])
- `races.pace_type`: 'ハイ' | 'ミドル' | 'スロー'

### 実績
- 第1バッチ: 2,500件処理 → 2,414件にラップ取得
- 第2バッチ: 2,500件処理 → 2,409件にラップ取得
- 合計DB上ラップあり: 4,849件 (77%カバレッジ)
- ペース分布: ハイ 49%, ミドル 35%, スロー 17%

### 最終評価結果 (全6,280件再生成後)
- 単勝的中率: 30.0%
- 複勝的中率: 61.0%
- ROI: 79.0%
- 信頼度80-100%: 単勝43.5%, 複勝74.0%

---

## A2: ML特徴量パイプライン

### 新規4特徴量 (55特徴量化)
1. `horsePacePreference`: 馬の過去レースの平均ペースタイプ (0=スロー ~ 1=ハイ)
2. `horseHaiPaceRate`: ハイペースレースの出走率
3. `courseDistPaceAvg`: コース×距離帯の平均ペース
4. `paceStyleMatch`: 馬の脚質とコースペースの相性スコア

### 変更ファイル
- `src/lib/historical-analyzer.ts`: `getCoursePaceAvg()`, `getHorsePaceHistory()` 追加
- `src/lib/ml-client.ts`: `buildMLFeatures()` に4特徴量追加、`ContextualFeatures`型拡張
- `src/lib/prediction-engine.ts`: ML特徴量ビルド時にペースデータを渡す
- `scripts/export-training-data.ts`: ペース特徴量 + `track_type_encoded`/`distance_val`メタデータ追加

### モデル再学習結果 (batch2後, 2026-03-13)
- XGBoost: 55 features, NDCG@1 0.4962, Top-1 32.4%
- CatBoost: NDCG@1 0.5029, Top-1 32.8%
- Ensemble最適: CatBoost 100% (全カテゴリ)
- Brier (較正後): 0.0596, ECE: 0.016

---

## バグ修正

### CRITICAL: 複勝率 <= 2 → <= 3 修正
- **ファイル**: `src/lib/queries.ts`
- **問題**: `getJockeyStats()`と`getTrainerStats()`で`position <= 2`を"複勝"としてカウント
- **影響**: 騎手能力・調教師能力スコアが全て過小評価
- **修正**: `<= 2` → `<= 3` (馬連圏ではなく複勝圏)

### HIGH: calibrateWeights ファクター欠落
- **ファイル**: `src/lib/accuracy-tracker.ts`
- **問題**: `marginCompetitiveness`と`weatherAptitude`がfactorNames・currentWeightsから欠落
- **影響**: 自動校正がこの2ファクターを無視、重みが更新されない
- **修正**: 両ファクター追加、currentWeightsをDEFAULT_WEIGHTSと同期

### HIGH: softmax NaN ガード
- **ファイル**: `src/lib/ml-client.ts`
- **問題**: `softmax()`に空配列やsumExp=0のガードなし
- **影響**: 空の馬リストでNaN伝播の可能性
- **修正**: 空配列チェック + sumExp===0時の均等分布フォールバック

### MEDIUM: currentWeights不一致
- **ファイル**: `src/lib/accuracy-tracker.ts`
- **問題**: calibrateWeightsのcurrentWeightsがDEFAULT_WEIGHTSとズレていた
  - `recentForm`: 0.16 → 0.15, `handicapAdvantage`: 0.02 → 0.01
- **修正**: DEFAULT_WEIGHTSと完全同期

---

## Stats ページ改善

### 信頼度別ROI表示
- **ファイル**: `src/app/api/accuracy-stats/route.ts`, `src/app/stats/page.tsx`
- 信頼度バケット(80-100/60-79/40-59/15-39)にROI列追加
- 棒グラフ + テーブルの複合表示
- ROI 100%ラインのリファレンス線追加

---

## データリーケージ対策 (前Phase継続確認)

全9関数にbeforeDateフィルタが適用済み:
- `getHorsePastPerformances()`
- `getJockeyStats()`
- `getTrainerStats()`
- `buildRaceContext()` (11並列クエリ全て)
- 全呼び出し元 (API, scheduler, scripts) にrace.dateを渡している

---

## ファイル一覧

### 新規
- `scripts/fetch-lap-times.ts`
- `scripts/recalc-pace-types.ts`
- `docs/phase2-changelog.md` (本ファイル)

### 変更
- `src/lib/historical-analyzer.ts` (ペース関数追加)
- `src/lib/ml-client.ts` (特徴量追加, NaNガード)
- `src/lib/prediction-engine.ts` (ペースデータ連携)
- `src/lib/queries.ts` (複勝率バグ修正)
- `src/lib/accuracy-tracker.ts` (ファクター欠落修正)
- `src/app/api/accuracy-stats/route.ts` (ROI追加)
- `src/app/stats/page.tsx` (ROI表示)
- `scripts/export-training-data.ts` (メタデータ追加)
- `model/*` (全モデル再学習)
