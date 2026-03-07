/**
 * XGBoost ML推論クライアント（TypeScript ネイティブ実装）
 *
 * XGBoost の JSON モデルファイルを直接読み込み、決定木を走査して推論する。
 * Python 不要 — Vercel の 500MB 制限を回避。
 *
 * v5.2: XGBRanker (ランキングモデル) 対応
 * - xgb_ranker.json が存在すればランキングモデルを使用
 * - なければ従来の xgb_win.json + xgb_place.json にフォールバック
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
const TRACK_TYPE_ENCODE: Record<string, number> = { '芝': 0, 'ダート': 1, '障害': 2 };
const TRACK_CONDITION_ENCODE: Record<string, number> = { '良': 0, '稍重': 1, '重': 2, '不良': 3 };
const WEATHER_ENCODE: Record<string, number> = { '晴': 0, '曇': 1, '小雨': 2, '雨': 3, '小雪': 4, '雪': 5 };
const GRADE_ENCODE: Record<string, number> = {
  '新馬': 0, '未勝利': 1, '1勝クラス': 2, '2勝クラス': 3,
  '3勝クラス': 4, 'リステッド': 5, 'オープン': 5,
  'G3': 6, 'G2': 7, 'G1': 8,
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
  // v4.2 新特徴量（後方互換性のためオプショナル）
  weather?: string | undefined;
  weightChange?: number | undefined;
  trainerWinRate?: number | undefined;
  trainerPlaceRate?: number | undefined;
  sireTrackWinRate?: number | undefined;
  jockeyDistanceWinRate?: number | undefined;
  jockeyCourseWinRate?: number | undefined;
  // v5.1: 馬体重トレンド特徴量
  weightStability?: number | undefined;
  weightTrendSlope?: number | undefined;
  weightOptimalDelta?: number | undefined;
}

/**
 * ファクタースコア + コンテキスト特徴量 → 特徴量dictを構築
 * v5.2: marginCompetitiveness, weatherAptitude はfactorScoresに含まれる
 */
export function buildMLFeatures(
  factorScores: Record<string, number>,
  ctx: ContextualFeatures,
): Record<string, number> {
  const odds = ctx.odds ?? 10;
  const popularity = ctx.popularity ?? Math.ceil(ctx.fieldSize / 2);

  return {
    ...factorScores,
    fieldSize: ctx.fieldSize,
    odds,
    popularity,
    age: ctx.age,
    sex_encoded: SEX_ENCODE[ctx.sex] ?? 0,
    handicapWeight: ctx.handicapWeight,
    postPosition: ctx.postPosition,
    grade_encoded: GRADE_ENCODE[ctx.grade ?? ''] ?? 3,
    trackType_encoded: TRACK_TYPE_ENCODE[ctx.trackType] ?? 0,
    distance: ctx.distance,
    trackCondition_encoded: TRACK_CONDITION_ENCODE[ctx.trackCondition] ?? 0,
    oddsLogTransform: Math.log1p(odds),
    popularityRatio: ctx.fieldSize > 0 ? popularity / ctx.fieldSize : 0.5,
    // v4.2 新特徴量
    weather_encoded: WEATHER_ENCODE[ctx.weather ?? ''] ?? 0,
    weightChange: ctx.weightChange ?? 0,
    trainerWinRate: ctx.trainerWinRate ?? 0.08,
    trainerPlaceRate: ctx.trainerPlaceRate ?? 0.20,
    // 交互作用特徴量
    sireTrackWinRate: ctx.sireTrackWinRate ?? 0.07,
    jockeyDistanceWinRate: ctx.jockeyDistanceWinRate ?? 0.08,
    jockeyCourseWinRate: ctx.jockeyCourseWinRate ?? 0.08,
    // v5.1: 馬体重トレンド
    weightStability: ctx.weightStability ?? 50,
    weightTrendSlope: ctx.weightTrendSlope ?? 0,
    weightOptimalDelta: ctx.weightOptimalDelta ?? 0,
  };
}

// ==================== Model loading & caching ====================

let cachedWinModel: XGBModel | null | undefined;
let cachedPlaceModel: XGBModel | null | undefined;
let cachedRankerModel: XGBModel | null | undefined;
let cachedFeatureNames: string[] | null = null;
let modelMode: 'ranker' | 'classifier' | 'none' | undefined;

function getModelDir(): string {
  return join(process.cwd(), 'model');
}

function loadModel(filename: string): XGBModel | null {
  const filepath = join(getModelDir(), filename);
  if (!existsSync(filepath)) {
    console.warn(`[ML] モデルファイル未検出: ${filepath}`);
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

/**
 * 単一の木を走査してリーフの値を返す
 */
function traverseTree(tree: XGBTree, features: number[]): number {
  let nodeId = 0;

  while (tree.left_children[nodeId] !== -1) {
    const featureIdx = tree.split_indices[nodeId];
    const threshold = tree.split_conditions[nodeId];
    const featureVal = features[featureIdx];

    // NaN/undefined の場合は default direction
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

/**
 * XGBoostモデルで推論し、確率を返す (binary:logistic 前提)
 */
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

/**
 * XGBRankerモデルで推論し、raw scoreを返す
 * ランキングモデルのリーフ値はそのままスコア（sigmoidは通さない）
 */
function predictRawScore(model: XGBModel, features: number[]): number {
  const baseScore = parseFloat(model.learner.learner_model_param.base_score) || 0.5;
  const trees = model.learner.gradient_booster.model.trees;

  let sum = baseScore;
  for (const tree of trees) {
    sum += traverseTree(tree, features);
  }

  return sum;
}

/**
 * softmax変換: raw scoresを確率に変換
 */
function softmax(scores: number[]): number[] {
  const maxScore = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - maxScore)); // 数値安定化
  const sumExp = exps.reduce((s, e) => s + e, 0);
  return exps.map(e => e / sumExp);
}

/**
 * 特徴量 dict を特徴量名の順序に従って配列に変換
 */
function featureDictToArray(
  features: Record<string, number>,
  featureNames: string[],
): number[] {
  return featureNames.map(name => features[name] ?? 0);
}

// ==================== Ranking prediction ====================

/**
 * ランキングモデルでレース内全馬の確率を推論
 */
function predictWithRanker(model: XGBModel, horses: MLHorseInput[], featureNames: string[]): MLPredictions {
  // 全馬のraw scoreを計算
  const rawScores = horses.map(h => {
    const featureArray = featureDictToArray(h.features, featureNames);
    return predictRawScore(model, featureArray);
  });

  // softmaxで確率に変換
  const probs = softmax(rawScores);

  // 降順ソートしてランク情報を構築
  const indexed = probs.map((prob, i) => ({ idx: i, prob }));
  indexed.sort((a, b) => b.prob - a.prob);

  // 上位3頭の確率合計を placeProb の基準とする
  const top3Sum = indexed.slice(0, 3).reduce((s, item) => s + item.prob, 0);

  const result: MLPredictions = {};
  for (let i = 0; i < horses.length; i++) {
    const rank = indexed.findIndex(item => item.idx === i);
    // winProb: そのまま softmax確率
    // placeProb: 上位3頭に入る確率として近似
    // ランクが3位以内なら高確率、それ以外は自分の確率 / top3合計を基に推定
    const placeProb = rank < 3
      ? Math.min(0.95, probs[i] / top3Sum + 0.3)  // 上位3頭は高確率
      : Math.min(0.80, probs[i] * 3);               // 4位以下は確率×3で近似

    result[horses[i].horseNumber] = {
      winProb: Math.round(probs[i] * 1_000_000) / 1_000_000,
      placeProb: Math.round(Math.min(1.0, placeProb) * 1_000_000) / 1_000_000,
    };
  }

  return result;
}

// ==================== Public API ====================

/**
 * XGBoost推論を実行する。
 * ランキングモデル → 分類モデル → null の優先順で推論。
 * モデル未配置・エラー時は null を返却（呼び出し元で加重平均フォールバック）。
 */
export async function callMLPredict(horses: MLHorseInput[]): Promise<MLPredictions | null> {
  try {
    if (!ensureModelsLoaded()) return null;
    if (!cachedFeatureNames) return null;

    // ランキングモデルモード
    if (modelMode === 'ranker' && cachedRankerModel) {
      const result = predictWithRanker(cachedRankerModel, horses, cachedFeatureNames);
      console.log(`[ML] ランキング推論完了: ${horses.length}頭`);
      return result;
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
