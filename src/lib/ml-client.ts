/**
 * XGBoost ML推論クライアント（TypeScript ネイティブ実装）
 *
 * XGBoost の JSON モデルファイルを直接読み込み、決定木を走査して推論する。
 * Python 不要 — Vercel の 500MB 制限を回避。
 *
 * v6.0 Phase 2:
 * - Isotonic Regression 確率較正 (Platt Scaling)
 * - カテゴリ別専門モデル (5カテゴリ)
 * - xgb_ranker_{category}.json が存在すればカテゴリモデルを使用
 * - calibration.json で softmax → 較正済み確率に変換
 *
 * モデル未配置時は null を返却し、呼び出し元は加重平均にフォールバックする。
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ==================== Types ====================

export interface MLHorseInput {
  horseNumber: number;
  features: Record<string, number>;
}

export interface MLPrediction {
  winProb: number;
  placeProb: number;
}

export type MLPredictions = Record<number, MLPrediction>;

export interface RaceContext {
  trackType: string;
  distance: number;
}

interface CalibrationData {
  x_thresholds: number[];
  y_values: number[];
}

// ==================== XGBoost JSON Model Types ====================

interface XGBTree {
  tree_param: { num_nodes: string };
  left_children: number[];
  right_children: number[];
  split_indices: number[];
  split_conditions: number[];
  default_left: number[];
  base_weights: number[];
}

interface XGBModel {
  learner: {
    learner_model_param: {
      base_score: string;
      num_feature: string;
    };
    gradient_booster: {
      model: {
        trees: XGBTree[];
        tree_info: number[];
      };
    };
    objective: {
      name: string;
    };
  };
}

// ==================== Feature construction ====================

const SEX_ENCODE: Record<string, number> = { '牡': 0, '牝': 1, 'セ': 2 };
const TRACK_TYPE_ENCODE: Record<string, number> = { '芝': 0, 'ダート': 1, 'ダ': 1, '障害': 2 };
const TRACK_CONDITION_ENCODE: Record<string, number> = { '良': 0, '稍重': 1, '重': 2, '不良': 3 };
const WEATHER_ENCODE: Record<string, number> = { '晴': 0, '曇': 1, '小雨': 2, '雨': 3, '小雪': 4, '雪': 5 };
const GRADE_ENCODE: Record<string, number> = {
  '新馬': 0, '未勝利': 1, '1勝クラス': 2, '2勝クラス': 3,
  '3勝クラス': 4, 'リステッド': 5, 'オープン': 5,
  'G3': 6, 'G2': 7, 'G1': 8,
};

// カテゴリ定義: (trackType_encoded, distance_min, distance_max)
const CATEGORY_DEFS: Record<string, [number, number, number]> = {
  'turf_sprint': [0, 0, 1400],
  'turf_mile': [0, 1401, 1800],
  'turf_long': [0, 1801, 99999],
  'dirt_short': [1, 0, 1600],
  'dirt_long': [1, 1601, 99999],
};

interface ContextualFeatures {
  fieldSize: number;
  odds: number | undefined;
  popularity: number | undefined;
  age: number;
  sex: string;
  handicapWeight: number;
  postPosition: number;
  grade: string | undefined;
  trackType: string;
  distance: number;
  trackCondition: string;
  weather?: string | undefined;
  sireTrackWinRate?: number | undefined;
  jockeyDistanceWinRate?: number | undefined; // jockeyXdistance交互作用の計算に使用
  cornerDelta?: number | undefined;
  avgMarginWhenWinning?: number | undefined;
  avgMarginWhenLosing?: number | undefined;
  daysSinceLastRace?: number | undefined;
  meetDay?: number | undefined;
  // v8.0: 直近フォーム + キャリア特徴量
  lastRacePosition?: number | undefined;
  last3WinRate?: number | undefined;
  last3PlaceRate?: number | undefined;
  careerWinRate?: number | undefined;
  relativeOdds?: number | undefined;
  winStreak?: number | undefined;
  // v9.0: 新特徴量
  relativePosition?: number | undefined;
  upsetRate?: number | undefined;
  avgPastOdds?: number | undefined;
  // v10.0: 走破タイム標準化
  standardTimeDev?: number | undefined;
  bestTimeDev?: number | undefined;
  timeConsistency?: number | undefined;
  // Phase 3 新特徴量 (#12-#16)
  bodyWeightTrend?: number | undefined;
  distanceChange?: number | undefined;
  jockeyTrainerWinRate?: number | undefined;
  horseCourseWinRate?: number | undefined;
  escaperCount?: number | undefined;
  // v12.0: タイム指数
  avgTimeIndex?: number | undefined;
  bestTimeIndex?: number | undefined;
  timeIndexTrend?: number | undefined;
  // v13.0: no-oddsモデル用に復活
  trainerDistCatWinRate?: number | undefined;
  // v13.0: コース形状
  straightLength?: number | undefined;
  isWesternGrass?: number | undefined;
  // v14.0: データ駆動枠順バイアス
  drawBiasZScore?: number | undefined;
  // v15.0: 追い切り評価
  oikiriRank?: number | undefined;
  // v16.0: ドメイン知識復活
  jockeyChanged?: number | undefined;        // 乗り替わりフラグ (0/1)
  earlyPositionRatio?: number | undefined;   // 一角確保率 (0-1, 低い=前方)
}

/**
 * ファクタースコア + コンテキスト特徴量 → 特徴量dictを構築
 */
export function buildMLFeatures(
  factorScores: Record<string, number>,
  ctx: ContextualFeatures,
): Record<string, number> {
  const odds = ctx.odds ?? 10;
  const popularity = ctx.popularity ?? Math.ceil(ctx.fieldSize / 2);

  const condEncoded = TRACK_CONDITION_ENCODE[ctx.trackCondition] ?? 0;

  // v13.0: jockeyAbility, trainerDistCatWinRate をno-odds用に復活
  // （factorScoresにjockeyAbilityが含まれるのでspread後に上書きは不要）
  const features: Record<string, number> = {
    ...factorScores,
    // v13.0: no-oddsモデルで有効な特徴量（factorScoresのjockeyAbilityはspreadで含まれる）
    trainerDistCatWinRate: ctx.trainerDistCatWinRate ?? 0.08,
    fieldSize: ctx.fieldSize,
    popularity,
    age: ctx.age,
    sex_encoded: SEX_ENCODE[ctx.sex] ?? 0,
    handicapWeight: ctx.handicapWeight,
    postPosition: ctx.postPosition,
    grade_encoded: GRADE_ENCODE[ctx.grade ?? ''] ?? 3,
    trackType_encoded: TRACK_TYPE_ENCODE[ctx.trackType] ?? 0,
    distance: ctx.distance,
    trackCondition_encoded: condEncoded,
    oddsLogTransform: odds > 0 ? Math.log(odds) : Math.log(10),
    popularityRatio: ctx.fieldSize > 0 ? popularity / ctx.fieldSize : 0.5,
    weather_encoded: WEATHER_ENCODE[ctx.weather ?? ''] ?? 0,
    sireTrackWinRate: ctx.sireTrackWinRate ?? 0.07,
    cornerDelta: ctx.cornerDelta ?? 0,
    avgMarginWhenWinning: ctx.avgMarginWhenWinning ?? 0,
    avgMarginWhenLosing: ctx.avgMarginWhenLosing ?? 0,
    daysSinceLastRace: ctx.daysSinceLastRace ?? 30,
    meetDay: ctx.meetDay ?? 1,
    conditionXsire: condEncoded * ((factorScores.sireAptitude ?? 50) / 100),
    // v8.0: 直近フォーム + キャリア特徴量
    lastRacePosition: ctx.lastRacePosition ?? 9,
    last3WinRate: ctx.last3WinRate ?? 0,
    last3PlaceRate: ctx.last3PlaceRate ?? 0,
    careerWinRate: ctx.careerWinRate ?? 0,
    relativeOdds: ctx.relativeOdds ?? 0,
    winStreak: ctx.winStreak ?? 0,
    // v9.0: 新特徴量
    relativePosition: ctx.relativePosition ?? 0.5,
    upsetRate: ctx.upsetRate ?? 0.1,
    avgPastOdds: ctx.avgPastOdds ?? Math.log(10),
    // v10.0: 走破タイム標準化
    standardTimeDev: ctx.standardTimeDev ?? 0,
    bestTimeDev: ctx.bestTimeDev ?? 0,
    timeConsistency: ctx.timeConsistency ?? 0,
    // Phase 3 新特徴量 (#12-#16)
    bodyWeightTrend: ctx.bodyWeightTrend ?? 0,
    distanceChange: ctx.distanceChange ?? 0,
    jockeyTrainerWinRate: ctx.jockeyTrainerWinRate ?? 0.05,
    horseCourseWinRate: ctx.horseCourseWinRate ?? 0.05,
    escaperCount: ctx.escaperCount ?? 0,
    // Phase 3 交互作用特徴量 (#17, 残留)
    jockeyXdistance: (ctx.jockeyDistanceWinRate ?? 0.08) * (ctx.distance / 1000),
    // v12.0: タイム指数
    avgTimeIndex: ctx.avgTimeIndex ?? 0,
    bestTimeIndex: ctx.bestTimeIndex ?? 0,
    timeIndexTrend: ctx.timeIndexTrend ?? 0,
    // v13.0: コース形状
    straightLength: ctx.straightLength ?? 0.5,
    isWesternGrass: ctx.isWesternGrass ?? 0,
    styleXstraight: ((factorScores.runningStyle ?? 50) / 100) * (ctx.straightLength ?? 0.5),
    // v14.0: データ駆動枠順バイアス
    drawBiasZScore: ctx.drawBiasZScore ?? 0,
    // v15.0: 追い切り評価 (A=3, B=2, C=1, D=0, 不明=1.5)
    oikiriRank: ctx.oikiriRank ?? 1.5,
    // v16.0: ドメイン知識復活
    jockeyChanged: ctx.jockeyChanged ?? 0,
    earlyPositionRatio: ctx.earlyPositionRatio ?? 0.5,
  };

  // NaN/Infinity ガード: 初出走馬やデータ欠損で特徴量が壊れるのを防止
  for (const key of Object.keys(features)) {
    if (!Number.isFinite(features[key])) {
      features[key] = 0;
    }
  }

  return features;
}

// ==================== CatBoost Oblivious Tree Types ====================

interface CatBoostSplit {
  feature_index: number;
  threshold: number;
}

interface CatBoostTree {
  splits: CatBoostSplit[];
  leaf_values: number[];
}

interface CatBoostModel {
  model_type: string;
  tree_count: number;
  feature_count: number;
  scale: number;
  bias: number;
  trees: CatBoostTree[];
}

interface EnsembleWeights {
  xgb: number;
  catboost: number;
  per_category?: Record<string, { xgb: number; catboost: number }>;
}

// ==================== Model loading & caching ====================

let cachedWinModel: XGBModel | null | undefined;
let cachedPlaceModel: XGBModel | null | undefined;
let cachedRankerModel: XGBModel | null | undefined;
let cachedFeatureNames: string[] | null = null;
let cachedCalibration: CalibrationData | null = null;
let cachedCategoryModels: Record<string, XGBModel> = {};
let cachedCatBoostModel: CatBoostModel | null | undefined;
let cachedCatBoostCalibration: CalibrationData | null = null;
let cachedCatBoostCategoryModels: Record<string, CatBoostModel> = {};
let cachedEnsembleWeights: EnsembleWeights | null = null;
let cachedPlaceClassifier: XGBModel | null | undefined;
let cachedPlaceCalibration: CalibrationData | null = null;
let cachedPlaceCategoryModels: Record<string, XGBModel> = {};
let cachedNoOddsModel: CatBoostModel | null | undefined;
let cachedNoOddsFeatureNames: string[] | null = null;
let cachedNoOddsCalibration: CalibrationData | null = null;
let modelMode: 'ranker' | 'classifier' | 'none' | undefined;

function getModelDir(): string {
  return join(process.cwd(), 'model');
}

function loadModel(filename: string): XGBModel | null {
  const filepath = join(getModelDir(), filename);
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as XGBModel;
  } catch (error) {
    console.error(`[ML] モデルファイル読み込みエラー (${filename}):`, error);
    return null;
  }
}

function loadFeatureNames(): string[] | null {
  const filepath = join(getModelDir(), 'feature_names.json');
  if (!existsSync(filepath)) {
    console.warn(`[ML] feature_names.json 未検出: ${filepath}`);
    return null;
  }
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as string[];
  } catch (error) {
    console.error('[ML] feature_names.json 読み込みエラー:', error);
    return null;
  }
}

function loadCalibration(filename = 'calibration.json'): CalibrationData | null {
  const filepath = join(getModelDir(), filename);
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const raw = readFileSync(filepath, 'utf-8');
    const data = JSON.parse(raw) as CalibrationData;
    if (data.x_thresholds?.length > 0 && data.y_values?.length > 0) {
      return data;
    }
    return null;
  } catch (error) {
    console.error(`[ML] ${filename} 読み込みエラー:`, error);
    return null;
  }
}

function loadCatBoostModel(filename: string): CatBoostModel | null {
  const filepath = join(getModelDir(), filename);
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const raw = readFileSync(filepath, 'utf-8');
    const data = JSON.parse(raw) as CatBoostModel;
    if (data.model_type === 'catboost_oblivious' && data.trees?.length > 0) {
      return data;
    }
    return null;
  } catch (error) {
    console.error(`[ML] ${filename} 読み込みエラー:`, error);
    return null;
  }
}

function loadEnsembleWeights(): EnsembleWeights | null {
  const filepath = join(getModelDir(), 'ensemble_weights.json');
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as EnsembleWeights;
  } catch (error) {
    console.error('[ML] ensemble_weights.json 読み込みエラー:', error);
    return null;
  }
}

function ensureModelsLoaded(): boolean {
  if (modelMode !== undefined) {
    return modelMode !== 'none';
  }

  console.log(`[ML] モデル読み込み開始 (modelDir: ${getModelDir()})`);

  cachedFeatureNames = loadFeatureNames();
  if (!cachedFeatureNames) {
    console.warn('[ML] feature_names が読み込めないため ML 推論を無効化');
    modelMode = 'none';
    return false;
  }
  console.log(`[ML] feature_names 読み込み完了: ${cachedFeatureNames.length}個`);

  // ランキングモデルを優先チェック
  cachedRankerModel = loadModel('xgb_ranker.json');
  if (cachedRankerModel) {
    const treeCount = cachedRankerModel.learner.gradient_booster.model.trees.length;
    console.log(`[ML] ランキングモデル読み込み完了 (trees: ${treeCount})`);

    // 較正マッピング読み込み
    cachedCalibration = loadCalibration();
    if (cachedCalibration) {
      console.log(`[ML] 較正マッピング読み込み完了 (${cachedCalibration.x_thresholds.length} points)`);
    }

    // カテゴリ別モデル読み込み
    cachedCategoryModels = {};
    for (const cat of Object.keys(CATEGORY_DEFS)) {
      const catModel = loadModel(`xgb_ranker_${cat}.json`);
      if (catModel) {
        cachedCategoryModels[cat] = catModel;
        console.log(`[ML] カテゴリモデル読み込み: ${cat}`);
      }
    }
    if (Object.keys(cachedCategoryModels).length > 0) {
      console.log(`[ML] カテゴリモデル: ${Object.keys(cachedCategoryModels).length}個`);
    }

    // CatBoost モデル読み込み (アンサンブル用)
    cachedCatBoostModel = loadCatBoostModel('catboost_ranker.json');
    if (cachedCatBoostModel) {
      console.log(`[ML] CatBoostモデル読み込み完了 (${cachedCatBoostModel.tree_count} trees)`);

      cachedCatBoostCalibration = loadCalibration('catboost_calibration.json');
      if (cachedCatBoostCalibration) {
        console.log(`[ML] CatBoost較正マッピング読み込み完了`);
      }

      // CatBoostカテゴリ別モデル
      cachedCatBoostCategoryModels = {};
      for (const cat of Object.keys(CATEGORY_DEFS)) {
        const catCbModel = loadCatBoostModel(`catboost_ranker_${cat}.json`);
        if (catCbModel) {
          cachedCatBoostCategoryModels[cat] = catCbModel;
        }
      }
      if (Object.keys(cachedCatBoostCategoryModels).length > 0) {
        console.log(`[ML] CatBoostカテゴリモデル: ${Object.keys(cachedCatBoostCategoryModels).length}個`);
      }

      // アンサンブル重み
      cachedEnsembleWeights = loadEnsembleWeights();
      if (cachedEnsembleWeights) {
        console.log(`[ML] アンサンブル重み: XGB=${cachedEnsembleWeights.xgb}, CB=${cachedEnsembleWeights.catboost}`);
      }
    }

    // Place classifier models (dedicated 複勝 prediction)
    cachedPlaceClassifier = loadModel('xgb_place_classifier.json');
    if (cachedPlaceClassifier) {
      console.log(`[ML] 複勝モデル読み込み完了`);
      cachedPlaceCalibration = loadCalibration('place_calibration.json');
      if (cachedPlaceCalibration) {
        console.log(`[ML] 複勝較正マッピング読み込み完了`);
      }
      for (const cat of Object.keys(CATEGORY_DEFS)) {
        const catPlaceModel = loadModel(`xgb_place_${cat}.json`);
        if (catPlaceModel) {
          cachedPlaceCategoryModels[cat] = catPlaceModel;
        }
      }
      if (Object.keys(cachedPlaceCategoryModels).length > 0) {
        console.log(`[ML] 複勝カテゴリモデル: ${Object.keys(cachedPlaceCategoryModels).length}個`);
      }
    }

    // No-Odds モデル（AI独自推奨用）
    cachedNoOddsModel = loadCatBoostModel('catboost_no_odds.json');
    if (cachedNoOddsModel) {
      console.log(`[ML] No-Oddsモデル読み込み完了 (${cachedNoOddsModel.tree_count} trees)`);
      const noOddsPath = join(getModelDir(), 'feature_names_no_odds.json');
      if (existsSync(noOddsPath)) {
        cachedNoOddsFeatureNames = JSON.parse(readFileSync(noOddsPath, 'utf-8')) as string[];
        console.log(`[ML] No-Odds feature_names: ${cachedNoOddsFeatureNames.length}個`);
      }
      cachedNoOddsCalibration = loadCalibration('catboost_no_odds_calibration.json');
      if (cachedNoOddsCalibration) {
        console.log(`[ML] No-Odds較正読み込み完了`);
      }
    }

    modelMode = 'ranker';
    return true;
  }

  // フォールバック: 分類モデル
  cachedWinModel = loadModel('xgb_win.json');
  cachedPlaceModel = loadModel('xgb_place.json');
  if (cachedWinModel && cachedPlaceModel) {
    console.log('[ML] 分類モデル (win+place) 読み込み完了');
    modelMode = 'classifier';
    return true;
  }

  console.warn('[ML] 利用可能なモデルなし → ML 推論を無効化');
  modelMode = 'none';
  return false;
}

// ==================== XGBoost tree inference ====================

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function traverseTree(tree: XGBTree, features: number[]): number {
  let nodeId = 0;

  while (tree.left_children[nodeId] !== -1) {
    const featureIdx = tree.split_indices[nodeId];
    const threshold = tree.split_conditions[nodeId];
    const featureVal = features[featureIdx];

    if (featureVal === undefined || isNaN(featureVal)) {
      nodeId = tree.default_left[nodeId]
        ? tree.left_children[nodeId]
        : tree.right_children[nodeId];
    } else if (featureVal < threshold) {
      nodeId = tree.left_children[nodeId];
    } else {
      nodeId = tree.right_children[nodeId];
    }
  }

  return tree.base_weights[nodeId];
}

function predictProba(model: XGBModel, features: number[]): number {
  const baseScoreProb = parseFloat(model.learner.learner_model_param.base_score) || 0.5;
  const clampedProb = Math.max(1e-7, Math.min(1 - 1e-7, baseScoreProb));
  const baseMargin = Math.log(clampedProb / (1 - clampedProb));

  const trees = model.learner.gradient_booster.model.trees;

  let sum = baseMargin;
  for (const tree of trees) {
    sum += traverseTree(tree, features);
  }

  return sigmoid(sum);
}

function predictRawScore(model: XGBModel, features: number[]): number {
  const baseScore = parseFloat(model.learner.learner_model_param.base_score) || 0.5;
  const trees = model.learner.gradient_booster.model.trees;

  let sum = baseScore;
  for (const tree of trees) {
    sum += traverseTree(tree, features);
  }

  return sum;
}

function softmax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  if (scores.length === 1) return [1];
  const maxScore = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - maxScore));
  const sumExp = exps.reduce((s, e) => s + e, 0);
  if (sumExp === 0) return scores.map(() => 1 / scores.length);
  return exps.map(e => e / sumExp);
}

function featureDictToArray(
  features: Record<string, number>,
  featureNames: string[],
): number[] {
  return featureNames.map(name => features[name] ?? NaN);
}

// ==================== Calibration ====================

/**
 * Isotonic Regression のピースワイズ線形補間
 */
function interpolateCalibration(prob: number, cal: CalibrationData): number {
  const { x_thresholds, y_values } = cal;
  if (x_thresholds.length === 0) return prob;
  if (prob <= x_thresholds[0]) return y_values[0];
  if (prob >= x_thresholds[x_thresholds.length - 1]) return y_values[y_values.length - 1];

  // 二分探索
  let lo = 0;
  let hi = x_thresholds.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (x_thresholds[mid] <= prob) lo = mid;
    else hi = mid;
  }

  const x0 = x_thresholds[lo];
  const x1 = x_thresholds[hi];
  const y0 = y_values[lo];
  const y1 = y_values[hi];
  const denom = x1 - x0;
  if (denom === 0) return y0;

  const t = (prob - x0) / denom;
  return y0 + t * (y1 - y0);
}

/**
 * softmax確率配列に較正を適用し、合計1に再正規化
 */
function applyCalibration(probs: number[], cal: CalibrationData): number[] {
  const calibrated = probs.map(p => interpolateCalibration(p, cal));
  const sum = calibrated.reduce((s, v) => s + v, 0);
  return sum > 0 ? calibrated.map(v => v / sum) : calibrated;
}

// ==================== Odds weight (XGBoost) ====================

/**
 * XGBoost カテゴリ別オッズ重み（学習時と同じスケーリングを推論時に適用）
 * CatBoostはfeature_weightsがツリー分割時に効くため推論時スケーリング不要
 */
const XGB_CATEGORY_ODDS_WEIGHTS: Record<string, number> = {
  turf_sprint: 0.0,
  turf_mile: 1.0,
  turf_long: 0.3,
  dirt_short: 0.0,
  dirt_long: 0.0,
};
const XGB_GLOBAL_ODDS_WEIGHT = 0.3;

// ==================== Category selection ====================

/**
 * レースのカテゴリを判定
 */
function categorizeRace(trackType: string, distance: number): string | null {
  const tt = TRACK_TYPE_ENCODE[trackType] ?? -1;
  for (const [cat, [catTT, dMin, dMax]] of Object.entries(CATEGORY_DEFS)) {
    if (tt === catTT && distance >= dMin && distance <= dMax) {
      return cat;
    }
  }
  return null;
}

// ==================== CatBoost Oblivious Tree inference ====================

/**
 * CatBoost Oblivious Tree の推論
 * 対称木: depth = splits.length, リーフ数 = 2^depth
 * 各splitの結果(0/1)を並べてバイナリインデックスとする
 */
function traverseCatBoostTree(tree: CatBoostTree, features: number[]): number {
  const depth = tree.splits.length;
  let leafIdx = 0;

  for (let d = 0; d < depth; d++) {
    const split = tree.splits[d];
    const featureVal = features[split.feature_index];
    const bit = (featureVal !== undefined && !isNaN(featureVal) && featureVal > split.threshold) ? 1 : 0;
    leafIdx |= (bit << d);
  }

  return tree.leaf_values[leafIdx] ?? 0;
}

function predictCatBoostRawScore(model: CatBoostModel, features: number[]): number {
  let sum = model.bias;
  for (const tree of model.trees) {
    sum += traverseCatBoostTree(tree, features);
  }
  return sum * model.scale;
}

function predictWithCatBoost(
  model: CatBoostModel,
  horses: MLHorseInput[],
  featureNames: string[],
  calibration: CalibrationData | null,
): number[] {
  const rawScores = horses.map(h => {
    const featureArray = featureDictToArray(h.features, featureNames);
    return predictCatBoostRawScore(model, featureArray);
  });

  let probs = softmax(rawScores);

  if (calibration) {
    probs = applyCalibration(probs, calibration);
  }

  return probs;
}

// ==================== Ranking prediction ====================

/**
 * XGBランカーからsoftmax+較正済みの確率配列を返す (アンサンブル用)
 */
function predictWithRankerProbs(
  model: XGBModel,
  horses: MLHorseInput[],
  featureNames: string[],
  calibration: CalibrationData | null,
  oddsWeight?: number,
): number[] {
  const oddsIdx = oddsWeight != null && oddsWeight !== 1.0
    ? featureNames.indexOf('oddsLogTransform')
    : -1;

  const rawScores = horses.map(h => {
    const featureArray = featureDictToArray(h.features, featureNames);
    // XGBoost: 学習時と同じオッズスケーリングを適用
    if (oddsIdx >= 0) {
      featureArray[oddsIdx] *= oddsWeight!;
    }
    return predictRawScore(model, featureArray);
  });

  let probs = softmax(rawScores);
  if (calibration) {
    probs = applyCalibration(probs, calibration);
  }
  return probs;
}

/**
 * 確率配列 → MLPredictions 変換
 */
function probsToMLPredictions(probs: number[], horses: MLHorseInput[], placeProbs?: number[] | null): MLPredictions {
  const indexed = probs.map((prob, i) => ({ idx: i, prob }));
  indexed.sort((a, b) => b.prob - a.prob);

  const top3Sum = indexed.slice(0, 3).reduce((s, item) => s + item.prob, 0);

  const result: MLPredictions = {};
  for (let i = 0; i < horses.length; i++) {
    const rank = indexed.findIndex(item => item.idx === i);
    const placeProb = placeProbs?.[i] ?? (rank < 3
      ? Math.min(0.95, probs[i] / top3Sum + 0.3)
      : Math.min(0.80, probs[i] * 3));

    result[horses[i].horseNumber] = {
      winProb: Math.round(probs[i] * 1_000_000) / 1_000_000,
      placeProb: Math.round(Math.min(1.0, placeProb) * 1_000_000) / 1_000_000,
    };
  }

  return result;
}

/**
 * ランキングモデルでレース内全馬の確率を推論
 * v6.0: 較正マッピング適用、カテゴリモデル対応
 */
function predictWithRanker(model: XGBModel, horses: MLHorseInput[], featureNames: string[]): MLPredictions {
  const rawScores = horses.map(h => {
    const featureArray = featureDictToArray(h.features, featureNames);
    return predictRawScore(model, featureArray);
  });

  // softmaxで確率に変換
  let probs = softmax(rawScores);

  // 較正マッピング適用
  if (cachedCalibration) {
    probs = applyCalibration(probs, cachedCalibration);
  }

  // 降順ソートしてランク情報を構築
  const indexed = probs.map((prob, i) => ({ idx: i, prob }));
  indexed.sort((a, b) => b.prob - a.prob);

  const top3Sum = indexed.slice(0, 3).reduce((s, item) => s + item.prob, 0);

  const result: MLPredictions = {};
  for (let i = 0; i < horses.length; i++) {
    const rank = indexed.findIndex(item => item.idx === i);
    const placeProb = rank < 3
      ? Math.min(0.95, probs[i] / top3Sum + 0.3)
      : Math.min(0.80, probs[i] * 3);

    result[horses[i].horseNumber] = {
      winProb: Math.round(probs[i] * 1_000_000) / 1_000_000,
      placeProb: Math.round(Math.min(1.0, placeProb) * 1_000_000) / 1_000_000,
    };
  }

  return result;
}

// ==================== Place classifier ====================

/**
 * 専用複勝モデルでtop-3確率を推論
 * Race-level正規化: 合計≈3.0になるようスケーリング
 */
function predictPlaceProbs(
  horses: MLHorseInput[],
  featureNames: string[],
  raceContext?: RaceContext,
): number[] | null {
  if (!cachedPlaceClassifier) return null;

  const cat = raceContext ? categorizeRace(raceContext.trackType, raceContext.distance) : null;
  let selectedModel = cachedPlaceClassifier;
  if (cat && cachedPlaceCategoryModels[cat]) {
    selectedModel = cachedPlaceCategoryModels[cat];
  }

  const rawProbs = horses.map(h => {
    const featureArray = featureDictToArray(h.features, featureNames);
    return predictProba(selectedModel, featureArray);
  });

  // Isotonic Regression calibration
  let calibratedProbs = rawProbs;
  if (cachedPlaceCalibration) {
    calibratedProbs = rawProbs.map(p => interpolateCalibration(p, cachedPlaceCalibration!));
  }

  // Race-level normalization: scale so sum ≈ 3.0
  const sum = calibratedProbs.reduce((s, p) => s + p, 0);
  if (sum > 0) {
    const scale = 3.0 / sum;
    calibratedProbs = calibratedProbs.map(p => Math.min(0.95, p * scale));
  }

  return calibratedProbs;
}

// ==================== Public API ====================

/**
 * XGBoost推論を実行する。
 * カテゴリモデル → グローバルランカー → 分類モデル → null の優先順で推論。
 * 較正マッピングがあれば自動適用。
 * モデル未配置・エラー時は null を返却（呼び出し元で加重平均フォールバック）。
 */
export async function callMLPredict(
  horses: MLHorseInput[],
  raceContext?: RaceContext,
): Promise<MLPredictions | null> {
  try {
    if (!ensureModelsLoaded()) return null;
    if (!cachedFeatureNames) return null;

    // ランキングモデルモード
    if (modelMode === 'ranker' && cachedRankerModel) {
      // カテゴリ判定
      const cat = raceContext ? categorizeRace(raceContext.trackType, raceContext.distance) : null;

      // XGBoost: カテゴリモデルを優先使用
      let selectedXgbModel = cachedRankerModel;
      let modelLabel = 'global';

      if (cat && cachedCategoryModels[cat]) {
        selectedXgbModel = cachedCategoryModels[cat];
        modelLabel = cat;
      }

      // CatBoostアンサンブルが利用可能か
      if (cachedCatBoostModel && cachedEnsembleWeights) {
        let selectedCbModel = cachedCatBoostModel;
        if (cat && cachedCatBoostCategoryModels[cat]) {
          selectedCbModel = cachedCatBoostCategoryModels[cat];
        }

        // XGBoost + CatBoost のアンサンブル推論
        // XGBoostは学習時にオッズ列をスケーリングしているため、推論時も同じスケーリングが必要
        const xgbOddsWeight = cat
          ? (XGB_CATEGORY_ODDS_WEIGHTS[cat] ?? XGB_GLOBAL_ODDS_WEIGHT)
          : XGB_GLOBAL_ODDS_WEIGHT;
        const xgbProbs = predictWithRankerProbs(selectedXgbModel, horses, cachedFeatureNames, cachedCalibration, xgbOddsWeight);
        const cbProbs = predictWithCatBoost(selectedCbModel, horses, cachedFeatureNames, cachedCatBoostCalibration);

        // カテゴリ別重みがあれば使用
        let xgbWeight = cachedEnsembleWeights.xgb;
        let cbWeight = cachedEnsembleWeights.catboost;
        if (cat && cachedEnsembleWeights.per_category?.[cat]) {
          xgbWeight = cachedEnsembleWeights.per_category[cat].xgb;
          cbWeight = cachedEnsembleWeights.per_category[cat].catboost;
        }

        // 加重平均
        const blendedProbs = xgbProbs.map((xp, i) => xp * xgbWeight + cbProbs[i] * cbWeight);
        const probSum = blendedProbs.reduce((s, v) => s + v, 0);
        const normalizedProbs = probSum > 0 ? blendedProbs.map(v => v / probSum) : blendedProbs;

        const placeProbs = predictPlaceProbs(horses, cachedFeatureNames!, raceContext);
        const result = probsToMLPredictions(normalizedProbs, horses, placeProbs);
        console.log(`[ML] アンサンブル推論完了: ${horses.length}頭 (${modelLabel}, XGB=${xgbWeight} CB=${cbWeight}${cachedCalibration ? ', 較正済' : ''}${placeProbs ? ', 複勝モデル使用' : ''})`);
        return result;
      }

      // XGBoostのみ
      {
        const xgbOddsW = cat
          ? (XGB_CATEGORY_ODDS_WEIGHTS[cat] ?? XGB_GLOBAL_ODDS_WEIGHT)
          : XGB_GLOBAL_ODDS_WEIGHT;
        const oddsIdx = xgbOddsW !== 1.0 ? cachedFeatureNames!.indexOf('oddsLogTransform') : -1;
        const rawScores = horses.map(h => {
          const featureArray = featureDictToArray(h.features, cachedFeatureNames!);
          if (oddsIdx >= 0) featureArray[oddsIdx] *= xgbOddsW;
          return predictRawScore(selectedXgbModel, featureArray);
        });
        let probs = softmax(rawScores);
        if (cachedCalibration) {
          probs = applyCalibration(probs, cachedCalibration);
        }
        const placeProbs = predictPlaceProbs(horses, cachedFeatureNames!, raceContext);
        const result = probsToMLPredictions(probs, horses, placeProbs);
        console.log(`[ML] ランキング推論完了: ${horses.length}頭 (${modelLabel}${cachedCalibration ? ', 較正済' : ''}${placeProbs ? ', 複勝モデル使用' : ''})`);
        return result;
      }
    }

    // 分類モデルフォールバック
    if (modelMode === 'classifier' && cachedWinModel && cachedPlaceModel) {
      const result: MLPredictions = {};

      for (const horse of horses) {
        const featureArray = featureDictToArray(horse.features, cachedFeatureNames);

        const winProb = predictProba(cachedWinModel, featureArray);
        const placeProb = predictProba(cachedPlaceModel, featureArray);

        result[horse.horseNumber] = {
          winProb: Math.round(winProb * 1_000_000) / 1_000_000,
          placeProb: Math.round(placeProb * 1_000_000) / 1_000_000,
        };
      }

      console.log(`[ML] 分類モデル推論完了: ${horses.length}頭`);
      return result;
    }

    return null;
  } catch (error) {
    console.error('[ML] callMLPredict でエラー発生:', error);
    return null;
  }
}

/**
 * No-Oddsモデルで推論し、馬番→確率のMapを返す。
 * AI独自推奨（市場非依存ランキング）用。
 * モデル未配置時はnullを返す。
 */
export function predictWithNoOddsModel(
  horses: MLHorseInput[],
): Map<number, number> | null {
  if (!ensureModelsLoaded()) return null;
  if (!cachedNoOddsModel || !cachedNoOddsFeatureNames) return null;

  try {
    const probs = predictWithCatBoost(
      cachedNoOddsModel,
      horses,
      cachedNoOddsFeatureNames,
      cachedNoOddsCalibration,
    );

    const result = new Map<number, number>();
    for (let i = 0; i < horses.length; i++) {
      result.set(horses[i].horseNumber, probs[i]);
    }
    return result;
  } catch (error) {
    console.error('[ML] No-Odds推論エラー:', error);
    return null;
  }
}
