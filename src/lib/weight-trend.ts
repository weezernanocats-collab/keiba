/**
 * 馬体重トレンド分析
 * 過去走データから体重の安定性・傾向・好走体重との乖離を評価しボーナスを算出
 */
import type { PastPerformance } from '@/types';

export interface WeightTrendResult {
  bonus: number;         // -8 ~ +8 (recentFormスコアに加算)
  signal: string;        // 理由テキスト
  stability: number;     // 0-100 (ML特徴量)
  trendSlope: number;    // kg/レース (ML特徴量)
  optimalDelta: number;  // 好走体重との差 (ML特徴量)
}

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

/** 標準偏差 */
const stdDev = (xs: readonly number[]): number => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
};

/** 単回帰の傾き (x=0..n-1, y=values) */
const linSlope = (ys: readonly number[]): number => {
  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  const num = ys.reduce((s, y, i) => s + (i - meanX) * (y - meanY), 0);
  const den = ys.reduce((s, _, i) => s + (i - meanX) ** 2, 0);
  return den === 0 ? 0 : num / den;
};

export function calcWeightTrendBonus(pp: readonly PastPerformance[]): WeightTrendResult {
  const valid = pp.filter((r) => r.weight > 0).slice(0, 10);

  if (valid.length < 2) {
    return { bonus: 0, signal: 'データ不足', stability: 50, trendSlope: 0, optimalDelta: 0 };
  }

  const weights = valid.map((r) => r.weight);
  const signals: string[] = [];

  // --- 安定性 (標準偏差) ---
  const sd = stdDev(weights);
  const [stabilityBonus, stability] =
    sd <= 2 ? [4, 90] : sd <= 4 ? [2, 70] : sd <= 6 ? [0, 50] : [-2, 25];
  if (sd <= 4) signals.push(`安定(σ${sd.toFixed(1)})`);
  if (sd > 6) signals.push(`体重不安定(σ${sd.toFixed(1)})`);

  // --- トレンド (直近5走の回帰傾き) ---
  const recent5 = weights.slice(0, 5);
  const slope = linSlope(recent5);
  let trendBonus = 0;
  if (slope >= 0 && slope <= 2) {
    trendBonus = 2;
    signals.push('微増傾向');
  } else if (Math.abs(slope) < 0.5) {
    trendBonus = 1;
  } else if (slope < -2) {
    trendBonus = -3;
    signals.push('急減');
  } else if (slope > 3) {
    trendBonus = -2;
    signals.push('急増');
  }

  // --- 好走体重との乖離 ---
  const goodRuns = valid.filter((r) => r.position >= 1 && r.position <= 3);
  let optimalBonus = 0;
  let optimalDelta = 0;
  if (goodRuns.length >= 2) {
    const avgGood = goodRuns.reduce((s, r) => s + r.weight, 0) / goodRuns.length;
    optimalDelta = valid[0].weight - avgGood;
    const absDelta = Math.abs(optimalDelta);
    optimalBonus = absDelta <= 2 ? 2 : absDelta <= 4 ? 1 : absDelta > 6 ? -2 : 0;
    if (absDelta <= 4) signals.push(`好走体重±${Math.round(absDelta)}kg`);
    if (absDelta > 6) signals.push(`好走体重乖離${optimalDelta > 0 ? '+' : ''}${Math.round(optimalDelta)}kg`);
  }

  // --- 極端な増減 (最新走) ---
  const absChange = Math.abs(valid[0].weightChange);
  const extremeBonus = absChange >= 10 ? -4 : absChange >= 6 ? -1 : 0;
  if (absChange >= 6) signals.push(`前走${valid[0].weightChange > 0 ? '+' : ''}${valid[0].weightChange}kg`);

  return {
    bonus: clamp(stabilityBonus + trendBonus + optimalBonus + extremeBonus, -8, 8),
    signal: signals.length > 0 ? signals.join(' ') : '平均的',
    stability,
    trendSlope: Math.round(slope * 100) / 100,
    optimalDelta: Math.round(optimalDelta * 100) / 100,
  };
}
