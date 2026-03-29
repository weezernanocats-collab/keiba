# 競馬予測システム 改善ロードマップ

**最終更新**: 2026-03-29
**現在のバージョン**: v10.1

## 現在のベースライン

| 指標 | 値 |
|---|---|
| 単勝的中率 | 34.7% (6,401件) |
| 複勝的中率 | 66.8% |
| ROI | 85.1% |
| XGBoost NDCG@1 | 0.5108 (Val) / 0.4683 (Test) |
| 特徴量数 | 63 |
| モデル構成 | XGBoost + CatBoost アンサンブル（5カテゴリ別） |

---

## 完了済み施策

### Phase 0: 評価基盤 (完了)
- [x] Isotonic Regression較正（Platt Scalingの代替として採用）
- [x] Brier Score / ECE 計測基盤
- [x] キャリブレーションプロット

### Phase 1: 特徴量改善 (完了)
- [x] 騎手乗り替わりシグナル（jockeySwitch, jockeySwitchQuality）
- [x] コーナー通過順位差（cornerDelta）
- [x] 着差定量化（avgMarginWhenWinning/Losing）
- [x] 休養日数連続値化（daysSinceLastRace）
- [x] 交互作用特徴量（9個）
- [x] ラップタイム基盤特徴量（horsePacePreference, horseHaiPaceRate, courseDistPaceAvg, paceStyleMatch）
- [x] v8.0追加（lastRacePosition, last3WinRate/PlaceRate, classChange, trackTypeChange, careerWinRate, relativeOdds, winStreak）
- [x] v9.0追加（relativePosition, upsetRate, avgPastOdds, totalEarningsLog）

### Phase 2: MLモデル改善 (完了)
- [x] CatBoost Ranker 導入
- [x] XGBoost + CatBoost アンサンブル（カテゴリ別重み最適化）
- [x] カテゴリ別専門モデル（5カテゴリ）
- [x] Isotonic Regression較正
- [x] v10: ML較正済み確率を直接使用（二重softmax解消）
- [x] SHAP分析ファクター除去（19→17ファクター）

### Phase 3: データ整備 (完了)
- [x] データリーケージ修正（全クエリにbeforeDateフィルタ）
- [x] ラップタイム取得（77%カバレッジ）
- [x] 複勝率バグ修正（<= 2 → <= 3）
- [x] エクスポートリーケージ修正

### Phase 4: ベッティング戦略 (完了)
- [x] Kelly Criterion（f*/4）
- [x] Value Betting Filter E（ROI 243.1%バックテスト）
- [x] isValueBetフラグ + フロントエンドハイライト
- [x] 市場オッズブレンド（log-odds空間）
- [x] カテゴリ別ブレンドパラメータ最適化

### Phase 5: インフラ・UX改善 (完了)
- [x] タイムアウト対策（段階的メッセージUI、buildAndPredictタイムアウト適用）
- [x] DB操作並列化
- [x] 予想ページUX改善（スティッキーヘッダー、騎手名・発走時刻表示）
- [x] 馬場バイアス自動再生成バナー
- [x] 管理ページに結果一括取得ボタン追加
- [x] keiba-fixプロジェクト廃止（Vercel CPU枠節約）
- [x] Turso batch() 廃止 → sequential execute（2026-03-21障害対策）

---

## 未着手・検討中の施策

### 高インパクト（優先度高）

| # | 施策 | 期待効果 | 備考 |
|---|---|---|---|
| 1 | **Optunaハイパーパラメータ最適化** | NDCG +2-5% | Val→Testで8.3%劣化 = 過学習の兆候あり。正則化強化が必要 |
| 2 | **turf_sprintカテゴリ改善** | NDCG +5-10% | 全カテゴリ中最低（0.3663）。分割またはカテゴリ別特徴量選択 |
| 3 | **専用複勝モデル** | ROI +5-10% | 現在は粗い推定。label_placeターゲットの専用モデル学習 |
| 4 | **サンプル重みの recency weighting** | ROI +2-3% | 2026年の的中率低下（コンセプトドリフト）対策 |

### 中インパクト（検討中）

| # | 施策 | 期待効果 | 備考 |
|---|---|---|---|
| 5 | LightGBM追加（3モデルアンサンブル） | +1-3% | 多様性でアンサンブル強化 |
| 6 | ランキング損失関数の代替（LambdaRank） | +0.5-1.5% | rank:ndcg → rank:pairwise |
| 7 | オッズ時系列スクレイピング | +1-2% | 前日→直前の変動パターン |
| 8 | 母父（BMS）血統データ | +0.5-1% | 馬ページからスクレイピング |
| 9 | 特徴量ドリフト監視 | 精度劣化早期検出 | 月次feature importance記録 |
| 10 | コンセプトドリフト検出 | ROI損失防止 | 直近30レースROI低下でアラート |

### 低インパクト・長期

| # | 施策 | 期待効果 |
|---|---|---|
| 11 | ラップタイムカバレッジ 77%→100% | +0.5-1% |
| 12 | 調教師得意パターン詳細化 | +0.3-0.5% |
| 13 | 開催週トラックバイアス予測 | +0.3-0.5% |
| 14 | モンテカルロ・シミュレーション | 戦略の統計的信頼性検証 |

---

## 改善の前提分析（CLAUDE.md準拠）

特徴量追加・仮説検証・モデル変更に着手する前に、以下を必ず実施すること:

1. **AI単独実力の計測**: オッズ・人気関連特徴量を全て除外したモデルのTop-1/ROIを測定
2. **市場依存度の定量化**: 全特徴量モデル vs オッズ除外モデルの差分 = 市場コピー分
3. **上記を踏まえた改善方針の判断**: AI付加価値がゼロなら、特徴量追加ではなくモデル構造・損失関数の見直しが先

---

## 年別精度推移

| 年 | 単勝的中率 | 備考 |
|---|---|---|
| 2024 | 34.9% | 安定期 |
| 2025 | 35.1% | 安定期 |
| 2026 | 31.9% | コンセプトドリフトの兆候 → recency weighting検討 |
