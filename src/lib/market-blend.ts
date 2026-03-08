/**
 * 市場オッズ統合モジュール
 *
 * モデル予測確率と市場オッズ暗示確率をlog-odds空間でブレンドし、
 * より精度の高い最終確率を算出する。
 * また、モデルと市場の乖離度を計算し「妙味馬」を検出する。
 */

export interface MarketDisagreement {
  horseNumber: number;
  modelProb: number;
  marketProb: number;
  blendedProb: number;
  disagreement: number; // modelProb - marketProb（正=モデルが高評価）
  isValueHorse: boolean;
  isOverbet: boolean;
}

/**
 * 単勝オッズから暗示確率を算出（オーバーラウンド除去→正規化）
 * @param oddsMap 馬番→単勝オッズのMap
 * @returns 馬番→暗示確率のMap + オーバーラウンド率
 */
export function oddsToImpliedProbabilities(
  oddsMap: Map<number, number>,
): { probs: Map<number, number>; overround: number } {
  const rawProbs = new Map<number, number>();
  let totalRaw = 0;

  for (const [horseNumber, odds] of oddsMap) {
    if (odds > 0) {
      const raw = 1 / odds;
      rawProbs.set(horseNumber, raw);
      totalRaw += raw;
    }
  }

  const overround = totalRaw;
  const probs = new Map<number, number>();

  // オーバーラウンド除去: 各確率を合計で割って正規化
  if (totalRaw > 0) {
    for (const [horseNumber, raw] of rawProbs) {
      probs.set(horseNumber, raw / totalRaw);
    }
  }

  return { probs, overround };
}

/**
 * log-odds空間でモデル確率と市場確率をブレンド
 *
 * logit(p) = ln(p / (1-p))
 * logit_blend = w_market * logit(p_market) + w_model * logit(p_model)
 * p_final = sigmoid(logit_blend) → 正規化
 *
 * @param modelProbs 馬番→モデル推定確率
 * @param marketProbs 馬番→市場暗示確率
 * @param marketWeight 市場確率の重み (0-1, デフォルト0.65)
 * @returns 馬番→ブレンド確率のMap
 */
export function blendProbabilities(
  modelProbs: Map<number, number>,
  marketProbs: Map<number, number>,
  marketWeight: number = 0.65,
): Map<number, number> {
  const modelWeight = 1 - marketWeight;
  const blended = new Map<number, number>();
  const EPSILON = 1e-6; // ゼロ除算防止

  // 全馬番を収集
  const allHorses = new Set([...modelProbs.keys(), ...marketProbs.keys()]);

  let totalBlended = 0;
  const rawBlended = new Map<number, number>();

  for (const horseNumber of allHorses) {
    const mp = modelProbs.get(horseNumber);
    const mk = marketProbs.get(horseNumber);

    if (mp !== undefined && mk !== undefined) {
      // 両方ある: log-oddsブレンド
      const clampedModel = Math.max(EPSILON, Math.min(1 - EPSILON, mp));
      const clampedMarket = Math.max(EPSILON, Math.min(1 - EPSILON, mk));

      const logitModel = Math.log(clampedModel / (1 - clampedModel));
      const logitMarket = Math.log(clampedMarket / (1 - clampedMarket));

      const logitBlend = modelWeight * logitModel + marketWeight * logitMarket;
      const prob = 1 / (1 + Math.exp(-logitBlend));
      rawBlended.set(horseNumber, prob);
      totalBlended += prob;
    } else if (mp !== undefined) {
      // モデルのみ: そのまま使用
      rawBlended.set(horseNumber, mp);
      totalBlended += mp;
    }
    // 市場のみで、モデルにない馬は除外（予想対象外）
  }

  // 正規化
  if (totalBlended > 0) {
    for (const [horseNumber, prob] of rawBlended) {
      blended.set(horseNumber, prob / totalBlended);
    }
  }

  return blended;
}

/**
 * モデルと市場の乖離度を計算
 */
export function computeDisagreement(
  modelProbs: Map<number, number>,
  marketProbs: Map<number, number>,
  blendedProbs: Map<number, number>,
  threshold: number = 0.03,
): Map<number, MarketDisagreement> {
  const result = new Map<number, MarketDisagreement>();

  for (const [horseNumber, modelProb] of modelProbs) {
    const marketProb = marketProbs.get(horseNumber);
    const blendedProb = blendedProbs.get(horseNumber);
    if (marketProb === undefined || blendedProb === undefined) continue;

    const disagreement = modelProb - marketProb;
    result.set(horseNumber, {
      horseNumber,
      modelProb,
      marketProb,
      blendedProb,
      disagreement,
      isValueHorse: disagreement >= threshold,
      isOverbet: disagreement <= -threshold,
    });
  }

  return result;
}

/**
 * 妙味馬を抽出（モデルが市場よりthreshold以上高評価の馬）
 */
export function findValueHorses(
  disagreements: Map<number, MarketDisagreement>,
  threshold: number = 0.03,
): number[] {
  const valueHorses: number[] = [];
  for (const [horseNumber, d] of disagreements) {
    if (d.disagreement >= threshold) {
      valueHorses.push(horseNumber);
    }
  }
  // 乖離度が大きい順にソート
  valueHorses.sort((a, b) => {
    const da = disagreements.get(a)!.disagreement;
    const db = disagreements.get(b)!.disagreement;
    return db - da;
  });
  return valueHorses;
}
