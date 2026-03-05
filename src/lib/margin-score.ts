/**
 * 着差(margin)スコアモジュール
 *
 * 過去走の着差パターンから馬の「競り合い力」を数値化する。
 * - 好走時(3着以内)の着差が小さい → 接戦に強い
 * - 大敗(5馬身以上)が多い → 安定感に欠ける
 * - 直近走の着差トレンド → 改善/悪化を反映
 */

import type { PastPerformance } from '@/types';

/** 着差文字列を馬身数値に変換 */
export function parseMargin(margin: string | undefined | null): number | null {
  if (!margin || margin === '') return 0; // 1着は着差なし = 0馬身
  const trimmed = margin.trim();
  if (trimmed === '' || trimmed === '0') return 0;

  // 日本語キーワード
  const keywordMap: Record<string, number> = {
    'ハナ': 0.1,
    'アタマ': 0.15,
    'クビ': 0.2,
    '大差': 10,
  };
  if (keywordMap[trimmed] !== undefined) return keywordMap[trimmed];

  // 分数表記: "1/2", "3/4" など
  const fracMatch = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    return parseInt(fracMatch[1], 10) / parseInt(fracMatch[2], 10);
  }

  // 複合表記: "1 1/2", "2 1/2" など
  const compoundMatch = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (compoundMatch) {
    return parseInt(compoundMatch[1], 10) +
      parseInt(compoundMatch[2], 10) / parseInt(compoundMatch[3], 10);
  }

  // 数値のみ: "1", "2", "3" など
  const num = parseFloat(trimmed);
  if (!isNaN(num)) return num;

  return null; // パース不能
}

/**
 * 過去走の着差パターンから競争力スコアを計算
 */
export function calcMarginScore(pp: readonly PastPerformance[]): {
  score: number;
  dataPoints: number;
} {
  if (pp.length === 0) return { score: 50, dataPoints: 0 };

  const recent = pp.slice(0, 15);
  const margins: Array<{ position: number; marginValue: number }> = [];

  for (const p of recent) {
    const marginVal = parseMargin(p.margin);
    if (marginVal === null) continue;
    margins.push({ position: p.position, marginValue: marginVal });
  }

  if (margins.length === 0) return { score: 50, dataPoints: 0 };

  // 好走時(3着以内)の平均着差
  const goodRuns = margins.filter(m => m.position <= 3);
  let baseScore = 50;

  if (goodRuns.length > 0) {
    const avgGoodMargin = goodRuns.reduce((s, m) => s + m.marginValue, 0) / goodRuns.length;
    if (avgGoodMargin <= 0.2) baseScore = 90;       // ほぼ差なし勝ち
    else if (avgGoodMargin <= 0.5) baseScore = 80;   // クビ〜半馬身差
    else if (avgGoodMargin <= 1.0) baseScore = 65;   // 1馬身以内
    else if (avgGoodMargin <= 1.5) baseScore = 55;
    else baseScore = 50;
  } else {
    // 好走なし → 低評価ベース
    baseScore = 35;
  }

  // 大敗率 (着差5馬身以上の割合)
  const bigLossCount = margins.filter(m => m.marginValue >= 5).length;
  const bigLossRate = bigLossCount / margins.length;
  if (bigLossRate > 0.3) baseScore -= 15;
  else if (bigLossRate > 0.2) baseScore -= 10;
  else if (bigLossRate > 0.1) baseScore -= 5;

  // トレンド (直近3走の着差が縮小傾向か)
  const recentThree = margins.slice(0, 3);
  if (recentThree.length >= 3) {
    const isImproving = recentThree[0].marginValue < recentThree[1].marginValue &&
                        recentThree[1].marginValue < recentThree[2].marginValue;
    const isWorsening = recentThree[0].marginValue > recentThree[1].marginValue &&
                        recentThree[1].marginValue > recentThree[2].marginValue;
    if (isImproving) baseScore += 5;
    else if (isWorsening) baseScore -= 5;
  }

  // 1着率ボーナス
  const winCount = margins.filter(m => m.position === 1).length;
  const winRate = winCount / margins.length;
  if (winRate >= 0.4) baseScore += 10;
  else if (winRate >= 0.2) baseScore += 5;

  return {
    score: Math.max(0, Math.min(100, baseScore)),
    dataPoints: margins.length,
  };
}
