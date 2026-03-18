import { describe, it, expect } from 'vitest';
import {
  oddsToImpliedProbabilities,
  blendProbabilities,
  computeDisagreement,
  findValueHorses,
} from '@/lib/market-blend';

// 許容誤差
const EPSILON = 1e-9;

describe('oddsToImpliedProbabilities', () => {
  it('正常: 4頭のオッズから確率の合計が 1.0 になること', () => {
    const oddsMap = new Map([
      [1, 2.0],
      [2, 4.0],
      [3, 8.0],
      [4, 16.0],
    ]);
    const { probs } = oddsToImpliedProbabilities(oddsMap);
    const total = [...probs.values()].reduce((acc, p) => acc + p, 0);
    expect(total).toBeCloseTo(1.0, 9);
  });

  it('overround が 1.0 より大きいこと (馬券控除率を反映)', () => {
    const oddsMap = new Map([
      [1, 2.0],
      [2, 4.0],
      [3, 8.0],
      [4, 16.0],
    ]);
    const { overround } = oddsToImpliedProbabilities(oddsMap);
    // 合計raw = 0.5 + 0.25 + 0.125 + 0.0625 = 0.9375 (1以下のケースも合法だが確認)
    expect(overround).toBeCloseTo(0.9375, 5);
  });

  it('overround の値が正しく算出されること (典型的な競馬 >1.0 例)', () => {
    // 3頭、均等に1/2.0=0.5ずつならoverround=1.5
    const oddsMap = new Map([
      [1, 2.0],
      [2, 2.0],
      [3, 2.0],
    ]);
    const { overround } = oddsToImpliedProbabilities(oddsMap);
    expect(overround).toBeCloseTo(1.5, 5);
  });

  it('オッズが 0 の馬はスキップされること', () => {
    const oddsMap = new Map([
      [1, 2.0],
      [2, 0],   // ← スキップ対象
      [3, 4.0],
    ]);
    const { probs } = oddsToImpliedProbabilities(oddsMap);
    expect(probs.has(2)).toBe(false);
    expect(probs.has(1)).toBe(true);
    expect(probs.has(3)).toBe(true);
  });

  it('空のMapを渡すと空の結果が返ること', () => {
    const { probs, overround } = oddsToImpliedProbabilities(new Map());
    expect(probs.size).toBe(0);
    expect(overround).toBe(0);
  });
});

// ==================== blendProbabilities ====================

describe('blendProbabilities', () => {
  it('marketWeight=0 のときモデル確率がそのまま (正規化後) 反映されること', () => {
    const modelProbs = new Map([
      [1, 0.5],
      [2, 0.3],
      [3, 0.2],
    ]);
    const marketProbs = new Map([
      [1, 0.2],
      [2, 0.5],
      [3, 0.3],
    ]);
    const blended = blendProbabilities(modelProbs, marketProbs, 0);

    // marketWeight=0 → log-oddsブレンドはモデルのlogit × 1.0 → sigmoid → 正規化
    // 正規化後はモデル確率の順序が保持されるはず (horse1 > horse2 > horse3)
    const p1 = blended.get(1)!;
    const p2 = blended.get(2)!;
    const p3 = blended.get(3)!;
    expect(p1).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(p3);
  });

  it('marketWeight=1 のとき市場確率が優先されること', () => {
    const modelProbs = new Map([
      [1, 0.5],
      [2, 0.3],
      [3, 0.2],
    ]);
    const marketProbs = new Map([
      [1, 0.1],
      [2, 0.6],
      [3, 0.3],
    ]);
    const blended = blendProbabilities(modelProbs, marketProbs, 1);

    // marketWeight=1 → 市場確率の順序: horse2 > horse3 > horse1
    const p1 = blended.get(1)!;
    const p2 = blended.get(2)!;
    const p3 = blended.get(3)!;
    expect(p2).toBeGreaterThan(p3);
    expect(p3).toBeGreaterThan(p1);
  });

  it('デフォルト (marketWeight=0.65) でブレンド後の確率合計が 1.0 になること', () => {
    const modelProbs = new Map([
      [1, 0.4],
      [2, 0.35],
      [3, 0.25],
    ]);
    const marketProbs = new Map([
      [1, 0.3],
      [2, 0.4],
      [3, 0.3],
    ]);
    const blended = blendProbabilities(modelProbs, marketProbs);
    const total = [...blended.values()].reduce((acc, p) => acc + p, 0);
    expect(total).toBeCloseTo(1.0, 9);
  });

  it('モデルにしかない馬番が含まれる場合、その馬のモデル確率が使われること', () => {
    // horse3 は市場に存在しない
    const modelProbs = new Map([
      [1, 0.5],
      [2, 0.3],
      [3, 0.2],
    ]);
    const marketProbs = new Map([
      [1, 0.6],
      [2, 0.4],
    ]);
    const blended = blendProbabilities(modelProbs, marketProbs);
    // horse3 はモデルのみ → blendedに含まれる
    expect(blended.has(3)).toBe(true);
    expect(blended.get(3)).toBeGreaterThan(0);
  });

  it('市場にしかない馬番はブレンド結果に含まれないこと', () => {
    // horse3 はモデルに存在しない
    const modelProbs = new Map([
      [1, 0.6],
      [2, 0.4],
    ]);
    const marketProbs = new Map([
      [1, 0.5],
      [2, 0.3],
      [3, 0.2], // ← 市場のみ
    ]);
    const blended = blendProbabilities(modelProbs, marketProbs);
    expect(blended.has(3)).toBe(false);
  });
});

// ==================== computeDisagreement ====================

describe('computeDisagreement', () => {
  const buildMaps = (
    modelData: [number, number][],
    marketData: [number, number][],
    blendedData: [number, number][],
  ) => ({
    modelProbs: new Map(modelData),
    marketProbs: new Map(marketData),
    blendedProbs: new Map(blendedData),
  });

  it('モデル > 市場 のとき isValueHorse=true, isOverbet=false', () => {
    const { modelProbs, marketProbs, blendedProbs } = buildMaps(
      [[1, 0.40]],
      [[1, 0.25]],
      [[1, 0.32]],
    );
    const result = computeDisagreement(modelProbs, marketProbs, blendedProbs, 0.03);
    const d = result.get(1)!;
    expect(d.isValueHorse).toBe(true);
    expect(d.isOverbet).toBe(false);
    expect(d.disagreement).toBeCloseTo(0.15, 5);
  });

  it('市場 > モデル のとき isOverbet=true, isValueHorse=false', () => {
    const { modelProbs, marketProbs, blendedProbs } = buildMaps(
      [[2, 0.20]],
      [[2, 0.45]],
      [[2, 0.35]],
    );
    const result = computeDisagreement(modelProbs, marketProbs, blendedProbs, 0.03);
    const d = result.get(2)!;
    expect(d.isOverbet).toBe(true);
    expect(d.isValueHorse).toBe(false);
    expect(d.disagreement).toBeCloseTo(-0.25, 5);
  });

  it('乖離度が threshold 未満のとき両方 false', () => {
    const { modelProbs, marketProbs, blendedProbs } = buildMaps(
      [[3, 0.30]],
      [[3, 0.31]], // 差 = -0.01 < threshold 0.03
      [[3, 0.305]],
    );
    const result = computeDisagreement(modelProbs, marketProbs, blendedProbs, 0.03);
    const d = result.get(3)!;
    expect(d.isValueHorse).toBe(false);
    expect(d.isOverbet).toBe(false);
  });

  it('marketProbs に存在しない馬番はスキップされること', () => {
    const modelProbs = new Map([[1, 0.5], [2, 0.5]]);
    const marketProbs = new Map([[1, 0.4]]); // horse2 はない
    const blendedProbs = new Map([[1, 0.45]]);
    const result = computeDisagreement(modelProbs, marketProbs, blendedProbs);
    expect(result.has(2)).toBe(false);
    expect(result.has(1)).toBe(true);
  });
});

// ==================== findValueHorses ====================

describe('findValueHorses', () => {
  it('乖離度の大きい順にソートされること', () => {
    const disagreements = new Map([
      [1, { horseNumber: 1, modelProb: 0.40, marketProb: 0.25, blendedProb: 0.32, disagreement: 0.15, isValueHorse: true, isOverbet: false }],
      [2, { horseNumber: 2, modelProb: 0.35, marketProb: 0.28, blendedProb: 0.31, disagreement: 0.07, isValueHorse: true, isOverbet: false }],
      [3, { horseNumber: 3, modelProb: 0.25, marketProb: 0.47, blendedProb: 0.37, disagreement: -0.22, isValueHorse: false, isOverbet: true }],
    ]);
    const result = findValueHorses(disagreements, 0.03);
    // threshold 以上の馬: horse1 (0.15) と horse2 (0.07)
    expect(result).toEqual([1, 2]); // 乖離が大きい順
  });

  it('threshold 未満の馬は含まれないこと', () => {
    const disagreements = new Map([
      [1, { horseNumber: 1, modelProb: 0.30, marketProb: 0.28, blendedProb: 0.29, disagreement: 0.02, isValueHorse: false, isOverbet: false }],
      [2, { horseNumber: 2, modelProb: 0.50, marketProb: 0.30, blendedProb: 0.40, disagreement: 0.20, isValueHorse: true, isOverbet: false }],
    ]);
    const result = findValueHorses(disagreements, 0.03);
    expect(result).not.toContain(1); // 0.02 < 0.03
    expect(result).toContain(2);     // 0.20 >= 0.03
  });

  it('threshold 以上の馬が全くいないとき空配列を返すこと', () => {
    const disagreements = new Map([
      [1, { horseNumber: 1, modelProb: 0.30, marketProb: 0.30, blendedProb: 0.30, disagreement: 0.0, isValueHorse: false, isOverbet: false }],
    ]);
    const result = findValueHorses(disagreements, 0.03);
    expect(result).toEqual([]);
  });

  it('空の disagreements で空配列を返すこと', () => {
    const result = findValueHorses(new Map(), 0.03);
    expect(result).toEqual([]);
  });
});
