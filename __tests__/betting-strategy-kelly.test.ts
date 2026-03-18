import { describe, it, expect } from 'vitest';
import {
  calcKellyFraction,
  calcValueEdge,
  calcRecommendedStake,
  classifyRacePattern,
  KELLY_FRACTION_DIVISOR,
  MAX_STAKE_FRACTION,
  type ScoredHorse,
} from '@/lib/betting-strategy';
import type { RaceEntry } from '@/types';

// ==================== テストヘルパー ====================

/** ScoredHorse のモック生成 */
function makeScoredHorse(
  horseNumber: number,
  totalScore: number,
  overrides: Partial<ScoredHorse> = {},
): ScoredHorse {
  const entry: RaceEntry = {
    postPosition: horseNumber,
    horseNumber,
    horseId: `horse-${horseNumber}`,
    horseName: `馬${horseNumber}`,
    age: 4,
    sex: '牡',
    jockeyId: `jockey-${horseNumber}`,
    jockeyName: `騎手${horseNumber}`,
    trainerName: `調教師${horseNumber}`,
    handicapWeight: 55,
    odds: 5.0,
  };

  return {
    entry,
    totalScore,
    scores: { consistency: 50 },
    reasons: [],
    runningStyle: '先行',
    escapeRate: 10,
    fatherName: 'テスト種牡馬',
    ...overrides,
  };
}

// ==================== calcKellyFraction ====================

describe('calcKellyFraction', () => {
  it('正のエッジ: prob=0.3, odds=4 → Kelly > 0', () => {
    // b = 3, fullKelly = (3*0.3 - 0.7) / 3 = (0.9 - 0.7) / 3 ≈ 0.0667
    const result = calcKellyFraction(0.3, 4);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo(0.0667, 3);
  });

  it('負のエッジ: prob=0.1, odds=2 → Kelly = 0 (マイナスにクランプ)', () => {
    // b = 1, fullKelly = (1*0.1 - 0.9) / 1 = -0.8 → 0にクランプ
    const result = calcKellyFraction(0.1, 2);
    expect(result).toBe(0);
  });

  it('odds <= 1 → Kelly = 0', () => {
    expect(calcKellyFraction(0.5, 1.0)).toBe(0);
    expect(calcKellyFraction(0.5, 0.8)).toBe(0);
  });

  it('prob = 0 → Kelly = 0', () => {
    expect(calcKellyFraction(0, 5)).toBe(0);
  });

  it('prob=1, odds=2 → Kelly = 1.0 (フルベット)', () => {
    // b = 1, fullKelly = (1*1 - 0) / 1 = 1.0
    const result = calcKellyFraction(1, 2);
    expect(result).toBeCloseTo(1.0, 9);
  });

  it('prob と odds が妥当な値なら結果が 0〜1 の範囲に収まること', () => {
    const result = calcKellyFraction(0.25, 6);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ==================== calcValueEdge ====================

describe('calcValueEdge', () => {
  it('prob=0.3, odds=4 → edge = 0.2 (期待値 1.2)', () => {
    // edge = 0.3 * 4 - 1 = 1.2 - 1 = 0.2
    const result = calcValueEdge(0.3, 4);
    expect(result).toBeCloseTo(0.2, 9);
  });

  it('期待値が 1.0 を下回る場合、負の edge が返ること', () => {
    // prob=0.2, odds=3 → edge = 0.6 - 1 = -0.4
    const result = calcValueEdge(0.2, 3);
    expect(result).toBeLessThan(0);
    expect(result).toBeCloseTo(-0.4, 9);
  });

  it('フェアオッズ (prob=0.5, odds=2) → edge = 0', () => {
    const result = calcValueEdge(0.5, 2);
    expect(result).toBeCloseTo(0, 9);
  });

  it('prob = 0 → -1 を返すこと', () => {
    expect(calcValueEdge(0, 5)).toBe(-1);
  });

  it('odds = 0 → -1 を返すこと', () => {
    expect(calcValueEdge(0.3, 0)).toBe(-1);
  });
});

// ==================== calcRecommendedStake ====================

describe('calcRecommendedStake', () => {
  it('Fractional Kelly (1/4) が適用されること', () => {
    // kelly=0.4 → fractional=0.4/4=0.1 < MAX_STAKE_FRACTION(0.25)
    const result = calcRecommendedStake(0.4);
    expect(result).toBeCloseTo(0.4 / KELLY_FRACTION_DIVISOR, 9);
  });

  it('MAX_STAKE_FRACTION (25%) でキャップされること', () => {
    // kelly=1.5 → fractional=0.375 > 0.25 → 0.25にキャップ
    const result = calcRecommendedStake(1.5);
    expect(result).toBe(MAX_STAKE_FRACTION);
    expect(result).toBe(0.25);
  });

  it('kelly=0 → stake=0', () => {
    expect(calcRecommendedStake(0)).toBe(0);
  });

  it('KELLY_FRACTION_DIVISOR が 4 であること (定数確認)', () => {
    expect(KELLY_FRACTION_DIVISOR).toBe(4);
  });

  it('MAX_STAKE_FRACTION が 0.25 であること (定数確認)', () => {
    expect(MAX_STAKE_FRACTION).toBe(0.25);
  });

  it('小さな kelly 値では fractional がそのまま返ること', () => {
    // kelly=0.08 → fractional=0.02 < 0.25
    const result = calcRecommendedStake(0.08);
    expect(result).toBeCloseTo(0.02, 9);
  });
});

// ==================== classifyRacePattern ====================

describe('classifyRacePattern', () => {
  it('1位と2位のスコア差が 6pt 以上 → 一強', () => {
    const horses = [
      makeScoredHorse(1, 90), // gap12 = 7
      makeScoredHorse(2, 83),
      makeScoredHorse(3, 79),
      makeScoredHorse(4, 70),
    ];
    const { pattern, gap12 } = classifyRacePattern(horses);
    expect(pattern).toBe('一強');
    expect(gap12).toBe(7);
  });

  it('上位2頭が僅差 (gap12 < 3) で3位以下が離れている (gap23 >= 4) → 二強', () => {
    const horses = [
      makeScoredHorse(1, 85), // gap12 = 2
      makeScoredHorse(2, 83), // gap23 = 5
      makeScoredHorse(3, 78),
      makeScoredHorse(4, 70),
    ];
    const { pattern, gap12, gap23 } = classifyRacePattern(horses);
    expect(pattern).toBe('二強');
    expect(gap12).toBe(2);
    expect(gap23).toBe(5);
  });

  it('上位3頭が拮抗 (gap12 < 4, gap23 < 4) で4位以下と離れている (gap34 >= 4) → 三つ巴', () => {
    const horses = [
      makeScoredHorse(1, 83), // gap12 = 2
      makeScoredHorse(2, 81), // gap23 = 3
      makeScoredHorse(3, 78), // gap34 = 6
      makeScoredHorse(4, 72),
    ];
    const { pattern } = classifyRacePattern(horses);
    expect(pattern).toBe('三つ巴');
  });

  it('上位4頭すべてが僅差 (gap34 < 4) → 大混戦', () => {
    const horses = [
      makeScoredHorse(1, 80), // gap12 = 1
      makeScoredHorse(2, 79), // gap23 = 1
      makeScoredHorse(3, 78), // gap34 = 2
      makeScoredHorse(4, 76),
    ];
    const { pattern } = classifyRacePattern(horses);
    expect(pattern).toBe('大混戦');
  });

  it('gap12 が 3-5 の場合 → 混戦', () => {
    // gap12=4 (一強未満=6), gap23=2 (二強未満: gap12<3が必要)
    // → 一強でも二強でも三つ巴でも大混戦でもない → 混戦
    const horses = [
      makeScoredHorse(1, 84), // gap12 = 4
      makeScoredHorse(2, 80), // gap23 = 2
      makeScoredHorse(3, 78), // gap34 = 1
      makeScoredHorse(4, 77),
    ];
    const { pattern } = classifyRacePattern(horses);
    expect(pattern).toBe('混戦');
  });

  it('gap12, gap23, gap34 の値が正しく計算されること', () => {
    const horses = [
      makeScoredHorse(1, 100),
      makeScoredHorse(2, 92),
      makeScoredHorse(3, 85),
      makeScoredHorse(4, 80),
    ];
    const { gap12, gap23, gap34 } = classifyRacePattern(horses);
    expect(gap12).toBe(8);
    expect(gap23).toBe(7);
    expect(gap34).toBe(5);
  });

  it('4頭未満のとき gap34 が 999 になること', () => {
    const horses = [
      makeScoredHorse(1, 90),
      makeScoredHorse(2, 83),
      makeScoredHorse(3, 79),
    ];
    const { gap34 } = classifyRacePattern(horses);
    expect(gap34).toBe(999);
  });
});
