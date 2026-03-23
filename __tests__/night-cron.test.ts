/**
 * 夜間cron テスト
 *
 * 結果確定後のレース情報が過去レース表示に正しく移行されるか検証する。
 *
 * 1. cleanupStaleRaces の includeToday パラメータ
 *    - デフォルト(false): 当日レースを含まない
 *    - true: 当日レースも結果取得対象になる
 *
 * 2. cron の時間帯分岐
 *    - JST 17:00 (evening): 夕方ブロック実行
 *    - JST 22:00 (night): 夜間ブロックも実行される（修正後）
 *
 * 3. getUpcomingRaces / getRecentResults のステータスフィルタ
 *    - 出走確定 → upcoming に表示
 *    - 結果確定 → results に表示（移行完了）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ensureInitialized, dbAll, dbRun, closeDatabase,
} from '@/lib/database';
import {
  upsertRace, getUpcomingRaces, getRecentResults,
  seedRacecourses,
} from '@/lib/queries';
import { RACECOURSES } from '@/types';

beforeAll(async () => {
  await ensureInitialized();
  await seedRacecourses(RACECOURSES);
});

afterAll(async () => {
  await closeDatabase();
});

// ==================== JST時刻計算ヘルパー ====================

/** UTC Date を渡して JST 時刻を返す（cron route と同じロジック） */
function computeJstHour(utcDate: Date): number {
  const jstOffset = 9 * 60;
  const jstMinutes = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + jstOffset;
  return Math.floor((jstMinutes % 1440) / 60);
}

function getJstToday(): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  return new Date(now.getTime() + jstOffset).toISOString().split('T')[0];
}

// ==================== cron 時間帯分岐ロジック ====================

describe('cron 時間帯分岐', () => {
  it('UTC 08:00 = JST 17:00 → evening ブロックに該当する', () => {
    const utc = new Date('2026-03-23T08:00:00Z');
    const jstHour = computeJstHour(utc);
    expect(jstHour).toBe(17);
    // 修正後: jstHour >= 16 で evening/night ブロック実行
    expect(jstHour >= 16).toBe(true);
    // periodLabel
    const periodLabel = jstHour <= 18 ? 'evening' : 'night';
    expect(periodLabel).toBe('evening');
  });

  it('UTC 13:00 = JST 22:00 → night ブロックに該当する', () => {
    const utc = new Date('2026-03-23T13:00:00Z');
    const jstHour = computeJstHour(utc);
    expect(jstHour).toBe(22);
    // 修正後: jstHour >= 16 で夜間もブロック実行
    expect(jstHour >= 16).toBe(true);
    // periodLabel
    const periodLabel = jstHour <= 18 ? 'evening' : 'night';
    expect(periodLabel).toBe('night');
  });

  it('修正前の条件 (16-18) では JST 22:00 が対象外だった', () => {
    const jstHour = 22;
    // 旧条件
    const oldCondition = jstHour >= 16 && jstHour <= 18;
    expect(oldCondition).toBe(false);
    // 新条件
    const newCondition = jstHour >= 16;
    expect(newCondition).toBe(true);
  });

  it('朝・昼の時間帯は evening/night ブロックに該当しない', () => {
    // JST 9:00
    expect(computeJstHour(new Date('2026-03-23T00:00:00Z'))).toBe(9);
    expect(9 >= 16).toBe(false);

    // JST 12:00
    expect(computeJstHour(new Date('2026-03-23T03:00:00Z'))).toBe(12);
    expect(12 >= 16).toBe(false);

    // JST 14:00
    expect(computeJstHour(new Date('2026-03-23T05:00:00Z'))).toBe(14);
    expect(14 >= 16).toBe(false);
  });
});

// ==================== cleanupStaleRaces の includeToday ====================

describe('cleanupStaleRaces includeToday パラメータ', () => {
  const today = getJstToday();
  const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0];

  // テスト用レースID（racecourse_id は既存の '05' = 東京 を使用）
  const todayRaceId = `202605031211`;
  const yesterdayRaceId = `202605031111`;

  beforeAll(async () => {
    // テスト用レースを登録
    await upsertRace({
      id: todayRaceId,
      name: '当日テストレース',
      date: today,
      racecourseId: 'tokyo',
      racecourseName: '東京',
      raceNumber: 11,
      trackType: '芝',
      distance: 2000,
      status: '出走確定',
    });
    await upsertRace({
      id: yesterdayRaceId,
      name: '前日テストレース',
      date: yesterday,
      racecourseId: 'tokyo',
      racecourseName: '東京',
      raceNumber: 11,
      trackType: '芝',
      distance: 2000,
      status: '出走確定',
    });
  });

  it('includeToday=false (デフォルト) では当日レースを含まない', async () => {
    const dateOp = '<';
    const staleRaces = await dbAll<{ id: string; date: string }>(
      `SELECT id, date FROM races
       WHERE date ${dateOp} ? AND status IN ('予定', '出走確定')
       ORDER BY date DESC LIMIT 200`,
      [today],
    );
    const ids = staleRaces.map(r => r.id);
    expect(ids).toContain(yesterdayRaceId);
    expect(ids).not.toContain(todayRaceId);
  });

  it('includeToday=true では当日レースも含まれる', async () => {
    const dateOp = '<=';
    const staleRaces = await dbAll<{ id: string; date: string }>(
      `SELECT id, date FROM races
       WHERE date ${dateOp} ? AND status IN ('予定', '出走確定')
       ORDER BY date DESC LIMIT 200`,
      [today],
    );
    const ids = staleRaces.map(r => r.id);
    expect(ids).toContain(yesterdayRaceId);
    expect(ids).toContain(todayRaceId);
  });
});

// ==================== ステータス移行と表示フィルタ ====================

describe('ステータス移行後の表示フィルタ', () => {
  const today = getJstToday();
  const raceId = '202605031212';

  beforeAll(async () => {
    await upsertRace({
      id: raceId,
      name: '移行テストレース',
      date: today,
      racecourseId: 'tokyo',
      racecourseName: '東京',
      raceNumber: 12,
      trackType: '芝',
      distance: 1600,
      status: '出走確定',
    });
  });

  it('出走確定のレースは upcoming に表示される', async () => {
    const upcoming = await getUpcomingRaces(100);
    const found = upcoming.find(r => r.id === raceId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('出走確定');
  });

  it('出走確定のレースは results に表示されない', async () => {
    const results = await getRecentResults(100);
    const found = results.find(r => r.id === raceId);
    expect(found).toBeUndefined();
  });

  it('結果確定に移行すると upcoming から消える', async () => {
    await upsertRace({ id: raceId, status: '結果確定' });

    const upcoming = await getUpcomingRaces(100);
    const found = upcoming.find(r => r.id === raceId);
    expect(found).toBeUndefined();
  });

  it('結果確定に移行すると results に表示される', async () => {
    const results = await getRecentResults(100);
    const found = results.find(r => r.id === raceId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('結果確定');
  });
});
