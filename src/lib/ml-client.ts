/**
 * XGBoost ML推論クライアント（TypeScript ネイティブ実装）
 *
 * XGBoost の JSON モデルファイルを直接読み込み、決定木を走査して推論する。
 * Python 不要 — Vercel の 500MB 制限を回避。
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
}

/**
 * 16ファクタースコア + コンテキスト特徴量 → 29次元の特徴量dictを構築
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
  };
}

// ==================== Model loading & caching ====================

let cachedWinModel: XGBModel | null | undefined;
let cachedPlaceModel: XGBModel | null | undefined;
let cachedFeatureNames: string[] | null = null;

function getModelDir(): string {
  return join(process.cwd(), 'model');
}

function loadModel(filename: string): XGBModel | null {
  const filepath = join(getModelDir(), filename);
  if (!existsSync(filepath)) return null;
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as XGBModel;
  } catch {
    return null;
  }
}

function loadFeatureNames(): string[] | null {
  const filepath = join(getModelDir(), 'feature_names.json');
  if (!existsSync(filepath)) return null;
  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

function ensureModelsLoaded(): boolean {
  if (cachedWinModel === undefined) {
    cachedWinModel = loadModel('xgb_win.json');
  }
  if (cachedPlaceModel === undefined) {
    cachedPlaceModel = loadModel('xgb_place.json');
  }
  if (cachedFeatureNames === null) {
    cachedFeatureNames = loadFeatureNames();
  }
  return cachedWinModel !== null && cachedPlaceModel !== null;
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
  const baseScore = parseFloat(model.learner.learner_model_param.base_score) || 0.5;
  const trees = model.learner.gradient_booster.model.trees;

  let sum = baseScore;
  for (const tree of trees) {
    sum += traverseTree(tree, features);
  }

  return sigmoid(sum);
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

// ==================== Public API ====================

/**
 * XGBoost推論を実行する。
 * モデル未配置・エラー時は null を返却（呼び出し元で加重平均フォールバック）。
 */
export async function callMLPredict(horses: MLHorseInput[]): Promise<MLPredictions | null> {
  try {
    if (!ensureModelsLoaded()) return null;
    if (!cachedFeatureNames || !cachedWinModel || !cachedPlaceModel) return null;

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

    return result;
  } catch {
    return null;
  }
}
