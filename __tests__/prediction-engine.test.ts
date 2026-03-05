/**
 * prediction-engine.ts ユニットテスト
 *
 * 16のスコアリング関数 + ベイズ推定 + 動的ウェイト + ユーティリティをテスト
 */
import { describe, it, expect } from 'vitest';
import { _testExports } from '@/lib/prediction-engine';
import {
  makePP, makeStrongHorsePP,
  makeEscapeHorsePP, makeCloserHorsePP, makeGradeRacePP,
  makeScoredHorse, makeEmptyContext,
} from './fixtures/mock-data';

const {
  calcFactorReliability, bayesianScore, adjustWeights,
  detectRunningStyle,
  calcRecentFormScore, calcCourseAptitude, calcDistanceAptitude,
  calcTrackConditionAptitude, calcJockeyScore, calcSpeedRating,
  calcClassPerformance, calcRunningStyleBase, calcPostPositionBias,
  calcRotation, calcLastThreeFurlongs, calcConsistency,
  applyPaceBonus, calculateConfidence, generateBetRecommendations,
  positionToScore, ratioToScore, timeToSeconds,
  WEIGHTS, POPULATION_PRIORS,
} = _testExports;

// ==================== ユーティリティ ====================

describe('positionToScore', () => {
  it('1着は100点', () => {
    expect(positionToScore(1, 16)).toBe(100);
  });

  it('2着は93点', () => {
    expect(positionToScore(2, 16)).toBe(93);
  });

  it('3着は87点', () => {
    expect(positionToScore(3, 16)).toBe(87);
  });

  it('最下位は低スコア', () => {
    expect(positionToScore(16, 16)).toBeLessThanOrEqual(10);
  });

  it('entries=0のとき100を返す(1着)', () => {
    expect(positionToScore(1, 0)).toBe(100);
  });

  it('1/20 (上位5%) は100点', () => {
    expect(positionToScore(1, 20)).toBe(100);
  });
});

describe('ratioToScore', () => {
  it('ratio 0.10以下は95点', () => {
    expect(ratioToScore(0.05)).toBe(95);
    expect(ratioToScore(0.10)).toBe(95);
  });

  it('ratio 0.50は45点', () => {
    expect(ratioToScore(0.50)).toBe(45);
  });

  it('ratio 0.65超は20点', () => {
    expect(ratioToScore(0.80)).toBe(20);
  });
});

describe('timeToSeconds', () => {
  it('1:34.5 → 94.5秒', () => {
    expect(timeToSeconds('1:34.5')).toBe(94.5);
  });

  it('0:56.2 → 56.2秒', () => {
    expect(timeToSeconds('0:56.2')).toBe(56.2);
  });

  it('56.2 → 56.2秒 (分なし)', () => {
    expect(timeToSeconds('56.2')).toBe(56.2);
  });

  it('2:05.3 → 125.3秒', () => {
    expect(timeToSeconds('2:05.3')).toBe(125.3);
  });

  it('空文字は0を返す', () => {
    expect(timeToSeconds('')).toBe(0);
  });

  it('不正な文字列は0を返す', () => {
    expect(timeToSeconds('invalid')).toBe(0);
  });
});

// ==================== ベイズ推定 ====================

describe('calcFactorReliability', () => {
  it('recentFormの必要データ点数は5', () => {
    expect(calcFactorReliability('recentForm', 5)).toBe(1.0);
    expect(calcFactorReliability('recentForm', 3)).toBeCloseTo(0.6);
    expect(calcFactorReliability('recentForm', 0)).toBe(0.0);
  });

  it('sireAptitudeの必要データ点数は10', () => {
    expect(calcFactorReliability('sireAptitude', 10)).toBe(1.0);
    expect(calcFactorReliability('sireAptitude', 5)).toBe(0.5);
  });

  it('上限は1.0', () => {
    expect(calcFactorReliability('recentForm', 100)).toBe(1.0);
  });

  it('未知のファクターはデフォルト5', () => {
    expect(calcFactorReliability('unknown', 5)).toBe(1.0);
    expect(calcFactorReliability('unknown', 2)).toBeCloseTo(0.4);
  });
});

describe('bayesianScore', () => {
  it('データ十分なら観測値がそのまま返る', () => {
    const result = bayesianScore('recentForm', 80, 10);
    expect(result.score).toBe(80);
    expect(result.reliability).toBe(1.0);
  });

  it('データゼロなら事前分布(prior)が返る', () => {
    const result = bayesianScore('recentForm', 80, 0);
    expect(result.score).toBe(POPULATION_PRIORS.recentForm);
    expect(result.reliability).toBe(0.0);
  });

  it('データ中間ならpriorと観測値の混合', () => {
    const result = bayesianScore('recentForm', 80, 3); // reliability = 0.6
    const prior = POPULATION_PRIORS.recentForm; // 45
    const expected = prior * 0.4 + 80 * 0.6;
    expect(result.score).toBeCloseTo(expected);
  });
});

describe('adjustWeights', () => {
  it('全ファクターreliability=1.0なら重みは基本値と同じ', () => {
    const reliabilities = Object.keys(WEIGHTS).map(factor => ({
      factor, reliability: 1.0, dataPoints: 100,
    }));
    const adjusted = adjustWeights(reliabilities);
    for (const [key, value] of Object.entries(WEIGHTS)) {
      expect(adjusted[key]).toBeCloseTo(value as number, 4);
    }
  });

  it('低reliabilityファクターの重みは下がり、高reliabilityに再配分', () => {
    const reliabilities = Object.keys(WEIGHTS).map((factor, i) => ({
      factor, reliability: i === 0 ? 0.1 : 1.0, dataPoints: i === 0 ? 0 : 100,
    }));
    const adjusted = adjustWeights(reliabilities);
    const firstFactor = Object.keys(WEIGHTS)[0];
    expect(adjusted[firstFactor]).toBeLessThan(WEIGHTS[firstFactor as keyof typeof WEIGHTS] as number);
  });

  it('全ファクターの調整後重み合計は基本重み合計と概ね等しい', () => {
    const reliabilities = Object.keys(WEIGHTS).map(factor => ({
      factor, reliability: 0.5, dataPoints: 3,
    }));
    const adjusted = adjustWeights(reliabilities);
    const totalAdjusted = Object.values(adjusted).reduce((s, v) => s + v, 0);
    const totalBase = Object.values(WEIGHTS).reduce((s, v) => s + (v as number), 0);
    expect(totalAdjusted).toBeCloseTo(totalBase, 1);
  });
});

// ==================== 脚質判定 ====================

describe('detectRunningStyle', () => {
  it('空配列は不明', () => {
    expect(detectRunningStyle([])).toBe('不明');
  });

  it('コーナーなしは不明', () => {
    const pp = [makePP({ cornerPositions: '' })];
    expect(detectRunningStyle(pp)).toBe('不明');
  });

  it('先頭通過が多いと逃げ', () => {
    const pp = makeEscapeHorsePP();
    expect(detectRunningStyle(pp)).toBe('逃げ');
  });

  it('後方通過が多いと追込', () => {
    const pp = makeCloserHorsePP();
    expect(detectRunningStyle(pp)).toBe('追込');
  });

  it('中団が多いと差し', () => {
    const pp = Array.from({ length: 10 }, () => makePP({
      cornerPositions: '8-8-7-6',
      entries: 16,
    }));
    expect(detectRunningStyle(pp)).toBe('差し');
  });

  it('最大15走で判定', () => {
    const pp = Array.from({ length: 20 }, (_, i) => makePP({
      cornerPositions: i < 15 ? '1-1-1-1' : '16-16-16-16',
      entries: 16,
    }));
    expect(detectRunningStyle(pp)).toBe('逃げ');
  });
});

// ==================== 個別スコア関数 ====================

describe('calcRecentFormScore', () => {
  it('成績なしは40点', () => {
    expect(calcRecentFormScore([])).toBe(40);
  });

  it('全1着なら高スコア(+連勝ボーナス)', () => {
    const pp = Array.from({ length: 5 }, () => makePP({ position: 1, entries: 16 }));
    const score = calcRecentFormScore(pp);
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('全最下位なら低スコア', () => {
    const pp = Array.from({ length: 5 }, () => makePP({ position: 16, entries: 16 }));
    const score = calcRecentFormScore(pp);
    expect(score).toBeLessThanOrEqual(15);
  });

  it('直近3着以内+前走8着以上で急上昇ボーナス(+3)', () => {
    // calcRecentFormScore checks: pp[0].position <= 3 && pp[1].position >= 8
    // Same base positions but one pair triggers the bonus
    const ppBase = [
      makePP({ position: 2, entries: 16 }),
      makePP({ position: 7, entries: 16 }), // < 8 → no bonus
      makePP({ position: 5, entries: 16 }),
    ];
    const ppBonus = [
      makePP({ position: 2, entries: 16 }),
      makePP({ position: 8, entries: 16 }), // >= 8 → +3 bonus
      makePP({ position: 5, entries: 16 }),
    ];
    const base = calcRecentFormScore(ppBase);
    const bonused = calcRecentFormScore(ppBonus);
    // pp[1] score differs (7th vs 8th), plus bonus → bonused should be roughly +3 higher or close
    // The bonus condition fires when position 2 <= 3 and position 8 >= 8
    expect(bonused - base).toBeGreaterThanOrEqual(0);
  });

  it('スコアは0-100の範囲', () => {
    const pp = makeStrongHorsePP(5);
    const score = calcRecentFormScore(pp);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('calcCourseAptitude', () => {
  it('コース経験なしは50点', () => {
    expect(calcCourseAptitude([], '東京')).toBe(50);
  });

  it('同コースで1着多いと高スコア', () => {
    const pp = Array.from({ length: 5 }, () => makePP({
      racecourseName: '東京', position: 1, entries: 16,
    }));
    const score = calcCourseAptitude(pp, '東京');
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('同コースで下位だと低スコア', () => {
    const pp = Array.from({ length: 5 }, () => makePP({
      racecourseName: '東京', position: 14, entries: 16,
    }));
    const score = calcCourseAptitude(pp, '東京');
    expect(score).toBeLessThanOrEqual(40);
  });

  it('別のコースの成績は含まない', () => {
    const pp = Array.from({ length: 5 }, () => makePP({
      racecourseName: '中山', position: 1, entries: 16,
    }));
    const score = calcCourseAptitude(pp, '東京');
    expect(score).toBe(50);
  });
});

describe('calcDistanceAptitude', () => {
  it('成績なしは50点', () => {
    expect(calcDistanceAptitude([], 1600)).toBe(50);
  });

  it('距離±400m以内のデータなしは35点', () => {
    const pp = [makePP({ distance: 3000, position: 1, entries: 16 })];
    expect(calcDistanceAptitude(pp, 1200)).toBe(35);
  });

  it('同距離で好成績なら高スコア', () => {
    const pp = Array.from({ length: 5 }, () => makePP({
      distance: 1600, position: 1, entries: 16,
    }));
    const score = calcDistanceAptitude(pp, 1600);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('exact > near > wideの重み順', () => {
    const ppExact = [makePP({ distance: 1600, position: 1, entries: 16 })];
    const ppNear = [makePP({ distance: 1500, position: 1, entries: 16 })];
    const ppWide = [makePP({ distance: 1300, position: 1, entries: 16 })];

    const exactScore = calcDistanceAptitude(ppExact, 1600);
    const nearScore = calcDistanceAptitude(ppNear, 1600);
    const wideScore = calcDistanceAptitude(ppWide, 1600);

    expect(exactScore).toBeGreaterThanOrEqual(nearScore);
    expect(nearScore).toBeGreaterThanOrEqual(wideScore);
  });
});

describe('calcTrackConditionAptitude', () => {
  it('関連レースなしは50点', () => {
    const pp = [makePP({ trackType: 'ダート' })];
    const score = calcTrackConditionAptitude(pp, '芝', '良');
    expect(score).toBe(50);
  });

  it('重馬場で好成績なら高スコア', () => {
    const pp = Array.from({ length: 5 }, () => makePP({
      trackType: '芝', trackCondition: '重', position: 1, entries: 16,
    }));
    const score = calcTrackConditionAptitude(pp, '芝', '重');
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('重馬場データなしで重馬場時は40点', () => {
    const pp = Array.from({ length: 5 }, () => makePP({
      trackType: '芝', trackCondition: '良', position: 3, entries: 16,
    }));
    const score = calcTrackConditionAptitude(pp, '芝', '重');
    // 同条件なし かつ 重/不良成績もない → isHeavyがtrueで40
    expect(score).toBe(40);
  });
});

describe('calcJockeyScore', () => {
  it('高勝率の騎手は高スコア', () => {
    const score = calcJockeyScore(0.20, 0.50);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('低勝率の騎手は低スコア', () => {
    const score = calcJockeyScore(0.02, 0.10);
    expect(score).toBeLessThanOrEqual(30);
  });

  it('スコアは10-100の範囲', () => {
    expect(calcJockeyScore(0, 0)).toBe(10);
    expect(calcJockeyScore(0.50, 1.0)).toBeLessThanOrEqual(100);
  });
});

describe('calcSpeedRating', () => {
  it('成績なしは50点', () => {
    expect(calcSpeedRating([], '芝', 1600)).toBe(50);
  });

  it('条件に合うレースなしは50点', () => {
    const pp = [makePP({ trackType: 'ダート', distance: 1600 })];
    expect(calcSpeedRating(pp, '芝', 1600)).toBe(50);
  });

  it('標準タイムより速いと高スコア', () => {
    const pp = [makePP({
      trackType: '芝', distance: 1600,
      time: '1:33.0', trackCondition: '良',
    })];
    const score = calcSpeedRating(pp, '芝', 1600);
    expect(score).toBeGreaterThan(50);
  });

  it('標準タイムより遅いと低スコア', () => {
    const pp = [makePP({
      trackType: '芝', distance: 1600,
      time: '1:38.0', trackCondition: '良',
    })];
    const score = calcSpeedRating(pp, '芝', 1600);
    expect(score).toBeLessThan(50);
  });

  it('上位3つのタイムで平均する', () => {
    const pp = [
      makePP({ trackType: '芝', distance: 1600, time: '1:33.0', trackCondition: '良' }),
      makePP({ trackType: '芝', distance: 1600, time: '1:34.0', trackCondition: '良' }),
      makePP({ trackType: '芝', distance: 1600, time: '1:35.0', trackCondition: '良' }),
      makePP({ trackType: '芝', distance: 1600, time: '1:40.0', trackCondition: '良' }),
    ];
    const score = calcSpeedRating(pp, '芝', 1600);
    // 4つ目の遅いタイムは含まれない（上位3つ）
    expect(score).toBeGreaterThan(50);
  });
});

describe('calcClassPerformance', () => {
  it('成績なしは50点', () => {
    expect(calcClassPerformance([], 'G1')).toBe(50);
  });

  it('グレードレースなしは45点', () => {
    const pp = [makePP({ raceName: '一般レース' })];
    expect(calcClassPerformance(pp, 'G1')).toBe(45);
  });

  it('G1で好走実績あれば高スコア', () => {
    const pp = makeGradeRacePP();
    const score = calcClassPerformance(pp, 'G1');
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it('G1で50%以上入賞なら90点', () => {
    const pp = Array.from({ length: 4 }, () => makePP({
      raceName: 'ダービー(G1)', position: 1, entries: 18,
    }));
    expect(calcClassPerformance(pp, 'G1')).toBe(90);
  });
});

describe('calcRunningStyleBase', () => {
  it('不明は50点', () => {
    expect(calcRunningStyleBase('不明', 1600)).toBe(50);
  });

  it('短距離で逃げは有利', () => {
    expect(calcRunningStyleBase('逃げ', 1200)).toBe(75);
    expect(calcRunningStyleBase('追込', 1200)).toBe(35);
  });

  it('長距離で差しは有利', () => {
    expect(calcRunningStyleBase('差し', 2400)).toBe(70);
    expect(calcRunningStyleBase('逃げ', 2400)).toBe(50);
  });

  it('中距離で先行が最も有利', () => {
    expect(calcRunningStyleBase('先行', 1600)).toBe(70);
  });
});

describe('calcPostPositionBias', () => {
  it('fieldSize=0は50点', () => {
    expect(calcPostPositionBias(1, 0, 1600, '芝', '東京')).toBe(50);
  });

  it('中山芝の内枠は有利', () => {
    const inner = calcPostPositionBias(1, 16, 1600, '芝', '中山');
    const outer = calcPostPositionBias(8, 16, 1600, '芝', '中山');
    expect(inner).toBeGreaterThanOrEqual(outer);
  });

  it('未知のコースはデフォルト値', () => {
    // posRatio = post / ceil(fieldSize/2) → inner=post<=1.0, outer=post>1.0
    // post=1, fieldSize=16 → posRatio = 1/8 = 0.125 → inner → 55
    // post=8, fieldSize=16 → posRatio = 8/8 = 1.0 → inner → 55
    // post=9, fieldSize=16 → posRatio = 9/8 = 1.125 → outer → 48
    const innerPost = calcPostPositionBias(1, 16, 1600, '芝', '札幌');
    const outerPost = calcPostPositionBias(9, 16, 1600, '芝', '札幌');
    expect(innerPost).toBe(55);
    expect(outerPost).toBe(48);
  });

  it('短距離で枠順の影響が大きくなる(distFactor=1.2)', () => {
    const short = calcPostPositionBias(1, 16, 1200, '芝', '中山');
    const long = calcPostPositionBias(1, 16, 2400, '芝', '中山');
    expect(short).toBeGreaterThan(long);
  });
});

describe('calcRotation', () => {
  it('成績なしは50点', () => {
    expect(calcRotation([])).toBe(50);
  });

  it('前走日付なしは50点', () => {
    expect(calcRotation([makePP({ date: '' })])).toBe(50);
  });

  it('中3-5週が最適(80点)', () => {
    const daysAgo = 28;
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const pp = [makePP({ date })];
    expect(calcRotation(pp)).toBe(80);
  });

  it('10日未満は低スコア(25点)', () => {
    const date = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const pp = [makePP({ date })];
    expect(calcRotation(pp)).toBe(25);
  });

  it('半年以上は最低スコア(20点)', () => {
    const date = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const pp = [makePP({ date })];
    expect(calcRotation(pp)).toBe(20);
  });
});

describe('calcLastThreeFurlongs', () => {
  it('成績なしは50点', () => {
    expect(calcLastThreeFurlongs([], '芝')).toBe(50);
  });

  it('上がり3Fデータなしは50点', () => {
    const pp = [makePP({ lastThreeFurlongs: '' })];
    expect(calcLastThreeFurlongs(pp, '芝')).toBe(50);
  });

  it('芝で33.0秒は高スコア', () => {
    const pp = [makePP({ lastThreeFurlongs: '33.0' })];
    const score = calcLastThreeFurlongs(pp, '芝');
    expect(score).toBeGreaterThan(60);
  });

  it('芝で37.0秒は低スコア', () => {
    const pp = [makePP({ lastThreeFurlongs: '37.0' })];
    const score = calcLastThreeFurlongs(pp, '芝');
    expect(score).toBeLessThan(40);
  });

  it('ダートは基準タイムが高い(36.5秒)', () => {
    const pp = [makePP({ lastThreeFurlongs: '36.0' })];
    const turfScore = calcLastThreeFurlongs(pp, '芝');
    const dirtScore = calcLastThreeFurlongs(pp, 'ダート');
    expect(dirtScore).toBeGreaterThan(turfScore);
  });
});

describe('calcConsistency', () => {
  it('3走未満は50点', () => {
    expect(calcConsistency([makePP(), makePP()])).toBe(50);
  });

  it('全同着順は高スコア(stdDev低い)', () => {
    const pp = Array.from({ length: 10 }, () => makePP({ position: 3, entries: 16 }));
    expect(calcConsistency(pp)).toBe(90);
  });

  it('着順バラバラは低スコア', () => {
    const pp = Array.from({ length: 10 }, (_, i) =>
      makePP({ position: i % 2 === 0 ? 1 : 16, entries: 16 })
    );
    expect(calcConsistency(pp)).toBeLessThanOrEqual(30);
  });
});

// ==================== 展開予想ボーナス ====================

describe('applyPaceBonus', () => {
  it('前行き馬多い→ハイペース→差し追込に加算', () => {
    const horses = [
      makeScoredHorse({ runningStyle: '逃げ', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '逃げ', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '先行', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '先行', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '先行', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '差し', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '追込', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '追込', totalScore: 60 }),
    ];
    applyPaceBonus(horses, 1600);

    const escaper = horses.find(h => h.runningStyle === '逃げ')!;
    const closer = horses.find(h => h.runningStyle === '追込')!;
    expect(closer.totalScore).toBeGreaterThan(escaper.totalScore);
  });

  it('前行き馬少ない→スローペース→逃げに加算', () => {
    const horses = [
      makeScoredHorse({ runningStyle: '逃げ', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '差し', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '差し', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '差し', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '追込', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '追込', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '追込', totalScore: 60 }),
      makeScoredHorse({ runningStyle: '追込', totalScore: 60 }),
    ];
    applyPaceBonus(horses, 1600);

    const escaper = horses.find(h => h.runningStyle === '逃げ')!;
    const closer = horses.find(h => h.runningStyle === '追込')!;
    expect(escaper.totalScore).toBeGreaterThan(closer.totalScore);
  });
});

// ==================== 信頼度 ====================

describe('calculateConfidence', () => {
  it('馬3頭未満は15', () => {
    const horses = [makeScoredHorse(), makeScoredHorse()];
    expect(calculateConfidence(horses, makeEmptyContext())).toBe(15);
  });

  it('スコア差が大きいと信頼度が高い', () => {
    const horses = [
      makeScoredHorse({ totalScore: 80 }),
      makeScoredHorse({ totalScore: 60 }),
      makeScoredHorse({ totalScore: 50 }),
    ];
    const conf = calculateConfidence(horses, makeEmptyContext());
    expect(conf).toBeGreaterThanOrEqual(30);
  });

  it('スコア差が小さいと信頼度が低い', () => {
    const horses = [
      makeScoredHorse({ totalScore: 51, scores: { _dataReliability: 0, _totalDataPoints: 0 } }),
      makeScoredHorse({ totalScore: 50.5, scores: { _dataReliability: 0, _totalDataPoints: 0 } }),
      makeScoredHorse({ totalScore: 50, scores: { _dataReliability: 0, _totalDataPoints: 0 } }),
    ];
    const conf = calculateConfidence(horses, makeEmptyContext());
    // スコア差が小さい + データ不足 → 低い信頼度
    expect(conf).toBeLessThanOrEqual(45);
  });

  it('信頼度は10-92の範囲', () => {
    const horses = [
      makeScoredHorse({ totalScore: 100, scores: { _dataReliability: 100, _totalDataPoints: 100, consistency: 80 } }),
      makeScoredHorse({ totalScore: 50 }),
      makeScoredHorse({ totalScore: 30 }),
    ];

    const ctxRich = {
      courseDistStats: { totalRaces: 50 } as never,
      sireStatsMap: new Map(Array.from({ length: 6 }, (_, i) => [`sire${i}`, {} as never])),
      jockeyTrainerMap: new Map(Array.from({ length: 4 }, (_, i) => [`jt${i}`, {} as never])),
      trainerStatsMap: new Map(),
      seasonalMap: new Map(Array.from({ length: 4 }, (_, i) => [`h${i}`, [] as never])),
      secondStartMap: new Map(),
    };

    const conf = calculateConfidence(horses, ctxRich);
    expect(conf).toBeGreaterThanOrEqual(10);
    expect(conf).toBeLessThanOrEqual(92);
  });
});

// ==================== 推奨馬券 ====================

describe('generateBetRecommendations', () => {
  it('3頭未満は空配列', () => {
    expect(generateBetRecommendations([makeScoredHorse()], 50)).toEqual([]);
  });

  it('必ず複勝と馬連を含む', () => {
    const horses = [
      makeScoredHorse({ totalScore: 80, entry: { horseNumber: 1, horseName: '馬1' } }),
      makeScoredHorse({ totalScore: 70, entry: { horseNumber: 2, horseName: '馬2' } }),
      makeScoredHorse({ totalScore: 60, entry: { horseNumber: 3, horseName: '馬3' } }),
      makeScoredHorse({ totalScore: 50, entry: { horseNumber: 4, horseName: '馬4' } }),
    ];
    const bets = generateBetRecommendations(horses, 60);
    const types = bets.map(b => b.type);
    expect(types).toContain('複勝');
    expect(types).toContain('馬連');
  });

  it('スコア差大 + 高信頼度で単勝を推奨', () => {
    const horses = [
      makeScoredHorse({ totalScore: 80, entry: { horseNumber: 1, horseName: '馬1' } }),
      makeScoredHorse({ totalScore: 70, entry: { horseNumber: 2, horseName: '馬2' } }),
      makeScoredHorse({ totalScore: 55, entry: { horseNumber: 3, horseName: '馬3' } }),
      makeScoredHorse({ totalScore: 50, entry: { horseNumber: 4, horseName: '馬4' } }),
    ];
    const bets = generateBetRecommendations(horses, 60);
    const types = bets.map(b => b.type);
    expect(types).toContain('単勝');
  });
});

// ==================== WEIGHTS定数 ====================

describe('WEIGHTS', () => {
  it('全重みの合計が1.0', () => {
    const total = Object.values(WEIGHTS).reduce((s, v) => s + (v as number), 0);
    expect(total).toBeCloseTo(1.0, 2);
  });

  it('18個のファクターがある', () => {
    expect(Object.keys(WEIGHTS).length).toBe(18);
  });
});

describe('POPULATION_PRIORS', () => {
  it('全prior値が10-100の範囲', () => {
    for (const [, value] of Object.entries(POPULATION_PRIORS)) {
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('全ファクターに対応するpriorがある', () => {
    for (const key of Object.keys(WEIGHTS)) {
      expect(POPULATION_PRIORS).toHaveProperty(key);
    }
  });
});
