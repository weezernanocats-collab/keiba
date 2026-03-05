/**
 * AI予想エンジン v4.2
 *
 * 過去の成績データを18の観点から多角的に分析し、レースの予想を生成する。
 * v4: ベイズ推定フォールバック + 動的ウェイト調整 + データ充実度ベース信頼度
 * v4.2: 調教師能力ファクター追加
 *
 * スコアリング要素と重み:
 *   === 個体分析 ===
 *   1.  直近成績        (18%) - 直近5走の着順を重み付け評価
 *   2.  コース適性      (6%)  - 同競馬場での過去成績
 *   3.  距離適性        (12%) - 同距離帯での過去成績
 *   4.  馬場状態適性    (4%)  - 同馬場状態での成績
 *   5.  騎手能力        (6%)  - 騎手の勝率・複勝率
 *   6.  スピード指数    (10%) - タイムベースの速度評価
 *   7.  クラス実績      (4%)  - 重賞など上位クラスでの成績
 *   8.  脚質適性        (5%)  - 展開との相性（逃げ/先行/差し/追込）
 *   9.  枠順分析        (2%)  - コース形態に応じた枠の有利不利
 *   10. ローテーション  (4%)  - 前走からの間隔と叩き良化パターン
 *   11. 上がり3F        (8%)  - 末脚の切れ味評価
 *   12. 安定性          (4%)  - 着順のバラつきの少なさ
 *
 *   === 統計ベース分析 ===
 *   13. 血統適性        (5%)  - 種牡馬産駒の統計的なコース/距離/馬場適性
 *   14. 調教師能力      (4%)  - 調教師の勝率・トラック別成績・直近成績
 *   15. 騎手×調教師     (2%)  - コンビの過去成績統計
 *   16. 統計的枠順バイアス (3%) - 過去データから算出した枠別勝率
 *   17. 季節パターン    (2%)  - 馬ごとの季節別成績傾向
 *   18. 斤量アドバンテージ (2%) - 平均斤量との差分
 */

import type {
  Prediction, PredictionPick, RaceAnalysis, RecommendedBet,
  RaceEntry, PastPerformance, TrackType, TrackCondition,
} from '@/types';

import {
  buildRaceContext,
  calcSireAptitudeScore,
  calcJockeyTrainerScore,
  calcTrainerAbilityScore,
  calcHistoricalPostBias,
  calcSeasonalScore,
  calcSecondStartScore,
  type RaceHistoricalContext,
} from './historical-analyzer';
import { enhancePredictionWithGemini, type GeminiRaceContext } from './gemini-enhancer';
import { callMLPredict, buildMLFeatures, type MLHorseInput } from './ml-client';
import { calculateTodayTrackBias, type TodayTrackBias } from './track-bias';

// デフォルト重み設定 (v4.2: 調教師能力を追加、的中率最適化)
const DEFAULT_WEIGHTS: Record<string, number> = {
  // 個体分析 (直近・距離・速度の重み強化)
  recentForm: 0.18,
  courseAptitude: 0.06,
  distanceAptitude: 0.12,
  trackConditionAptitude: 0.04,
  jockeyAbility: 0.06,
  speedRating: 0.10,
  classPerformance: 0.04,
  runningStyle: 0.05,
  postPositionBias: 0.02,
  rotation: 0.04,
  lastThreeFurlongs: 0.08,
  consistency: 0.04,
  // 統計ベース分析
  sireAptitude: 0.05,
  trainerAbility: 0.04,
  jockeyTrainerCombo: 0.02,
  historicalPostBias: 0.02,
  seasonalPattern: 0.02,
  handicapAdvantage: 0.02,
};

// WEIGHTS はキャリブレーション結果で上書き可能
let WEIGHTS: Record<string, number> = { ...DEFAULT_WEIGHTS };

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

// ==================== v4: データ充実度 & ベイズ推定 ====================

/**
 * 各ファクターのデータ充実度 (0.0〜1.0)
 * 0.0 = データなし（全て事前分布）, 1.0 = 十分なデータあり（観測値のみ）
 */
interface DataReliability {
  factor: string;
  reliability: number; // 0.0-1.0
  dataPoints: number;  // このファクター計算に使われたデータ点数
}

/**
 * 母集団の事前分布 (ベイズ推定のprior)
 * データ不足時にデフォルト50ではなくこれを使う
 *
 * 例: コース適性でそのコースの成績が0走の場合
 *   旧: 50 (情報なし)
 *   新: 全馬の平均コース適性スコアをpriorとして、
 *       reliability に応じて posterior = prior * (1-r) + observed * r
 */
const POPULATION_PRIORS: Record<string, number> = {
  recentForm: 45,          // 平均的な馬は若干下位寄り
  courseAptitude: 48,       // 未経験コースはやや不利
  distanceAptitude: 45,    // 距離未経験は不利寄り
  trackConditionAptitude: 48,
  jockeyAbility: 40,       // 騎手データなし → 平均以下
  speedRating: 45,         // タイムなし → やや不利
  classPerformance: 42,    // 重賞未経験は不利
  runningStyle: 50,        // 脚質は中立
  postPositionBias: 50,    // 枠順は中立
  rotation: 50,            // ローテは中立
  lastThreeFurlongs: 45,   // 上がり3Fデータなし → やや不利
  consistency: 45,         // 走数少 → 安定感不明は不利寄り
  sireAptitude: 50,        // 血統は中立prior
  trainerAbility: 45,      // 調教師不明は平均以下
  jockeyTrainerCombo: 50,  // コンボは中立prior
  historicalPostBias: 50,  // 枠バイアスは中立
  seasonalPattern: 50,     // 季節は中立
  handicapAdvantage: 50,   // 斤量は中立prior
};

/**
 * ファクターごとのデータ充実度を計算し、信頼度を返す
 * reliability = min(dataPoints / requiredPoints, 1.0)
 */
function calcFactorReliability(factor: string, dataPoints: number): number {
  // 各ファクターで「十分」とみなすデータ点数
  const requiredPoints: Record<string, number> = {
    recentForm: 5,
    courseAptitude: 3,
    distanceAptitude: 3,
    trackConditionAptitude: 2,
    jockeyAbility: 1,       // 騎手率は常に1 or 0
    speedRating: 3,
    classPerformance: 2,
    runningStyle: 5,
    postPositionBias: 1,    // 常に利用可能
    rotation: 1,            // 前走があれば利用可能
    lastThreeFurlongs: 3,
    consistency: 5,
    sireAptitude: 10,
    trainerAbility: 20,
    jockeyTrainerCombo: 5,
    historicalPostBias: 20,
    seasonalPattern: 6,
  };
  const req = requiredPoints[factor] || 5;
  return Math.min(1.0, dataPoints / req);
}

/**
 * ベイズ推定: prior と observed を reliability で混合
 */
function bayesianScore(factor: string, observedScore: number, dataPoints: number): { score: number; reliability: number } {
  const reliability = calcFactorReliability(factor, dataPoints);
  const prior = POPULATION_PRIORS[factor] || 50;
  const score = prior * (1 - reliability) + observedScore * reliability;
  return { score, reliability };
}

/**
 * 動的ウェイト調整: データ不足ファクターの重みを下げ、充実ファクターに再配分
 */
function adjustWeights(reliabilities: DataReliability[]): Record<string, number> {
  const adjusted: Record<string, number> = { ...WEIGHTS };

  // 各ファクターの有効重み = 基本重み × reliability
  let totalEffective = 0;
  let totalBase = 0;
  for (const { factor, reliability } of reliabilities) {
    const base = WEIGHTS[factor as keyof typeof WEIGHTS] || 0;
    // reliability < 0.3 のファクターは重みを大きく減らす
    const effective = base * Math.max(0.2, reliability);
    adjusted[factor] = effective;
    totalEffective += effective;
    totalBase += base;
  }

  // 残った重みを reliability >= 0.5 のファクターに比例配分
  if (totalEffective < totalBase * 0.99) {
    const surplus = totalBase - totalEffective;
    const reliableFactors = reliabilities.filter(r => r.reliability >= 0.5);
    const reliableTotal = reliableFactors.reduce((s, r) =>
      s + (WEIGHTS[r.factor as keyof typeof WEIGHTS] || 0), 0);

    if (reliableTotal > 0) {
      for (const { factor } of reliableFactors) {
        const base = WEIGHTS[factor as keyof typeof WEIGHTS] || 0;
        adjusted[factor] += surplus * (base / reliableTotal);
      }
    }
  }

  return adjusted;
}

// 脚質
type RunningStyle = '逃げ' | '先行' | '差し' | '追込' | '不明';

interface HorseAnalysisInput {
  entry: RaceEntry;
  pastPerformances: PastPerformance[];
  jockeyWinRate: number;
  jockeyPlaceRate: number;
  fatherName: string;
  trainerWinRate?: number;
  trainerPlaceRate?: number;
  sireTrackWinRate?: number;
  jockeyDistanceWinRate?: number;
  jockeyCourseWinRate?: number;
}

interface ScoredHorse {
  entry: RaceEntry;
  totalScore: number;
  scores: Record<string, number>;
  reasons: string[];
  runningStyle: RunningStyle;
  fatherName: string;
}

export async function generatePrediction(
  raceId: string,
  raceName: string,
  date: string,
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition | undefined,
  racecourseName: string,
  grade: string | undefined,
  horses: HorseAnalysisInput[],
  weather?: string,
): Promise<Prediction> {
  const cond = trackCondition || '良';
  const month = new Date(date).getMonth() + 1;

  // 統計コンテキストを構築（1レースにつき1回）
  const ctx = await buildRaceContext(
    racecourseName, trackType, distance, month,
    horses.map(h => ({
      horseId: h.entry.horseId,
      fatherName: h.fatherName,
      jockeyId: h.entry.jockeyId,
      trainerName: h.entry.trainerName,
    })),
  );

  // 平均斤量を算出（斤量ファクター用）
  const avgHandicapWeight = horses.length > 0
    ? horses.reduce((sum, h) => sum + (h.entry.handicapWeight || 55), 0) / horses.length
    : 55;

  // 各馬をスコアリング
  const scoredHorses = horses.map(h =>
    scoreHorse(h, trackType, distance, cond, racecourseName, grade, horses.length, ctx, month, avgHandicapWeight)
  );

  // 展開予想から脚質ボーナスを付与
  applyPaceBonus(scoredHorses, distance);

  // 当日馬場バイアスを反映（同場・同日・同トラックの完走レースから推定）
  const todayBias = await calculateTodayTrackBias(racecourseName, date, trackType);
  if (todayBias) {
    applyTodayTrackBias(scoredHorses, todayBias, horses.length);
  }

  // スコア順にソート
  scoredHorses.sort((a, b) => b.totalScore - a.totalScore);

  // --- ML推論によるスコアブレンド ---
  const horseInputMap = new Map(horses.map(h => [h.entry.horseNumber, h]));
  const mlInputs: MLHorseInput[] = scoredHorses.map(sh => {
    const input = horseInputMap.get(sh.entry.horseNumber);
    return {
      horseNumber: sh.entry.horseNumber,
      features: buildMLFeatures(
        Object.fromEntries(
          Object.entries(sh.scores).filter(([k]) => !k.startsWith('_'))
        ),
        {
          fieldSize: horses.length,
          odds: sh.entry.odds,
          popularity: sh.entry.popularity,
          age: sh.entry.age,
          sex: sh.entry.sex,
          handicapWeight: sh.entry.handicapWeight,
          postPosition: sh.entry.postPosition,
          grade,
          trackType,
          distance,
          trackCondition: cond,
          weather,
          weightChange: sh.entry.result?.weightChange != null
            ? sh.entry.result.weightChange
            : undefined,
          trainerWinRate: input?.trainerWinRate,
          trainerPlaceRate: input?.trainerPlaceRate,
          sireTrackWinRate: input?.sireTrackWinRate,
          jockeyDistanceWinRate: input?.jockeyDistanceWinRate,
          jockeyCourseWinRate: input?.jockeyCourseWinRate,
        },
      ),
    };
  });

  const mlPredictions = await callMLPredict(mlInputs);

  if (mlPredictions) {
    const ML_BLEND_WEIGHT = parseFloat(process.env.ML_BLEND_WEIGHT || '0.40');
    for (const sh of scoredHorses) {
      const ml = mlPredictions[sh.entry.horseNumber];
      if (ml) {
        sh.totalScore = sh.totalScore * (1 - ML_BLEND_WEIGHT) + ml.winProb * 100 * ML_BLEND_WEIGHT;
      }
    }
    scoredHorses.sort((a, b) => b.totalScore - a.totalScore);
  }
  // --- ML推論ここまで ---

  // トップピック生成
  const topPicks: PredictionPick[] = scoredHorses.slice(0, 6).map((sh, idx) => ({
    rank: idx + 1,
    horseId: sh.entry.horseId,
    horseNumber: sh.entry.horseNumber,
    horseName: sh.entry.horseName,
    score: Math.round(sh.totalScore * 100) / 100,
    reasons: sh.reasons,
  }));

  // レース分析（当日バイアスも含める）
  const analysis = analyzeRace(scoredHorses, trackType, distance, cond, racecourseName, ctx, todayBias);

  // キャリブレーション用: 全馬のファクタースコアを analysis に格納
  // (horse_number -> { factor: score })
  const horseScores: Record<number, Record<string, number>> = {};
  for (const sh of scoredHorses) {
    const factorScores: Record<string, number> = {};
    for (const [key, value] of Object.entries(sh.scores)) {
      if (!key.startsWith('_')) {
        factorScores[key] = Math.round(value * 100) / 100;
      }
    }
    horseScores[sh.entry.horseNumber] = factorScores;
  }
  // ML確率もhorseScoresに保存（学習データエクスポート用）
  if (mlPredictions) {
    for (const sh of scoredHorses) {
      const ml = mlPredictions[sh.entry.horseNumber];
      if (ml) {
        horseScores[sh.entry.horseNumber].mlWinProb = Math.round(ml.winProb * 10000) / 10000;
        horseScores[sh.entry.horseNumber].mlPlaceProb = Math.round(ml.placeProb * 10000) / 10000;
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (analysis as any).horseScores = horseScores;

  // 信頼度算出
  const confidence = calculateConfidence(scoredHorses, ctx);

  // 推奨馬券
  const recommendedBets = generateBetRecommendations(scoredHorses, confidence);

  // サマリー生成
  const summary = generateSummary(topPicks, analysis, raceName, confidence);

  const rawPrediction: Prediction = {
    raceId,
    raceName,
    date,
    generatedAt: new Date().toISOString(),
    confidence,
    summary,
    topPicks,
    analysis,
    recommendedBets,
  };

  // Gemini による分析テキスト強化（APIキー未設定時やエラー時はそのまま返却）
  const geminiCtx: GeminiRaceContext = {
    trackType,
    distance,
    trackCondition: cond,
    racecourseName,
    grade,
    horseScores: scoredHorses.slice(0, 6).map(sh => ({
      horseName: sh.entry.horseName,
      horseNumber: sh.entry.horseNumber,
      totalScore: sh.totalScore,
      factorScores: Object.fromEntries(
        Object.entries(sh.scores).filter(([k]) => !k.startsWith('_'))
      ),
      runningStyle: sh.runningStyle,
      fatherName: sh.fatherName,
    })),
  };

  return enhancePredictionWithGemini(rawPrediction, geminiCtx);
}

// ==================== メインスコアリング ====================

function scoreHorse(
  input: HorseAnalysisInput,
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition,
  racecourseName: string,
  grade: string | undefined,
  fieldSize: number,
  ctx: RaceHistoricalContext,
  month: number,
  avgHandicapWeight: number,
): ScoredHorse {
  const { entry, pastPerformances: pp, jockeyWinRate, jockeyPlaceRate, fatherName } = input;
  const reasons: string[] = [];
  const scores: Record<string, number> = {};

  // 脚質判定
  const runStyle = detectRunningStyle(pp);

  // ==================== 個体分析 ====================

  // 1. 直近成績 (0-100)
  scores.recentForm = calcRecentFormScore(pp);
  if (scores.recentForm >= 75) reasons.push(`直近成績が優秀（スコア${Math.round(scores.recentForm)}）`);
  else if (scores.recentForm >= 60) reasons.push('直近の調子は悪くない');
  else if (scores.recentForm <= 30) reasons.push('直近成績が低調');

  // 2. コース適性 (0-100)
  scores.courseAptitude = calcCourseAptitude(pp, racecourseName);
  if (scores.courseAptitude >= 75) reasons.push(`${racecourseName}コースで好成績`);
  else if (scores.courseAptitude <= 35) reasons.push(`${racecourseName}コースは未経験or苦手`);

  // 3. 距離適性 (0-100)
  scores.distanceAptitude = calcDistanceAptitude(pp, distance);
  if (scores.distanceAptitude >= 75) reasons.push(`${distance}m前後がベスト距離`);
  else if (scores.distanceAptitude <= 35) reasons.push('距離適性に不安');

  // 4. 馬場状態適性 (0-100)
  scores.trackConditionAptitude = calcTrackConditionAptitude(pp, trackType, trackCondition);
  if (scores.trackConditionAptitude >= 75 && (trackCondition === '重' || trackCondition === '不良')) {
    reasons.push('道悪巧者、重馬場で成績上昇');
  }

  // 5. 騎手能力 (0-100)
  scores.jockeyAbility = calcJockeyScore(jockeyWinRate, jockeyPlaceRate);
  if (scores.jockeyAbility >= 75) reasons.push(`騎手${entry.jockeyName}は勝率トップクラス`);

  // 6. スピード指数 (0-100)
  scores.speedRating = calcSpeedRating(pp, trackType, distance);
  if (scores.speedRating >= 75) reasons.push('高水準のスピード指数を記録');

  // 7. クラス実績 (0-100)
  scores.classPerformance = calcClassPerformance(pp, grade);
  if (scores.classPerformance >= 75) reasons.push('重賞レベルで好走実績あり');

  // 8. 脚質適性 (0-100)
  scores.runningStyle = calcRunningStyleBase(runStyle, distance);
  if (runStyle === '逃げ' && distance <= 1400) reasons.push('逃げ馬で短距離向き');
  if (runStyle === '差し' && distance >= 1800) reasons.push('差し脚質で中長距離向き');
  if (runStyle === '追込' && distance >= 2000) reasons.push('追込で展開次第で一発あり');

  // 9. 枠順分析 (0-100)
  scores.postPositionBias = calcPostPositionBias(entry.postPosition, fieldSize, distance, trackType, racecourseName);
  if (scores.postPositionBias >= 75) reasons.push('枠順が有利');
  else if (scores.postPositionBias <= 30) reasons.push('外枠で不利');

  // 10. ローテーション (0-100)
  scores.rotation = calcRotation(pp);
  if (scores.rotation >= 75) reasons.push('理想的なローテーション');
  else if (scores.rotation <= 30) reasons.push('間隔が空きすぎorタイトすぎ');

  // 11. 上がり3F (0-100)
  scores.lastThreeFurlongs = calcLastThreeFurlongs(pp, trackType);
  if (scores.lastThreeFurlongs >= 80) reasons.push('末脚が鋭く上がり最速級');
  else if (scores.lastThreeFurlongs >= 65) reasons.push('末脚はまずまず');

  // 12. 安定性 (0-100)
  scores.consistency = calcConsistency(pp);
  if (scores.consistency >= 75) reasons.push('着順が安定しており堅実');
  else if (scores.consistency <= 30) reasons.push('ムラのある走りで計算しづらい');

  // ==================== 統計ベース分析 (v3) ====================

  // 13. 血統適性 (0-100)
  const sireStats = ctx.sireStatsMap.get(fatherName);
  scores.sireAptitude = calcSireAptitudeScore(sireStats, trackType, distance, trackCondition);
  if (sireStats && scores.sireAptitude >= 70) {
    const trackLabel = trackType === '芝' ? '芝' : 'ダート';
    reasons.push(`父${fatherName}産駒は${trackLabel}${distance}m適性が高い（統計）`);
  } else if (sireStats && scores.sireAptitude <= 35) {
    reasons.push(`父${fatherName}産駒のこの条件成績は低調（統計）`);
  }

  // 14. 調教師能力 (0-100)
  const trainerStats = ctx.trainerStatsMap.get(entry.trainerName);
  scores.trainerAbility = calcTrainerAbilityScore(trainerStats, trackType);
  if (trainerStats && trainerStats.totalRaces >= 20) {
    if (scores.trainerAbility >= 70) {
      reasons.push(`${entry.trainerName}厩舎は高勝率（${(trainerStats.winRate * 100).toFixed(1)}%）`);
    } else if (scores.trainerAbility <= 35) {
      reasons.push(`${entry.trainerName}厩舎の勝率は低調`);
    }
  }

  // 15. 騎手×調教師コンボ (0-100)
  const comboKey = `${entry.jockeyId}__${entry.trainerName}`;
  const combo = ctx.jockeyTrainerMap.get(comboKey);
  scores.jockeyTrainerCombo = calcJockeyTrainerScore(combo);
  if (combo && combo.totalRaces >= 5 && scores.jockeyTrainerCombo >= 70) {
    reasons.push(`${entry.jockeyName}×${entry.trainerName}コンビ好相性（勝率${Math.round(combo.winRate * 100)}%）`);
  }

  // 16. 統計的枠順バイアス (0-100)
  scores.historicalPostBias = calcHistoricalPostBias(ctx.courseDistStats, entry.postPosition);
  if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 30) {
    if (scores.historicalPostBias >= 70) reasons.push(`${racecourseName}${distance}mでこの枠は統計的に好成績`);
    else if (scores.historicalPostBias <= 35) reasons.push(`${racecourseName}${distance}mでこの枠は統計的に不利`);
  }

  // 17. 季節パターン (0-100)
  const seasonal = ctx.seasonalMap.get(entry.horseId);
  scores.seasonalPattern = calcSeasonalScore(seasonal, month);
  if (seasonal && scores.seasonalPattern >= 70) {
    reasons.push(`${month}月の成績が良い（季節パターン）`);
  } else if (seasonal && scores.seasonalPattern <= 35) {
    reasons.push(`${month}月は成績が振るわない傾向`);
  }

  // 18. 斤量（ハンデ）アドバンテージ (0-100)
  // レース出走馬の平均斤量との差分をスコア化（軽い=有利）
  // 55kg基準、±2kgで±15点程度のスケール
  {
    const weight = entry.handicapWeight || 55;
    const diff = avgHandicapWeight - weight; // 正=平均より軽い=有利
    // ±4kgで0-100にスケール (中央50)
    scores.handicapAdvantage = Math.max(0, Math.min(100, 50 + diff * 7.5));
    if (diff >= 1.5) reasons.push(`斤量${weight}kgで軽量有利（平均${avgHandicapWeight.toFixed(1)}kg）`);
    else if (diff <= -2) reasons.push(`斤量${weight}kgでトップハンデ不利`);
  }

  // 叩き良化ボーナス（ローテーションスコアに加算）
  const secondStartBonus = ctx.secondStartMap.get(entry.horseId);
  if (secondStartBonus && pp.length >= 2) {
    const lastDate = pp[0]?.date;
    const prevDate = pp[1]?.date;
    if (lastDate && prevDate) {
      const daysSinceLast = Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24));
      const daysBetweenLastTwo = Math.floor((new Date(lastDate).getTime() - new Date(prevDate).getTime()) / (1000 * 60 * 60 * 24));
      const isSecondStart = daysBetweenLastTwo >= 60 && daysSinceLast <= 42;
      const bonus = calcSecondStartScore(secondStartBonus, daysSinceLast, isSecondStart);
      if (isSecondStart && bonus > 55) {
        scores.rotation = Math.min(100, scores.rotation + (bonus - 50) * 0.5);
        reasons.push('叩き2走目で良化パターン（統計）');
      }
    }
  }

  // ==================== v4: ベイズ推定 + 動的ウェイト ====================

  // 各ファクターのデータ充実度を計算
  const reliabilities: DataReliability[] = [];
  const countCourse = pp.filter(p => p.racecourseName === racecourseName).length;
  const countDistWide = pp.filter(p => Math.abs(p.distance - distance) <= 400).length;
  const countTrackCond = pp.filter(p => p.trackType === trackType).length;
  const countSpeedRelevant = pp.filter(p => p.trackType === trackType && Math.abs(p.distance - distance) <= 200 && p.time).length;
  const countGrade = pp.filter(p => p.raceName.includes('G1') || p.raceName.includes('G2') || p.raceName.includes('G3') || p.raceName.includes('ステークス')).length;
  const countL3F = pp.slice(0, 15).filter(p => p.lastThreeFurlongs && parseFloat(p.lastThreeFurlongs) > 0).length;

  const jtComboKey = `${entry.jockeyId}__${entry.trainerName}`;
  const comboData = ctx.jockeyTrainerMap.get(jtComboKey);
  const sireData = ctx.sireStatsMap.get(fatherName);
  const seasonalData = ctx.seasonalMap.get(entry.horseId);

  reliabilities.push(
    { factor: 'recentForm', reliability: calcFactorReliability('recentForm', pp.length), dataPoints: pp.length },
    { factor: 'courseAptitude', reliability: calcFactorReliability('courseAptitude', countCourse), dataPoints: countCourse },
    { factor: 'distanceAptitude', reliability: calcFactorReliability('distanceAptitude', countDistWide), dataPoints: countDistWide },
    { factor: 'trackConditionAptitude', reliability: calcFactorReliability('trackConditionAptitude', countTrackCond), dataPoints: countTrackCond },
    { factor: 'jockeyAbility', reliability: jockeyWinRate > 0 ? 1.0 : 0.0, dataPoints: jockeyWinRate > 0 ? 1 : 0 },
    { factor: 'speedRating', reliability: calcFactorReliability('speedRating', countSpeedRelevant), dataPoints: countSpeedRelevant },
    { factor: 'classPerformance', reliability: calcFactorReliability('classPerformance', countGrade), dataPoints: countGrade },
    { factor: 'runningStyle', reliability: calcFactorReliability('runningStyle', pp.length), dataPoints: pp.length },
    { factor: 'postPositionBias', reliability: 1.0, dataPoints: 1 },
    { factor: 'rotation', reliability: pp.length > 0 ? 1.0 : 0.0, dataPoints: pp.length > 0 ? 1 : 0 },
    { factor: 'lastThreeFurlongs', reliability: calcFactorReliability('lastThreeFurlongs', countL3F), dataPoints: countL3F },
    { factor: 'consistency', reliability: calcFactorReliability('consistency', pp.length), dataPoints: pp.length },
    { factor: 'sireAptitude', reliability: calcFactorReliability('sireAptitude', sireData?.totalRaces || 0), dataPoints: sireData?.totalRaces || 0 },
    { factor: 'trainerAbility', reliability: calcFactorReliability('trainerAbility', trainerStats?.totalRaces || 0), dataPoints: trainerStats?.totalRaces || 0 },
    { factor: 'jockeyTrainerCombo', reliability: calcFactorReliability('jockeyTrainerCombo', comboData?.totalRaces || 0), dataPoints: comboData?.totalRaces || 0 },
    { factor: 'historicalPostBias', reliability: calcFactorReliability('historicalPostBias', ctx.courseDistStats?.totalRaces || 0), dataPoints: ctx.courseDistStats?.totalRaces || 0 },
    { factor: 'seasonalPattern', reliability: calcFactorReliability('seasonalPattern', seasonalData?.reduce((s, m) => s + m.races, 0) || 0), dataPoints: seasonalData?.reduce((s, m) => s + m.races, 0) || 0 },
    { factor: 'handicapAdvantage', reliability: 1.0, dataPoints: 1 },
  );

  // ベイズ推定でスコアを補正
  for (const rel of reliabilities) {
    const raw = scores[rel.factor];
    if (raw !== undefined) {
      const { score: bayesian } = bayesianScore(rel.factor, raw, rel.dataPoints);
      scores[rel.factor] = bayesian;
    }
  }

  // 動的ウェイト調整
  const dynWeights = adjustWeights(reliabilities);

  // 総合スコア (動的ウェイト使用)
  let totalScore = 0;
  for (const [key, weight] of Object.entries(dynWeights)) {
    totalScore += (scores[key] || 50) * weight;
  }

  if (reasons.length === 0) reasons.push('特筆すべき要素なし');

  // データ充実度を記録 (信頼度計算で使用)
  const avgReliability = reliabilities.reduce((s, r) => s + r.reliability, 0) / reliabilities.length;
  scores._dataReliability = avgReliability * 100;
  scores._totalDataPoints = reliabilities.reduce((s, r) => s + r.dataPoints, 0);

  return { entry, totalScore, scores, reasons, runningStyle: runStyle, fatherName };
}

// ==================== 脚質判定 ====================

function detectRunningStyle(pp: PastPerformance[]): RunningStyle {
  if (pp.length === 0) return '不明';

  const recent = pp.slice(0, 15);
  let escapeCount = 0;
  let frontCount = 0;
  let stalkerCount = 0;
  let closerCount = 0;

  for (const perf of recent) {
    if (!perf.cornerPositions) continue;
    const corners = perf.cornerPositions.split('-').map(Number).filter(n => !isNaN(n));
    if (corners.length === 0) continue;

    const firstCorner = corners[0];

    // entries フィールドが不正（枠番が入っている場合がある）のため、
    // コーナー通過順の最大値からフィールドサイズを推定
    const maxCorner = Math.max(...corners);
    const estimatedFieldSize = Math.max(maxCorner + 2, perf.entries || 0, 8);
    const ratio = firstCorner / estimatedFieldSize;

    if (ratio <= 0.15) escapeCount++;       // 先頭〜15% = 逃げ
    else if (ratio <= 0.35) frontCount++;   // 〜35% = 先行
    else if (ratio <= 0.65) stalkerCount++; // 〜65% = 差し
    else closerCount++;                     // 後方   = 追込
  }

  const total = escapeCount + frontCount + stalkerCount + closerCount;
  if (total === 0) return '不明';

  if (escapeCount / total >= 0.4) return '逃げ';
  if (frontCount / total >= 0.4) return '先行';
  if ((escapeCount + frontCount) / total >= 0.6) return '先行';
  if (closerCount / total >= 0.4) return '追込';
  return '差し';
}

function calcRunningStyleBase(style: RunningStyle, distance: number): number {
  if (style === '不明') return 50;

  if (distance <= 1200) {
    if (style === '逃げ') return 75;
    if (style === '先行') return 70;
    if (style === '差し') return 50;
    return 35;
  }
  if (distance <= 1600) {
    if (style === '逃げ') return 65;
    if (style === '先行') return 70;
    if (style === '差し') return 65;
    return 45;
  }
  if (distance <= 2200) {
    if (style === '逃げ') return 55;
    if (style === '先行') return 65;
    if (style === '差し') return 70;
    return 55;
  }
  if (style === '逃げ') return 50;
  if (style === '先行') return 60;
  if (style === '差し') return 70;
  return 65;
}

// ==================== 展開予想ボーナス ====================

function applyPaceBonus(horses: ScoredHorse[], distance: number): void {
  const escapers = horses.filter(h => h.runningStyle === '逃げ').length;
  const frontRunners = horses.filter(h => h.runningStyle === '先行').length;
  const forwardTotal = escapers + frontRunners;

  let paceType: 'ハイ' | 'ミドル' | 'スロー';
  if (forwardTotal >= Math.ceil(horses.length * 0.5)) {
    paceType = 'ハイ';
  } else if (forwardTotal <= Math.floor(horses.length * 0.25)) {
    paceType = 'スロー';
  } else {
    paceType = 'ミドル';
  }

  const bonus: Record<RunningStyle, number> = {
    '逃げ': 0, '先行': 0, '差し': 0, '追込': 0, '不明': 0,
  };

  if (paceType === 'ハイ') {
    bonus['逃げ'] = -4;
    bonus['先行'] = -2;
    bonus['差し'] = 3;
    bonus['追込'] = 5;
  } else if (paceType === 'スロー') {
    bonus['逃げ'] = escapers <= 1 ? 6 : 3;
    bonus['先行'] = 3;
    bonus['差し'] = -2;
    bonus['追込'] = -5;
  }

  const distFactor = distance <= 1400 ? 1.3 : distance <= 1800 ? 1.0 : 0.8;

  for (const horse of horses) {
    const b = (bonus[horse.runningStyle] || 0) * distFactor;
    horse.totalScore += b;
    if (b >= 3) {
      horse.reasons.push(`展開利あり（${paceType}ペースで${horse.runningStyle}有利）`);
    } else if (b <= -3) {
      horse.reasons.push(`展開不利（${paceType}ペースで${horse.runningStyle}不利）`);
    }
  }
}

// ==================== 当日馬場バイアス調整 ====================

/**
 * 同日・同場の完走レースから得た馬場バイアスをスコアに反映する。
 *
 * 最大調整幅: ±4点（枠順 ±2 + 脚質 ±2）
 * バイアス値(±1) × 信頼度(0-1) × 係数(2) でスケール。
 */
function applyTodayTrackBias(
  horses: ScoredHorse[],
  bias: TodayTrackBias,
  fieldSize: number,
): void {
  const midPoint = Math.ceil(fieldSize / 2);
  const SCALE = 2; // 最大 ±2点/要素

  for (const horse of horses) {
    let adjustment = 0;
    const reasons: string[] = [];

    // 枠順バイアス
    const isInner = horse.entry.postPosition <= midPoint;
    if (Math.abs(bias.innerAdvantage) > 0.15) {
      const match = (isInner && bias.innerAdvantage > 0) || (!isInner && bias.innerAdvantage < 0);
      const postAdj = Math.abs(bias.innerAdvantage) * bias.confidence * SCALE * (match ? 1 : -1);
      adjustment += postAdj;
      if (Math.abs(postAdj) >= 0.5) {
        reasons.push(match ? '本日の枠順バイアス有利' : '本日の枠順バイアス不利');
      }
    }

    // 脚質バイアス
    if (Math.abs(bias.frontRunnerAdvantage) > 0.15) {
      const isFront = horse.runningStyle === '逃げ' || horse.runningStyle === '先行';
      const isBack = horse.runningStyle === '差し' || horse.runningStyle === '追込';
      if (isFront || isBack) {
        const match = (isFront && bias.frontRunnerAdvantage > 0) || (isBack && bias.frontRunnerAdvantage < 0);
        const styleAdj = Math.abs(bias.frontRunnerAdvantage) * bias.confidence * SCALE * (match ? 1 : -1);
        adjustment += styleAdj;
        if (Math.abs(styleAdj) >= 0.5) {
          reasons.push(match ? '本日の馬場で脚質有利' : '本日の馬場で脚質不利');
        }
      }
    }

    horse.totalScore += adjustment;
    horse.reasons.push(...reasons);
  }
}

// ==================== 個別スコア計算 ====================

function calcRecentFormScore(pp: PastPerformance[]): number {
  if (pp.length === 0) return 40;
  const recent = pp.slice(0, 5);
  let score = 0;
  const weights = [0.35, 0.25, 0.20, 0.12, 0.08];

  recent.forEach((perf, idx) => {
    const w = weights[idx] || 0.05;
    const posScore = positionToScore(perf.position, perf.entries || 16);
    score += posScore * w;
  });

  const winStreak = countWinStreak(pp);
  if (winStreak >= 3) score += 10;
  else if (winStreak >= 2) score += 5;

  if (pp.length >= 2 && pp[0].position <= 3 && pp[1].position >= 8) {
    score += 3;
  }

  return Math.min(100, score);
}

function countWinStreak(pp: PastPerformance[]): number {
  let streak = 0;
  for (const perf of pp) {
    if (perf.position === 1) streak++;
    else break;
  }
  return streak;
}

function calcCourseAptitude(pp: PastPerformance[], racecourseName: string): number {
  const courseRaces = pp.filter(p => p.racecourseName === racecourseName);
  if (courseRaces.length === 0) return 50;

  const avgRatio = courseRaces.reduce((sum, p) => {
    return sum + p.position / (p.entries || 16);
  }, 0) / courseRaces.length;

  const wins = courseRaces.filter(p => p.position === 1).length;
  const winBonus = wins > 0 ? Math.min(15, wins * 5) : 0;

  return Math.min(100, ratioToScore(avgRatio) + winBonus);
}

function calcDistanceAptitude(pp: PastPerformance[], targetDistance: number): number {
  if (pp.length === 0) return 50;

  const exact = pp.filter(p => Math.abs(p.distance - targetDistance) <= 100);
  const near = pp.filter(p => Math.abs(p.distance - targetDistance) <= 200);
  const wide = pp.filter(p => Math.abs(p.distance - targetDistance) <= 400);

  if (wide.length === 0) return 35;

  let score = 0;
  let totalWeight = 0;

  if (exact.length > 0) {
    const avgRatio = exact.reduce((s, p) => s + p.position / (p.entries || 16), 0) / exact.length;
    score += ratioToScore(avgRatio) * 3;
    totalWeight += 3;
  }
  if (near.length > 0) {
    const avgRatio = near.reduce((s, p) => s + p.position / (p.entries || 16), 0) / near.length;
    score += ratioToScore(avgRatio) * 2;
    totalWeight += 2;
  }
  if (wide.length > 0) {
    const avgRatio = wide.reduce((s, p) => s + p.position / (p.entries || 16), 0) / wide.length;
    score += ratioToScore(avgRatio) * 1;
    totalWeight += 1;
  }

  return totalWeight > 0 ? Math.min(100, score / totalWeight) : 50;
}

function calcTrackConditionAptitude(pp: PastPerformance[], trackType: TrackType, condition: TrackCondition): number {
  const relevantRaces = pp.filter(p => p.trackType === trackType);
  if (relevantRaces.length === 0) return 50;

  const sameCondition = relevantRaces.filter(p => p.trackCondition === condition);
  const isHeavy = condition === '重' || condition === '不良';
  const heavyRaces = relevantRaces.filter(p => p.trackCondition === '重' || p.trackCondition === '不良');

  const targetRaces = sameCondition.length >= 2 ? sameCondition : (isHeavy ? heavyRaces : relevantRaces.filter(p => p.trackCondition === '良' || p.trackCondition === '稍重'));

  if (targetRaces.length === 0) {
    return isHeavy ? 40 : 50;
  }

  const avgRatio = targetRaces.reduce((s, p) => s + p.position / (p.entries || 16), 0) / targetRaces.length;
  return ratioToScore(avgRatio);
}

function calcJockeyScore(winRate: number, placeRate: number): number {
  const score = (winRate * 100) * 2.5 + (placeRate * 100) * 1.2;
  return Math.min(100, Math.max(10, score));
}

function calcSpeedRating(pp: PastPerformance[], trackType: TrackType, distance: number): number {
  if (pp.length === 0) return 50;

  const relevantRaces = pp.filter(p =>
    p.trackType === trackType &&
    Math.abs(p.distance - distance) <= 200 &&
    p.time
  );

  if (relevantRaces.length === 0) return 50;

  const standardTimes: Record<string, Record<number, number>> = {
    '芝': { 1000: 56.0, 1200: 69.0, 1400: 82.0, 1600: 95.0, 1800: 108.5, 2000: 121.0, 2200: 134.0, 2400: 147.0, 2500: 153.0, 3000: 183.0, 3200: 196.0, 3600: 222.0 },
    'ダート': { 1000: 59.0, 1200: 72.0, 1400: 84.0, 1600: 97.0, 1700: 104.0, 1800: 111.0, 2000: 125.0, 2100: 131.0 },
    '障害': { 3000: 210.0, 3200: 225.0, 3300: 232.0, 3570: 252.0, 3930: 280.0, 4250: 305.0 },
  };

  const ratings = relevantRaces.map(p => {
    const seconds = timeToSeconds(p.time);
    if (seconds <= 0) return 0;

    const stdTime = interpolateStandardTime(standardTimes[trackType] || {}, p.distance);
    if (stdTime <= 0) return 50;

    const condAdj = getConditionAdjustment(p.trackCondition, trackType);
    const timeDiff = stdTime - seconds;
    const rating = 50 + timeDiff * (1000 / p.distance) * 20 + condAdj;

    return Math.max(0, Math.min(100, rating));
  }).filter(r => r > 0);

  if (ratings.length === 0) return 50;

  ratings.sort((a, b) => b - a);
  const top3 = ratings.slice(0, 3);
  return top3.reduce((s, r) => s + r, 0) / top3.length;
}

function interpolateStandardTime(table: Record<number, number>, distance: number): number {
  const distances = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (distances.length === 0) return 0;

  if (table[distance] !== undefined) return table[distance];

  if (distance <= distances[0]) return table[distances[0]] * (distance / distances[0]);
  if (distance >= distances[distances.length - 1]) {
    const last = distances[distances.length - 1];
    return table[last] * (distance / last);
  }

  for (let i = 0; i < distances.length - 1; i++) {
    if (distance >= distances[i] && distance <= distances[i + 1]) {
      const ratio = (distance - distances[i]) / (distances[i + 1] - distances[i]);
      return table[distances[i]] + (table[distances[i + 1]] - table[distances[i]]) * ratio;
    }
  }
  return 0;
}

function getConditionAdjustment(condition: TrackCondition | string, trackType: TrackType): number {
  if (trackType === '芝') {
    if (condition === '重') return 3;
    if (condition === '不良') return 5;
    if (condition === '稍重') return 1;
  } else {
    if (condition === '重') return 2;
    if (condition === '不良') return 4;
    if (condition === '稍重') return 1;
  }
  return 0;
}

function calcClassPerformance(pp: PastPerformance[], _grade: string | undefined): number {
  if (pp.length === 0) return 50;

  const gradeRaces = pp.filter(p =>
    p.raceName.includes('G1') || p.raceName.includes('G2') || p.raceName.includes('G3') ||
    p.raceName.includes('ステークス') || p.raceName.includes('賞') || p.raceName.includes('カップ')
  );

  if (gradeRaces.length === 0) return 45;

  const topFinishes = gradeRaces.filter(p => p.position <= 3).length;
  const ratio = topFinishes / gradeRaces.length;

  if (ratio >= 0.5) return 90;
  if (ratio >= 0.3) return 75;
  if (ratio >= 0.15) return 60;
  return 40;
}

function calcPostPositionBias(post: number, fieldSize: number, distance: number, trackType: TrackType, racecourseName: string): number {
  if (fieldSize === 0) return 50;

  const posRatio = post / Math.ceil(fieldSize / 2);

  const biasMap: Record<string, Record<string, number>> = {
    '東京': { '芝_inner': 60, '芝_outer': 50, 'ダート_inner': 55, 'ダート_outer': 50 },
    '中山': { '芝_inner': 70, '芝_outer': 40, 'ダート_inner': 65, 'ダート_outer': 45 },
    '阪神': { '芝_inner': 55, '芝_outer': 55, 'ダート_inner': 60, 'ダート_outer': 50 },
    '京都': { '芝_inner': 60, '芝_outer': 50, 'ダート_inner': 55, 'ダート_outer': 50 },
    '小倉': { '芝_inner': 70, '芝_outer': 35, 'ダート_inner': 65, 'ダート_outer': 40 },
    '大井': { 'ダート_inner': 65, 'ダート_outer': 45 },
    '川崎': { 'ダート_inner': 70, 'ダート_outer': 35 },
    '船橋': { 'ダート_inner': 65, 'ダート_outer': 40 },
    '浦和': { 'ダート_inner': 70, 'ダート_outer': 35 },
  };

  const isInner = posRatio <= 1.0;
  const key = `${trackType}_${isInner ? 'inner' : 'outer'}`;
  const courseBias = biasMap[racecourseName]?.[key];

  if (courseBias !== undefined) {
    const distFactor = distance <= 1400 ? 1.2 : distance >= 2400 ? 0.7 : 1.0;
    return Math.min(100, Math.max(10, courseBias * distFactor));
  }

  return isInner ? 55 : 48;
}

function calcRotation(pp: PastPerformance[]): number {
  if (pp.length === 0) return 50;

  const lastDate = pp[0].date;
  if (!lastDate) return 50;

  const lastRaceDate = new Date(lastDate);
  const today = new Date();
  const daysSinceLast = Math.floor((today.getTime() - lastRaceDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysSinceLast < 10) return 25;
  if (daysSinceLast < 14) return 45;
  if (daysSinceLast < 21) return 60;
  if (daysSinceLast <= 35) return 80;
  if (daysSinceLast <= 56) return 75;
  if (daysSinceLast <= 84) return 60;
  if (daysSinceLast <= 120) return 45;
  if (daysSinceLast <= 180) return 35;
  return 20;
}

function calcLastThreeFurlongs(pp: PastPerformance[], trackType: TrackType): number {
  if (pp.length === 0) return 50;

  const recent = pp.slice(0, 15);
  const times: number[] = [];

  for (const perf of recent) {
    const l3f = perf.lastThreeFurlongs;
    if (!l3f) continue;
    const t = parseFloat(l3f);
    if (t > 0 && t < 50) times.push(t);
  }

  if (times.length === 0) return 50;

  const best = Math.min(...times);
  const recentAvg = times.slice(0, 3).reduce((s, t) => s + t, 0) / Math.min(3, times.length);

  const baseline = trackType === '芝' ? 34.5 : 36.5;

  const bestDiff = baseline - best;
  const avgDiff = baseline - recentAvg;

  const bestScore = 50 + bestDiff * 10;
  const avgScore = 50 + avgDiff * 8;

  return Math.min(100, Math.max(10, bestScore * 0.5 + avgScore * 0.5));
}

function calcConsistency(pp: PastPerformance[]): number {
  if (pp.length < 3) return 50;

  const recent = pp.slice(0, 20);
  const ratios = recent.map(p => p.position / (p.entries || 16));

  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const variance = ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev <= 0.10) return 90;
  if (stdDev <= 0.15) return 75;
  if (stdDev <= 0.20) return 60;
  if (stdDev <= 0.30) return 45;
  return 30;
}

// ==================== レース分析 ====================

function analyzeRace(
  scoredHorses: ScoredHorse[],
  trackType: TrackType,
  distance: number,
  condition: TrackCondition,
  racecourseName: string,
  ctx: RaceHistoricalContext,
  todayBias?: TodayTrackBias | null,
): RaceAnalysis {
  let trackBias = `${racecourseName}${trackType}${distance}m`;

  const courseInfo = getCourseCharacteristics(racecourseName, trackType, distance);
  if (condition === '重' || condition === '不良') {
    trackBias += `（${condition}馬場）- ${courseInfo}。道悪で内枠有利の傾向が強まる可能性あり。パワー型の馬に注目。`;
  } else if (condition === '稍重') {
    trackBias += `（${condition}馬場）- ${courseInfo}。やや時計がかかる馬場。`;
  } else {
    trackBias += `（${condition}馬場）- ${courseInfo}。`;
  }

  // 統計情報を分析に追加
  if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 20) {
    const stats = ctx.courseDistStats;
    if (stats.frontRunnerRate >= 0.6) {
      trackBias += ` 過去データでは先行馬の勝率が高い（${Math.round(stats.frontRunnerRate * 100)}%）。`;
    } else if (stats.frontRunnerRate <= 0.3) {
      trackBias += ` 過去データでは差し・追込が決まりやすいコース。`;
    }

    if (Math.abs(stats.innerFrameWinRate - stats.outerFrameWinRate) > 0.03) {
      const biasDir = stats.innerFrameWinRate > stats.outerFrameWinRate ? '内枠' : '外枠';
      trackBias += ` 統計上は${biasDir}有利。`;
    }
  }

  // 当日バイアス（リアルタイム分析結果）
  if (todayBias) {
    trackBias += ` 【当日実績(${todayBias.sampleRaces}R分析)】${todayBias.summary}。`;
  }

  // ペース分析
  const escapers = scoredHorses.filter(h => h.runningStyle === '逃げ');
  const frontRunners = scoredHorses.filter(h => h.runningStyle === '先行');
  const stalkers = scoredHorses.filter(h => h.runningStyle === '差し');
  const closers = scoredHorses.filter(h => h.runningStyle === '追込');
  const forwardTotal = escapers.length + frontRunners.length;

  let paceAnalysis: string;
  if (forwardTotal >= Math.ceil(scoredHorses.length * 0.5)) {
    paceAnalysis = `ハイペース予想。逃げ${escapers.length}頭・先行${frontRunners.length}頭と前に行く馬が多い。前が厳しい展開で、差し・追込馬（${stalkers.length + closers.length}頭）に展開利。後方から一気の末脚を使える馬が有利。`;
  } else if (forwardTotal <= Math.floor(scoredHorses.length * 0.25)) {
    paceAnalysis = `スローペース予想。逃げ${escapers.length}頭・先行${frontRunners.length}頭と先行勢が少ない。${escapers.length <= 1 ? '逃げ馬が楽にハナを切れそうで、前残りに警戒。' : ''}上がり勝負になりやすく、瞬発力のある馬が有利。`;
  } else {
    paceAnalysis = `ミドルペース予想。脚質分布は逃げ${escapers.length}/先行${frontRunners.length}/差し${stalkers.length}/追込${closers.length}とバランスが取れている。実力通りの決着が見込まれる。`;
  }

  // キーファクター
  const keyFactors: string[] = [];
  if (distance >= 2400) keyFactors.push('長距離戦。スタミナと折り合いが鍵。父母の血統的な裏付けも重要');
  else if (distance >= 1800) keyFactors.push('中距離戦。総合力が問われる距離帯');
  else if (distance <= 1200) keyFactors.push('スプリント戦。ゲートの出と前半3Fのスピードが勝敗を左右');
  else if (distance <= 1400) keyFactors.push('短距離戦。先行力とスピードの持続力がカギ');

  if (condition === '重' || condition === '不良') keyFactors.push('道悪適性が勝敗を分ける。パワー型が台頭しやすい');

  // 血統傾向
  const sireAnalysis: string[] = [];
  for (const [sire, stats] of ctx.sireStatsMap.entries()) {
    if (stats.totalRaces >= 10) {
      const trackStats = trackType === '芝' ? stats.turfStats : stats.dirtStats;
      if (trackStats.winRate >= 0.20) {
        const horses = scoredHorses.filter(h => h.fatherName === sire);
        if (horses.length > 0) {
          sireAnalysis.push(`${sire}産駒（${horses.map(h => h.entry.horseName).join('、')}）はこの条件で好成績`);
        }
      }
    }
  }
  if (sireAnalysis.length > 0) keyFactors.push(`【血統注目】${sireAnalysis.join('。')}`);

  const fastFinishers = scoredHorses.filter(h => h.scores.lastThreeFurlongs >= 70);
  if (fastFinishers.length > 0) {
    keyFactors.push(`上がり3F上位: ${fastFinishers.slice(0, 3).map(h => h.entry.horseName).join('、')}`);
  }

  if (scoredHorses.length >= 2) {
    const gap = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
    keyFactors.push(`1位と2位のスコア差: ${Math.round(gap * 10) / 10}pt`);
  }

  // リスク要因
  const riskFactors: string[] = [];
  if (scoredHorses.length >= 2 && scoredHorses[0].totalScore - scoredHorses[1].totalScore < 3) {
    riskFactors.push('上位馬の差が極めて小さく、波乱含み');
  } else if (scoredHorses.length >= 2 && scoredHorses[0].totalScore - scoredHorses[1].totalScore < 5) {
    riskFactors.push('上位馬の差が小さく、波乱の可能性あり');
  }

  if (scoredHorses.some(sh => sh.entry.odds && sh.entry.odds <= 1.5)) {
    riskFactors.push('断然の1番人気がいるが、過信は禁物');
  }

  const longAbsence = scoredHorses.filter(h => h.scores.rotation <= 35);
  if (longAbsence.length > 0) {
    riskFactors.push(`休養明けの馬あり: ${longAbsence.map(h => h.entry.horseName).join('、')} - 仕上がり次第`);
  }

  const inconsistent = scoredHorses.slice(0, 3).filter(h => h.scores.consistency <= 40);
  if (inconsistent.length > 0) {
    riskFactors.push(`上位予想馬にムラ馬あり: ${inconsistent.map(h => h.entry.horseName).join('、')}`);
  }

  return { trackBias, paceAnalysis, keyFactors, riskFactors };
}

function getCourseCharacteristics(course: string, trackType: TrackType, distance: number): string {
  const info: Record<string, Record<string, string>> = {
    '東京': {
      '芝': '直線が長く（525m）、末脚が活きるコース。瞬発力勝負になりやすい',
      'ダート': '直線が長くスピードの持続力が問われる。差し馬も届きやすい',
    },
    '中山': {
      '芝': '直線が短く（310m）小回り急坂。先行力と坂を上るパワーが重要',
      'ダート': '小回りで先行有利。内枠の逃げ・先行馬に注意',
    },
    '阪神': {
      '芝': `${distance >= 1800 ? '外回り' : '内回り'}。急坂があり、パワーとスタミナの両立が求められる`,
      'ダート': 'コーナーがきつめで、器用さが求められる。先行有利の傾向',
    },
    '京都': {
      '芝': `${distance >= 1800 ? '外回り' : '内回り'}。平坦でスピードが活きる。瞬発力のある差し馬に注意`,
      'ダート': '平坦コースでスピード持続力が問われる',
    },
    '大井': { 'ダート': '大箱コースでスピード持続力が問われる。外回りは差しも決まる' },
    '川崎': { 'ダート': '小回りで先行有利。内枠の逃げ馬が残りやすい' },
    '船橋': { 'ダート': '直線が短く小回り。先行力が重要' },
    '浦和': { 'ダート': '最も小回りのコース。圧倒的に先行有利' },
  };

  return info[course]?.[trackType] || '標準的なコース形態';
}

// ==================== 信頼度 ====================

function calculateConfidence(scoredHorses: ScoredHorse[], ctx: RaceHistoricalContext): number {
  if (scoredHorses.length < 3) return 15;

  const gap1_2 = scoredHorses[0].totalScore - scoredHorses[1].totalScore;
  const gap1_3 = scoredHorses[0].totalScore - scoredHorses[2].totalScore;

  // === 予測の分離度 (最大40pt) ===
  let separation = 0;
  if (gap1_2 > 10) separation += 20;
  else if (gap1_2 > 7) separation += 15;
  else if (gap1_2 > 4) separation += 8;
  else separation -= 5;

  if (gap1_3 > 15) separation += 15;
  else if (gap1_3 > 10) separation += 10;
  else if (gap1_3 > 6) separation += 5;

  if (scoredHorses[0].scores.consistency >= 70) separation += 5;

  // === データ充実度 (最大35pt) ===
  // 全馬平均のデータ信頼度
  const avgDataReliability = scoredHorses.reduce((sum, sh) =>
    sum + (sh.scores._dataReliability || 0), 0
  ) / scoredHorses.length;

  // 平均データ点数
  const avgDataPoints = scoredHorses.reduce((sum, sh) =>
    sum + (sh.scores._totalDataPoints || 0), 0
  ) / scoredHorses.length;

  let dataScore = 0;
  // データ信頼度 (0-100) → 最大20pt
  dataScore += Math.min(20, avgDataReliability * 0.25);

  // 平均データ点数 → 最大15pt
  if (avgDataPoints >= 50) dataScore += 15;
  else if (avgDataPoints >= 30) dataScore += 12;
  else if (avgDataPoints >= 15) dataScore += 8;
  else if (avgDataPoints >= 5) dataScore += 4;
  else dataScore -= 5; // データ不足でペナルティ

  // === 統計データの充実度 (最大15pt) ===
  let statScore = 0;
  if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 30) statScore += 5;
  else if (ctx.courseDistStats && ctx.courseDistStats.totalRaces >= 10) statScore += 2;
  if (ctx.sireStatsMap.size >= 5) statScore += 4;
  else if (ctx.sireStatsMap.size >= 2) statScore += 2;
  if (ctx.jockeyTrainerMap.size >= 3) statScore += 3;
  if (ctx.seasonalMap.size >= 3) statScore += 3;

  const confidence = 20 + separation + dataScore + statScore;
  return Math.min(92, Math.max(10, Math.round(confidence)));
}

// ==================== 推奨馬券 ====================

function generateBetRecommendations(scoredHorses: ScoredHorse[], confidence: number): RecommendedBet[] {
  const bets: RecommendedBet[] = [];
  if (scoredHorses.length < 3) return bets;

  // softmax で全馬の推定勝率を算出
  const winProbs = estimateWinProbabilities(scoredHorses);
  const top = scoredHorses[0];
  const second = scoredHorses[1];
  const third = scoredHorses[2];
  const fourth = scoredHorses[3];
  const gap12 = top.totalScore - second.totalScore;

  const evOf = (h: ScoredHorse) => calcExpectedValue(h, winProbs);

  // --- 通常の馬券推奨（従来ロジック + EV表示） ---

  // オッズ取得ヘルパー（0以下はundefined）
  const oddsOf = (h: ScoredHorse) => (h.entry.odds && h.entry.odds > 0) ? h.entry.odds : undefined;

  if (gap12 > 5 && confidence >= 50) {
    const ev = evOf(top);
    bets.push({
      type: '単勝',
      selections: [top.entry.horseNumber],
      reasoning: `${top.entry.horseName}が総合力で群を抜いている。${top.reasons[0] || ''}。信頼度${confidence}%。${ev >= 1.0 ? `期待値${ev.toFixed(2)}で妙味あり。` : ''}`,
      expectedValue: ev,
      odds: oddsOf(top),
    });
  }

  bets.push({
    type: '複勝',
    selections: [top.entry.horseNumber],
    reasoning: `${top.entry.horseName}の3着以内は堅い。安定感重視の馬券。${top.scores.consistency >= 70 ? '着順も安定しており信頼できる。' : ''}`,
    expectedValue: evOf(top) * 0.7,
    odds: oddsOf(top) ? Math.max(1.1, oddsOf(top)! * 0.35) : undefined,
  });

  bets.push({
    type: '馬連',
    selections: [top.entry.horseNumber, second.entry.horseNumber],
    reasoning: `${top.entry.horseName}と${second.entry.horseName}の上位2頭。${second.reasons[0] || ''}`,
    expectedValue: (evOf(top) + evOf(second)) / 2,
    odds: (oddsOf(top) && oddsOf(second)) ? oddsOf(top)! * oddsOf(second)! * 0.5 : undefined,
  });

  if (third.totalScore > 40) {
    bets.push({
      type: 'ワイド',
      selections: [top.entry.horseNumber, third.entry.horseNumber],
      reasoning: `${top.entry.horseName}軸で${third.entry.horseName}へ。${third.reasons[0] || '好走条件が揃っている'}`,
      expectedValue: (evOf(top) + evOf(third)) / 2,
      odds: (oddsOf(top) && oddsOf(third)) ? oddsOf(top)! * oddsOf(third)! * 0.25 : undefined,
    });
  }

  if (fourth && third.totalScore - fourth.totalScore > 2) {
    bets.push({
      type: '三連複',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: `上位3頭で堅く決まる想定。${confidence >= 60 ? '信頼度高め。' : '波乱の余地あり、抑え程度に。'}`,
      expectedValue: (evOf(top) + evOf(second) + evOf(third)) / 3,
      odds: (oddsOf(top) && oddsOf(second) && oddsOf(third)) ? oddsOf(top)! * oddsOf(second)! * oddsOf(third)! * 0.3 : undefined,
    });
  }

  if (gap12 > 7 && confidence >= 55) {
    bets.push({
      type: '馬単',
      selections: [top.entry.horseNumber, second.entry.horseNumber],
      reasoning: `${top.entry.horseName}が頭鉄板。2着に${second.entry.horseName}。${gap12 > 10 ? '1着は堅い。' : ''}`,
      expectedValue: evOf(top) * 1.5,
      odds: (oddsOf(top) && oddsOf(second)) ? oddsOf(top)! * oddsOf(second)! * 0.9 : undefined,
    });
  }

  if (gap12 > 8 && confidence >= 65 && fourth && third.totalScore - fourth.totalScore > 3) {
    bets.push({
      type: '三連単',
      selections: [top.entry.horseNumber, second.entry.horseNumber, third.entry.horseNumber],
      reasoning: `高配当狙い。着順まで予想。${top.entry.horseName}→${second.entry.horseName}→${third.entry.horseName}の順。`,
      expectedValue: (evOf(top) + evOf(second) + evOf(third)) / 3 * 2,
      odds: (oddsOf(top) && oddsOf(second) && oddsOf(third)) ? oddsOf(top)! * oddsOf(second)! * oddsOf(third)! * 0.6 : undefined,
    });
  }

  // --- バリューベット検出（EV > 1.0 の馬を抽出） ---
  // 上位3頭以外で期待値が高い馬（＝市場が過小評価している穴馬）を検出
  for (const horse of scoredHorses) {
    if (!horse.entry.odds || horse.entry.odds <= 0) continue;
    const ev = evOf(horse);
    if (ev < 1.15) continue; // EV 1.15以上のみ（マージン考慮）

    const rank = scoredHorses.indexOf(horse) + 1;
    // 上位3頭は既に推奨済みなのでスキップ
    if (rank <= 3) continue;

    const prob = winProbs.get(horse) || 0;
    bets.push({
      type: '単勝',
      selections: [horse.entry.horseNumber],
      reasoning: `【バリューベット】${horse.entry.horseName}（${rank}番人気相当）。推定勝率${(prob * 100).toFixed(1)}%に対しオッズ${horse.entry.odds.toFixed(1)}倍は過小評価。期待値${ev.toFixed(2)}。${horse.reasons[0] || ''}`,
      expectedValue: ev,
      odds: oddsOf(horse),
    });
  }

  // EVが高い順にソート（バリューベットが上位に来るように）
  bets.sort((a, b) => b.expectedValue - a.expectedValue);

  return bets;
}

// ==================== 確率推定・期待値計算 ====================

/**
 * softmax で各馬の推定勝率を算出する。
 * temperature パラメータでスコア差の感度を調整:
 *   低い値 → スコア差が大きく反映（1強なら高確率）
 *   高い値 → 均等に近づく
 */
function estimateWinProbabilities(
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

  for (let i = 0; i < scoredHorses.length; i++) {
    probs.set(scoredHorses[i], exps[i] / sumExp);
  }

  return probs;
}

/**
 * 期待値 = 推定勝率 × 実オッズ
 * オッズ未取得の場合はスコアベースのフェアオッズを使用。
 */
function calcExpectedValue(
  horse: ScoredHorse,
  winProbs: Map<ScoredHorse, number>,
): number {
  const prob = winProbs.get(horse) || 0;
  if (prob <= 0) return 0;
  const odds = horse.entry.odds && horse.entry.odds > 0
    ? horse.entry.odds
    : 1 / prob; // オッズ未取得時はフェアオッズ（EV=1.0）
  return Math.round(prob * odds * 100) / 100;
}

// ==================== サマリー生成 ====================

function generateSummary(topPicks: PredictionPick[], analysis: RaceAnalysis, raceName: string, confidence: number): string {
  const parts: string[] = [];
  parts.push(`【${raceName}の予想】`);
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

  parts.push('');
  parts.push(`AI信頼度: ${confidence}%`);
  parts.push('※統計分析v3: 16ファクター分析（血統・騎手×調教師・季節パターン含む）');

  return parts.join('\n');
}

// ==================== ユーティリティ ====================

/**
 * 着順スコア: 頭数を考慮した連続関数
 * 1着=100、最下位=0、中間は線形補間
 * 例: 18頭立て2着=94, 8頭立て2着=86
 */
function positionToScore(position: number, entries: number): number {
  if (entries <= 1) return position === 1 ? 100 : 50;
  if (position <= 0) return 50;
  // 1着=100, 最下位=0 の線形スケール
  const raw = 100 * (1 - (position - 1) / (entries - 1));
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function ratioToScore(ratio: number): number {
  if (ratio <= 0.10) return 95;
  if (ratio <= 0.15) return 85;
  if (ratio <= 0.20) return 78;
  if (ratio <= 0.25) return 72;
  if (ratio <= 0.30) return 65;
  if (ratio <= 0.40) return 55;
  if (ratio <= 0.50) return 45;
  if (ratio <= 0.65) return 32;
  return 20;
}

function timeToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  const match = timeStr.match(/(?:(\d+):)?(\d+)\.(\d+)/);
  if (!match) return 0;
  const min = parseInt(match[1] || '0');
  const sec = parseInt(match[2]);
  const msec = parseInt(match[3]);
  return min * 60 + sec + msec / 10;
}

// エクスポート
export { scoreHorse as _scoreHorse };
export type { HorseAnalysisInput };

// テスト用エクスポート
export const _testExports = {
  calcFactorReliability,
  bayesianScore,
  adjustWeights,
  detectRunningStyle,
  calcRecentFormScore,
  calcCourseAptitude,
  calcDistanceAptitude,
  calcTrackConditionAptitude,
  calcJockeyScore,
  calcSpeedRating,
  calcClassPerformance,
  calcRunningStyleBase,
  calcPostPositionBias,
  calcRotation,
  calcLastThreeFurlongs,
  calcConsistency,
  applyPaceBonus,
  calculateConfidence,
  generateBetRecommendations,
  positionToScore,
  ratioToScore,
  timeToSeconds,
  WEIGHTS,
  DEFAULT_WEIGHTS,
  POPULATION_PRIORS,
};
