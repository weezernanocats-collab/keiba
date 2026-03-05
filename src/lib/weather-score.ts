/**
 * 天候適性スコアモジュール
 *
 * 過去走の天候別成績から、当日天候での馬のパフォーマンスを推定する。
 * - 同天候での着順平均 → ベーススコア
 * - 雨/雪時のパフォーマンス変化 → ±10点の補正
 */

import type { PastPerformance } from '@/types';

/** 天候を「晴/曇」(良天候) と「雨/雪」(悪天候) に分類 */
function isWetWeather(weather: string): boolean {
  return ['雨', '小雨', '雪', '小雪'].includes(weather);
}

/** 着順から0-100スコアへの変換 */
function positionToScore(avgPos: number): number {
  // 1着=100, 3着=80, 5着=60, 8着=40, 12着=20, 16着=10
  if (avgPos <= 1) return 100;
  if (avgPos >= 16) return 10;
  return Math.max(10, Math.min(100, 110 - avgPos * 7));
}

/**
 * 過去走の天候別成績から天候適性スコアを計算
 */
export function calcWeatherScore(
  pp: readonly PastPerformance[],
  currentWeather: string | undefined,
): { score: number; dataPoints: number } {
  if (!currentWeather || pp.length === 0) return { score: 50, dataPoints: 0 };

  const recent = pp.slice(0, 15);

  // 同天候の走を抽出
  const sameWeatherRuns = recent.filter(p => p.weather === currentWeather);

  if (sameWeatherRuns.length === 0) {
    // 同天候データなし → 悪天候グループでの成績を代替で見る
    const isWet = isWetWeather(currentWeather);
    if (isWet) {
      const wetRuns = recent.filter(p => isWetWeather(p.weather));
      if (wetRuns.length > 0) {
        const avgPos = wetRuns.reduce((s, p) => s + p.position, 0) / wetRuns.length;
        return { score: positionToScore(avgPos), dataPoints: wetRuns.length };
      }
    }
    return { score: 50, dataPoints: 0 };
  }

  // 同天候での平均着順
  const avgPos = sameWeatherRuns.reduce((s, p) => s + p.position, 0) / sameWeatherRuns.length;
  let baseScore = positionToScore(avgPos);

  // 雨/雪の場合: 良天候時との比較でパフォーマンス変化を反映
  if (isWetWeather(currentWeather)) {
    const dryRuns = recent.filter(p => !isWetWeather(p.weather));
    if (dryRuns.length >= 2) {
      const dryAvgPos = dryRuns.reduce((s, p) => s + p.position, 0) / dryRuns.length;
      const improvement = dryAvgPos - avgPos; // 正 = 悪天候の方が好走
      baseScore += Math.max(-10, Math.min(10, improvement * 3));
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(baseScore))),
    dataPoints: sameWeatherRuns.length,
  };
}
