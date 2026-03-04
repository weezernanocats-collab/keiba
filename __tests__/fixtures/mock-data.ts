/**
 * テスト用モックデータ
 */
import type { PastPerformance, RaceEntry, TrackType, TrackCondition } from '@/types';

// --- PastPerformance ファクトリ ---

export function makePP(overrides: Partial<PastPerformance> = {}): PastPerformance {
  return {
    raceId: 'race001',
    date: '2025-01-15',
    raceName: 'テストレース',
    racecourseName: '東京',
    trackType: '芝',
    distance: 1600,
    trackCondition: '良',
    weather: '晴',
    entries: 16,
    postPosition: 3,
    horseNumber: 5,
    position: 3,
    jockeyName: 'テスト騎手',
    handicapWeight: 56,
    weight: 480,
    weightChange: 0,
    time: '1:34.5',
    margin: '0.5',
    lastThreeFurlongs: '34.0',
    cornerPositions: '5-5-4-3',
    odds: 5.0,
    popularity: 3,
    prize: 1000,
    ...overrides,
  };
}

/** 強い馬の成績 (1着多い) */
export function makeStrongHorsePP(count = 10): PastPerformance[] {
  return Array.from({ length: count }, (_, i) => makePP({
    date: `2025-0${Math.min(9, i + 1)}-15`,
    position: i < 5 ? 1 : (i < 8 ? 2 : 3),
    entries: 16,
    time: `1:3${3 + i % 3}.${i % 10}`,
    lastThreeFurlongs: `33.${i % 5}`,
    cornerPositions: '3-3-2-1',
    racecourseName: i % 2 === 0 ? '東京' : '中山',
    distance: 1600,
    trackType: '芝',
    trackCondition: i % 4 === 0 ? '重' : '良',
  }));
}

/** 弱い馬の成績 (下位多い) */
export function makeWeakHorsePP(count = 10): PastPerformance[] {
  return Array.from({ length: count }, (_, i) => makePP({
    date: `2025-0${Math.min(9, i + 1)}-15`,
    position: 10 + (i % 6),
    entries: 16,
    time: `1:3${6 + i % 3}.${i % 10}`,
    lastThreeFurlongs: `36.${i % 5}`,
    cornerPositions: '12-13-14-12',
    racecourseName: i % 3 === 0 ? '東京' : '小倉',
    distance: 1600,
    trackType: '芝',
    trackCondition: '良',
  }));
}

/** 逃げ馬の成績 */
export function makeEscapeHorsePP(count = 10): PastPerformance[] {
  return Array.from({ length: count }, (_, i) => makePP({
    date: `2025-0${Math.min(9, i + 1)}-15`,
    position: i < 4 ? 1 : (i < 7 ? 3 : 5),
    entries: 16,
    cornerPositions: '1-1-1-1',
    distance: 1200,
    trackType: '芝',
  }));
}

/** 追込馬の成績 */
export function makeCloserHorsePP(count = 10): PastPerformance[] {
  return Array.from({ length: count }, (_, i) => makePP({
    date: `2025-0${Math.min(9, i + 1)}-15`,
    position: i < 3 ? 1 : (i < 6 ? 4 : 8),
    entries: 16,
    cornerPositions: '14-14-12-5',
    distance: 2400,
    trackType: '芝',
  }));
}

/** G1/G2 出走実績あり */
export function makeGradeRacePP(count = 6): PastPerformance[] {
  const names = ['有馬記念(G1)', '天皇賞(G1)', '日本ダービー(G1)', 'オークス(G1)', '皐月賞ステークス(G2)', 'アルゼンチン共和国杯(G2)'];
  return Array.from({ length: count }, (_, i) => makePP({
    date: `2025-0${Math.min(9, i + 1)}-15`,
    raceName: names[i % names.length],
    position: i < 2 ? 1 : (i < 4 ? 3 : 6),
    entries: 18,
    distance: 2400,
  }));
}

// --- RaceEntry ファクトリ ---

export function makeEntry(overrides: Partial<RaceEntry> = {}): RaceEntry {
  return {
    postPosition: 3,
    horseNumber: 5,
    horseId: 'horse001',
    horseName: 'テストホース',
    age: 4,
    sex: '牡',
    weight: 480,
    jockeyId: 'jockey001',
    jockeyName: 'テスト騎手',
    trainerName: 'テスト調教師',
    handicapWeight: 56,
    odds: 5.0,
    popularity: 3,
    ...overrides,
  };
}

// --- ScoredHorse ファクトリ (簡易) ---

export function makeScoredHorse(overrides: Record<string, unknown> = {}) {
  const entry = makeEntry(overrides.entry as Partial<RaceEntry> || {});
  return {
    entry,
    totalScore: (overrides.totalScore as number) ?? 60,
    scores: {
      recentForm: 60, courseAptitude: 50, distanceAptitude: 55,
      trackConditionAptitude: 50, jockeyAbility: 50, speedRating: 55,
      classPerformance: 50, runningStyle: 50, postPositionBias: 50,
      rotation: 60, lastThreeFurlongs: 55, consistency: 55,
      sireAptitude: 50, jockeyTrainerCombo: 50, historicalPostBias: 50,
      seasonalPattern: 50,
      _dataReliability: 70, _totalDataPoints: 30,
      ...(overrides.scores as Record<string, number> || {}),
    },
    reasons: (overrides.reasons as string[]) || ['テスト理由'],
    runningStyle: (overrides.runningStyle as '逃げ' | '先行' | '差し' | '追込' | '不明') || '差し',
    fatherName: (overrides.fatherName as string) || 'テスト父馬',
  };
}

// --- RaceHistoricalContext モック ---

export function makeEmptyContext() {
  return {
    courseDistStats: null,
    sireStatsMap: new Map(),
    jockeyTrainerMap: new Map(),
    trainerStatsMap: new Map(),
    seasonalMap: new Map(),
    secondStartMap: new Map(),
  };
}
