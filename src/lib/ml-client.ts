/**
 * XGBoost ML推論クライアント
 *
 * Python Vercel関数 (/api/ml-predict) を呼び出し、勝率・複勝率を取得する。
 * モデル未配置・タイムアウト・エラー時は null を返却し、呼び出し元は加重平均にフォールバックする。
 */

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

// ==================== ML inference call ====================

const ML_TIMEOUT_MS = 8000;

/**
 * Python XGBoost推論関数を呼び出す。
 * 失敗時は null を返却（呼び出し元で加重平均フォールバック）。
 */
export async function callMLPredict(horses: MLHorseInput[]): Promise<MLPredictions | null> {
  // 開発環境ではスキップ（ローカルにPython関数がない前提）
  if (process.env.NODE_ENV === 'development') return null;

  // モデル未配置を想定して存在チェック用の環境変数は不要
  // Python関数が500を返せばnullになる

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL || '';

  if (!baseUrl) return null;

  try {
    const response = await fetch(`${baseUrl}/api/ml-predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ horses }),
      signal: AbortSignal.timeout(ML_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = await response.json() as { success: boolean; predictions?: Record<string, MLPrediction> };
    if (!data.success || !data.predictions) return null;

    const result: MLPredictions = {};
    for (const [key, val] of Object.entries(data.predictions)) {
      result[parseInt(key)] = val;
    }
    return result;
  } catch {
    return null;
  }
}
