import { NextResponse } from 'next/server';
import { dbAll, dbGet, dbRun, dbRunNamed } from '@/lib/database';
import { scrapeRaceList } from '@/lib/scraper';
import { upsertRace } from '@/lib/queries';

export const maxDuration = 30;

export async function GET() {
  const results: Record<string, unknown> = {};

  // 1. DB接続テスト: SELECT
  try {
    const row = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM races');
    results.dbReadTest = { success: true, racesCount: row?.c ?? 0 };
  } catch (error) {
    results.dbReadTest = { success: false, error: String(error) };
  }

  // 2. DB書き込みテスト: 直接INSERT (positional params)
  try {
    await dbRun(
      `INSERT OR REPLACE INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['test_diag_001', 'テスト直接INSERT', '2025-01-01', null, 'tokyo', '東京', 1, null, '芝', 2000, null, null, '予定']
    );
    const readBack = await dbGet<{ id: string; name: string }>('SELECT id, name FROM races WHERE id = ?', ['test_diag_001']);
    results.dbDirectInsert = { success: true, readBack };
  } catch (error) {
    results.dbDirectInsert = { success: false, error: String(error) };
  }

  // 3. DB書き込みテスト: dbRunNamed (@named params)
  try {
    await dbRunNamed(
      `INSERT OR REPLACE INTO races (id, name, date, time, racecourse_id, racecourse_name, race_number, grade, track_type, distance, track_condition, weather, status)
       VALUES (@id, @name, @date, @time, @racecourse_id, @racecourse_name, @race_number, @grade, @track_type, @distance, @track_condition, @weather, @status)`,
      {
        id: 'test_diag_002',
        name: 'テストNamed INSERT',
        date: '2025-01-02',
        time: null,
        racecourse_id: 'tokyo',
        racecourse_name: '東京',
        race_number: 2,
        grade: null,
        track_type: '芝',
        distance: 1600,
        track_condition: null,
        weather: null,
        status: '予定',
      }
    );
    const readBack = await dbGet<{ id: string; name: string }>('SELECT id, name FROM races WHERE id = ?', ['test_diag_002']);
    results.dbNamedInsert = { success: true, readBack };
  } catch (error) {
    results.dbNamedInsert = { success: false, error: String(error) };
  }

  // 4. upsertRace関数テスト
  try {
    await upsertRace({
      id: 'test_diag_003',
      name: 'テストupsertRace',
      date: '2025-01-03',
      racecourseName: '中山',
      raceNumber: 3,
      status: '予定',
    });
    const readBack = await dbGet<{ id: string; name: string }>('SELECT id, name FROM races WHERE id = ?', ['test_diag_003']);
    results.upsertRaceTest = { success: true, readBack };
  } catch (error) {
    results.upsertRaceTest = { success: false, error: String(error) };
  }

  // 5. スクレイパーテスト: 複数日をテスト + 生のHTML確認
  try {
    const testDates = ['2025-12-28', '2025-06-01', '2026-02-22'];
    const scraperResults: Record<string, unknown>[] = [];
    for (const testDate of testDates) {
      const races = await scrapeRaceList(testDate);
      scraperResults.push({
        date: testDate,
        racesFound: races.length,
        sampleRaces: races.slice(0, 3).map(r => ({ id: r.id, name: r.name, course: r.racecourseName })),
      });
    }
    results.scraperTest = { success: true, results: scraperResults };
  } catch (error) {
    results.scraperTest = { success: false, error: String(error) };
  }

  // 5b. 生のHTMLを取得してセレクタを確認
  try {
    const rawUrl = 'https://race.netkeiba.com/top/race_list.html?kaisai_date=20251228';
    const response = await fetch(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      },
    });
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-jp');
    const html = decoder.decode(buffer);
    results.rawHtmlTest = {
      status: response.status,
      htmlLength: html.length,
      htmlSnippet: html.substring(0, 2000),
      containsRaceList: html.includes('RaceList_DataList'),
      containsRaceId: html.includes('race_id='),
    };
  } catch (error) {
    results.rawHtmlTest = { success: false, error: String(error) };
  }

  // 6. 全テーブルのレコード数
  try {
    const tables = ['horses', 'races', 'race_entries', 'jockeys', 'past_performances', 'odds', 'predictions', 'racecourses'];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = await dbGet<{ c: number }>(`SELECT COUNT(*) as c FROM ${table}`);
      counts[table] = row?.c ?? 0;
    }
    results.tableCounts = counts;
  } catch (error) {
    results.tableCounts = { error: String(error) };
  }

  // 7. クリーンアップ: テスト用レコードを削除
  try {
    await dbRun("DELETE FROM races WHERE id LIKE 'test_diag_%'");
    results.cleanup = { success: true };
  } catch (error) {
    results.cleanup = { success: false, error: String(error) };
  }

  return NextResponse.json(results, { status: 200 });
}

function getRecentSaturday(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = dayOfWeek >= 6 ? dayOfWeek - 6 : dayOfWeek + 1;
  const saturday = new Date(now);
  saturday.setDate(now.getDate() - diff);
  return saturday.toISOString().split('T')[0];
}
