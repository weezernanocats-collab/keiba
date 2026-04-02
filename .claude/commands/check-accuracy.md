---
description: 予測精度・ROIの現状を確認する
---

# 精度・ROI確認

直近の予測精度とROIを確認します。

## 手順

1. prediction_resultsテーブルから直近の的中率・ROIを集計
2. 期間別（直近7日/30日/全体）で表示
3. カテゴリ別（芝/ダート、距離帯）の内訳を表示

## 実行

```bash
cd /Users/naoto_kimura/kaihatsu/keiba
npx tsx -r tsconfig-paths/register scripts/calculate-accuracy.ts $ARGUMENTS
```
