/**
 * 競馬場別ファクター補正プロファイル
 *
 * 各競馬場のコース特性に基づき、予想ファクターの乗数を定義する。
 * weight-profiles.ts と同パターンで適用し、正規化する。
 *
 * 適用順: DEFAULT_WEIGHTS → カテゴリ補正 → 競馬場補正 → 正規化
 */

/** 競馬場別ファクター乗数 */
const VENUE_MULTIPLIERS: Record<string, Record<string, number>> = {
  // === 中央競馬 ===
  '東京': {
    // 広いコース、直線長い → 末脚・差し追込が有利
    lastThreeFurlongs: 1.4,
    runningStyle: 1.2,
    speedRating: 1.1,
    postPositionBias: 0.7,    // 外枠の不利が小さい
    distanceAptitude: 1.1,
  },
  '中山': {
    // 小回り、内枠有利、先行有利
    postPositionBias: 1.5,
    runningStyle: 1.3,        // 先行脚質が重要
    lastThreeFurlongs: 0.8,   // 直線短い
    consistency: 1.1,
  },
  '阪神': {
    // 外回り/内回りで特性が異なるが平均的に適用
    speedRating: 1.2,
    lastThreeFurlongs: 1.2,
    sireAptitude: 1.1,
    trackConditionAptitude: 1.1,
  },
  '京都': {
    // 3コーナーの坂、淀の坂が特徴
    runningStyle: 1.2,
    consistency: 1.1,
    speedRating: 1.1,
    sireAptitude: 1.1,
  },
  '中京': {
    // 左回り、直線長め
    lastThreeFurlongs: 1.2,
    distanceAptitude: 1.1,
    speedRating: 1.1,
    postPositionBias: 0.9,
  },
  '小倉': {
    // 小回り平坦、前残り傾向
    runningStyle: 1.4,        // 逃げ先行が非常に有利
    postPositionBias: 1.3,    // 内枠有利
    lastThreeFurlongs: 0.7,   // 直線短い
    speedRating: 1.2,
  },
  '新潟': {
    // 直線1000m、外回りは直線長い
    lastThreeFurlongs: 1.3,
    speedRating: 1.2,
    postPositionBias: 0.8,    // 外枠も不利少ない
    runningStyle: 0.9,        // 脚質の影響やや小
  },
  '札幌': {
    // 洋芝、スタミナ要求
    trackConditionAptitude: 1.3,
    distanceAptitude: 1.2,
    sireAptitude: 1.2,        // 洋芝適性は血統で決まりやすい
    speedRating: 0.9,
    weatherAptitude: 1.2,
  },
  '函館': {
    // 洋芝、小回り、前有利
    trackConditionAptitude: 1.3,
    sireAptitude: 1.2,
    runningStyle: 1.3,
    postPositionBias: 1.2,
    speedRating: 0.9,
    weatherAptitude: 1.2,
  },
  '福島': {
    // 小回り平坦、紛れが多い
    postPositionBias: 1.3,
    runningStyle: 1.2,
    consistency: 1.1,
    lastThreeFurlongs: 0.8,
  },
};

/**
 * 競馬場補正を適用して正規化
 * 未定義の競馬場はそのまま返す（乗数1.0扱い）
 */
export function applyVenueMultipliers(
  weights: Record<string, number>,
  racecourseName: string,
): Record<string, number> {
  const multipliers = VENUE_MULTIPLIERS[racecourseName];
  if (!multipliers) return weights;

  const adjusted: Record<string, number> = {};
  for (const [key, weight] of Object.entries(weights)) {
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
