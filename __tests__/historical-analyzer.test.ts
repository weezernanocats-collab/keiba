/**
 * historical-analyzer.ts ユニットテスト
 *
 * エクスポートされたスコア変換関数をテスト
 * (DB依存のbuildRaceContext等は統合テストで扱う)
 */
import { describe, it, expect } from 'vitest';
import {
  calcSireAptitudeScore,
  calcJockeyTrainerScore,
  calcHistoricalPostBias,
  calcSeasonalScore,
  calcSecondStartScore,
  type SireStats,
  type JockeyTrainerCombo,
  type CourseDistanceStats,
  type SeasonalStats,
  type SecondStartBonus,
} from '@/lib/historical-analyzer';

// ==================== calcSireAptitudeScore ====================

describe('calcSireAptitudeScore', () => {
  it('sireStatsがundefinedなら50点', () => {
    expect(calcSireAptitudeScore(undefined, '芝', 1600, '良')).toBe(50);
  });

  it('高勝率の種牡馬は高スコア', () => {
    const stats: SireStats = {
      sireName: 'ディープインパクト',
      totalRaces: 100,
      wins: 25,
      winRate: 0.25,
      placeRate: 0.50,
      turfStats: { races: 60, wins: 20, winRate: 0.33 },
      dirtStats: { races: 40, wins: 5, winRate: 0.125 },
      sprintStats: { races: 20, wins: 3, winRate: 0.15 },
      mileStats: { races: 30, wins: 10, winRate: 0.33 },
      middleStats: { races: 30, wins: 8, winRate: 0.27 },
      stayerStats: { races: 20, wins: 4, winRate: 0.20 },
      heavyStats: { races: 10, wins: 1, winRate: 0.10 },
    };
    const score = calcSireAptitudeScore(stats, '芝', 1600, '良');
    expect(score).toBeGreaterThan(60);
  });

  it('ダートが苦手な種牡馬はダートで低スコア', () => {
    const stats: SireStats = {
      sireName: 'テスト種牡馬',
      totalRaces: 50,
      wins: 5,
      winRate: 0.10,
      placeRate: 0.25,
      turfStats: { races: 30, wins: 5, winRate: 0.167 },
      dirtStats: { races: 20, wins: 0, winRate: 0.0 },
      sprintStats: { races: 15, wins: 2, winRate: 0.133 },
      mileStats: { races: 15, wins: 2, winRate: 0.133 },
      middleStats: { races: 10, wins: 1, winRate: 0.10 },
      stayerStats: { races: 10, wins: 0, winRate: 0.0 },
      heavyStats: { races: 5, wins: 0, winRate: 0.0 },
    };
    const turfScore = calcSireAptitudeScore(stats, '芝', 1600, '良');
    const dirtScore = calcSireAptitudeScore(stats, 'ダート', 1600, '良');
    expect(turfScore).toBeGreaterThan(dirtScore);
  });

  it('重馬場適性がプラスに反映', () => {
    const stats: SireStats = {
      sireName: '重馬場血統',
      totalRaces: 50,
      wins: 5,
      winRate: 0.10,
      placeRate: 0.25,
      turfStats: { races: 50, wins: 5, winRate: 0.10 },
      dirtStats: { races: 0, wins: 0, winRate: 0 },
      sprintStats: { races: 10, wins: 1, winRate: 0.10 },
      mileStats: { races: 20, wins: 2, winRate: 0.10 },
      middleStats: { races: 10, wins: 1, winRate: 0.10 },
      stayerStats: { races: 10, wins: 1, winRate: 0.10 },
      heavyStats: { races: 10, wins: 4, winRate: 0.40 },
    };
    const goodScore = calcSireAptitudeScore(stats, '芝', 1600, '良');
    const heavyScore = calcSireAptitudeScore(stats, '芝', 1600, '重');
    expect(heavyScore).toBeGreaterThan(goodScore);
  });

  it('距離帯ごとに適性が変わる', () => {
    const stats: SireStats = {
      sireName: 'スプリンター血統',
      totalRaces: 60,
      wins: 10,
      winRate: 0.167,
      placeRate: 0.30,
      turfStats: { races: 60, wins: 10, winRate: 0.167 },
      dirtStats: { races: 0, wins: 0, winRate: 0 },
      sprintStats: { races: 20, wins: 8, winRate: 0.40 },
      mileStats: { races: 20, wins: 2, winRate: 0.10 },
      middleStats: { races: 10, wins: 0, winRate: 0.0 },
      stayerStats: { races: 10, wins: 0, winRate: 0.0 },
      heavyStats: { races: 5, wins: 1, winRate: 0.20 },
    };
    const sprintScore = calcSireAptitudeScore(stats, '芝', 1200, '良');
    const stayerScore = calcSireAptitudeScore(stats, '芝', 2400, '良');
    expect(sprintScore).toBeGreaterThan(stayerScore);
  });

  it('スコアは10-100の範囲', () => {
    const extremeStats: SireStats = {
      sireName: 'テスト',
      totalRaces: 100,
      wins: 50,
      winRate: 0.50,
      placeRate: 0.80,
      turfStats: { races: 100, wins: 50, winRate: 0.50 },
      dirtStats: { races: 0, wins: 0, winRate: 0 },
      sprintStats: { races: 50, wins: 25, winRate: 0.50 },
      mileStats: { races: 25, wins: 15, winRate: 0.60 },
      middleStats: { races: 15, wins: 5, winRate: 0.33 },
      stayerStats: { races: 10, wins: 5, winRate: 0.50 },
      heavyStats: { races: 20, wins: 10, winRate: 0.50 },
    };
    const score = calcSireAptitudeScore(extremeStats, '芝', 1600, '重');
    expect(score).toBeGreaterThanOrEqual(10);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ==================== calcJockeyTrainerScore ====================

describe('calcJockeyTrainerScore', () => {
  it('undefinedなら50点', () => {
    expect(calcJockeyTrainerScore(undefined)).toBe(50);
  });

  it('レース数3未満は50点', () => {
    const combo: JockeyTrainerCombo = {
      totalRaces: 2, wins: 2, places: 2, winRate: 1.0, placeRate: 1.0,
    };
    expect(calcJockeyTrainerScore(combo)).toBe(50);
  });

  it('高勝率コンビは高スコア', () => {
    const combo: JockeyTrainerCombo = {
      totalRaces: 20, wins: 6, places: 12, winRate: 0.30, placeRate: 0.60,
    };
    const score = calcJockeyTrainerScore(combo);
    expect(score).toBeGreaterThan(70);
  });

  it('低勝率コンビは低スコア', () => {
    const combo: JockeyTrainerCombo = {
      totalRaces: 20, wins: 0, places: 2, winRate: 0.0, placeRate: 0.10,
    };
    const score = calcJockeyTrainerScore(combo);
    expect(score).toBeLessThan(50);
  });

  it('スコアは10-100の範囲', () => {
    const extreme: JockeyTrainerCombo = {
      totalRaces: 10, wins: 10, places: 10, winRate: 1.0, placeRate: 1.0,
    };
    expect(calcJockeyTrainerScore(extreme)).toBeLessThanOrEqual(100);
    expect(calcJockeyTrainerScore(extreme)).toBeGreaterThanOrEqual(10);
  });
});

// ==================== calcHistoricalPostBias ====================

describe('calcHistoricalPostBias', () => {
  it('statsがnullなら50点', () => {
    expect(calcHistoricalPostBias(null, 3)).toBe(50);
  });

  it('データ少(5未満)なら50点', () => {
    const stats: CourseDistanceStats = {
      totalRaces: 3,
      postPositionWinRate: {},
      innerFrameWinRate: 0.15,
      outerFrameWinRate: 0.05,
      avgWinLast3F: 34.0,
      frontRunnerRate: 0.5,
    };
    expect(calcHistoricalPostBias(stats, 3)).toBe(50);
  });

  it('枠別データありで高勝率枠は高スコア', () => {
    const stats: CourseDistanceStats = {
      totalRaces: 100,
      postPositionWinRate: {
        1: { races: 20, wins: 5, rate: 0.25 },
        8: { races: 20, wins: 1, rate: 0.05 },
      },
      innerFrameWinRate: 0.12,
      outerFrameWinRate: 0.06,
      avgWinLast3F: 34.0,
      frontRunnerRate: 0.5,
    };
    const inner = calcHistoricalPostBias(stats, 1);
    const outer = calcHistoricalPostBias(stats, 8);
    expect(inner).toBeGreaterThan(outer);
  });

  it('枠別データなしの場合、内外の勝率で判定', () => {
    const stats: CourseDistanceStats = {
      totalRaces: 100,
      postPositionWinRate: {},
      innerFrameWinRate: 0.15,
      outerFrameWinRate: 0.05,
      avgWinLast3F: 34.0,
      frontRunnerRate: 0.5,
    };
    const inner = calcHistoricalPostBias(stats, 2); // postPosition <= 4 → inner
    const outer = calcHistoricalPostBias(stats, 6); // postPosition > 4 → outer
    expect(inner).toBeGreaterThan(outer);
  });
});

// ==================== calcSeasonalScore ====================

describe('calcSeasonalScore', () => {
  it('データなしは50点', () => {
    expect(calcSeasonalScore(undefined, 6)).toBe(50);
  });

  it('3ヶ月未満は50点', () => {
    const stats: SeasonalStats[] = [
      { month: 1, races: 5, wins: 2, places: 3, winRate: 0.4, placeRate: 0.6 },
      { month: 6, races: 3, wins: 1, places: 2, winRate: 0.33, placeRate: 0.67 },
    ];
    expect(calcSeasonalScore(stats, 6)).toBe(50);
  });

  it('対象月のデータなしは50点', () => {
    const stats: SeasonalStats[] = [
      { month: 1, races: 5, wins: 2, places: 3, winRate: 0.4, placeRate: 0.6 },
      { month: 3, races: 3, wins: 1, places: 2, winRate: 0.33, placeRate: 0.67 },
      { month: 6, races: 4, wins: 1, places: 2, winRate: 0.25, placeRate: 0.5 },
    ];
    expect(calcSeasonalScore(stats, 9)).toBe(50);
  });

  it('得意月は高スコア', () => {
    const stats: SeasonalStats[] = [
      { month: 1, races: 5, wins: 0, places: 1, winRate: 0.0, placeRate: 0.2 },
      { month: 3, races: 5, wins: 0, places: 1, winRate: 0.0, placeRate: 0.2 },
      { month: 6, races: 5, wins: 4, places: 5, winRate: 0.80, placeRate: 1.0 },
      { month: 9, races: 5, wins: 0, places: 1, winRate: 0.0, placeRate: 0.2 },
    ];
    const score = calcSeasonalScore(stats, 6);
    expect(score).toBeGreaterThan(60);
  });

  it('苦手月は低スコア', () => {
    const stats: SeasonalStats[] = [
      { month: 1, races: 5, wins: 3, places: 4, winRate: 0.60, placeRate: 0.8 },
      { month: 3, races: 5, wins: 3, places: 4, winRate: 0.60, placeRate: 0.8 },
      { month: 6, races: 5, wins: 0, places: 0, winRate: 0.0, placeRate: 0.0 },
      { month: 9, races: 5, wins: 3, places: 4, winRate: 0.60, placeRate: 0.8 },
    ];
    const score = calcSeasonalScore(stats, 6);
    expect(score).toBeLessThan(40);
  });
});

// ==================== calcSecondStartScore ====================

describe('calcSecondStartScore', () => {
  it('bonusがnullなら50点', () => {
    expect(calcSecondStartScore(null, 30, true)).toBe(50);
  });

  it('sampleSize < 2なら50点', () => {
    const bonus: SecondStartBonus = {
      firstStartAvgPos: 0.5, secondStartAvgPos: 0.3, improvement: 0.2, sampleSize: 1,
    };
    expect(calcSecondStartScore(bonus, 30, true)).toBe(50);
  });

  it('叩き2走目でないなら50点', () => {
    const bonus: SecondStartBonus = {
      firstStartAvgPos: 0.5, secondStartAvgPos: 0.3, improvement: 0.2, sampleSize: 3,
    };
    expect(calcSecondStartScore(bonus, 30, false)).toBe(50);
  });

  it('改善パターンあり(improvement > 0.05)は高スコア', () => {
    const bonus: SecondStartBonus = {
      firstStartAvgPos: 0.5, secondStartAvgPos: 0.25, improvement: 0.25, sampleSize: 5,
    };
    const score = calcSecondStartScore(bonus, 30, true);
    expect(score).toBeGreaterThan(60);
  });

  it('悪化パターン(improvement < -0.05)は低スコア', () => {
    const bonus: SecondStartBonus = {
      firstStartAvgPos: 0.3, secondStartAvgPos: 0.6, improvement: -0.3, sampleSize: 5,
    };
    const score = calcSecondStartScore(bonus, 30, true);
    expect(score).toBeLessThan(45);
  });

  it('改善微小(±0.05以内)は50点', () => {
    const bonus: SecondStartBonus = {
      firstStartAvgPos: 0.4, secondStartAvgPos: 0.38, improvement: 0.02, sampleSize: 5,
    };
    expect(calcSecondStartScore(bonus, 30, true)).toBe(50);
  });

  it('スコアは30-85の範囲', () => {
    const bigImprovement: SecondStartBonus = {
      firstStartAvgPos: 0.8, secondStartAvgPos: 0.1, improvement: 0.7, sampleSize: 10,
    };
    expect(calcSecondStartScore(bigImprovement, 30, true)).toBeLessThanOrEqual(85);
    expect(calcSecondStartScore(bigImprovement, 30, true)).toBeGreaterThanOrEqual(30);
  });
});
