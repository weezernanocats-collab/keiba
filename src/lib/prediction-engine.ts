/**
 * AI予想エンジン v5.2
 *
 * 過去の成績データを16の観点から多角的に分析し、レースの予想を生成する。
 * v4: ベイズ推定フォールバック + 動的ウェイト調整 + データ充実度ベース信頼度
 * v4.2: 調教師能力ファクター追加
 * v5.0: 5つの精度向上改善
 *   - 動的スピード指数（コース×距離×馬場別の実データ基準タイム）
 *   - リアルタイム枠順バイアス（固定biasMap → 実データの枠別勝率）
 *   - 騎手直近フォーム（30日/年間トレンド）
 *   - グレード補正 + トレンド検出（直近成績の質を反映）
 *   - カテゴリ別ウェイトプロファイル（芝短/マイル/長/ダ短/ダ長）
 *
 * スコアリング要素と重み (v7.1: SHAP分析で重要度0の3ファクター除去):
 *   === 個体分析 ===
 *   1.  直近成績        (17%) - 直近5走+グレード補正+トレンド検出
 *   2.  距離適性        (11%) - 同距離帯での過去成績
 *   3.  馬場状態適性    (5%)  - 同馬場状態での成績
 *   4.  騎手能力        (8%)  - 騎手の勝率+直近30日フォーム
 *   5.  スピード指数    (11%) - 動的基準タイムベースの速度評価
 *   6.  脚質適性        (6%)  - 展開との相性（逃げ/先行/差し/追込）
 *   7.  枠順分析        (5%)  - 実データベースの枠別勝率
 *   8.  ローテーション  (4%)  - 前走からの間隔と叩き良化パターン
 *   9.  上がり3F        (8%)  - 末脚の切れ味評価
 *   10. 安定性          (5%)  - 着順のバラつきの少なさ
 *
 *   === 統計ベース分析 ===
 *   11. 血統適性        (6%)  - 種牡馬産駒の統計的なコース/距離/馬場適性
 *   12. 調教師能力      (5%)  - 調教師の勝率・トラック別成績・直近成績
 *   13. 季節パターン    (2%)  - 馬ごとの季節別成績傾向
 *   14. 斤量アドバンテージ (1%) - 平均斤量との差分
 *   15. 市場オッズ      (3%)  - 単勝オッズの逆数正規化（低ウェイト）
 *   16. 着差競争力      (1%)  - 僅差好走の頻度
 *   17. 天候適性        (2%)  - 天候条件での成績
 */

import type {
  Prediction, PredictionPick, RaceAnalysis,
  RaceEntry, PastPerformance, TrackType, TrackCondition,
} from '@/types';

import {
  buildRaceContext,
  calcSireAptitudeScore,
  calcTrainerAbilityScore,
  calcSeasonalScore,
  calcSecondStartScore,
  type RaceHistoricalContext,
  type DynamicStandardTime,
  type JockeyRecentForm,
  type CourseDistanceStats,
} from './historical-analyzer';
import { callMLPredict, buildMLFeatures, type MLHorseInput } from './ml-client';
import { calculateTodayTrackBias, type TodayTrackBias } from './track-bias';
import { categorizeRace, applyCategoryMultipliers } from './weight-profiles';
import { calcWeightTrendBonus } from './weight-trend';
import { applyEnhancedPaceBonus } from './pace-analyzer';
import { calcMarginScore } from './margin-score';
import { calcWeatherScore } from './weather-score';
import { applyVenueMultipliers } from './racecourse-profiles';

// v6.0: ML特徴量用ヘルパー
function marginToSeconds(margin: string | undefined): number {
  if (!margin) return 0;
  const m = margin.trim();
  if (m === '' || m === '同着') return 0;
  if (m === 'クビ') return 0.1;
  if (m === 'ハナ') return 0.05;
  if (m === 'アタマ') return 0.15;
  if (m.includes('1/2')) return 0.3;
  if (m.includes('3/4')) return 0.45;
  if (m === '大差') return 5.0;
  const num = parseFloat(m);
  return isNaN(num) ? 0 : num * 0.6;
}

function parseCornerDelta(cornerStr: string | undefined): number {
  if (!cornerStr) return 0;
  const parts = cornerStr.split('-').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  if (parts.length < 2) return 0;
  return parts[parts.length - 2] - parts[parts.length - 1];
}

// v9.0: classChange 計算用グレードエンコード
const GRADE_ENCODE: Record<string, number> = {
  '新馬': 0, '未勝利': 1, '1勝クラス': 2, '2勝クラス': 3,
  '3勝クラス': 4, 'リステッド': 5, 'オープン': 5,
  'G3': 6, 'G2': 7, 'G1': 8,
};

import { dbAll } from './database';
import {
  oddsToImpliedProbabilities,
  blendProbabilities,
  computeDisagreement,
  findValueHorses,
} from './market-blend';

// 分割モジュールからインポート
import {
  getCurrentWeights,
  calcFactorReliability,
  bayesianScore,
  adjustWeightsWithBase,
  DEFAULT_WEIGHTS,
  POPULATION_PRIORS,
  getCategoryBlendParams,
  type DataReliability,
} from './weight-management';
export { applyCalibrationWeights, resetWeights, getCurrentWeights } from './weight-management';
import { analyzeRace, calculateConfidence } from './race-analysis';
import { generateBettingStrategy, generateBetRecommendations, type ScoredHorse } from './betting-strategy';
import { estimateWinProbabilities, generateSummary } from './probability-estimation';

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
  trainerDistCatWinRate?: number;
  trainerCondWinRate?: number;
  trainerGradeWinRate?: number;
  // v9.0: 通算賞金
  totalEarnings?: number;
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
  options?: { isAfternoon?: boolean },
): Promise<Prediction> {
  const cond = trackCondition || '良';
  const month = new Date(date).getMonth() + 1;

  // 統計コンテキストを構築（1レースにつき1回、beforeDateフィルタ付き）
  const ctx = await buildRaceContext(
    racecourseName, trackType, distance, month,
    horses.map(h => ({
      horseId: h.entry.horseId,
      fatherName: h.fatherName,
      jockeyId: h.entry.jockeyId,
      trainerName: h.entry.trainerName,
    })),
    date,
  );

  // 平均斤量を算出（斤量ファクター用）
  const avgHandicapWeight = horses.length > 0
    ? horses.reduce((sum, h) => sum + (h.entry.handicapWeight || 55), 0) / horses.length
    : 55;

  // カテゴリ別ウェイトプロファイル適用 → 競馬場別補正
  const category = categorizeRace(trackType, distance);
  const categoryWeights = applyVenueMultipliers(
    applyCategoryMultipliers(getCurrentWeights(), category),
    racecourseName,
  );

  // 単勝オッズマップ取得（市場シグナル用）
  const oddsMap = await getWinOddsMap(raceId);

  // 各馬をスコアリング
  const scoredHorses = horses.map(h =>
    scoreHorse(h, trackType, distance, cond, racecourseName, grade, horses.length, ctx, month, avgHandicapWeight, oddsMap, categoryWeights, weather, date)
  );

  // 展開予想から脚質ボーナスを付与（強化版: コンテキスト依存）
  applyEnhancedPaceBonus(scoredHorses, distance, grade, cond, ctx.paceProfile);

  // 当日馬場バイアスを反映（同場・同日・同トラックの完走レースから推定）
  const todayBias = await calculateTodayTrackBias(racecourseName, date, trackType);
  if (todayBias) {
    applyTodayTrackBias(scoredHorses, todayBias, horses.length);
  }

  // スコア順にソート
  scoredHorses.sort((a, b) => b.totalScore - a.totalScore);

  // --- ML推論によるスコアブレンド ---
  const horseInputMap = new Map(horses.map(h => [h.entry.horseNumber, h]));
  const raceDate = new Date(date);
  const mlInputs: MLHorseInput[] = scoredHorses.map(sh => {
    const input = horseInputMap.get(sh.entry.horseNumber);
    const pp = input?.pastPerformances || [];

    // v6.0: 騎手乗替シグナル
    let jockeySwitchQuality = 0;
    if (pp.length > 0 && sh.entry.jockeyName) {
      const lastJockey = pp[0].jockeyName;
      if (lastJockey && lastJockey !== sh.entry.jockeyName) {
        jockeySwitchQuality = (sh.scores.jockeyAbility ?? 50) - 50;
      }
    }

    // v6.0: コーナー加速（直近5走平均）
    let cornerDelta = 0;
    const cornerPerfs = pp.slice(0, 5).filter(p => p.cornerPositions);
    if (cornerPerfs.length > 0) {
      const deltas = cornerPerfs.map(p => parseCornerDelta(p.cornerPositions));
      cornerDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    }

    // v6.0: 着差定量化
    let avgMarginWhenWinning = 0;
    let avgMarginWhenLosing = 0;
    const winPerfs = pp.filter(p => p.position === 1 && p.margin);
    const losePerfs = pp.filter(p => p.position > 1 && p.margin);
    if (winPerfs.length > 0) {
      avgMarginWhenWinning = winPerfs.reduce((s, p) => s + marginToSeconds(p.margin), 0) / winPerfs.length;
    }
    if (losePerfs.length > 0) {
      avgMarginWhenLosing = losePerfs.reduce((s, p) => s + marginToSeconds(p.margin), 0) / losePerfs.length;
    }

    // v6.0: 休養日数
    let daysSinceLastRace = 30;
    if (pp.length > 0) {
      const lastDate = new Date(pp[0].date);
      daysSinceLastRace = Math.max(0, Math.round((raceDate.getTime() - lastDate.getTime()) / 86400000));
    }

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
          // v6.0: 新特徴量
          jockeySwitchQuality,
          cornerDelta,
          avgMarginWhenWinning,
          avgMarginWhenLosing,
          daysSinceLastRace,
          meetDay: raceId.length >= 10 ? parseInt(raceId.substring(8, 10)) || 1 : 1,
          trainerDistCatWinRate: input?.trainerDistCatWinRate,
          trainerCondWinRate: input?.trainerCondWinRate,
          trainerGradeWinRate: input?.trainerGradeWinRate,
          // v7.0: ラップタイム基盤特徴量
          horsePacePreference: ctx.horsePaceMap.get(sh.entry.horseId)?.preference,
          horseHaiPaceRate: ctx.horsePaceMap.get(sh.entry.horseId)?.haiRate,
          courseDistPaceAvg: ctx.courseDistPaceAvg,
          // v8.0: 直近フォーム + キャリア特徴量
          lastRacePosition: pp.length > 0 ? pp[0].position : 9,
          last3WinRate: pp.length > 0
            ? pp.slice(0, 3).filter(p => p.position === 1).length / Math.min(pp.length, 3) : 0,
          last3PlaceRate: pp.length > 0
            ? pp.slice(0, 3).filter(p => p.position <= 3).length / Math.min(pp.length, 3) : 0,
          // v9.0: classChange 推論修正（前走グレードと今走グレードの差）
          classChange: (() => {
            if (pp.length === 0) return 0;
            const prevGrade = GRADE_ENCODE[pp[0].grade ?? ''] ?? 3;
            const curGrade = GRADE_ENCODE[grade ?? ''] ?? 3;
            return curGrade - prevGrade;
          })(),
          // v9.0: trackTypeChange 推論修正（過去走データから計算）
          trackTypeChange: (() => {
            if (pp.length === 0) return 0;
            const prevTrackType = pp[0].trackType;
            return (prevTrackType === '芝' && trackType !== '芝') ||
                   (prevTrackType !== '芝' && trackType === '芝') ? 1 : 0;
          })(),
          careerWinRate: pp.length > 0
            ? pp.filter(p => p.position === 1).length / pp.length : 0,
          relativeOdds: (() => {
            const allOdds = scoredHorses
              .map(s => s.entry.odds)
              .filter((o): o is number => o != null && o > 0)
              .sort((a, b) => a - b);
            const median = allOdds.length > 0 ? allOdds[Math.floor(allOdds.length / 2)] : 10;
            const odds = sh.entry.odds;
            return odds && odds > 0 ? Math.log(odds / median) : 0;
          })(),
          winStreak: (() => {
            let streak = 0;
            for (const p of pp) { if (p.position === 1) streak++; else break; }
            return streak;
          })(),
          // v9.0: 新特徴量4つ
          relativePosition: pp.length > 0 && pp[0].entries > 0
            ? pp[0].position / pp[0].entries : 0.5,
          upsetRate: (() => {
            const longshots = pp.filter(p => p.popularity >= 5);
            if (longshots.length === 0) return 0.1;
            return longshots.filter(p => p.position <= 3).length / longshots.length;
          })(),
          avgPastOdds: (() => {
            const placed = pp.filter(p => p.position <= 3 && p.odds > 0);
            if (placed.length === 0) return Math.log(10);
            const avg = placed.reduce((s, p) => s + p.odds, 0) / placed.length;
            return Math.log(avg > 0 ? avg : 10);
          })(),
          totalEarningsLog: Math.log1p(input?.totalEarnings ?? 0),
        },
      ),
    };
  });

  const mlPredictions = await callMLPredict(mlInputs, { trackType, distance });

  // v7.2: カテゴリ別ブレンドパラメータ取得
  const blendParams = getCategoryBlendParams(trackType, distance);
  const envMlBlend = process.env.ML_BLEND_WEIGHT;
  const envMarketBlend = process.env.MARKET_BLEND_WEIGHT;
  const mlBlendWeight = envMlBlend ? parseFloat(envMlBlend) : blendParams.mlBlend;
  const marketBlendWeight = envMarketBlend ? parseFloat(envMarketBlend) : blendParams.marketBlend;
  const softmaxTemp = blendParams.temperature;

  if (mlPredictions) {
    // v10: ML較正済み確率を直接使用（二重softmax問題を解消）
    // 旧: totalScore = 16factor*0.05 + winProb*100*0.95 → softmax → 確率（較正が破壊される）
    // 新: totalScoreはソート用にwinProbベース、確率はMLから直接取得
    for (const sh of scoredHorses) {
      const ml = mlPredictions[sh.entry.horseNumber];
      if (ml) {
        sh.totalScore = ml.winProb * 100;
      }
    }
    scoredHorses.sort((a, b) => b.totalScore - a.totalScore);
  }
  // --- ML推論ここまで ---

  // --- 市場オッズブレンド ---
  // ML確率が利用可能な場合は較正済み確率を直接使用
  // ML不可の場合のみsoftmaxフォールバック（カテゴリ別温度）
  const modelProbsByNumber = new Map<number, number>();
  if (mlPredictions) {
    // ML較正済み確率を直接使用（二重softmaxを回避）
    for (const sh of scoredHorses) {
      const ml = mlPredictions[sh.entry.horseNumber];
      if (ml) {
        modelProbsByNumber.set(sh.entry.horseNumber, ml.winProb);
      }
    }
  } else {
    // MLなし: 16因子スコアからsoftmaxで確率推定
    const modelWinProbs = estimateWinProbabilities(scoredHorses, softmaxTemp);
    for (const [sh, prob] of modelWinProbs) {
      modelProbsByNumber.set(sh.entry.horseNumber, prob);
    }
  }

  // 市場暗示確率を算出（oddsMapは既に上で取得済み）
  const { probs: marketProbsByNumber, overround } = oddsToImpliedProbabilities(oddsMap);

  // ブレンド確率・乖離度・妙味馬
  let blendedProbsByNumber: Map<number, number>;
  let disagreements: Map<number, import('./market-blend').MarketDisagreement>;
  let valueHorseNumbers: number[];

  if (marketProbsByNumber.size > 0) {
    blendedProbsByNumber = blendProbabilities(modelProbsByNumber, marketProbsByNumber, marketBlendWeight);
    disagreements = computeDisagreement(modelProbsByNumber, marketProbsByNumber, blendedProbsByNumber, 0.03);
    valueHorseNumbers = findValueHorses(disagreements, 0.03);

    // 妙味馬に理由を追加
    for (const sh of scoredHorses) {
      const d = disagreements.get(sh.entry.horseNumber);
      if (d && d.isValueHorse) {
        sh.reasons.push(`妙味あり: モデル${(d.modelProb * 100).toFixed(1)}% vs 市場${(d.marketProb * 100).toFixed(1)}%`);
      }
    }
  } else {
    blendedProbsByNumber = modelProbsByNumber;
    disagreements = new Map();
    valueHorseNumbers = [];
  }
  // --- 市場オッズブレンドここまで ---

  // トップピック生成
  const topPicks: PredictionPick[] = scoredHorses.slice(0, 6).map((sh, idx) => ({
    rank: idx + 1,
    horseId: sh.entry.horseId,
    horseNumber: sh.entry.horseNumber,
    horseName: sh.entry.horseName,
    score: Math.round(sh.totalScore * 100) / 100,
    reasons: sh.reasons,
    runningStyle: sh.runningStyle,
    escapeRate: sh.escapeRate,
  }));

  // レース分析（当日バイアス + ペースプロファイルも含める）
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

  // 各馬のsoftmax確率を算出・保存（Brier Score / キャリブレーション評価用）
  const winProbabilities: Record<number, number> = {};
  for (const sh of scoredHorses) {
    // ブレンド確率があればそちらを使用、なければモデル確率
    const prob = blendedProbsByNumber.get(sh.entry.horseNumber) || modelProbsByNumber.get(sh.entry.horseNumber) || 0;
    winProbabilities[sh.entry.horseNumber] = Math.round(prob * 10000) / 10000;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (analysis as any).winProbabilities = winProbabilities;

  // 市場分析データをanalysisに格納
  if (disagreements.size > 0) {
    const marketAnalysis: Record<number, { modelProb: number; marketProb: number; blendedProb: number; disagreement: number; isValue: boolean }> = {};
    for (const [hn, d] of disagreements) {
      marketAnalysis[hn] = {
        modelProb: Math.round(d.modelProb * 10000) / 10000,
        marketProb: Math.round(d.marketProb * 10000) / 10000,
        blendedProb: Math.round(d.blendedProb * 10000) / 10000,
        disagreement: Math.round(d.disagreement * 10000) / 10000,
        isValue: d.isValueHorse,
      };
    }
    analysis.marketAnalysis = marketAnalysis;
    analysis.valueHorses = valueHorseNumbers;
    analysis.overround = Math.round(overround * 10000) / 10000;
  }

  // 信頼度算出
  const confidence = calculateConfidence(scoredHorses, ctx);

  // 馬券戦略
  const bettingStrategy = generateBettingStrategy(scoredHorses, confidence);
  analysis.bettingStrategy = bettingStrategy;

  // 推奨馬券（戦略ベース + ブレンド確率 + バリューベット判定）
  // ML の placeProb（3着以内確率）も渡して、馬券ごとの的中率を精密に計算
  const placeProbsByNumber = new Map<number, number>();
  if (mlPredictions) {
    for (const sh of scoredHorses) {
      const ml = mlPredictions[sh.entry.horseNumber];
      if (ml) {
        placeProbsByNumber.set(sh.entry.horseNumber, ml.placeProb);
      }
    }
  }
  const marketAnalysisData = analysis.marketAnalysis as Record<number, { modelProb: number; marketProb: number; disagreement: number; isValue: boolean }> | undefined;
  const recommendedBets = generateBetRecommendations(scoredHorses, confidence, bettingStrategy, oddsMap, blendedProbsByNumber, trackType, distance, marketAnalysisData, placeProbsByNumber);

  // サマリー生成
  const summary = generateSummary(topPicks, analysis, raceName, confidence, todayBias, options?.isAfternoon);

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

  return rawPrediction;
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
  oddsMap: Map<number, number>,
  categoryWeights: Record<string, number>,
  currentWeather?: string,
  raceDate?: string,
): ScoredHorse {
  const { entry, pastPerformances: pp, jockeyWinRate, jockeyPlaceRate, fatherName } = input;
  const reasons: string[] = [];
  const scores: Record<string, number> = {};

  // 脚質判定（逃げ率も取得）
  const { style: runStyle, escapeRate } = detectRunningStyleWithRate(pp);

  // 逃げ率が高い馬にはreasonを追加
  if (escapeRate >= 60) reasons.push(`逃げ率${escapeRate}%（逃げ馬）`);
  else if (escapeRate >= 30) reasons.push(`逃げ率${escapeRate}%`);

  // ==================== 個体分析 ====================

  // 1. 直近成績 (0-100) + グレード補正 + トレンド検出 + 馬体重トレンド
  scores.recentForm = calcRecentFormScoreV5(pp);
  const weightTrend = calcWeightTrendBonus(pp);
  scores.recentForm = Math.max(0, Math.min(100, scores.recentForm + weightTrend.bonus));
  scores._weightStability = weightTrend.stability;
  scores._weightTrendSlope = weightTrend.trendSlope;
  scores._weightOptimalDelta = weightTrend.optimalDelta;
  if (weightTrend.bonus >= 3) reasons.push(`馬体重安定・好調（${weightTrend.signal}）`);
  else if (weightTrend.bonus <= -3) reasons.push(`馬体重に不安（${weightTrend.signal}）`);
  if (scores.recentForm >= 75) reasons.push(`直近成績が優秀（スコア${Math.round(scores.recentForm)}）`);
  else if (scores.recentForm >= 60) reasons.push('直近の調子は悪くない');
  else if (scores.recentForm <= 30) reasons.push('直近成績が低調');

  // 2. 距離適性 (0-100)
  scores.distanceAptitude = calcDistanceAptitude(pp, distance);
  if (scores.distanceAptitude >= 75) reasons.push(`${distance}m前後がベスト距離`);
  else if (scores.distanceAptitude <= 35) reasons.push('距離適性に不安');

  // 4. 馬場状態適性 (0-100)
  scores.trackConditionAptitude = calcTrackConditionAptitude(pp, trackType, trackCondition);
  if (scores.trackConditionAptitude >= 75 && (trackCondition === '重' || trackCondition === '不良')) {
    reasons.push('道悪巧者、重馬場で成績上昇');
  }

  // 5. 騎手能力 (0-100) + 直近フォーム
  const jockeyForm = ctx.jockeyFormMap.get(entry.jockeyId);
  scores.jockeyAbility = calcJockeyScoreV5(jockeyWinRate, jockeyPlaceRate, jockeyForm);
  if (jockeyForm?.trend === 'improving') reasons.push(`騎手${entry.jockeyName}は直近好調↑`);
  if (scores.jockeyAbility >= 75) reasons.push(`騎手${entry.jockeyName}は勝率トップクラス`);

  // 6. スピード指数 (0-100) - 動的基準タイム対応
  scores.speedRating = calcSpeedRatingV5(pp, trackType, distance, trackCondition, ctx.dynamicStdTime);
  if (scores.speedRating >= 75) reasons.push('高水準のスピード指数を記録');

  // 6. 脚質適性 (0-100)
  scores.runningStyle = calcRunningStyleBase(runStyle, distance);
  if (runStyle === '逃げ' && distance <= 1400) reasons.push('逃げ馬で短距離向き');
  if (runStyle === '差し' && distance >= 1800) reasons.push('差し脚質で中長距離向き');
  if (runStyle === '追込' && distance >= 2000) reasons.push('追込で展開次第で一発あり');

  // 9. 枠順分析 (0-100) - リアルタイムデータ優先
  scores.postPositionBias = calcPostPositionBiasV5(entry.postPosition, fieldSize, distance, trackType, racecourseName, ctx.courseDistStats);
  if (scores.postPositionBias >= 75) reasons.push('枠順が有利');
  else if (scores.postPositionBias <= 30) reasons.push('外枠で不利');

  // 10. ローテーション (0-100)
  scores.rotation = calcRotation(pp, raceDate);
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

  // 13. 季節パターン (0-100)
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

  // 19. 市場オッズ (0-100) - 低ウェイト、利用可能時のみ
  {
    const odds = oddsMap.get(entry.horseNumber);
    if (odds && odds > 0) {
      // オッズの逆数を正規化（1.0倍=100, 10倍=60, 50倍=30, 100倍=15）
      scores.marketOdds = Math.min(100, Math.max(10, 100 - Math.log10(odds) * 30));
      if (odds <= 3.0) reasons.push(`単勝${odds}倍の人気馬（市場評価高）`);
    } else {
      scores.marketOdds = 50; // オッズなし→中立
    }
  }

  // 20. 着差競争力 (0-100) - v5.2
  {
    const marginResult = calcMarginScore(pp);
    scores.marginCompetitiveness = marginResult.score;
    if (marginResult.score >= 75) reasons.push('僅差好走が多く競り合いに強い');
    else if (marginResult.score <= 30) reasons.push('大敗が多く安定感に欠ける');
  }

  // 21. 天候適性 (0-100) - v5.2
  {
    const weatherResult = calcWeatherScore(pp, currentWeather);
    scores.weatherAptitude = weatherResult.score;
    if (weatherResult.dataPoints >= 2 && weatherResult.score >= 75) {
      reasons.push(`${currentWeather || ''}天候で好走実績あり`);
    } else if (weatherResult.dataPoints >= 2 && weatherResult.score <= 30) {
      reasons.push(`${currentWeather || ''}天候は苦手傾向`);
    }
  }

  // 叩き良化ボーナス（ローテーションスコアに加算）
  const secondStartBonus = ctx.secondStartMap.get(entry.horseId);
  if (secondStartBonus && pp.length >= 2) {
    const lastDate = pp[0]?.date;
    const prevDate = pp[1]?.date;
    if (lastDate && prevDate) {
      const refTime = raceDate ? new Date(raceDate).getTime() : Date.now();
      const daysSinceLast = Math.floor((refTime - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24));
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
  const countDistWide = pp.filter(p => Math.abs(p.distance - distance) <= 400).length;
  const countTrackCond = pp.filter(p => p.trackType === trackType).length;
  const countSpeedRelevant = pp.filter(p => p.trackType === trackType && Math.abs(p.distance - distance) <= 200 && p.time).length;
  const countL3F = pp.slice(0, 15).filter(p => p.lastThreeFurlongs && parseFloat(p.lastThreeFurlongs) > 0).length;

  const sireData = ctx.sireStatsMap.get(fatherName);
  const seasonalData = ctx.seasonalMap.get(entry.horseId);

  reliabilities.push(
    { factor: 'recentForm', reliability: calcFactorReliability('recentForm', pp.length), dataPoints: pp.length },
    { factor: 'distanceAptitude', reliability: calcFactorReliability('distanceAptitude', countDistWide), dataPoints: countDistWide },
    { factor: 'trackConditionAptitude', reliability: calcFactorReliability('trackConditionAptitude', countTrackCond), dataPoints: countTrackCond },
    { factor: 'jockeyAbility', reliability: jockeyWinRate > 0 ? 1.0 : 0.0, dataPoints: jockeyWinRate > 0 ? 1 : 0 },
    { factor: 'speedRating', reliability: calcFactorReliability('speedRating', countSpeedRelevant), dataPoints: countSpeedRelevant },
    { factor: 'runningStyle', reliability: calcFactorReliability('runningStyle', pp.length), dataPoints: pp.length },
    { factor: 'postPositionBias', reliability: 1.0, dataPoints: 1 },
    { factor: 'rotation', reliability: pp.length > 0 ? 1.0 : 0.0, dataPoints: pp.length > 0 ? 1 : 0 },
    { factor: 'lastThreeFurlongs', reliability: calcFactorReliability('lastThreeFurlongs', countL3F), dataPoints: countL3F },
    { factor: 'consistency', reliability: calcFactorReliability('consistency', pp.length), dataPoints: pp.length },
    { factor: 'sireAptitude', reliability: calcFactorReliability('sireAptitude', sireData?.totalRaces || 0), dataPoints: sireData?.totalRaces || 0 },
    { factor: 'trainerAbility', reliability: calcFactorReliability('trainerAbility', trainerStats?.totalRaces || 0), dataPoints: trainerStats?.totalRaces || 0 },
    { factor: 'seasonalPattern', reliability: calcFactorReliability('seasonalPattern', seasonalData?.reduce((s, m) => s + m.races, 0) || 0), dataPoints: seasonalData?.reduce((s, m) => s + m.races, 0) || 0 },
    { factor: 'handicapAdvantage', reliability: 1.0, dataPoints: 1 },
    { factor: 'marketOdds', reliability: oddsMap.has(entry.horseNumber) ? 1.0 : 0.0, dataPoints: oddsMap.has(entry.horseNumber) ? 1 : 0 },
    { factor: 'marginCompetitiveness', reliability: calcFactorReliability('marginCompetitiveness', pp.filter(p => p.margin !== undefined && p.margin !== '').length), dataPoints: pp.filter(p => p.margin !== undefined && p.margin !== '').length },
    { factor: 'weatherAptitude', reliability: calcFactorReliability('weatherAptitude', currentWeather ? pp.filter(p => p.weather === currentWeather).length : 0), dataPoints: currentWeather ? pp.filter(p => p.weather === currentWeather).length : 0 },
  );

  // ベイズ推定でスコアを補正
  for (const rel of reliabilities) {
    const raw = scores[rel.factor];
    if (raw !== undefined) {
      const { score: bayesian } = bayesianScore(rel.factor, raw, rel.dataPoints);
      scores[rel.factor] = bayesian;
    }
  }

  // 動的ウェイト調整（カテゴリ別ウェイトをベースに）
  const dynWeights = adjustWeightsWithBase(reliabilities, categoryWeights);

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

  return { entry, totalScore, scores, reasons, runningStyle: runStyle, escapeRate, fatherName };
}

// ==================== 脚質判定 ====================

interface RunningStyleResult {
  style: RunningStyle;
  escapeRate: number;  // 逃げ率 (0-100)
}

function detectRunningStyle(pp: PastPerformance[]): RunningStyle {
  return detectRunningStyleWithRate(pp).style;
}

function detectRunningStyleWithRate(pp: PastPerformance[]): RunningStyleResult {
  if (pp.length === 0) return { style: '不明', escapeRate: 0 };

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
  if (total === 0) return { style: '不明', escapeRate: 0 };

  const escapeRate = Math.round(escapeCount / total * 100);

  let style: RunningStyle;
  if (escapeCount / total >= 0.4) style = '逃げ';
  else if (frontCount / total >= 0.4) style = '先行';
  else if ((escapeCount + frontCount) / total >= 0.6) style = '先行';
  else if (closerCount / total >= 0.4) style = '追込';
  else style = '差し';

  return { style, escapeRate };
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

  const bonus: Record<string, number> = {
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

/**
 * v5: 直近成績スコア（グレード補正 + トレンド検出付き）
 * - G1/G2/G3での好走に補正倍率を適用
 * - 直近3走の着順推移からトレンドを検出（改善/悪化）
 */
function calcRecentFormScoreV5(pp: PastPerformance[]): number {
  if (pp.length === 0) return 40;
  const recent = pp.slice(0, 5);
  let score = 0;
  const weights = [0.35, 0.25, 0.20, 0.12, 0.08];

  recent.forEach((perf, idx) => {
    const w = weights[idx] || 0.05;
    let posScore = positionToScore(perf.position, perf.entries || 16);

    // グレード補正: 重賞での好走はより価値が高い
    const raceName = perf.raceName || '';
    if (perf.position <= 3) {
      if (raceName.includes('G1') || raceName.includes('（G1）')) posScore *= 1.4;
      else if (raceName.includes('G2') || raceName.includes('（G2）')) posScore *= 1.25;
      else if (raceName.includes('G3') || raceName.includes('（G3）')) posScore *= 1.15;
      else if (raceName.includes('ステークス')) posScore *= 1.08;
    }

    score += Math.min(100, posScore) * w;
  });

  // 連勝ボーナス
  const winStreak = countWinStreak(pp);
  if (winStreak >= 3) score += 10;
  else if (winStreak >= 2) score += 5;

  // 復調ボーナス
  if (pp.length >= 2 && pp[0].position <= 3 && pp[1].position >= 8) {
    score += 3;
  }

  // トレンド検出: 直近3走の着順比率の推移
  if (pp.length >= 3) {
    const ratios = pp.slice(0, 3).map(p => p.position / (p.entries || 16));
    // ratios[0]が最新。値が小さい=好着順
    const trend = (ratios[2] - ratios[0]); // 正 = 改善、負 = 悪化
    if (trend > 0.15) score += 4;      // 明確な改善トレンド
    else if (trend > 0.05) score += 2;  // 微改善
    else if (trend < -0.15) score -= 3; // 明確な悪化
    else if (trend < -0.05) score -= 1; // 微悪化
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

/**
 * v5: 騎手能力スコア（直近30日フォーム + トレンド反映）
 */
function calcJockeyScoreV5(winRate: number, placeRate: number, form: JockeyRecentForm | undefined): number {
  let score = calcJockeyScore(winRate, placeRate);

  if (form) {
    // 直近30日のフォームを反映（十分なサンプルがある場合）
    if (form.recent30DayRaces >= 5) {
      const recentPlaceRate = (form as { recent30DayPlaceRate?: number }).recent30DayPlaceRate ?? form.recent30DayWinRate * 2.5;
      const recentScore = calcJockeyScore(form.recent30DayWinRate, recentPlaceRate);
      // 通算70% + 直近30% でブレンド
      score = score * 0.7 + recentScore * 0.3;
    }

    // トレンドボーナス
    if (form.trend === 'improving') score += 4;
    else if (form.trend === 'declining') score -= 3;
  }

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

/**
 * v5: 動的基準タイムベースのスピード指数
 * DB実データの中央タイムを基準に使い、ハードコードはフォールバックのみ
 */
function calcSpeedRatingV5(
  pp: PastPerformance[],
  trackType: TrackType,
  distance: number,
  trackCondition: TrackCondition,
  dynamicStdTime: DynamicStandardTime | null,
): number {
  if (pp.length === 0) return 50;

  const relevantRaces = pp.filter(p =>
    p.trackType === trackType &&
    Math.abs(p.distance - distance) <= 200 &&
    p.time
  );

  if (relevantRaces.length === 0) return 50;

  // ハードコード基準タイム（フォールバック用）
  const staticTimes: Record<string, Record<number, number>> = {
    '芝': { 1000: 56.0, 1200: 69.0, 1400: 82.0, 1600: 95.0, 1800: 108.5, 2000: 121.0, 2200: 134.0, 2400: 147.0, 2500: 153.0, 3000: 183.0, 3200: 196.0, 3600: 222.0 },
    'ダート': { 1000: 59.0, 1200: 72.0, 1400: 84.0, 1600: 97.0, 1700: 104.0, 1800: 111.0, 2000: 125.0, 2100: 131.0 },
    '障害': { 3000: 210.0, 3200: 225.0, 3300: 232.0, 3570: 252.0, 3930: 280.0, 4250: 305.0 },
  };

  const ratings = relevantRaces.map(p => {
    const seconds = timeToSeconds(p.time);
    if (seconds <= 0) return 0;

    // 動的基準タイムがあり、距離が一致する場合は優先使用
    let stdTime: number;
    if (dynamicStdTime && Math.abs(p.distance - dynamicStdTime.distance) <= 50) {
      // 動的基準タイム + 馬場差補正
      stdTime = dynamicStdTime.medianTimeSeconds;
      // 馬場差: 動的基準は「良」で計算、走ったレースの馬場との差を補正
      const condDiff = getConditionTimeAdjustment(p.trackCondition, trackType, p.distance);
      stdTime += condDiff;
    } else {
      stdTime = interpolateStandardTime(staticTimes[trackType] || {}, p.distance);
    }

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

/**
 * 馬場状態による基準タイムへの加算秒数
 * 良を基準(0)として、重/不良はタイムが遅くなる分を加算
 */
function getConditionTimeAdjustment(condition: TrackCondition | string, trackType: TrackType, distance: number): number {
  const perFurlong = distance / 200; // 1Fあたりのロス
  if (trackType === '芝') {
    if (condition === '稍重') return perFurlong * 0.1;
    if (condition === '重') return perFurlong * 0.25;
    if (condition === '不良') return perFurlong * 0.4;
  } else {
    // ダートは重馬場で速くなる傾向
    if (condition === '稍重') return perFurlong * -0.05;
    if (condition === '重') return perFurlong * -0.1;
    if (condition === '不良') return perFurlong * 0.05;
  }
  return 0;
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
      const denom = distances[i + 1] - distances[i];
      const ratio = denom > 0 ? (distance - distances[i]) / denom : 0;
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

/**
 * v5: リアルタイム枠順バイアス
 * courseDistStats の実データがあればそれを使い、なければハードコードにフォールバック
 */
function calcPostPositionBiasV5(
  post: number,
  fieldSize: number,
  distance: number,
  trackType: TrackType,
  racecourseName: string,
  courseDistStats: CourseDistanceStats | null,
): number {
  if (fieldSize === 0) return 50;

  // 実データがある場合: 枠番別勝率から直接スコアを算出
  if (courseDistStats && courseDistStats.totalRaces >= 20) {
    const postData = courseDistStats.postPositionWinRate[post];
    if (postData && postData.races >= 5) {
      // この枠の勝率を全体平均と比較
      const avgRate = 1 / Math.max(fieldSize, 8);
      const diff = postData.rate - avgRate;
      return Math.min(100, Math.max(10, 50 + diff * 500));
    }

    // 枠番のデータ不足 → 内外の傾向で判定
    const isInner = post <= Math.ceil(fieldSize / 2);
    if (isInner) {
      const innerAdv = courseDistStats.innerFrameWinRate - courseDistStats.outerFrameWinRate;
      return Math.min(100, Math.max(10, 50 + innerAdv * 300));
    } else {
      const outerAdv = courseDistStats.outerFrameWinRate - courseDistStats.innerFrameWinRate;
      return Math.min(100, Math.max(10, 50 + outerAdv * 300));
    }
  }

  // フォールバック: 従来のハードコード
  return calcPostPositionBias(post, fieldSize, distance, trackType, racecourseName);
}

function calcRotation(pp: PastPerformance[], raceDate?: string): number {
  if (pp.length === 0) return 50;

  const lastDate = pp[0].date;
  if (!lastDate) return 50;

  const lastRaceDate = new Date(lastDate);
  const referenceDate = raceDate ? new Date(raceDate) : new Date();
  const daysSinceLast = Math.floor((referenceDate.getTime() - lastRaceDate.getTime()) / (1000 * 60 * 60 * 24));

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

// ==================== レースパターン分類 (→ betting-strategy.ts へ移動済み) ====================
// analyzeRace, getCourseCharacteristics, calculateConfidence → race-analysis.ts
// classifyRacePattern, generateBettingStrategy, generateBetRecommendations → betting-strategy.ts
// estimateWinProbabilities, generateSummary → probability-estimation.ts
// (関数本体は各モジュールに移動済み)
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

// ==================== オッズ取得ヘルパー ====================

/** レースの単勝オッズをDB or entryから取得 */
async function getWinOddsMap(raceId: string): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await dbAll(
      "SELECT horse_number1, odds FROM odds WHERE race_id = ? AND bet_type = '単勝'",
      [raceId]
    );
    for (const r of rows) {
      if (r.horse_number1 && r.odds > 0) {
        map.set(r.horse_number1, r.odds);
      }
    }
  } catch {
    // oddsテーブルが無い場合は空マップを返す
  }
  return map;
}

// エクスポート
export { scoreHorse as _scoreHorse };
export type { HorseAnalysisInput };
export type { ScoredHorse } from './betting-strategy';

// テスト用エクスポート (分割モジュールの関数はそちらから直接importすること)
export const _testExports = {
  calcFactorReliability,
  bayesianScore,
  detectRunningStyle,
  calcRecentFormScore,
  calcDistanceAptitude,
  calcTrackConditionAptitude,
  calcJockeyScore,
  calcSpeedRating,
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
  DEFAULT_WEIGHTS,
  POPULATION_PRIORS,
};
