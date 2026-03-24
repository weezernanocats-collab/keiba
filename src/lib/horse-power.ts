/**
 * 馬力スコア（Horse Power Score）モジュール
 *
 * 第1層: 馬の実力・騎手の実力・相性・安定性から、買い方に依存しない
 * 「この馬がこのレースで好走する確率」を算出する。
 *
 * 第2層の買い方補正（betting-strategy.ts の calcBetHitProb）で
 * 馬券種別ごとの的中確率に変換される。
 */

import type { PastPerformance, TrackType, TrackCondition } from '@/types';

// ==================== 型定義 ====================

export interface HorsePowerScore {
  /** 総合スコア (0-100) */
  total: number;

  /** A. 馬の実力 (0-40) */
  horseAbility: number;
  /** B. 騎手の実力 (0-25) */
  jockeyAbility: number;
  /** C. 相性 (0-25) */
  compatibility: number;
  /** D. 安定性 (0-10) */
  stability: number;

  /** 推定勝率 (0-1): 馬力スコアから変換 */
  estimatedWinProb: number;
  /** 推定連対率 (0-1) */
  estimatedPlaceRate: number;
  /** 推定複勝率 (0-1) */
  estimatedShowRate: number;

  /** サンプル不足の警告 */
  sampleWarning?: SampleWarning;

  /** 内訳の詳細（UI表示用） */
  breakdown: HorsePowerBreakdown;
}

export interface SampleWarning {
  level: 'danger' | 'caution';
  message: string;
  totalRaces: number;
  categoryRaces: number;
}

export interface HorsePowerBreakdown {
  /** 馬のカテゴリ別単勝率 */
  horseCategoryWinRate: number;
  /** 馬のカテゴリ別連対率 */
  horseCategoryPlaceRate: number;
  /** 馬のカテゴリ別複勝率 */
  horseCategoryShowRate: number;
  /** 直近3走トレンド (-1 ~ +1) */
  recentTrend: number;
  /** 騎手単勝率 */
  jockeyWinRate: number;
  /** 騎手連対率 */
  jockeyPlaceRate: number;
  /** 騎手×距離勝率 */
  jockeyDistWinRate: number;
  /** 騎手×コース勝率 */
  jockeyCourseWinRate: number;
  /** 馬×コース複勝率 */
  horseCourseShowRate: number;
  /** 馬×馬場状態複勝率 */
  horseCondShowRate: number;
  /** 馬の総出走数 */
  horseTotalRaces: number;
  /** 馬のカテゴリ別出走数 */
  horseCategoryRaces: number;
}

// ==================== 定数 ====================

/** ベイズ平滑化パラメータ: 出走数が少ないほど全体平均に寄せる */
const SMOOTHING_ALPHA = 5;

/** 全体平均（ベイズ事前分布） */
const PRIOR_WIN_RATE = 0.07;
const PRIOR_PLACE_RATE = 0.14;
const PRIOR_SHOW_RATE = 0.21;
const PRIOR_JOCKEY_WIN_RATE = 0.08;

// ==================== メイン関数 ====================

export interface HorsePowerInput {
  /** 馬のID */
  horseId: string;
  /** 馬名 */
  horseName: string;
  /** 馬の過去成績 (beforeDateフィルタ済み) */
  pastPerformances: PastPerformance[];
  /** 騎手の全体勝率 */
  jockeyWinRate: number;
  /** 騎手の全体連対率 */
  jockeyPlaceRate: number;
  /** 騎手×距離勝率 */
  jockeyDistWinRate: number;
  /** 騎手×コース勝率 */
  jockeyCourseWinRate: number;
  /** 騎手×調教師コンビ勝率 (null=データなし) */
  jockeyTrainerComboWinRate: number | null;
  /** 種牡馬×馬場タイプ勝率 */
  sireTrackWinRate: number;
  /** 安定性スコア (16因子のconsistency, 0-100) */
  consistencyScore: number;
  /** 騎手直近30日フォーム (勝率) */
  jockeyRecentFormWinRate: number;
}

export interface HorsePowerContext {
  trackType: TrackType;
  distance: number;
  trackCondition?: TrackCondition;
  racecourseName: string;
}

/**
 * 馬力スコアを算出する
 */
export function calcHorsePower(
  input: HorsePowerInput,
  context: HorsePowerContext,
): HorsePowerScore {
  const pp = input.pastPerformances;
  const totalRaces = pp.length;

  // --- カテゴリ別成績（芝/ダート × 距離帯） ---
  const categoryPerfs = filterByCategory(pp, context.trackType, context.distance);
  const categoryRaces = categoryPerfs.length;

  const catStats = calcStats(categoryPerfs);
  const allStats = calcStats(pp);

  // ベイズ平滑化
  const horseCatWinRate = bayesSmooth(catStats.wins, categoryRaces, PRIOR_WIN_RATE);
  const horseCatPlaceRate = bayesSmooth(catStats.places, categoryRaces, PRIOR_PLACE_RATE);
  const horseCatShowRate = bayesSmooth(catStats.shows, categoryRaces, PRIOR_SHOW_RATE);

  // 全条件のfallback（カテゴリデータが少ない場合）
  const horseAllWinRate = bayesSmooth(allStats.wins, totalRaces, PRIOR_WIN_RATE);
  const horseAllShowRate = bayesSmooth(allStats.shows, totalRaces, PRIOR_SHOW_RATE);

  // カテゴリデータが2走以上あればカテゴリ優先、なければ全条件で補完
  const effectiveWinRate = categoryRaces >= 2 ? horseCatWinRate : horseAllWinRate;
  const effectivePlaceRate = categoryRaces >= 2 ? horseCatPlaceRate
    : bayesSmooth(allStats.places, totalRaces, PRIOR_PLACE_RATE);
  const effectiveShowRate = categoryRaces >= 2 ? horseCatShowRate : horseAllShowRate;

  // --- 直近3走トレンド ---
  const recentTrend = calcRecentTrend(pp);

  // --- 馬×コース適性 ---
  const coursePerfs = pp.filter(p => p.racecourseName === context.racecourseName);
  const courseStats = calcStats(coursePerfs);
  const horseCourseShowRate = coursePerfs.length >= 2
    ? bayesSmooth(courseStats.shows, coursePerfs.length, PRIOR_SHOW_RATE)
    : PRIOR_SHOW_RATE;

  // --- 馬×馬場状態適性 ---
  const condPerfs = context.trackCondition
    ? pp.filter(p => p.trackCondition === context.trackCondition)
    : [];
  const condStats = calcStats(condPerfs);
  const horseCondShowRate = condPerfs.length >= 2
    ? bayesSmooth(condStats.shows, condPerfs.length, PRIOR_SHOW_RATE)
    : PRIOR_SHOW_RATE;

  // ==================== A. 馬の実力 (40点満点) ====================
  const horseAbility = Math.min(40,
    scoreFromRate(effectiveWinRate, PRIOR_WIN_RATE, 0.35) * 15 +     // 単勝率 (15)
    scoreFromRate(effectivePlaceRate, PRIOR_PLACE_RATE, 0.50) * 10 + // 連対率 (10)
    scoreFromRate(effectiveShowRate, PRIOR_SHOW_RATE, 0.60) * 8 +    // 複勝率 (8)
    trendScore(recentTrend) * 7                                       // トレンド (7)
  );

  // ==================== B. 騎手の実力 (25点満点) ====================
  const jockeyAbility = Math.min(25,
    scoreFromRate(input.jockeyWinRate, PRIOR_JOCKEY_WIN_RATE, 0.25) * 8 +      // 騎手全体勝率 (8)
    scoreFromRate(input.jockeyPlaceRate, PRIOR_JOCKEY_WIN_RATE * 2, 0.40) * 4 + // 騎手連対率 (4)
    scoreFromRate(input.jockeyDistWinRate, PRIOR_JOCKEY_WIN_RATE, 0.25) * 5 +  // 騎手×距離 (5)
    scoreFromRate(input.jockeyCourseWinRate, PRIOR_JOCKEY_WIN_RATE, 0.25) * 5 + // 騎手×コース (5)
    scoreFromRate(input.jockeyRecentFormWinRate, PRIOR_JOCKEY_WIN_RATE, 0.25) * 3 // 騎手直近 (3)
  );

  // ==================== C. 相性 (25点満点) ====================
  const jockeyTrainerScore = input.jockeyTrainerComboWinRate !== null
    ? scoreFromRate(input.jockeyTrainerComboWinRate, PRIOR_WIN_RATE, 0.20) * 5
    : 2.5; // データなしは中間値

  const compatibility = Math.min(25,
    scoreFromRate(horseCourseShowRate, PRIOR_SHOW_RATE, 0.50) * 7 +   // 馬×コース (7)
    scoreFromRate(horseCondShowRate, PRIOR_SHOW_RATE, 0.50) * 5 +     // 馬×馬場 (5)
    jockeyTrainerScore +                                               // 騎手×調教師 (5)
    scoreFromRate(input.sireTrackWinRate, PRIOR_WIN_RATE, 0.15) * 5 + // 血統×条件 (5)
    3 // 馬×騎手コンビ: 将来拡張用 (3) - 現在は中間値固定
  );

  // ==================== D. 安定性 (10点満点) ====================
  const consistencyNorm = Math.min(input.consistencyScore, 100) / 100;
  const sampleConfidence = Math.min(1, totalRaces / 15); // 15走で信頼度100%
  const stability = Math.min(10,
    consistencyNorm * 5 +
    sampleConfidence * 5
  );

  // ==================== 総合スコア ====================
  const total = Math.round(
    (horseAbility + jockeyAbility + compatibility + stability) * 10
  ) / 10;

  // ==================== 推定確率への変換 ====================
  // 馬力スコアから推定確率を算出（データ検証結果に基づくキャリブレーション）
  const estimatedWinProb = scoreToProbability(total, 'win');
  const estimatedPlaceRate = scoreToProbability(total, 'place');
  const estimatedShowRate = scoreToProbability(total, 'show');

  // ==================== サンプル警告 ====================
  const sampleWarning = getSampleWarning(totalRaces, categoryRaces, context.trackType, context.distance);

  return {
    total,
    horseAbility: Math.round(horseAbility * 10) / 10,
    jockeyAbility: Math.round(jockeyAbility * 10) / 10,
    compatibility: Math.round(compatibility * 10) / 10,
    stability: Math.round(stability * 10) / 10,
    estimatedWinProb,
    estimatedPlaceRate,
    estimatedShowRate,
    sampleWarning,
    breakdown: {
      horseCategoryWinRate: effectiveWinRate,
      horseCategoryPlaceRate: effectivePlaceRate,
      horseCategoryShowRate: effectiveShowRate,
      recentTrend,
      jockeyWinRate: input.jockeyWinRate,
      jockeyPlaceRate: input.jockeyPlaceRate,
      jockeyDistWinRate: input.jockeyDistWinRate,
      jockeyCourseWinRate: input.jockeyCourseWinRate,
      horseCourseShowRate,
      horseCondShowRate,
      horseTotalRaces: totalRaces,
      horseCategoryRaces: categoryRaces,
    },
  };
}

// ==================== ヘルパー関数 ====================

/** ベイズ平滑化: (実績 + α×事前確率) / (N + α) */
function bayesSmooth(successes: number, total: number, prior: number): number {
  return (successes + SMOOTHING_ALPHA * prior) / (total + SMOOTHING_ALPHA);
}

/** 距離帯でフィルタ（±200m） */
function filterByCategory(
  perfs: PastPerformance[],
  trackType: TrackType,
  distance: number,
): PastPerformance[] {
  return perfs.filter(p =>
    p.trackType === trackType &&
    Math.abs(p.distance - distance) <= 200
  );
}

/** 成績を集計 */
function calcStats(perfs: PastPerformance[]): { wins: number; places: number; shows: number } {
  let wins = 0, places = 0, shows = 0;
  for (const p of perfs) {
    if (p.position === 1) wins++;
    if (p.position <= 2) places++;
    if (p.position <= 3) shows++;
  }
  return { wins, places, shows };
}

/** 直近3走のトレンド (-1=下降, 0=安定, +1=上昇) */
function calcRecentTrend(perfs: PastPerformance[]): number {
  if (perfs.length < 2) return 0;

  // 最新3走（日付降順でソート済みと仮定）
  const recent = perfs.slice(0, Math.min(3, perfs.length));
  if (recent.length < 2) return 0;

  // 着順の変化を見る（小さい=好走）
  let improvement = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    const diff = recent[i + 1].position - recent[i].position;
    improvement += Math.sign(diff); // 前走より着順改善=+1
  }

  // -1 ~ +1 に正規化
  return Math.max(-1, Math.min(1, improvement / (recent.length - 1)));
}

/** 率を0-1のスコアに変換（事前分布 = 0.5, 上限率 = 1.0） */
function scoreFromRate(rate: number, prior: number, maxRate: number): number {
  if (maxRate <= prior) return 0.5;
  // rate = prior → 0.5, rate >= maxRate → 1.0, rate = 0 → 0に近い
  const normalized = (rate - prior) / (maxRate - prior);
  return Math.max(0, Math.min(1, 0.5 + normalized * 0.5));
}

/** トレンドをスコア(0-1)に変換 */
function trendScore(trend: number): number {
  return 0.5 + trend * 0.5; // -1→0, 0→0.5, +1→1
}

/**
 * 馬力スコアから推定確率に変換
 * 検証データに基づくキャリブレーション:
 * - 馬力スコア 80+ の馬 → 実単勝率 ~30%
 * - 馬力スコア 50 の馬 → 実単勝率 ~7%
 * - 馬力スコア 30 の馬 → 実単勝率 ~2%
 */
function scoreToProbability(score: number, type: 'win' | 'place' | 'show'): number {
  // シグモイド風の変換
  const x = (score - 50) / 20; // 50を中心に正規化
  const sigmoid = 1 / (1 + Math.exp(-x));

  switch (type) {
    case 'win':
      // 0.02 ~ 0.50 の範囲
      return Math.max(0.02, Math.min(0.50, sigmoid * 0.48 + 0.02));
    case 'place':
      // 0.05 ~ 0.65 の範囲
      return Math.max(0.05, Math.min(0.65, sigmoid * 0.60 + 0.05));
    case 'show':
      // 0.10 ~ 0.80 の範囲
      return Math.max(0.10, Math.min(0.80, sigmoid * 0.70 + 0.10));
  }
}

/** サンプル不足の警告を生成 */
function getSampleWarning(
  totalRaces: number,
  categoryRaces: number,
  trackType: TrackType,
  distance: number,
): SampleWarning | undefined {
  const distLabel = `${trackType}${distance}m`;

  if (totalRaces <= 2) {
    return {
      level: 'danger',
      message: `出走データ不足（${totalRaces}走） - 参考値です`,
      totalRaces,
      categoryRaces,
    };
  }

  if (totalRaces <= 5) {
    return {
      level: 'caution',
      message: `データ少なめ（${totalRaces}走）`,
      totalRaces,
      categoryRaces,
    };
  }

  if (categoryRaces <= 1 && totalRaces >= 3) {
    return {
      level: 'caution',
      message: `${distLabel}での出走: ${categoryRaces}回 - 全条件データで補完`,
      totalRaces,
      categoryRaces,
    };
  }

  return undefined;
}
