/**
 * ウェイト管理モジュール
 *
 * 予測エンジンの重み設定、キャリブレーション、ベイズ推定、
 * データ充実度に基づく動的ウェイト調整を一元管理する。
 */

import type { TrackType } from '@/types';
import { categorizeRace } from './weight-profiles';

// ==================== インターフェース ====================

/** v7.2: カテゴリ別ブレンドパラメータ */
export interface CategoryBlendParams {
  mlBlend: number;
  marketBlend: number;
  temperature: number;
}

/**
 * 各ファクターのデータ充実度 (0.0〜1.0)
 * 0.0 = データなし（全て事前分布）, 1.0 = 十分なデータあり（観測値のみ）
 */
export interface DataReliability {
  factor: string;
  reliability: number; // 0.0-1.0
  dataPoints: number;  // このファクター計算に使われたデータ点数
}

// ==================== 定数 ====================

// デフォルト重み設定 (v7.1: SHAP重要度0の3ファクター除去 + 比例再配分, 合計1.00)
// 除去: courseAptitude(0.06), classPerformance(0.04), jockeyTrainerCombo(0.02)
export const DEFAULT_WEIGHTS: Record<string, number> = {
  // 個体分析
  recentForm: 0.17,
  distanceAptitude: 0.11,
  trackConditionAptitude: 0.05,
  jockeyAbility: 0.08,
  speedRating: 0.11,
  runningStyle: 0.06,
  postPositionBias: 0.05,
  rotation: 0.04,
  lastThreeFurlongs: 0.08,
  consistency: 0.05,
  // 統計ベース分析
  sireAptitude: 0.06,
  trainerAbility: 0.05,
  seasonalPattern: 0.02,
  handicapAdvantage: 0.01,
  // 市場シグナル
  marketOdds: 0.03,
  marginCompetitiveness: 0.01,
  weatherAptitude: 0.02,
};

// WEIGHTS はキャリブレーション結果で上書き可能
let WEIGHTS: Record<string, number> = { ...DEFAULT_WEIGHTS };

// v7.2: カテゴリ別ブレンドパラメータ（グリッドサーチ最適化済み）
// ML_BLEND: ML vs 伝統スコアの比率, MARKET_BLEND: モデル vs 市場オッズ, TEMPERATURE: softmax温度
const CATEGORY_BLEND_PARAMS: Record<string, CategoryBlendParams> = {
  turf_sprint:  { mlBlend: 0.95, marketBlend: 0.10, temperature: 7 },
  turf_mile:    { mlBlend: 0.95, marketBlend: 0.30, temperature: 8 },
  turf_long:    { mlBlend: 0.85, marketBlend: 0.50, temperature: 4 },
  dirt_sprint:  { mlBlend: 1.00, marketBlend: 0.05, temperature: 12 },
  dirt_long:    { mlBlend: 0.95, marketBlend: 0.10, temperature: 8 },
};

const DEFAULT_BLEND_PARAMS: CategoryBlendParams = {
  mlBlend: 0.90, marketBlend: 0.50, temperature: 12,
};

/**
 * 母集団の事前分布 (ベイズ推定のprior)
 * データ不足時にデフォルト50ではなくこれを使う
 *
 * 例: コース適性でそのコースの成績が0走の場合
 *   旧: 50 (情報なし)
 *   新: 全馬の平均コース適性スコアをpriorとして、
 *       reliability に応じて posterior = prior * (1-r) + observed * r
 */
export const POPULATION_PRIORS: Record<string, number> = {
  recentForm: 45,          // 平均的な馬は若干下位寄り
  distanceAptitude: 45,    // 距離未経験は不利寄り
  trackConditionAptitude: 48,
  jockeyAbility: 40,       // 騎手データなし → 平均以下
  speedRating: 45,         // タイムなし → やや不利
  runningStyle: 50,        // 脚質は中立
  postPositionBias: 50,    // 枠順は中立
  rotation: 50,            // ローテは中立
  lastThreeFurlongs: 45,   // 上がり3Fデータなし → やや不利
  consistency: 45,         // 走数少 → 安定感不明は不利寄り
  sireAptitude: 50,        // 血統は中立prior
  trainerAbility: 45,      // 調教師不明は平均以下
  seasonalPattern: 50,     // 季節は中立
  handicapAdvantage: 50,   // 斤量は中立prior
  marketOdds: 50,          // オッズなし → 中立
  marginCompetitiveness: 48, // 着差データなし → やや不利
  weatherAptitude: 50,     // 天候データなし → 中立
};

// ==================== 関数 ====================

/** カテゴリ別ブレンドパラメータを取得 */
export function getCategoryBlendParams(trackType: string, distance: number): CategoryBlendParams {
  const cat = categorizeRace(trackType as TrackType, distance);
  return CATEGORY_BLEND_PARAMS[cat] ?? DEFAULT_BLEND_PARAMS;
}

/**
 * キャリブレーション済み重みを適用する。
 * 合計が1.0に正規化されていることを検証する。
 */
export function applyCalibrationWeights(calibratedWeights: Record<string, number>): void {
  const total = Object.values(calibratedWeights).reduce((s, v) => s + v, 0);
  if (Math.abs(total - 1.0) > 0.05) {
    // 正規化
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(calibratedWeights)) {
      normalized[k] = v / total;
    }
    WEIGHTS = { ...DEFAULT_WEIGHTS, ...normalized };
  } else {
    WEIGHTS = { ...DEFAULT_WEIGHTS, ...calibratedWeights };
  }
}

/** デフォルト重みにリセット */
export function resetWeights(): void {
  WEIGHTS = { ...DEFAULT_WEIGHTS };
}

/** 現在使用中の重みを取得 */
export function getCurrentWeights(): Record<string, number> {
  return { ...WEIGHTS };
}

/**
 * ファクターごとのデータ充実度を計算し、信頼度を返す
 * reliability = min(dataPoints / requiredPoints, 1.0)
 */
export function calcFactorReliability(factor: string, dataPoints: number): number {
  // 各ファクターで「十分」とみなすデータ点数
  const requiredPoints: Record<string, number> = {
    recentForm: 5,
    distanceAptitude: 3,
    trackConditionAptitude: 2,
    jockeyAbility: 1,       // 騎手率は常に1 or 0
    speedRating: 3,
    runningStyle: 5,
    postPositionBias: 1,    // 常に利用可能
    rotation: 1,            // 前走があれば利用可能
    lastThreeFurlongs: 3,
    consistency: 5,
    sireAptitude: 10,
    trainerAbility: 20,
    seasonalPattern: 6,
    marketOdds: 1,
    marginCompetitiveness: 5,
    weatherAptitude: 3,
  };
  const req = requiredPoints[factor] || 5;
  return Math.min(1.0, dataPoints / req);
}

/**
 * ベイズ推定: prior と observed を reliability で混合
 */
export function bayesianScore(factor: string, observedScore: number, dataPoints: number): { score: number; reliability: number } {
  const reliability = calcFactorReliability(factor, dataPoints);
  const prior = POPULATION_PRIORS[factor] || 50;
  const score = prior * (1 - reliability) + observedScore * reliability;
  return { score, reliability };
}

/**
 * 動的ウェイト調整: データ不足ファクターの重みを下げ、充実ファクターに再配分
 */
export function adjustWeights(reliabilities: DataReliability[]): Record<string, number> {
  return adjustWeightsWithBase(reliabilities, WEIGHTS);
}

/**
 * カテゴリ別ウェイトをベースにした動的ウェイト調整
 */
export function adjustWeightsWithBase(reliabilities: DataReliability[], baseWeights: Record<string, number>): Record<string, number> {
  const adjusted: Record<string, number> = { ...baseWeights };

  let totalEffective = 0;
  let totalBase = 0;
  for (const { factor, reliability } of reliabilities) {
    const base = baseWeights[factor] || 0;
    const effective = base * Math.max(0.2, reliability);
    adjusted[factor] = effective;
    totalEffective += effective;
    totalBase += base;
  }

  if (totalEffective < totalBase * 0.99) {
    const surplus = totalBase - totalEffective;
    const reliableFactors = reliabilities.filter(r => r.reliability >= 0.5);
    const reliableTotal = reliableFactors.reduce((s, r) =>
      s + (baseWeights[r.factor] || 0), 0);

    if (reliableTotal > 0) {
      for (const { factor } of reliableFactors) {
        const base = baseWeights[factor] || 0;
        adjusted[factor] += surplus * (base / reliableTotal);
      }
    }
  }

  return adjusted;
}
