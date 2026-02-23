/**
 * database.ts + queries.ts 統合テスト
 *
 * インメモリSQLiteを使用して実際のDB操作をテスト
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ensureInitialized, dbAll, dbGet, dbRun, dbRunNamed, dbBatch, dbExec, closeDatabase,
} from '@/lib/database';
import {
  upsertRace, getRaceById, getRacesByDate, getUpcomingRaces,
  upsertHorse, getHorseById, searchHorses, getAllHorses,
  upsertJockey, getJockeyById, searchJockeys,
  upsertRaceEntry,
  insertPastPerformance, getHorsePastPerformances,
  savePrediction, getPredictionByRaceId,
  upsertOdds, getOddsByRaceId,
  getDashboardStats,
  seedRacecourses, getAllRacecourses,
  setHorseTraits,
} from '@/lib/queries';

// テスト用にインメモリDBを使用（環境変数未設定でローカルファイル使用）
// テストはDB状態に依存するため順番に実行

beforeAll(async () => {
  // ローカルファイルDBで初期化（テストごとに新しいDB）
  await ensureInitialized();
});

afterAll(async () => {
  await closeDatabase();
});

// ==================== DB基本操作 ====================

describe('database helpers', () => {
  it('ensureInitialized でテーブルが作成される', async () => {
    const tables = await dbAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = tables.map(t => t.name);
    expect(names).toContain('races');
    expect(names).toContain('horses');
    expect(names).toContain('jockeys');
    expect(names).toContain('race_entries');
    expect(names).toContain('past_performances');
    expect(names).toContain('predictions');
    expect(names).toContain('odds');
    expect(names).toContain('horse_traits');
    expect(names).toContain('prediction_results');
  });

  it('dbRun で INSERT が実行できる', async () => {
    const result = await dbRun(
      "INSERT OR IGNORE INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?)",
      ['test_course', 'テスト競馬場', '中央', '東京都']
    );
    expect(result.rowsAffected).toBeGreaterThanOrEqual(0);
  });

  it('dbGet で SELECT が実行できる', async () => {
    const row = await dbGet<{ name: string }>(
      "SELECT name FROM racecourses WHERE id = ?", ['test_course']
    );
    expect(row?.name).toBe('テスト競馬場');
  });

  it('dbAll で複数行取得', async () => {
    await dbRun(
      "INSERT OR IGNORE INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?)",
      ['test_course2', 'テスト競馬場2', '地方', '大阪府']
    );
    const rows = await dbAll<{ id: string }>(
      "SELECT id FROM racecourses WHERE id LIKE 'test_%'"
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('dbRunNamed で名前付きパラメータが使える', async () => {
    const result = await dbRunNamed(
      "INSERT OR REPLACE INTO racecourses (id, name, region, prefecture) VALUES (@id, @name, @region, @pref)",
      { id: 'named_test', name: 'NamedTest', region: '中央', pref: '千葉県' }
    );
    expect(result.rowsAffected).toBeGreaterThanOrEqual(1);

    const row = await dbGet<{ name: string }>(
      "SELECT name FROM racecourses WHERE id = ?", ['named_test']
    );
    expect(row?.name).toBe('NamedTest');
  });

  it('dbBatch で複数文をバッチ実行', async () => {
    await dbBatch([
      { sql: "INSERT OR IGNORE INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?)", args: ['batch1', 'Batch1', '中央', '東京都'] },
      { sql: "INSERT OR IGNORE INTO racecourses (id, name, region, prefecture) VALUES (?, ?, ?, ?)", args: ['batch2', 'Batch2', '地方', '大阪府'] },
    ]);

    const rows = await dbAll<{ id: string }>(
      "SELECT id FROM racecourses WHERE id IN ('batch1', 'batch2')"
    );
    expect(rows.length).toBe(2);
  });
});

// ==================== Racecourses ====================

describe('racecourses', () => {
  it('seedRacecourses でマスタデータを投入', async () => {
    await seedRacecourses([
      { id: 'tokyo', name: '東京', region: '中央', prefecture: '東京都', trackTypes: ['芝', 'ダート'] },
      { id: 'nakayama', name: '中山', region: '中央', prefecture: '千葉県', trackTypes: ['芝', 'ダート'] },
    ]);
    const all = await getAllRacecourses();
    const names = all.map(r => r.name);
    expect(names).toContain('東京');
    expect(names).toContain('中山');
  });
});

// ==================== Horses ====================

describe('horses', () => {
  it('upsertHorse + getHorseById', async () => {
    await upsertHorse({
      id: 'h001', name: 'テストホース', age: 4, sex: '牡',
      fatherName: 'テスト父', motherName: 'テスト母', trainerName: 'テスト調教師',
    });

    const horse = await getHorseById('h001');
    expect(horse).toBeTruthy();
    expect(horse!.name).toBe('テストホース');
    expect(horse!.age).toBe(4);
  });

  it('upsert で更新される', async () => {
    await upsertHorse({
      id: 'h001', name: 'テストホース改', age: 5, sex: '牡',
      fatherName: 'テスト父', motherName: 'テスト母', trainerName: 'テスト調教師',
    });

    const horse = await getHorseById('h001');
    expect(horse!.name).toBe('テストホース改');
    expect(horse!.age).toBe(5);
  });

  it('searchHorses で部分一致検索', async () => {
    await upsertHorse({
      id: 'h002', name: 'サンデーサイレンス', age: 3, sex: '牝',
      fatherName: 'テスト父2', motherName: 'テスト母2', trainerName: 'テスト調教師2',
    });

    const results = await searchHorses('サンデー');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('サンデーサイレンス');
  });

  it('getAllHorses でページネーション', async () => {
    const page1 = await getAllHorses(1, 0);
    const page2 = await getAllHorses(1, 1);
    expect(page1.length).toBe(1);
    expect(page2.length).toBe(1);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it('setHorseTraits で強み・弱みを設定', async () => {
    await setHorseTraits('h001', ['スピード', 'スタミナ'], ['道悪']);

    const traits = await dbAll<{ trait_type: string; description: string }>(
      "SELECT trait_type, description FROM horse_traits WHERE horse_id = ?", ['h001']
    );
    expect(traits.length).toBe(3);
    const strengths = traits.filter(t => t.trait_type === 'strength');
    const weaknesses = traits.filter(t => t.trait_type === 'weakness');
    expect(strengths.length).toBe(2);
    expect(weaknesses.length).toBe(1);
  });
});

// ==================== Jockeys ====================

describe('jockeys', () => {
  it('upsertJockey + getJockeyById', async () => {
    await upsertJockey({
      id: 'j001', name: 'テスト騎手', winRate: 0.15, placeRate: 0.35,
    });

    const jockey = await getJockeyById('j001');
    expect(jockey).toBeTruthy();
    expect(jockey!.name).toBe('テスト騎手');
  });

  it('searchJockeys で部分一致検索', async () => {
    const results = await searchJockeys('テスト');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ==================== Races ====================

describe('races', () => {
  it('upsertRace + getRaceById', async () => {
    await upsertRace({
      id: 'r001',
      name: 'テストレース',
      date: '2025-06-15',
      racecourseId: 'tokyo',
      racecourseName: '東京',
      raceNumber: 11,
      grade: 'G1',
      trackType: '芝',
      distance: 2400,
      trackCondition: '良',
      status: '予定',
    });

    const race = await getRaceById('r001');
    expect(race).toBeTruthy();
    expect(race!.name).toBe('テストレース');
    expect(race!.distance).toBe(2400);
  });

  it('getRacesByDate で日付検索', async () => {
    const races = await getRacesByDate('2025-06-15');
    expect(races.length).toBeGreaterThanOrEqual(1);
    expect(races[0].id).toBe('r001');
  });

  it('getUpcomingRaces で未来のレース取得', async () => {
    await upsertRace({
      id: 'r_future',
      name: '未来レース',
      date: '2030-01-01',
      racecourseId: 'tokyo',
      racecourseName: '東京',
      raceNumber: 1,
      trackType: '芝',
      distance: 1600,
      status: '予定',
    });

    const upcoming = await getUpcomingRaces(10);
    const ids = upcoming.map(r => r.id);
    expect(ids).toContain('r_future');
  });
});

// ==================== Race Entries ====================

describe('race entries', () => {
  it('upsertRaceEntry でエントリー追加', async () => {
    await upsertRaceEntry('r001', {
      postPosition: 3,
      horseNumber: 5,
      horseId: 'h001',
      horseName: 'テストホース改',
      age: 5,
      sex: '牡',
      weight: 480,
      jockeyId: 'j001',
      jockeyName: 'テスト騎手',
      trainerName: 'テスト調教師',
      handicapWeight: 56,
      result: { position: 1, time: '1:34.5', margin: '', lastThreeFurlongs: '33.5', cornerPositions: '3-3-2-1', weight: 480, weightChange: 0 },
    });

    const entries = await dbAll<{ horse_name: string }>(
      "SELECT horse_name FROM race_entries WHERE race_id = ?", ['r001']
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

// ==================== Past Performances ====================

describe('past performances', () => {
  it('insertPastPerformance + getHorsePastPerformances', async () => {
    await insertPastPerformance('h001', {
      raceId: null as unknown as string,
      date: '2025-01-15',
      raceName: '過去レース1',
      racecourseName: '東京',
      trackType: '芝',
      distance: 1600,
      trackCondition: '良',
      weather: '晴',
      entries: 16,
      postPosition: 3,
      horseNumber: 5,
      position: 1,
      jockeyName: 'テスト騎手',
      handicapWeight: 56,
      weight: 480,
      weightChange: 0,
      time: '1:34.5',
      margin: '',
      lastThreeFurlongs: '33.5',
      cornerPositions: '3-3-2-1',
      odds: 5.0,
      popularity: 3,
      prize: 1000,
    });

    const pp = await getHorsePastPerformances('h001');
    expect(pp.length).toBeGreaterThanOrEqual(1);
    // ORDER BY date DESC なので最新のものが先頭
    const perf1 = pp.find(p => p.raceName === '過去レース1');
    expect(perf1).toBeTruthy();
    expect(perf1!.position).toBe(1);
  });

  it('limitパラメータで件数制限', async () => {
    for (let i = 2; i <= 5; i++) {
      await insertPastPerformance('h001', {
        raceId: null as unknown as string,
        date: `2025-0${i}-15`,
        raceName: `過去レース${i}`,
        racecourseName: '東京',
        trackType: '芝',
        distance: 1600,
        trackCondition: '良',
        weather: '晴',
        entries: 16,
        postPosition: 3,
        horseNumber: 5,
        position: i,
        jockeyName: 'テスト騎手',
        handicapWeight: 56,
        weight: 480,
        weightChange: 0,
        time: '',
        margin: '',
        lastThreeFurlongs: '',
        cornerPositions: '',
        odds: 0,
        popularity: 0,
        prize: 0,
      });
    }

    const pp3 = await getHorsePastPerformances('h001', 3);
    expect(pp3.length).toBe(3);
  });
});

// ==================== Predictions ====================

describe('predictions', () => {
  it('savePrediction + getPredictionByRaceId', async () => {
    await savePrediction({
      raceId: 'r001',
      raceName: 'テストレース',
      date: '2025-06-15',
      generatedAt: '2025-06-14T10:00:00Z',
      confidence: 75,
      summary: 'テスト予想サマリー',
      topPicks: [
        { rank: 1, horseNumber: 5, horseName: 'テストホース改', score: 85, reasons: ['理由1'] },
      ],
      analysis: {
        trackBias: '芝2400m',
        paceAnalysis: 'ミドルペース予想',
        keyFactors: ['距離適性'],
        riskFactors: ['波乱の可能性'],
      },
      recommendedBets: [
        { type: '単勝', selections: [5], reasoning: 'テスト', expectedValue: 1.5 },
      ],
    });

    const pred = await getPredictionByRaceId('r001');
    expect(pred).toBeTruthy();
    expect(pred!.confidence).toBe(75);
    expect(pred!.topPicks.length).toBe(1);
    expect(pred!.topPicks[0].horseName).toBe('テストホース改');
  });
});

// ==================== Odds ====================

describe('odds', () => {
  it('upsertOdds + getOddsByRaceId', async () => {
    await upsertOdds('r001', '単勝', [5], 3.5);
    await upsertOdds('r001', '単勝', [3], 8.0);

    const odds = await getOddsByRaceId('r001');
    expect(odds.length).toBeGreaterThanOrEqual(1);
  });
});

// ==================== Dashboard Stats ====================

describe('dashboard stats', () => {
  it('getDashboardStats がオブジェクトを返す', async () => {
    const stats = await getDashboardStats();
    expect(stats).toHaveProperty('totalRaces');
    expect(stats).toHaveProperty('totalHorses');
    expect(stats).toHaveProperty('totalJockeys');
    expect(stats).toHaveProperty('totalPredictions');
    expect(typeof stats.totalRaces).toBe('number');
  });
});
