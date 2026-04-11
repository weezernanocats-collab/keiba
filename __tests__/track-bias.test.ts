/**
 * track-bias.ts テスト
 *
 * 方針B の核心: races.status が '結果確定' に更新されなくても、
 * race_entries.result_position が入っていればバイアス計算が機能することを保証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureInitialized, dbRun, dbAll, closeDatabase } from '@/lib/database';
import {
  upsertRace,
  upsertRaceEntry,
  upsertHorse,
  upsertJockey,
  seedRacecourses,
} from '@/lib/queries';
import { calculateTodayTrackBias } from '@/lib/track-bias';

const TEST_DATE = '2099-12-31';
const TEST_VENUE = 'tb_test_venue';
const TEST_COURSE_ID = 'tb_test_course';

/**
 * 1レース分のデータをセットアップするヘルパー。
 * opts.results が null の馬は未完走扱い（result_position = null）。
 */
async function setupRace(
  raceNum: number,
  opts: {
    status: '予定' | '出走確定' | '結果確定';
    trackType: '芝' | 'ダート';
    results: Array<{
      horseNum: number;
      post: number;
      jockeyId: string;
      jockeyName: string;
      finish: number | null;
      corner?: string;
    }>;
  },
): Promise<string> {
  const raceId = `tb_test_r_${raceNum}`;
  await upsertRace({
    id: raceId,
    name: `TB R${raceNum}`,
    date: TEST_DATE,
    racecourseId: TEST_COURSE_ID,
    racecourseName: TEST_VENUE,
    raceNumber: raceNum,
    trackType: opts.trackType,
    distance: 1600,
    status: opts.status,
  });

  for (const e of opts.results) {
    const horseId = `tb_test_h_${raceNum}_${e.horseNum}`;
    await upsertHorse({
      id: horseId,
      name: `TB Horse ${raceNum}-${e.horseNum}`,
      age: 4,
      sex: '牡',
      fatherName: '',
      motherName: '',
      trainerName: '',
    });
    await upsertJockey({ id: e.jockeyId, name: e.jockeyName });
    await upsertRaceEntry(raceId, {
      postPosition: e.post,
      horseNumber: e.horseNum,
      horseId,
      horseName: `TB Horse ${raceNum}-${e.horseNum}`,
      age: 4,
      sex: '牡',
      weight: 480,
      jockeyId: e.jockeyId,
      jockeyName: e.jockeyName,
      trainerName: '',
      handicapWeight: 55,
      result: e.finish !== null
        ? {
            position: e.finish,
            time: '1:34.5',
            margin: '',
            lastThreeFurlongs: '33.5',
            cornerPositions: e.corner ?? '3-3-2-1',
            weight: 480,
            weightChange: 0,
          }
        : undefined,
    });
  }
  return raceId;
}

/**
 * 1レース = 8頭の標準完走レースを作る。
 * 勝ち馬の内外・脚質を指定可能。
 */
function buildEntries(opts: {
  /** 勝ち馬の枠番 (1-8) */
  winnerPost: number;
  /** 勝ち馬のコーナー通過 */
  winnerCorner?: string;
  /** 好調騎手 (全馬 3着以内扱い) */
  hotJockey?: { id: string; name: string; places: number[] };
  /** その他の騎手名プレフィクス */
  prefix: string;
}) {
  const entries: Parameters<typeof setupRace>[1]['results'] = [];
  // 勝ち馬
  entries.push({
    horseNum: 1,
    post: opts.winnerPost,
    jockeyId: `${opts.prefix}_winner`,
    jockeyName: `${opts.prefix}Winner`,
    finish: 1,
    corner: opts.winnerCorner,
  });
  // 他の7頭
  for (let i = 2; i <= 8; i++) {
    entries.push({
      horseNum: i,
      post: ((opts.winnerPost + i - 1) % 8) + 1,
      jockeyId: `${opts.prefix}_j${i}`,
      jockeyName: `${opts.prefix}J${i}`,
      finish: i,
    });
  }
  return entries;
}

beforeAll(async () => {
  await ensureInitialized();

  // 並列で走る他のDBテスト (database-queries.test.ts) との SQLITE_BUSY 衝突回避。
  // busy_timeout は SQLite がロック解放を待つミリ秒を指定する。
  await dbAll('PRAGMA busy_timeout = 10000');

  // テスト用 racecourse を投入 (FK用)
  await seedRacecourses([
    {
      id: TEST_COURSE_ID,
      name: TEST_VENUE,
      region: '中央',
      prefecture: 'テスト県',
      trackTypes: ['芝', 'ダート'],
    },
  ]);

  // 同じ TEST_DATE / TEST_VENUE の過去のテストデータをクリーンアップ
  await dbRun(
    `DELETE FROM race_entries WHERE race_id IN (
       SELECT id FROM races WHERE date = ? AND racecourse_name = ?
     )`,
    [TEST_DATE, TEST_VENUE],
  );
  await dbRun(
    `DELETE FROM races WHERE date = ? AND racecourse_name = ?`,
    [TEST_DATE, TEST_VENUE],
  );
});

afterAll(async () => {
  // テストデータを片付け (他テストへの汚染防止)
  await dbRun(
    `DELETE FROM race_entries WHERE race_id IN (
       SELECT id FROM races WHERE date = ? AND racecourse_name = ?
     )`,
    [TEST_DATE, TEST_VENUE],
  );
  await dbRun(
    `DELETE FROM races WHERE date = ? AND racecourse_name = ?`,
    [TEST_DATE, TEST_VENUE],
  );
  await closeDatabase();
});

describe('calculateTodayTrackBias - 方針B: status非依存', () => {
  it('status が出走確定のままでも result_position があれば集計される', async () => {
    // 3レース分、全て status='出走確定' で result_position だけ埋まっている状態
    // (= 今日のレースが終わったが races.status 更新バッチが走っていない状況を再現)
    for (let i = 1; i <= 3; i++) {
      await setupRace(i, {
        status: '出走確定',
        trackType: '芝',
        results: buildEntries({ winnerPost: 1, prefix: `t1_r${i}` }),
      });
    }

    const bias = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, '芝');
    expect(bias).not.toBeNull();
    expect(bias!.sampleRaces).toBe(3);
  });

  it('status が結果確定でも従来通り集計される (既存挙動維持)', async () => {
    for (let i = 4; i <= 6; i++) {
      await setupRace(i, {
        status: '結果確定',
        trackType: '芝',
        results: buildEntries({ winnerPost: 1, prefix: `t2_r${i}` }),
      });
    }

    const bias = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, '芝');
    expect(bias).not.toBeNull();
    // テスト1 の3レース + テスト2 の3レース = 6レース
    expect(bias!.sampleRaces).toBe(6);
  });

  it('result_position が null の未完走レースは除外される', async () => {
    // 全馬 result_position=null の「発走前」レース
    await setupRace(7, {
      status: '出走確定',
      trackType: '芝',
      results: [
        { horseNum: 1, post: 1, jockeyId: 't3_j1', jockeyName: 't3J1', finish: null },
        { horseNum: 2, post: 2, jockeyId: 't3_j2', jockeyName: 't3J2', finish: null },
        { horseNum: 3, post: 3, jockeyId: 't3_j3', jockeyName: 't3J3', finish: null },
        { horseNum: 4, post: 4, jockeyId: 't3_j4', jockeyName: 't3J4', finish: null },
        { horseNum: 5, post: 5, jockeyId: 't3_j5', jockeyName: 't3J5', finish: null },
        { horseNum: 6, post: 6, jockeyId: 't3_j6', jockeyName: 't3J6', finish: null },
      ],
    });

    const bias = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, '芝');
    // 前テストの6レースのまま（未完走R7は加算されない）
    expect(bias!.sampleRaces).toBe(6);
  });

  it('3レース未満では null を返す', async () => {
    const bias = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, 'ダート');
    // ダートはまだ登録していない
    expect(bias).toBeNull();
  });

  it('trackType フィルタが効く', async () => {
    // ダート3レース追加
    for (let i = 8; i <= 10; i++) {
      await setupRace(i, {
        status: '出走確定',
        trackType: 'ダート',
        results: buildEntries({ winnerPost: 2, prefix: `t5_r${i}` }),
      });
    }

    const dirt = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, 'ダート');
    const turf = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, '芝');
    expect(dirt!.sampleRaces).toBe(3);
    expect(turf!.sampleRaces).toBe(6);
  });

  it('trackType 未指定なら芝・ダート合算', async () => {
    const all = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE);
    expect(all!.sampleRaces).toBe(9); // 6 + 3
  });

  it('jockeyDayForms が2騎乗以上の騎手で返る', async () => {
    // テスト1/2 で prefix が違うので各騎手 1騎乗のみ → jockeyDayForms 空
    // ここで同じ騎手を複数レースに出走させる
    for (let i = 11; i <= 13; i++) {
      await setupRace(i, {
        status: '出走確定',
        trackType: '芝',
        results: [
          { horseNum: 1, post: 1, jockeyId: 'hot_j', jockeyName: 'HotJockey', finish: 1 },
          { horseNum: 2, post: 2, jockeyId: 'cold_j', jockeyName: 'ColdJockey', finish: 8 },
          { horseNum: 3, post: 3, jockeyId: `r${i}_j3`, jockeyName: `R${i}J3`, finish: 2 },
          { horseNum: 4, post: 4, jockeyId: `r${i}_j4`, jockeyName: `R${i}J4`, finish: 3 },
          { horseNum: 5, post: 5, jockeyId: `r${i}_j5`, jockeyName: `R${i}J5`, finish: 4 },
          { horseNum: 6, post: 6, jockeyId: `r${i}_j6`, jockeyName: `R${i}J6`, finish: 5 },
          { horseNum: 7, post: 7, jockeyId: `r${i}_j7`, jockeyName: `R${i}J7`, finish: 6 },
          { horseNum: 8, post: 8, jockeyId: `r${i}_j8`, jockeyName: `R${i}J8`, finish: 7 },
        ],
      });
    }

    const bias = await calculateTodayTrackBias(TEST_VENUE, TEST_DATE, '芝');
    expect(bias!.jockeyDayForms).toBeDefined();
    const hot = bias!.jockeyDayForms!.find(j => j.jockeyName === 'HotJockey');
    const cold = bias!.jockeyDayForms!.find(j => j.jockeyName === 'ColdJockey');
    expect(hot).toBeDefined();
    expect(hot!.rides).toBe(3);
    expect(hot!.wins).toBe(3);
    expect(hot!.formBonus).toBeGreaterThan(0); // 複勝率100% → 好調
    expect(cold).toBeDefined();
    expect(cold!.rides).toBe(3);
    expect(cold!.wins).toBe(0);
    expect(cold!.formBonus).toBeLessThan(0); // 複勝率0% → 不調
  });
});
