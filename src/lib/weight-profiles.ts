/**
 * レースカテゴリ別ウェイトプロファイル
 *
 * 芝/ダート、距離帯ごとに異なるファクター重要度を反映する。
 * 基本WEIGHTSに対する乗数として適用し、正規化する。
 */

import type { TrackType } from '@/types';

export type RaceCategory =
  | 'turf_sprint'   // 芝短距離 (≤1400m)
  | 'turf_mile'     // 芝マイル (1500-1800m)
  | 'turf_long'     // 芝中長距離 (1900m+)
  | 'dirt_sprint'   // ダート短距離 (≤1400m)
  | 'dirt_long';    // ダート中長距離 (1500m+)

/** レース条件からカテゴリを判定 */
export function categorizeRace(trackType: TrackType | string, distance: number): RaceCategory {
  if (trackType === 'ダート' || trackType === 'ダ') {
    return distance <= 1400 ? 'dirt_sprint' : 'dirt_long';
  }
  if (distance <= 1400) return 'turf_sprint';
  if (distance <= 1800) return 'turf_mile';
  return 'turf_long';
}

/**
 * カテゴリ別ウェイト乗数
 *
 * 根拠:
 * - 芝短距離: 枠順・スピードが重要、末脚は短距離で差がつきにくい
 * - 芝中長距離: 血統・脚質・安定性が重要、枠順の影響は薄い
 * - ダート短距離: スピード・クラス・枠順が支配的
 * - ダート中長距離: スピード・馬場適性・直近成績が重要
 */
const CATEGORY_MULTIPLIERS: Record<RaceCategory, Record<string, number>> = {
  turf_sprint: {
    recentForm: 1.1,
    postPositionBias: 1.5,
    historicalPostBias: 1.4,
    speedRating: 1.3,
    lastThreeFurlongs: 0.7,
    sireAptitude: 0.8,
    consistency: 0.8,
    runningStyle: 0.8,
    distanceAptitude: 0.9,
    marginCompetitiveness: 1.2,  // 短距離は接戦が多い
    weatherAptitude: 0.8,
  },
  turf_mile: {
    // マイルは基本ウェイトが最適なのでほぼそのまま
  },
  turf_long: {
    sireAptitude: 1.3,
    runningStyle: 1.3,
    consistency: 1.2,
    postPositionBias: 0.6,
    historicalPostBias: 0.7,
    speedRating: 0.9,
    distanceAptitude: 1.2,
    marginCompetitiveness: 0.9,
    weatherAptitude: 1.1,  // 長距離は天候影響大
  },
  dirt_sprint: {
    speedRating: 1.4,
    classPerformance: 1.2,
    postPositionBias: 1.3,
    historicalPostBias: 1.3,
    sireAptitude: 1.1,
    lastThreeFurlongs: 0.6,
    trackConditionAptitude: 1.2,
    marginCompetitiveness: 1.1,
    weatherAptitude: 1.2,  // ダートは雨の影響大
  },
  dirt_long: {
    speedRating: 1.2,
    classPerformance: 1.2,
    recentForm: 1.1,
    trackConditionAptitude: 1.3,
    distanceAptitude: 1.1,
    postPositionBias: 0.8,
    historicalPostBias: 0.8,
    marginCompetitiveness: 1.0,
    weatherAptitude: 1.3,  // ダート長距離は天候の影響が最大
  },
};

// 自動校正済み乗数（calibrateCategoryWeightsから適用）
let CALIBRATED_MULTIPLIERS: Record<RaceCategory, Record<string, number>> | null = null;

/**
 * カテゴリ別自動校正結果を適用する
 */
export function applyCalibratedCategoryMultipliers(
  calibrations: Map<string, Record<string, number>>,
): void {
  const result = { ...CATEGORY_MULTIPLIERS } as Record<RaceCategory, Record<string, number>>;
  for (const [category, multipliers] of calibrations.entries()) {
    if (category in result) {
      result[category as RaceCategory] = { ...result[category as RaceCategory], ...multipliers };
    }
  }
  CALIBRATED_MULTIPLIERS = result;
}

/** 校正済み乗数をリセットする */
export function resetCalibratedMultipliers(): void {
  CALIBRATED_MULTIPLIERS = null;
}

/**
 * ベースウェイトにカテゴリ別乗数を適用して正規化
 * 校正済み乗数が存在すればそちらを優先使用
 */
export function applyCategoryMultipliers(
  baseWeights: Record<string, number>,
  category: RaceCategory,
): Record<string, number> {
  const source = CALIBRATED_MULTIPLIERS ?? CATEGORY_MULTIPLIERS;
  const multipliers = source[category];
  const adjusted: Record<string, number> = {};

  for (const [key, weight] of Object.entries(baseWeights)) {
    adjusted[key] = weight * (multipliers[key] ?? 1.0);
  }

  // 合計を1.0に正規化
  const total = Object.values(adjusted).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const key of Object.keys(adjusted)) {
      adjusted[key] = adjusted[key] / total;
    }
  }

  return adjusted;
}
