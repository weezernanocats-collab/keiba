# KEIBA MASTER 予想システム アーキテクチャ概要

## 全体アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA COLLECTION                              │
│                                                                     │
│  netkeiba.com ──scraper.ts──┐                                       │
│    ├─ レース一覧 (race_list)  │     ┌──────────────────────────┐     │
│    ├─ 出馬表 (shutuba)       │     │   Turso DB (SQLite)      │     │
│    ├─ オッズ (JSON API)      ├────→│                          │     │
│    ├─ レース結果 (result)    │     │  races                   │     │
│    ├─ ラップタイム (result)  │     │  race_entries            │     │
│    └─ 馬詳細 (horse detail)  │     │  horses                  │     │
│                              │     │  past_performances       │     │
│  scheduler.ts ───────────────┘     │  odds / odds_snapshots   │     │
│    09:00 出馬表+馬詳細+予想生成    │  jockeys                 │     │
│    17:00 結果取得＋評価            │  predictions             │     │
│                                    │  prediction_results      │     │
│  bulk-importer.ts ─────────────────│  calibration_weights     │     │
│    過去データ一括取り込み          │  category_calibration    │     │
│    (チャンク分割でVercel対応)      │                          │     │
│                                    └──────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                PREDICTION ENGINE v8.1 + ML v10.0                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ STEP 1: 17ファクタースコアリング (0〜100点)              │        │
│  │  (v7.1: SHAP重要度0の3ファクター除去)                    │        │
│  │                                                         │        │
│  │  個別能力 (80%)                統計ベース (17%)          │        │
│  │  ├ 直近成績        17%       ├ 血統適性       6%        │        │
│  │  ├ 距離適性        11%       ├ 調教師能力     5%        │        │
│  │  ├ スピード指数    11%       ├ 季節パターン   2%        │        │
│  │  ├ 騎手能力         8%       └ 斤量差         1%        │        │
│  │  ├ 上がり3F         8%                                  │        │
│  │  ├ 脚質適性         6%       市場シグナル (3%)           │        │
│  │  ├ 馬場適性         5%       ├ 市場オッズ     3%        │        │
│  │  ├ 枠順分析         5%       ├ 着差競争力     1%        │        │
│  │  ├ 安定性           5%       └ 天候適性       2%        │        │
│  │  └ ローテーション   4%                                  │        │
│  │                                                         │        │
│  │  ※ カテゴリ別ウェイト × 競馬場別補正 で動的に調整       │        │
│  └─────────────────────────────────────────────────────────┘        │
│                          │                                          │
│                          ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ STEP 2: ベイズ推定 + 動的重み調整                        │        │
│  │         + カテゴリ別ウェイト + 競馬場別補正               │        │
│  │                                                         │        │
│  │  カテゴリ判定: 芝短/芝マイル/芝長/ダ短/ダ長              │        │
│  │  カテゴリ乗数 × 基本重み → 競馬場補正 → 正規化           │        │
│  │                                                         │        │
│  │  データ信頼度 = min(実データ数 / 必要数, 1.0)            │        │
│  │  スコア = 事前分布 × (1-信頼度) + 観測値 × 信頼度       │        │
│  │  重み = カテゴリ重み × max(0.2, 信頼度)                  │        │
│  │  余剰重み → 高信頼度ファクターへ再配分                  │        │
│  └─────────────────────────────────────────────────────────┘        │
│                          │                                          │
│                          ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ STEP 3: 加重合計 + ペースボーナス                        │        │
│  │                                                         │        │
│  │  totalScore = Σ (ファクター得点 × 動的重み)              │        │
│  │  + 脚質ボーナス（距離・馬場・グレード依存）             │        │
│  └─────────────────────────────────────────────────────────┘        │
│                          │                                          │
│                          ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ STEP 4: 当日馬場バイアス補正 (track-bias.ts)             │        │
│  │                                                         │        │
│  │  同日・同競馬場の結果確定3R以上から算出:                 │        │
│  │  ├ 枠順バイアス: 内枠/外枠有利度 (-1〜+1) → ±2点       │        │
│  │  └ 脚質バイアス: 先行/差し追込有利度 (-1〜+1) → ±2点   │        │
│  │  最大 ±4点の調整（信頼度に応じてスケール）              │        │
│  └─────────────────────────────────────────────────────────┘        │
│                          │                                          │
│                          ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ STEP 5: XGBoost + CatBoost アンサンブル推論              │        │
│  │                                                         │        │
│  │  63次元特徴量 ──→ TypeScriptネイティブ推論               │        │
│  │                                                         │        │
│  │  ┌─ カテゴリモデル優先 ─────────────────────────┐        │        │
│  │  │ xgb_ranker_{cat}.json + catboost_ranker_{cat}.json │  │        │
│  │  └───────────── or グローバルモデル ────────────┘        │        │
│  │                                                         │        │
│  │  XGBoost: softmax → Isotonic Regression較正             │        │
│  │  CatBoost: softmax → Isotonic Regression較正            │        │
│  │  アンサンブル: XGB×w_xgb + CB×w_cb (カテゴリ別重み)     │        │
│  │                                                         │        │
│  │  v10: ML較正済み確率を直接使用                           │        │
│  │  totalScore = mlWinProb × 100（ソート用）               │        │
│  └─────────────────────────────────────────────────────────┘        │
│                          │                                          │
│                          ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ STEP 6: 市場オッズブレンド + バリューベット検出           │        │
│  │                                                         │        │
│  │  市場暗示確率 = 1/odds → オーバーラウンド除去 → 正規化  │        │
│  │  ブレンド確率 = log-odds空間でモデル×(1-w) + 市場×w     │        │
│  │  カテゴリ別ブレンド比率 (marketBlend: 0.05〜0.50)       │        │
│  │  乖離度 = modelProb - marketProb → 妙味馬検出           │        │
│  └─────────────────────────────────────────────────────────┘        │
│                          │                                          │
│                          ▼                                          │
│              ┌───────────────────────┐                              │
│              │ 最終ランキング生成     │                              │
│              │ Top 6 推奨馬 + 分析   │                              │
│              └───────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     OUTPUT & FEEDBACK                                │
│                                                                     │
│  predictions テーブルに保存                                         │
│    ├ confidence (信頼度 0〜100%)                                     │
│    ├ summary (分析テキスト)                                          │
│    ├ picks_json (Top 6 推奨馬)                                      │
│    ├ analysis_json (馬場/ペース/キーファクター/horseScores           │
│    │                /winProbabilities/marketAnalysis)                │
│    └ bets_json (推奨馬券 + EV情報 + isValueBet)                     │
│                                                                     │
│  ──────────── レース終了後 ────────────                              │
│                                                                     │
│  accuracy-tracker.ts                                                │
│    ├ 予想 vs 実結果を照合                                           │
│    ├ 単勝的中率・複勝的中率・ROI を集計                              │
│    └ 信頼度帯ごとの精度評価                                         │
│                                                                     │
│  自動キャリブレーション                                              │
│    ├ 精度データから最適重みを推定                                    │
│    ├ 20レース以上の評価データで自動適用                              │
│    └ calibration_weights テーブルに保存                              │
│                                                                     │
│  XGBoost + CatBoost 自動再学習 (GitHub Actions)                    │
│    ├ 毎週月曜 12:00 JST に自動実行                                  │
│    ├ /api/ml-export から学習データ取得                               │
│    ├ XGBoost + CatBoost で5カテゴリ別モデル学習                     │
│    ├ Isotonic Regression 較正マッピング生成                         │
│    └ model/ にコミット → Vercel自動デプロイ                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. データ収集 (Data Collection)

### 1.1 データソース

本システムのデータは全て **netkeiba.com** からスクレイピングで取得する。

| データ種別 | 取得元 | 取得タイミング | 格納先テーブル |
|---|---|---|---|
| レース一覧 | `race.netkeiba.com/top/race_list_sub.html` | 朝 09:00 JST | `races` |
| 出馬表（馬・騎手・枠順） | `race.netkeiba.com/race/shutuba.html` | レース一覧取得後 | `race_entries` |
| オッズ（単勝・複勝） | `race.netkeiba.com/api/api_get_jra_odds.html` (JSON) | 出馬表取得後 / 手動 | `odds`, `odds_snapshots` |
| 馬の詳細（血統・戦績） | `db.netkeiba.com/horse/{horseId}` | 出馬表取得後 | `horses`, `past_performances` |
| レース結果（着順・タイム・ラップ） | `race.netkeiba.com/race/result.html` | 17:00 全レース終了後 / 再生成時 | `race_entries` (result_* 列), `races` (lap_times_json, pace_type) |

### 1.2 現在のデータ蓄積量

| テーブル | 件数 | 期間 |
|---|---|---|
| races (レース) | ~6,421 | 2024-05-04 〜 現在 (約1年10ヶ月) |
| race_entries (出走馬) | ~87,598 | 同上 |
| horses (馬マスター) | ~16,312 | - |
| past_performances (過去成績) | ~69,504 | 2017-12-09 〜 現在 (約8年分) |
| odds (オッズ) | ~86,000 | カバー率 98.7% |
| jockeys (騎手マスター) | ~197 | - |
| predictions (予測) | ~6,400 | - |
| prediction_results (評価結果) | ~6,400 | - |

ラップタイムカバー率: ~77%。各馬の過去成績（past_performances）は馬詳細ページから取得するため、最大約8年前まで遡った走歴データを保持している。

### 1.3 取得フロー

```
Vercel Cron (vercel.json: 6ジョブ)
│
├─ 09:00 JST (0 0 * * *) ── bulk_chunked トリガー
│    └─ /api/sync にPOST → チェーン実行:
│       dates → race_details → horses → results → odds → predictions → evaluate
├─ 10:00 JST (0 1 * * *)
├─ 12:00 JST (0 3 * * *) ── 予想補完（朝チェーン途切れ時の安全網）
├─ 14:00 JST (0 5 * * *)
├─ 17:00 JST (0 8 * * *) ── 結果スクレイプ + 予想照合 + 予想補完
└─ 22:00 JST (0 13 * * *)

GitHub Actions (8ワークフロー)
│
├─ daily-morning.yml  (朝 / 手動) ── データ取得 + 予想生成
├─ daily-results.yml  (17:00 JST / 手動) ── 結果取得 + 予想照合 + キャリブレーション
├─ prefetch-races.yml (水・土 / 手動) ── 先行レース取得
├─ train-model.yml    (毎週月曜 / 手動) ── XGBoost + CatBoost 再学習
├─ afternoon-predictions.yml ── 午後予想再生成
├─ odds-refresh.yml   ── オッズ再取得
├─ accuracy-report.yml ── 精度レポート生成
└─ confidence-roi-analysis.yml ── 信頼度×ROI分析
```

※ 非開催日はcronエンドポイント内で早期リターン（レースの存在チェック）。

各リクエストには **1.2秒間隔のレートリミット**、**10秒タイムアウト**、**最大2回リトライ**（指数バックオフ）を適用し、取得元サーバーに過度な負荷をかけない設計としている。

### 1.4 バルクインポート

過去データを一括取り込みする機能。日付範囲を指定し、レース一覧→出馬表→馬詳細→オッズ→結果→予想生成までを自動実行する。Vercelの60秒タイムアウト制約に対応するため、チャンク単位で分割処理し、APIを繰り返し呼び出して段階的に完了させる。

### 1.5 手動オッズ取得

レース詳細ページに「オッズ取得/更新」ボタンを配置。`POST /api/odds` でnetkeiba APIから単勝・複勝オッズを取得する。レース前の時間帯（netkeiba APIが `status: "middle"` を返す期間）は取得不可。odds取得時に `upsertRaceEntryOdds()` で `race_entries.odds` も同期更新。

### 1.6 netkeiba スクレイピング注意点

| 項目 | 注意点 |
|---|---|
| エンコーディング | `race_list_sub.html` = UTF-8、その他 = EUC-JP |
| トラックタイプ | 出馬表では省略形 `ダ`（`ダート`ではない） |
| 馬場状態 | `稍`（`稍重`の省略形）の場合あり |
| グレード | CSSクラスベース（`Icon_GradeType1/2/3`）、テキストではない |
| 騎手・調教師名 | 出馬表では截断される（netkeiba仕様） |
| オッズ | `result.html` に確定オッズ（col[10]）と人気（col[9]） |
| レートリミット | 約2,600リクエストで400エラー → 12時間以上待つ必要あり |

---

## 2. 予想エンジン (Prediction Engine) v8.1

### 2.0 改善サマリー

#### v5.2 → v6.0 (ML Phase 2)

| 改善 | 内容 | 効果 |
|---|---|---|
| **CatBoostアンサンブル** | XGBoost + CatBoost の加重平均アンサンブル | ML精度向上 |
| **カテゴリ別MLモデル** | 5カテゴリ（芝短/マイル/長/ダ短/ダ長）別に専門モデル学習 | レース条件に最適化 |
| **Isotonic Regression較正** | softmax確率をIsotonic Regressionで較正 | 確率の信頼性向上 |
| **v6.0新特徴量** | 騎手乗替シグナル、コーナー加速、着差定量化、休養日数、開催日 | 45→55次元 |

#### v6.0 → v7.x

| 改善 | 内容 | 効果 |
|---|---|---|
| **SHAP分析ファクター除去** | 重要度0の3ファクター除去（courseAptitude, classPerformance, jockeyTrainerCombo） | 19→17ファクター |
| **ラップタイム基盤特徴量** | horsePacePreference, horseHaiPaceRate, courseDistPaceAvg, paceStyleMatch | ペース適性をML化 |
| **カテゴリ別ブレンドパラメータ** | mlBlend, marketBlend, temperature をカテゴリごとにグリッドサーチ最適化 | 予測精度向上 |
| **市場オッズブレンド** | market-blend.ts: log-odds空間でモデル確率と市場確率をブレンド | 妙味馬検出 |
| **競馬場別補正** | racecourse-profiles.ts: 10競馬場のコース特性に基づくファクター乗数 | コース特性反映 |

#### v7.x → v8.x

| 改善 | 内容 | 効果 |
|---|---|---|
| **直近フォーム特徴量** | lastRacePosition, last3WinRate, last3PlaceRate, winStreak | 直近調子をML化 |
| **Value Betting戦略** | Kelly Criterion (f*/4), Filter E: ダsprint除外 & 3-50倍 & 乖離>3% | ROI 243.1% |

#### v8.x → v9.0〜v10.0

| 改善 | 内容 | 効果 |
|---|---|---|
| **classChange推論修正** | 前走グレードと今走グレードの差をGRADE_ENCODEで正確に計算 | 昇級/降級の影響を正確に |
| **trackTypeChange推論修正** | 前走のtrackTypeとの比較を過去走データから計算 | 芝⇔ダート変更を検出 |
| **v9.0新特徴量** | relativePosition, upsetRate, avgPastOdds, totalEarningsLog | 63次元化 |
| **v10: ML確率直接使用** | 二重softmax問題を解消、ML較正済み確率をtotalScoreに直接使用 | 較正精度保持 |

### 2.1 17ファクタースコアリング

各出走馬に対して、以下の17要素を0〜100点で独立にスコアリングする。

> v7.1: SHAP分析で重要度0と判定された3ファクター（コース適性、クラス実績、騎手×調教師コンビ）を除去し、その分の重みを比例再配分。

#### 個体分析ファクター (10要素、合計80%)

| ファクター | 重み | 算出ロジック |
|---|---|---|
| **直近成績** | 17% | 直近5走の着順を加重平均 + グレード補正（G1×1.4, G2×1.25, G3×1.15）+ トレンド検出 + 馬体重トレンドボーナス(weight-trend.ts) |
| **距離適性** | 11% | レース距離 ±400m 以内の過去成績。距離が近いほど高評価 |
| **スピード指数** | 11% | 上がり3F + 走破タイムから算出。DB実データから動的基準タイム算出（コース×距離×馬場別） |
| **騎手能力** | 8% | 通算成績70% + 直近30日フォーム30%のブレンド。トレンドボーナス付与 |
| **上がり3F** | 8% | 直近の上がり3Fタイムの平均。35秒以下で高評価 |
| **脚質適性** | 6% | 通過順位から判定（逃げ/先行/差し/追込）。距離によるボーナス |
| **馬場適性** | 5% | 芝/ダート、良/稍重/重/不良での過去成績 |
| **枠順分析** | 5% | 実データベースの枠別勝率（courseDistStats）、データ不足時は固定biasMapにフォールバック |
| **安定性** | 5% | 着順の標準偏差が小さいほど高評価 |
| **ローテーション** | 4% | 前走からの間隔。最適間隔（3〜8週）で高得点 + 叩き良化ボーナス |

#### 統計ベースファクター (4要素、合計14%)

| ファクター | 重み | 算出ロジック |
|---|---|---|
| **血統適性** | 6% | 父馬産駒の芝/ダート・距離帯・馬場状態別成績 |
| **調教師能力** | 5% | 調教師の勝率・トラック別成績・距離カテゴリ別・馬場状態別・グレード別 |
| **季節パターン** | 2% | 馬ごとの月別成績パターン |
| **斤量アドバンテージ** | 1% | 平均斤量との差分 |

#### 市場シグナルファクター (3要素、合計6%)

| ファクター | 重み | 算出ロジック |
|---|---|---|
| **市場オッズ** | 3% | 単勝オッズの逆数を対数正規化。オッズ未取得時は事前分布（50点） |
| **天候適性** | 2% | 当該天候条件での過去成績 |
| **着差競争力** | 1% | 僅差好走の頻度（margin-score.ts） |

### 2.2 カテゴリ別ウェイトプロファイル + 競馬場別補正

レース条件に応じて5カテゴリに分類し、ファクター重みに乗数を適用する。

| カテゴリ | 条件 | 主な重み調整 |
|---|---|---|
| **turf_sprint** | 芝 ≤1400m | スピード指数×1.3、枠順×1.5、上がり3F×0.7 |
| **turf_mile** | 芝 1401-1800m | ほぼ基本重みのまま（マイルが基準） |
| **turf_long** | 芝 1801m+ | 血統×1.3、脚質×1.3、安定性×1.2、枠順×0.6 |
| **dirt_sprint** | ダート ≤1400m | スピード×1.4、クラス×1.2、枠順×1.3、上がり3F×0.6 |
| **dirt_long** | ダート 1401m+ | 馬場適性×1.3、スピード×1.2、直近成績×1.1 |

さらに **競馬場別補正** (racecourse-profiles.ts) で10競馬場のコース特性を反映:
- 東京: 上がり3F×1.4（直線長い）、枠順×0.7（外枠不利小）
- 中山: 枠順×1.5（内枠有利）、脚質×1.3（先行有利）、上がり3F×0.8
- 阪神/京都/中京/小倉/新潟/福島/札幌/函館: 各コース特性に応じた補正

適用順: `DEFAULT_WEIGHTS` → カテゴリ補正 → 競馬場補正 → 正規化（合計1.0）

### 2.3 ベイズ推定と動的重み調整

各ファクターのスコアは、**データの信頼度**に応じて補正される。

```
信頼度 = min(実際のデータ数 / 統計的に必要なデータ数, 1.0)

最終スコア = 事前分布（母集団prior） × (1 - 信頼度) + 観測スコア × 信頼度
```

母集団の事前分布は `POPULATION_PRIORS` で定義（例: 騎手能力=40、スピード指数=45、枠順=50）。データが少ない馬の極端なスコアを防ぐ。

さらに、各ファクターの重みに信頼度を乗じる（最低20%を保証: `重み × max(0.2, 信頼度)`）。削減された分の重みは、信頼度の高いファクターに比例再配分する（**動的重み調整**）。

### 2.4 ペースボーナスと加重合計

```
totalScore = Σ (各ファクタースコア × 動的調整後の重み) + ペースボーナス
```

ペースボーナスは `pace-analyzer.ts` で算出。レース構成・グレード・馬場状態を考慮したコンテキスト依存のペース分析を行い、脚質と距離の相性に応じて加減算。

### 2.5 当日馬場バイアス補正

`track-bias.ts` で同日・同競馬場の結果確定済みレース（3R以上）を分析し、馬場バイアスを算出する。

| バイアス | 算出方法 | 調整幅 |
|---|---|---|
| 枠順バイアス | 上位3着の内枠/外枠比率 → 期待値(0.5)からの乖離 | ±2点 |
| 脚質バイアス | 勝ち馬の第1コーナー通過順位 → 前残り/差し有利判定 | ±2点 |

信頼度（3R=0.375 〜 8R+=1.0）でスケールし、最大 ±4点の調整を適用。

### 2.6 市場オッズブレンド + バリューベット検出

`market-blend.ts` でモデル確率と市場オッズ暗示確率をブレンドし、妙味馬を検出する。

```
市場暗示確率 = (1/odds) / Σ(1/odds)   (オーバーラウンド除去)
ブレンド確率 = log-odds空間でモデル × (1-w) + 市場 × w
乖離度 = modelProb - marketProb   (正=モデルが高評価=妙味あり)
```

カテゴリ別ブレンドパラメータ（v7.2グリッドサーチ最適化済み）:

| カテゴリ | mlBlend | marketBlend | temperature |
|---|---|---|---|
| turf_sprint | 0.95 | 0.10 | 7 |
| turf_mile | 0.95 | 0.30 | 8 |
| turf_long | 0.85 | 0.50 | 4 |
| dirt_sprint | 1.00 | 0.05 | 12 |
| dirt_long | 0.95 | 0.10 | 8 |

### 2.7 信頼度 (Confidence) の算出

各予想には0〜100%の信頼度が付与される。以下の3要素の合計で算出する。

| 要素 | 最大配点 | 内容 |
|---|---|---|
| スコア差 | 40点 | 上位馬間のスコア差が大きいほど本命が明確→高信頼度 |
| データ充実度 | 35点 | 全馬の平均データ量（過去走数等）が多いほど高信頼度 |
| 統計コンテキスト | 15点 | コース統計・血統統計の充実度 |

---

## 3. XGBoost + CatBoost アンサンブル

### 3.1 目的

加重合計は線形結合であるため、「コース適性が高い＋距離適性も高い」場合の相乗効果のような非線形パターンを捉えられない。XGBoost + CatBoost のアンサンブルで勝率を学習し、較正済み確率を直接使用することで精度向上を狙う。

### 3.2 特徴量 (63次元)

| グループ | 特徴量 | 次元数 |
|---|---|---|
| 17ファクタースコア | recentForm, distanceAptitude, ... marginCompetitiveness | 15 |
| コンテキスト特徴量 | 頭数, 人気, 年齢, 性別, 斤量, 枠順, 距離 | 7 |
| カテゴリエンコード | グレード, 芝/ダート, 馬場状態, 天候 | 4 |
| 派生特徴量 | log(1+オッズ), 人気/頭数 | 2 |
| 調教師詳細統計 | 勝率, 複勝率, 距離カテゴリ勝率, 馬場状態勝率, グレード勝率 | 5 |
| 交互作用特徴量 | 種牡馬×トラック, 騎手×距離, 騎手×コース, 斤量×スピード, 年齢×距離, 騎手×フォーム, 頭数×枠順, ローテ×フォーム, 馬場×種牡馬 | 9 |
| v6.0追加 | 騎手乗替シグナル, コーナー加速, 着差(勝時/負時), 休養日数, 開催日 | 6 |
| v7.0追加 | 馬ペース指向, ハイペース率, コース距離ペース平均, ペーススタイル一致度 | 4 |
| v8.0追加 | 前走着順, 直近3走勝率/複勝率, クラス変更, トラックタイプ変更, キャリア勝率, 相対オッズ, 連勝数 | 8 |
| v9.0追加 | 相対着順, 穴馬好走率, 過去好走時平均オッズ, 通算賞金(log) | 4 |
| **合計** | | **63** |

### 3.3 推論フロー（TypeScriptネイティブ実装）

```
prediction-engine.ts
  │
  ├─ buildMLFeatures() で63次元ベクトル構築
  │
  ├─ callMLPredict() → TypeScriptでモデルJSONを直接走査
  │     │
  │     ├─ [優先] カテゴリ別モデル (5カテゴリ)
  │     │    ├─ xgb_ranker_{cat}.json → rawScore → softmax → Isotonic較正
  │     │    ├─ catboost_ranker_{cat}.json → rawScore → softmax → Isotonic較正
  │     │    └─ アンサンブル: XGB×w + CB×w (ensemble_weights.json)
  │     │
  │     ├─ [フォールバック1] グローバルモデル
  │     │    ├─ xgb_ranker.json + catboost_ranker.json → アンサンブル
  │     │    └─ XGBoostのみ (CatBoost未配置時)
  │     │
  │     └─ [フォールバック2] 分類モデル (レガシー)
  │          └─ xgb_win.json + xgb_place.json → sigmoid → 勝率・複勝率
  │
  └─ v10: totalScore = mlWinProb × 100 (ML較正済み確率を直接使用)
     (MLなし時のみ16因子スコアからsoftmaxで確率推定)
```

Python不要 — XGBoost/CatBoostのJSON決定木形式をTypeScriptで直接パースし、ツリー走査で推論する。これによりVercel Hobbyプランの500MB制限を回避。

### 3.4 アンサンブル重み

`ensemble_weights.json` でXGBoostとCatBoostの重みを管理。カテゴリ別に最適化。

| カテゴリ | XGBoost | CatBoost |
|---|---|---|
| グローバル | 0.20 | 0.80 |
| turf_sprint | 0.60 | 0.40 |
| turf_mile | 0.65 | 0.35 |
| turf_long | 0.80 | 0.20 |
| dirt_sprint | 0.20 | 0.80 |
| dirt_long | 0.70 | 0.30 |

### 3.5 最新モデル精度 (ranker_v6)

| 指標 | Validation | Test |
|---|---|---|
| 学習サンプル | 60,867 | - |
| 較正サンプル | 13,043 | - |
| テストサンプル | - | 13,043 |
| 特徴量数 | 63 | 63 |
| NDCG@1 | 0.5108 | 0.4683 |
| NDCG@3 | 0.5564 | 0.5378 |
| Top-1精度 | 33.6% | 28.2% |
| Top-3精度 | 67.3% | 64.9% |
| Brier (較正後) | - | 0.0587 |
| ECE (較正後) | - | 0.0107 |

#### カテゴリ別精度 (Test)

| カテゴリ | XGB NDCG@1 | XGB Top-1 | CB NDCG@1 | CB Top-1 |
|---|---|---|---|---|
| turf_sprint | 0.3663 | 19.8% | 0.3187 | 15.4% |
| turf_mile | 0.5417 | 35.0% | 0.5396 | 32.5% |
| turf_long | 0.5423 | 36.6% | 0.5435 | 33.6% |
| dirt_sprint | 0.4782 | 33.7% | 0.5131 | 36.3% |
| dirt_long | 0.5138 | 33.4% | 0.5138 | 35.0% |

### 3.6 学習フロー（GitHub Actions 自動化）

```
GitHub Actions (毎週月曜 12:00 JST / 手動実行可能)
  │
  ├─ Python 3.11 + xgboost + catboost をインストール
  ├─ GET /api/ml-export ← 過去の予想スコア + 実際の着順
  ├─ サンプル100件未満 → スキップ
  ├─ 時系列分割 (70% 学習 / 15% 較正 / 15% テスト)
  ├─ [XGBoost] グローバル + 5カテゴリ別 XGBRanker 学習
  ├─ [CatBoost] グローバル + 5カテゴリ別 CatBoost 学習
  ├─ [較正] Isotonic Regression → calibration.json / catboost_calibration.json
  ├─ [アンサンブル] カテゴリ別最適重み学習 → ensemble_weights.json
  ├─ [SHAP] Permutation Importance → shap_report.json
  ├─ [メタ] 全指標保存 → meta.json
  └─ model/*.json をコミット・push
       │
       ▼
  Vercel自動デプロイ → 次回予想からML適用
```

ローカル学習も可能:
- `scripts/train_model.py` (XGBoost)
- `scripts/train_catboost.py` (CatBoost + アンサンブル重み学習)

---

## 4. Value Betting 戦略

### 4.1 Kelly Criterion

```
f* = (b×p - q) / b
推奨: f*/4 (Fractional Kelly)
MAX_STAKE: 25%
```

### 4.2 バリューベット検出

Filter E（バックテスト検証済み）:
- ダートスプリント除外
- オッズ 3〜50倍
- モデルと市場の乖離 > 3%

バックテスト結果: ROI 243.1%、23ヶ月中20ヶ月黒字

高信頼度フィルター（信頼度60+ & EV>1.2 & 乖離>5%）: ROI 411.1%

### 4.3 isValueBet フラグ

`RecommendedBet` に `isValueBet` フラグを付与。フロントエンドで妙味ベットを視覚的にハイライト表示。

---

## 5. 的中率評価と自動キャリブレーション

### 5.1 評価項目

レース確定後、予想と実結果を自動照合して以下を計測する。

| 指標 | 内容 |
|---|---|
| 単勝的中率 | 本命馬が1着になった割合 |
| 複勝的中率 | 本命馬が3着以内に入った割合 |
| Top3カバー率 | 推奨上位3頭のうち、実際に3着以内に入った頭数 |
| 馬券ROI | 推奨馬券の回収率（本命馬に単勝100円想定 × 実オッズ） |
| 信頼度キャリブレーション | 「信頼度70%の予想が実際に70%当たるか」の検証 |

### 5.2 現在の精度実績

| 指標 | 全期間 (6,401件) |
|---|---|
| 単勝的中率 | 34.7% |
| 複勝的中率 | 66.8% |
| ROI | 85.1% |

#### カテゴリ別的中率

| カテゴリ | 的中率 |
|---|---|
| turf_long | 37.5% |
| dirt_long | 36.1% |
| turf_mile | 34.7% |
| dirt_short | 33.5% |
| turf_sprint | 30.7% |

#### 年別推移

| 年 | 的中率 |
|---|---|
| 2024 | 34.9% |
| 2025 | 35.1% |
| 2026 | 31.9% (コンセプトドリフト) |

### 5.3 自動キャリブレーション

評価データが **20レース以上**蓄積されると、各ファクターの重みを自動調整する。

1. 的中レースで高スコアだったファクターの重みを上げる
2. 外れレースで誤誘導したファクターの重みを下げる
3. 算出された新しい重みを自動適用
4. `calibration_weights`テーブルに履歴を保存

### 5.4 データリーケージ修正（2026-03-08）

v5.2以前は全データ取得関数に日付フィルタがなく、過去レースの予測再生成時に**未来のレース結果が混入**していた（データリーケージ）。

#### 修正内容

| 関数 | 修正 |
|---|---|
| `getHorsePastPerformances(horseId, beforeDate?, limit)` | `AND date < ?` フィルタ追加 |
| `getJockeyStats(jockeyId, beforeDate?)` | `AND r.date < ?` フィルタ追加、jockeysテーブル経由せず直接計算 |
| `buildRaceContext(... raceDate?)` | 内部9関数すべてに `AND date < ?` フィルタ追加 |
| `generatePrediction()` | `date` を `buildRaceContext()` に自動伝搬 |

修正後は全期間で均一な精度となり、auto-calibrationが正しく機能する基盤が完成した。

### 5.5 SHAP分析

`shap_report.json` に Permutation Importance ベースの特徴量重要度を保存。

SHAP Top5: oddsLogTransform(38.2), jockeyAbility(9.0), trainerDistCatWinRate(4.3), popularity(4.1), sireTrackWinRate(3.2)

---

## 6. 管理機能

### 6.1 管理画面 (`/admin`)

| 機能 | 説明 |
|---|---|
| フル同期 | 指定日のレース一覧→出馬表→馬詳細→オッズ→予想を一括実行 |
| 予想再生成 | 結果取得→バイアス算出→予想再生成を1ボタンで実行 |
| バルクインポート | 日付範囲指定で過去データを一括取込（チャンク分割） |
| 的中率ダッシュボード | 単勝/複勝的中率、ROI、信頼度帯別精度を表示 |
| 一括照合 | 未照合レースの予想vs結果を一括評価 |
| ウェイト校正 | ファクター重みの自動キャリブレーション |

### 6.2 フロントエンドページ

| ページ | パス | 機能 |
|---|---|---|
| トップ | `/` | レース一覧 |
| レース詳細 | `/races/[raceId]` | 予想詳細、モンテカルロシミュレーション、オッズ取得ボタン |
| 予想一覧 | `/predictions` | 全予想の一覧 |
| 統計 | `/stats` | 的中率・ROI統計 |
| カレンダー | `/calendar` | レースカレンダー |
| 馬詳細 | `/horses` | 馬の過去成績 |
| 騎手一覧 | `/jockeys` | 騎手統計 |
| お気に入り | `/favorites` | ブックマークしたレース |
| 管理画面 | `/admin` | 管理機能 |

### 6.3 同期進捗バナー

全ページ共通のヘッダー下に `SyncStatusBanner` コンポーネントを配置。バックグラウンドで同期処理が実行中の場合、5秒ごとにポーリングして進捗を表示する。完了時は緑バナーで8秒間通知。SYNC_KEY は localStorage に永続化し、どのページからでも参照可能。

---

## 7. ローカルスクリプト

Vercelのタイムアウト制約（60秒）を回避するための一括処理スクリプト群。全てプロジェクトルートの `scripts/` ディレクトリに配置。

実行方法: `npx tsx -r tsconfig-paths/register scripts/<スクリプト名>.ts`

### 7.1 データ取込・メンテナンス

| スクリプト | 機能 |
|---|---|
| `import-history.ts` | 過去レースの一括取込（`--days N` で期間指定） |
| `fetch-odds.ts` | 結果確定レースのオッズ後付け取得（result.htmlから） |
| `fetch-lap-times.ts` | ラップタイムの後付け取得（`--limit N`, `--resume`） |
| `recalc-pace-types.ts` | lap_times_json修正 + pace_type再計算 |

### 7.2 予測生成

| スクリプト | 機能 |
|---|---|
| `gen-predictions-optimized.ts` | **最適化版**一括予測生成。全データをプリロード → メモリキャッシュで予測生成 |

### 7.3 評価・分析

| スクリプト | 機能 |
|---|---|
| `evaluate-all.ts` | 未照合レースの一括照合 + キャリブレーション実行 |
| `repair-roi.ts` | 全prediction_resultsのROI再計算 |
| `compare-accuracy.ts` | 16ファクター vs XGBoost の精度比較 |
| `roi-filtered-validation.ts` | 18フィルタコンボ × 期間のROI検証 |
| `roi-deep-analysis.ts` | カテゴリ・月・グレード別の深堀りROI分析 |
| `profitability-analysis.ts` | 複数戦略のROI分析 |

### 7.4 ML関連

| スクリプト | 機能 |
|---|---|
| `export-training-data.ts` | TursoからML学習データをエクスポート（v10.0: 63特徴量） |
| `train_model.py` | XGBoost モデル学習 (Python) |
| `train_catboost.py` | CatBoost 学習 + アンサンブル重み学習 (Python) |
| `shap_analysis_xgb.py` | SHAP / Permutation Importance 分析 |

### 7.5 プリロード+キャッシュインターセプター方式

`gen-predictions-optimized.ts` で採用している最適化方式。

```
通常の予測生成: レースあたり ~50クエリ × 数千レース = 数万クエリ
最適化版:       7プリロードクエリ + レースあたり ~2書き込みのみ

プリロード (7クエリ):
  1. SELECT * FROM races               → racesById (Map)
  2. SELECT * FROM race_entries         → entriesByRace (Map)
  3. SELECT ... FROM horses             → horsesById (Map)
  4. SELECT * FROM past_performances    → perfsByHorse (Map)
  5. SELECT ... FROM jockeys            → jockeysById (Map)
  6. SELECT ... FROM odds (単勝)        → oddsByRace (Map)
  7. 派生インデックス構築               → jockeyRaceHistory, topFinisherPerfs 等

SQLインターセプター:
  client.execute() をパッチし、SQL文をパターンマッチ
  → 該当するメモリキャッシュから結果を返す（Turso読み取りゼロ）
  → INSERT/DELETE/UPDATE のみ実DBにパススルー
```

---

## 8. システム構成

### 8.1 技術スタック

| コンポーネント | 技術 | 備考 |
|---|---|---|
| フロントエンド | Next.js (App Router) | Vercel Hobbyプラン |
| バックエンド | Next.js API Routes | サーバーレス (60秒タイムアウト) |
| データベース | Turso (libsql/SQLite) | エッジ対応の分散SQLite |
| ML推論 | TypeScriptネイティブ (XGBoost/CatBoost JSON走査) | Python不要、追加依存なし |
| ML学習 | GitHub Actions (Python) | 週次自動 or 手動 |
| CI/CD | Vercel (git push連動) + GitHub Actions | 自動デプロイ + 自動再学習 |

### 8.2 ディレクトリ構成

```
keiba/
├── .github/workflows/
│   ├── train-model.yml            # XGBoost + CatBoost 自動再学習
│   ├── daily-morning.yml          # 朝データ取得 + 予想生成
│   ├── daily-results.yml          # 結果取得 + 照合
│   ├── prefetch-races.yml         # 先行レース取得
│   ├── afternoon-predictions.yml  # 午後予想再生成
│   ├── odds-refresh.yml           # オッズ再取得
│   ├── accuracy-report.yml        # 精度レポート
│   └── confidence-roi-analysis.yml # 信頼度×ROI分析
├── docs/
│   └── prediction-system-architecture.md  # 本ドキュメント
├── model/                             # 学習済みモデル（GitHub Actionsで自動更新）
│   ├── xgb_ranker.json            # XGBoostグローバルランキングモデル
│   ├── xgb_ranker_{cat}.json      # XGBoostカテゴリ別モデル (×5)
│   ├── catboost_ranker.json       # CatBoostグローバルモデル
│   ├── catboost_ranker_{cat}.json # CatBoostカテゴリ別モデル (×5)
│   ├── calibration.json           # XGBoost Isotonic Regression較正
│   ├── catboost_calibration.json  # CatBoost Isotonic Regression較正
│   ├── ensemble_weights.json      # アンサンブル重み (カテゴリ別)
│   ├── feature_names.json         # 63特徴量名の順序定義
│   ├── meta.json                  # 学習メタ情報 (精度指標等)
│   ├── shap_report.json           # Permutation Importance分析結果
│   ├── xgb_win.json               # レガシー分類モデル (フォールバック)
│   ├── xgb_place.json             # レガシー複勝モデル (フォールバック)
│   └── training_data.json         # 学習データスナップショット
├── scripts/                           # ローカル実行スクリプト群（§7参照）
│   ├── gen-predictions-optimized.ts   # 最適化版一括予測生成
│   ├── export-training-data.ts        # ML学習データエクスポート
│   ├── train_model.py                 # XGBoost学習
│   ├── train_catboost.py              # CatBoost学習 + アンサンブル
│   ├── shap_analysis_xgb.py           # SHAP分析
│   ├── evaluate-all.ts                # 一括照合
│   ├── import-history.ts              # 過去データ一括取込
│   ├── fetch-odds.ts                  # オッズ後付け取得
│   ├── fetch-lap-times.ts             # ラップタイム取得
│   ├── repair-roi.ts                  # ROI再計算
│   ├── roi-filtered-validation.ts     # ROIフィルタ検証
│   ├── roi-deep-analysis.ts           # 深堀りROI分析
│   ├── profitability-analysis.ts      # 収益性分析
│   └── ...                            # 他スクリプト
├── src/
│   ├── app/
│   │   ├── admin/page.tsx         # 管理画面
│   │   ├── api/
│   │   │   ├── cron/route.ts      # Vercel Cronエンドポイント
│   │   │   ├── ml-export/route.ts # 学習データエクスポートAPI
│   │   │   ├── odds/route.ts      # オッズ取得API
│   │   │   ├── sync/route.ts      # データ同期 + 予想生成
│   │   │   ├── predictions/       # 予想API
│   │   │   ├── accuracy-stats/    # 精度統計API
│   │   │   ├── stats/             # 統計API
│   │   │   ├── score-lookup/      # スコア照会API
│   │   │   ├── scheduler/         # スケジューラAPI
│   │   │   ├── diagnostic/        # 診断API
│   │   │   └── ...
│   │   ├── races/[raceId]/page.tsx # レース詳細（モンテカルロ付き）
│   │   ├── predictions/           # 予想一覧
│   │   ├── stats/                 # 統計ページ
│   │   ├── calendar/              # カレンダー
│   │   ├── horses/                # 馬詳細
│   │   ├── jockeys/               # 騎手一覧
│   │   ├── favorites/             # お気に入り
│   │   └── layout.tsx             # ルートレイアウト（SyncStatusBanner含む）
│   ├── components/
│   │   ├── Header.tsx             # ヘッダーナビ
│   │   ├── Footer.tsx             # フッター
│   │   └── SyncStatusBanner.tsx   # 同期進捗バナー
│   └── lib/
│       ├── prediction-engine.ts   # 予想エンジン本体 (17ファクター)
│       ├── prediction-builder.ts  # 予測構築共通化 (バッチクエリ ~7q/race)
│       ├── ml-client.ts           # ML推論（XGBoost+CatBoostアンサンブル）
│       ├── market-blend.ts        # 市場オッズブレンド + 妙味馬検出
│       ├── weight-management.ts   # ウェイト管理 + カテゴリ別ブレンドパラメータ
│       ├── weight-profiles.ts     # カテゴリ別ウェイトプロファイル
│       ├── racecourse-profiles.ts # 競馬場別ファクター補正 (10場)
│       ├── weight-trend.ts        # 体重トレンド分析 (±8ptボーナス)
│       ├── pace-analyzer.ts       # 強化ペース分析 (コンテキスト依存)
│       ├── track-bias.ts          # 当日馬場バイアス分析
│       ├── margin-score.ts        # 着差競争力スコア
│       ├── weather-score.ts       # 天候適性スコア
│       ├── historical-analyzer.ts # 統計分析 (枠順/血統/季節/動的基準タイム/騎手フォーム)
│       ├── ev-calculator.ts       # EV再計算モジュール
│       ├── betting-strategy.ts    # 馬券戦略 + 推奨馬券生成
│       ├── probability-estimation.ts # softmax確率推定
│       ├── race-analysis.ts       # レース分析 + 信頼度算出
│       ├── accuracy-tracker.ts    # 的中率評価 + 自動キャリブレーション
│       ├── scraper.ts             # netkeiba スクレイパー
│       ├── bulk-importer.ts       # 過去データ一括取込
│       ├── scheduler.ts           # 日次スケジューラ
│       ├── queries.ts             # DB操作 (CRUD)
│       ├── database.ts            # DB接続 + スキーマ定義
│       └── time-features.ts       # 走破タイム標準化・ペース特徴量 (train/inference共通)
└── vercel.json                    # Cron設定 (6ジョブ)
```

### 8.3 エラーハンドリング方針

本システムは**段階的フォールバック**を採用している。各レイヤーが独立して失敗してもシステム全体は動作し続ける。

| 障害 | 影響範囲 | フォールバック動作 |
|---|---|---|
| カテゴリ別モデル未配置 | ML推論 | グローバルモデルにフォールバック |
| CatBoost未配置 | アンサンブル | XGBoostのみで推論 |
| 全MLモデル未配置/パースエラー | ML推論 | 17因子加重合計スコアのみで予想 |
| 較正マッピング未配置 | 確率較正 | softmax確率をそのまま使用 |
| 当日バイアスデータ不足 | バイアス補正 | 補正なし（加重合計のまま） |
| 動的基準タイムデータ不足 | スピード指数 | ハードコード基準タイムにフォールバック |
| コース別枠順データ不足 | 枠順バイアス | 固定biasMapにフォールバック |
| 騎手直近フォームデータ不足 | 騎手能力 | 通算成績のみで評価 |
| オッズ未取得 | 市場オッズファクター | 事前分布（50点）にフォールバック |
| 市場暗示確率なし | オッズブレンド | モデル確率のみ使用 |
| 馬の過去データ不足 | スコア精度 | ベイズ推定で事前分布にフォールバック + 動的重み再配分 |
| スクレイピング失敗 | データ取得 | リトライ (最大2回)、失敗時はスキップして次の処理へ |
| 同期処理タイムアウト | バックグラウンド処理 | 2分後に自動リセット、再実行可能 |
| Turso読み取り制限 | 全クエリ | ローカルスクリプト（プリロード方式）で回避可能 |

### 8.4 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `TURSO_DATABASE_URL` | Yes | Turso DB接続URL |
| `TURSO_AUTH_TOKEN` | Yes | Turso認証トークン |
| `SYNC_KEY` | No | 同期API認証キー（未設定時は認証なし） |
| `CRON_SECRET` | No | Vercel Cron認証用シークレット |
| `ML_BLEND_WEIGHT` | No | MLブレンド比率（カテゴリ別パラメータで管理、環境変数でオーバーライド可） |
| `MARKET_BLEND_WEIGHT` | No | 市場オッズブレンド比率（同上） |

### 8.5 GitHub Secrets（GitHub Actions用）

| シークレット名 | 説明 |
|---|---|
| `APP_URL` | VercelデプロイURL（例: `https://keiba.vercel.app`） |
| `TURSO_DATABASE_URL` | Turso DB接続URL |
| `TURSO_AUTH_TOKEN` | Turso認証トークン |

---

## 変更履歴

| バージョン | 日付 | 変更内容 |
|---|---|---|
| v10.0 | 2026-03-19 | ML較正済み確率を直接使用（二重softmax問題解消）。63特徴量化。v9.0特徴量追加（relativePosition, upsetRate, avgPastOdds, totalEarningsLog）。classChange/trackTypeChange推論修正 |
| v8.1 | 2026-03-15 | Value Betting戦略確立（Filter E: ROI 243.1%）。Kelly Criterion f*/4。isValueBetフラグ追加 |
| v7.2 | 2026-03-14 | カテゴリ別ブレンドパラメータ（mlBlend/marketBlend/temperature）グリッドサーチ最適化。市場オッズブレンド（market-blend.ts）。競馬場別補正（racecourse-profiles.ts） |
| v7.1 | 2026-03-13 | SHAP分析で重要度0の3ファクター除去（19→17）。比例再配分 |
| v6.0 | 2026-03-10 | CatBoostアンサンブル、カテゴリ別MLモデル（×5）、Isotonic Regression較正、v6.0新特徴量6個 |
| v5.3 | 2026-03-08 | データリーケージ修正（全クエリにbeforeDateフィルタ追加）。XGBoostをリーケージ修正済みデータで再学習。全予想再生成 |
| v5.2 | 2026-03 | XGBRanker(LambdaMART/NDCG)導入、特徴量45次元化。marginCompetitiveness/weatherAptitudeファクター追加 |
| v5.1 | 2026-03 | weight-trend.ts, pace-analyzer.ts, category_calibrationテーブル追加 |
| v5.0 | 2026-03 | 19ファクター化、動的スピード指数、騎手直近フォーム、カテゴリ別ウェイト |
| v4.2 | 2025-09 | 調教師能力ファクター追加、XGBoost特徴量拡充 |
| v4.0 | 2025-06 | ベイズ推定フォールバック + 動的ウェイト調整、XGBoostブレンド |
| v3.0 | 2025-03 | 16ファクタースコアリング |
