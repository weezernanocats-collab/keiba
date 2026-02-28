import { NextResponse } from 'next/server';
import { dbAll, dbGet, dbRun, dbRunNamed } from '@/lib/database';
import { scrapeRaceList, scrapeHorseDetail } from '@/lib/scraper';
import { upsertRace, upsertHorse } from '@/lib/queries';

export const maxDuration = 30;

export async function GET() {
  const results: Record<string, unknown> = {};

  // 0. 環境変数チェック
  results.envCheck = {
    hasTursoUrl: !!process.env.TURSO_DATABASE_URL,
    tursoUrlPrefix: process.env.TURSO_DATABASE_URL?.substring(0, 30) || 'not set',
    hasTursoToken: !!process.env.TURSO_AUTH_TOKEN,
  };

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

  // 4. upsertRace関数テスト (racecourseId未指定 = バルクインポートと同じ条件)
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

  // 5. スクレイパーテスト: 複数日をテスト
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
    // race_list_sub.html をテスト（修正後のスクレイパーが使うURL）
    const rawUrl = 'https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20251228';
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
      containsRaceList: html.includes('RaceList_DataList'),
      containsRaceId: html.includes('race_id='),
      containsDlTag: html.includes('<dl'),
      bodySnippetAroundRace: extractAroundKeyword(html, 'race_id', 500),
      bodySnippetAroundDl: extractAroundKeyword(html, '<dl', 500),
      htmlSnippet: html.substring(0, 2000),
    };
  } catch (error) {
    results.rawHtmlTest = { success: false, error: String(error) };
  }

  // 5c. 馬詳細スクレイピングテスト（Vercelからdb.netkeiba.comにアクセスできるか）
  try {
    // DBから実際の馬IDを1件取得
    const sampleHorse = await dbGet<{ id: string; name: string }>(
      "SELECT id, name FROM horses WHERE birth_date IS NULL AND name != '取得失敗' LIMIT 1"
    );
    if (sampleHorse) {
      const startMs = Date.now();
      const horseDetail = await scrapeHorseDetail(sampleHorse.id);
      const elapsed = Date.now() - startMs;
      results.horseDetailTest = {
        success: !!horseDetail,
        horseId: sampleHorse.id,
        elapsed: `${elapsed}ms`,
        name: horseDetail?.name || null,
        pastPerfs: horseDetail?.pastPerformances?.length || 0,
      };

      // upsertHorse テスト
      if (horseDetail) {
        try {
          await upsertHorse({
            id: horseDetail.id,
            name: horseDetail.name,
            birthDate: horseDetail.birthDate,
            fatherName: horseDetail.fatherName,
            motherName: horseDetail.motherName,
            trainerName: horseDetail.trainerName,
            ownerName: horseDetail.ownerName,
          });
          results.upsertHorseTest = { success: true, horseId: horseDetail.id };
        } catch (error) {
          results.upsertHorseTest = { success: false, error: String(error) };
        }
      }
    } else {
      results.horseDetailTest = { skipped: true, reason: 'No placeholder horses found' };
    }
  } catch (error) {
    results.horseDetailTest = { success: false, error: String(error) };
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

  // 7. 壊れたレース（date=''）の検出
  try {
    const broken = await dbAll<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM races WHERE date = '' OR date IS NULL LIMIT 50"
    );
    results.brokenRaces = { count: broken.length, samples: broken.slice(0, 10) };
  } catch (error) {
    results.brokenRaces = { error: String(error) };
  }

  // 8. クリーンアップ: テスト用レコードを削除
  try {
    await dbRun("DELETE FROM races WHERE id LIKE 'test_diag_%'");
    results.cleanup = { success: true };
  } catch (error) {
    results.cleanup = { success: false, error: String(error) };
  }

  return NextResponse.json(results, { status: 200 });
}

// POST: 壊れたレースの修復（date=''のレースを削除して再取込可能にする）
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.action === 'fix_broken_dates') {
      // date='' のレースに関連するデータを削除
      const broken = await dbAll<{ id: string }>(
        "SELECT id FROM races WHERE date = '' OR date IS NULL"
      );
      const ids = broken.map(r => r.id);

      if (ids.length === 0) {
        return NextResponse.json({ fixed: 0, message: '修復対象なし' });
      }

      const placeholders = ids.map(() => '?').join(',');
      await dbRun(`DELETE FROM race_entries WHERE race_id IN (${placeholders})`, ids);
      await dbRun(`DELETE FROM odds WHERE race_id IN (${placeholders})`, ids);
      await dbRun(`DELETE FROM predictions WHERE race_id IN (${placeholders})`, ids);
      await dbRun(`DELETE FROM races WHERE id IN (${placeholders})`, ids);

      return NextResponse.json({
        fixed: ids.length,
        message: `${ids.length}件の壊れたレースを削除しました。バルクインポートで再取込してください。`,
        deletedIds: ids.slice(0, 20),
      });
    }

    return NextResponse.json({ error: '不明なアクション' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function extractAroundKeyword(html: string, keyword: string, radius: number): string {
  const idx = html.indexOf(keyword);
  if (idx === -1) return 'keyword not found';
  const start = Math.max(0, idx - radius);
  const end = Math.min(html.length, idx + radius);
  return html.substring(start, end);
}
