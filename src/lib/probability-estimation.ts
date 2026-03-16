/**
 * 確率推定 & サマリー生成
 *
 * prediction-engine.ts から抽出:
 *   - estimateWinProbabilities: softmax でスコア → 勝率変換
 *   - generateSummary: 人間向け予想サマリーテキスト生成
 */

import type { PredictionPick, RaceAnalysis } from '@/types';
import type { TodayTrackBias } from './track-bias';
import type { ScoredHorse } from './betting-strategy';

// ==================== 確率推定 ====================

/**
 * スコア配列を softmax で勝率マップに変換する。
 * temperature が高いほど均等に、低いほど上位集中になる。
 */
export function estimateWinProbabilities(
  scoredHorses: ScoredHorse[],
  temperature: number = 8,
): Map<ScoredHorse, number> {
  const probs = new Map<ScoredHorse, number>();
  if (scoredHorses.length === 0) return probs;

  // スコアの中央値を基準に正規化（オーバーフロー防止）
  const scores = scoredHorses.map(h => h.totalScore);
  const maxScore = Math.max(...scores);

  let sumExp = 0;
  const exps: number[] = [];
  for (const score of scores) {
    const e = Math.exp((score - maxScore) / temperature);
    exps.push(e);
    sumExp += e;
  }

  const uniform = 1 / scoredHorses.length;
  for (let i = 0; i < scoredHorses.length; i++) {
    probs.set(scoredHorses[i], sumExp > 0 ? exps[i] / sumExp : uniform);
  }

  return probs;
}

// ==================== サマリー生成 ====================

export function generateSummary(
  topPicks: PredictionPick[],
  analysis: RaceAnalysis,
  raceName: string,
  confidence: number,
  todayBias?: TodayTrackBias | null,
  isAfternoon?: boolean,
): string {
  const parts: string[] = [];
  parts.push(`【${raceName}の予想】`);

  // 午後再生成時: 午前の傾向セクション
  if (isAfternoon && todayBias && todayBias.sampleRaces >= 3) {
    parts.push('');
    parts.push(`【午前の傾向（${todayBias.sampleRaces}R分析）】`);
    const trends: string[] = [];
    if (Math.abs(todayBias.innerAdvantage) > 0.15) {
      trends.push(todayBias.innerAdvantage > 0
        ? `内枠有利（バイアス${(todayBias.innerAdvantage * 100).toFixed(0)}%）`
        : `外枠有利（バイアス${(Math.abs(todayBias.innerAdvantage) * 100).toFixed(0)}%）`);
    } else {
      trends.push('枠順バイアスなし');
    }
    if (Math.abs(todayBias.frontRunnerAdvantage) > 0.15) {
      trends.push(todayBias.frontRunnerAdvantage > 0
        ? `先行有利（逃げ・先行馬の好走多い）`
        : `差し追込有利（後方勢が台頭）`);
    } else {
      trends.push('脚質バイアスなし');
    }
    parts.push(`  ${trends.join(' / ')}`);
    parts.push(`  ※午前${todayBias.sampleRaces}レースの実績を反映して予想を更新`);
  }

  parts.push('');

  if (topPicks.length > 0) {
    parts.push(`◎本命: ${topPicks[0].horseName}（スコア${topPicks[0].score}）`);
    parts.push(`  → ${topPicks[0].reasons.slice(0, 2).join('。')}`);
  }
  if (topPicks.length > 1) {
    parts.push(`○対抗: ${topPicks[1].horseName}（スコア${topPicks[1].score}）`);
    parts.push(`  → ${topPicks[1].reasons.slice(0, 2).join('。')}`);
  }
  if (topPicks.length > 2) {
    parts.push(`▲単穴: ${topPicks[2].horseName}（スコア${topPicks[2].score}）`);
  }

  parts.push('');
  parts.push(`【展開予想】${analysis.paceAnalysis}`);

  if (analysis.riskFactors.length > 0) {
    parts.push('');
    parts.push(`【注意点】${analysis.riskFactors.join(' / ')}`);
  }

  // 妙味馬サマリー
  if (analysis.valueHorses && analysis.valueHorses.length > 0 && analysis.marketAnalysis) {
    parts.push('');
    const valueNames = analysis.valueHorses.slice(0, 3).map(hn => {
      const pick = topPicks.find(p => p.horseNumber === hn);
      const ma = analysis.marketAnalysis![hn];
      if (pick && ma) {
        return `${pick.horseName}（モデル${(ma.modelProb * 100).toFixed(1)}% vs 市場${(ma.marketProb * 100).toFixed(1)}%）`;
      }
      return null;
    }).filter(Boolean);
    if (valueNames.length > 0) {
      parts.push(`【妙味馬】${valueNames.join('、')}はオッズ以上の実力と判断`);
    }
  }

  parts.push('');
  parts.push(`AI信頼度: ${confidence}%`);
  if (isAfternoon) {
    parts.push('※午後更新版: 午前の馬場傾向を反映した19ファクター分析 + 市場オッズブレンド');
  } else {
    parts.push('※統計分析v3: 16ファクター分析（血統・騎手×調教師・季節パターン含む）+ 市場オッズブレンド');
  }

  return parts.join('\n');
}
